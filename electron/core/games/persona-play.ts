/**
 * Personality in Werewolf (docs/ai-personality-module.md §9): an opening plan per Bot seat, and a choice among the
 * model's reasonable candidates in weak situations. Rules, camp goals and legality never change; strong situations
 * always keep the model's pick. Everything here is a pure function of the match state and its seed.
 */
import type { GameAction, GameRequest } from '../../../shared/types/game-types';
import { parseCandidateSemantic, semanticEvidenceMatches } from '../../../shared/persona/persona-assessment';
import { seededRandom } from '../../../shared/games/seeded-random';
import {
  KEY_DECISIONS,
  PLANS,
  choose,
  CHOICE_PARAMETERS,
  mbtiOf,
  planRole,
  sameAction,
  tendencies,
  toAction,
  type Candidate,
  type DecisionContext,
  type Features,
  type Traits,
} from '../../../shared/persona/persona-model';
import type { WerewolfState } from './werewolf';

/** Private persona of one Bot seat for this match. Only the seat itself sees it before the reveal. */
export interface SeatPersona {
  botId: string;
  traits: Traits;
  mbti: string;
  plan?: { id: string; name: string; detail: string; f: Features; prob: number };
  /** Affinity of this Bot towards the Bot in each other seat, frozen at the start. */
  affinity: Record<string, number>;
}
/** One key decision made under personality, kept for growth at settlement. */
export interface PersonaDecision {
  /** Older decisions used fixed feature mappings; never relabel historical evidence. */
  selectionMethod?: 'model_semantic_v1';
  growthDisposition?: 'record_only';
  gateReason?:
    | 'single_candidate'
    | 'model_decisive'
    | 'rule_strong'
    | 'weak'
    | 'semantic_missing'
    | 'semantic_uncertain'
    | 'semantic_evidence_invalid'
    | 'semantic_indistinguishable'
    | 'semantic_conflict';
  context?: DecisionContext;
  candidates?: { candidate: Candidate; features: Features; rank: number; probability: number; fit?: number }[];
  requestId: string;
  seatId: string;
  kind: GameRequest['kind'];
  day: number;
  strong: boolean;
  /** Reasonable candidates offered (the model's pick first). */
  options: number;
  chosen: Candidate;
  /** Seat the chosen action lands on: the target, or the night victim for a witch save. */
  subject?: string;
  features: Features;
  prob: number;
  overridden: boolean;
}
export interface PersonaSeed {
  traits: Traits;
  /** Plan id this Bot used last time it held each plan role, for f_explore. */
  lastPlans?: Partial<Record<string, string>>;
  /** Affinity towards other Bots and 'user', by member id. */
  affinity?: Record<string, number>;
}

const draw = (s: WerewolfState, salt: number) => {
  // Each draw has its own stream: seed, a per-match counter and a salt. Replays with the same seed and the same
  // model answers give the same choices.
  s.personaDraws = (s.personaDraws || 0) + 1;
  return seededRandom(((s.seed || 0) ^ Math.imul(s.personaDraws, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) | 0);
};

/**
 * Give each Bot seat its persona and opening plan (§9.2). At most one wolf jumps per team: wolves draw in order of
 * `assert`, and once one picks the jump the rest lose that option.
 */
export function assignPersonas(s: WerewolfState, seeds: Record<string, PersonaSeed>) {
  const persona: Record<string, SeatPersona> = {};
  const bots = s.seats.filter((p) => p.botId && !p.human && seeds[p.botId]);
  if (!bots.length) return;
  const memberOf = (seatId: string) => {
    const p = s.seats.find((x) => x.id === seatId)!;
    return p.human ? 'user' : p.botId;
  };
  const order = [...bots].sort(
    (a, b) => tendencies(seeds[b.botId!].traits).assert - tendencies(seeds[a.botId!].traits).assert,
  );
  let wolfJumped = false;
  for (const p of order) {
    const seed = seeds[p.botId!],
      role = planRole(p.role);
    const affinity: Record<string, number> = {};
    for (const other of s.seats) {
      const id = other.id !== p.id && memberOf(other.id);
      if (id && seed.affinity?.[id]) affinity[other.id] = seed.affinity[id];
    }
    let plans = PLANS.filter((x) => x.role === role);
    if (role === 'wolf' && wolfJumped) plans = plans.filter((x) => x.id !== 'wolf_jump');
    const last = seed.lastPlans?.[role];
    const random = draw(s, s.seats.indexOf(p));
    const picked = choose(
      seed.traits,
      plans.map((x) => ({ value: x.id, rank: 0, f: { ...x.f, explore: last ? (last === x.id ? -1 : 1) : 0 } })),
      random,
    );
    const plan = plans[picked.index];
    if (plan.id === 'wolf_jump') wolfJumped = true;
    persona[p.id] = {
      botId: p.botId!,
      traits: seed.traits,
      mbti: mbtiOf(seed.traits),
      plan: { id: plan.id, name: plan.name, detail: plan.detail, f: plan.f, prob: picked.prob },
      affinity,
    };
  }
  s.persona = persona;
}

/** Seat most often named in today's public speeches (§8.3 f_conform), by seat number or player name. */
export function mostNominated(s: WerewolfState, exclude: string) {
  const counts = new Map<string, number>();
  for (const l of s.logs) {
    if (l.day !== s.day || !l.seatId || l.audience) continue;
    s.seats.forEach((p, i) => {
      if (p.id === l.seatId) return;
      const n =
        (l.text.match(new RegExp(`(?<!\\d)${i + 1}号`, 'g')) || []).length +
        (p.name && l.text.includes(p.name) ? 1 : 0);
      if (n) counts.set(p.id, (counts.get(p.id) || 0) + n);
    });
  }
  counts.delete(exclude);
  const top = [...counts].sort((a, b) => b[1] - a[1]);
  return top.length && (top.length === 1 || top[0][1] > top[1][1]) ? top[0][0] : undefined;
}

/** Rules with one legal target or a seer-confirmed wolf always keep the model's first choice. */
function isStrong(s: WerewolfState, r: GameRequest) {
  if (r.targets.length === 1) return true;
  if (r.kind !== 'vote') return false;
  const actor = s.seats.find((p) => p.id === r.seatId);
  if (actor?.role !== 'seer') return false;
  return (s.events || []).some(
    (e) => e.type === 'inspect' && e.seerId === actor.id && e.wolf && r.targets.includes(e.seatId),
  );
}

/**
 * Model semantics replace the old mechanical action→feature inference. The caller must pass the actual input of
 * this attempt: concurrent actions and revealed identities are not evidence. Uncertain/missing advice keeps the
 * first choice. Referenced text proves provenance, not the truth of the model's interpretation.
 */
export function personaPick(
  s: WerewolfState,
  r: GameRequest,
  action: GameAction,
  valid: (a: GameAction) => boolean,
  actorInput?: string,
): { action: GameAction; decision?: PersonaDecision } {
  const p = s.persona?.[r.seatId];
  if (!p || !KEY_DECISIONS.includes(r.kind)) return { action };
  const actor = s.seats.find((x) => x.id === r.seatId)!;
  const own: Candidate = { target: action.target, potion: action.potion, choice: action.choice, skip: action.skip };
  const legal = (action.candidates || []).filter((c) => valid(toAction(c, action)));
  const first = legal.find((c) => sameAction(c, own));
  const offered = legal.filter((c) => c.reasonable && !sameAction(c, own));
  const pool = [first ? { ...own, ...first } : own, ...offered].filter(
    (c, i, all) => all.findIndex((d) => sameAction(c, d)) === i,
  );
  const decisive = (action.candidates || []).some((c) => c.decisive);
  const subject = (c: Candidate) => (c.potion === 'save' ? r.witch?.victim : c.skip ? undefined : c.target);
  const strong = pool.length <= 1 || decisive || isStrong(s, r);
  let gateReason: PersonaDecision['gateReason'] =
    pool.length <= 1 ? 'single_candidate' : decisive ? 'model_decisive' : strong ? 'rule_strong' : 'weak';
  if (!strong) {
    const conflict = legal.some((c, i) =>
      legal
        .slice(i + 1)
        .some(
          (d) =>
            sameAction(c, d) &&
            (c.reasonable !== d.reasonable || JSON.stringify(c.semantic) !== JSON.stringify(d.semantic)),
        ),
    );
    if (conflict || (first && !first.reasonable)) gateReason = 'semantic_conflict';
    else if (pool.some((c) => !parseCandidateSemantic(c.semantic))) gateReason = 'semantic_missing';
    else if (pool.some((c) => c.semantic!.status === 'uncertain')) gateReason = 'semantic_uncertain';
    else if (pool.some((c) => !semanticEvidenceMatches(c.semantic!, actorInput, r.seatId, r.kind)))
      gateReason = 'semantic_evidence_invalid';
    else if (new Set(pool.map((c) => c.semantic!.fit)).size < 2) gateReason = 'semantic_indistinguishable';
  }
  let index = 0;
  let probs: number[] = pool.map((_, i) => (i === 0 ? 1 : 0));
  if (gateReason === 'weak') {
    // These are versioned product parameters, not confidence estimates or psychological constants.
    const scores = pool.map(
      (c, rank) => (c.semantic!.fit! - CHOICE_PARAMETERS.rankPenalty * rank) / CHOICE_PARAMETERS.temperature,
    );
    const max = Math.max(...scores),
      weights = scores.map((x) => Math.exp(x - max));
    const total = weights.reduce((a, b) => a + b, 0);
    probs = weights.map((w) => w / total);
    let x = draw(s, s.seats.indexOf(actor) + 100).next();
    while (index < probs.length - 1 && (x -= probs[index]) >= 0) index++;
  }
  const chosen = pool[index];
  return {
    action:
      index === 0
        ? action
        : toAction(chosen, {
            ...action,
            note: chosen.semantic!.summary,
            personalityNote: chosen.semantic!.summary.slice(0, 200),
          }),
    decision: {
      requestId: r.id,
      seatId: r.seatId,
      kind: r.kind,
      day: s.day,
      strong,
      selectionMethod: 'model_semantic_v1',
      growthDisposition: 'record_only',
      options: pool.length,
      chosen,
      subject: subject(chosen),
      features: {},
      prob: probs[index],
      overridden: index !== 0,
      gateReason,
      candidates: pool.map((candidate, rank) => ({
        candidate,
        rank,
        features: {},
        probability: probs[rank],
        ...(gateReason === 'weak' ? { fit: candidate.semantic!.fit } : {}),
      })),
    },
  };
}
