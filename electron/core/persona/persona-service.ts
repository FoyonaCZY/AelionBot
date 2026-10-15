import { PersonaStore, type AffinityModifier, type PersonaProfile } from './persona-store';
import type { PersonaView } from '../../../shared/types/persona-types';
import type { GrowthObservation } from '../../../shared/types/persona-growth-types';
import { GrowthRunner, type GrowthReviewerHooks } from './growth-runner';
import { settleMatch, type SettleMatch } from './settle';
import { APPRAISAL_KINDS, appraisalModifier, type Appraisal, type AppraisalType } from './appraisal';
import { matchExperiences } from './growth';
import { birthPrompt, facetsFrom } from './birth';
import {
  NEUTRAL,
  TRAITS,
  clip,
  growthStep,
  mbtiOf,
  planRole,
  roundTraits,
  styleText,
  tendencies,
  traitsFromMbti,
  type Traits,
} from '../../../shared/persona/persona-model';
import type { PersonaDecision, PersonaSeed, SeatPersona } from '../games/persona-play';

const DAY = 86_400_000;
/** Neutral neuroticism for Bots without a profile (§11.2). */
const DEFAULT_N = 0.5;
const HIGHLIGHT_COOLDOWN_DAYS = 7;

/**
 * affinity(t) = clip(Σ b_i · k_i · w_i(t), −1, 1), w_i linear decay over its duration,
 * k_i = 1 + N for negative modifiers (§11.2: bad is stronger than good, amplified by N).
 */
export function affinityScore(mods: AffinityModifier[], now = Date.now(), n = DEFAULT_N) {
  let sum = 0;
  for (const m of mods) {
    const w = Math.max(0, 1 - (now - m.createdAt) / (m.durationDays * DAY));
    sum += m.value * (m.value < 0 ? 1 + n : 1) * w;
  }
  return Math.max(-1, Math.min(1, sum));
}
function affinityWord(v: number) {
  return v >= 0.5 ? '很好' : v >= 0.15 ? '不错' : v <= -0.5 ? '很差' : v <= -0.15 ? '有芥蒂' : undefined;
}

export interface PersonaMatch extends SettleMatch {
  decisions?: PersonaDecision[];
  persona?: Record<string, SeatPersona>;
}
const dayStart = (t: number) => t - (t % DAY);

export class PersonaService {
  readonly store: PersonaStore;
  private growthRunner: GrowthRunner;
  private estimating = new Set<string>();
  constructor(
    dir: string,
    private now: () => number = Date.now,
  ) {
    this.store = new PersonaStore(dir);
    this.store.prune(this.now());
    this.growthRunner = new GrowthRunner(this.store, this.now);
  }
  configureGrowthReviewer(hooks: GrowthReviewerHooks) {
    this.growthRunner.configure(hooks);
  }
  recordGrowthObservations(observations: GrowthObservation[]) {
    this.growthRunner.record(observations);
  }
  requestGrowthReview(botId: string) {
    this.growthRunner.request(botId);
  }
  cancelGrowthReview(botId: string) {
    this.growthRunner.cancel(botId);
    this.store.advanceGrowthEpoch(botId);
  }
  undoGrowthReview(botId: string, reviewId: string) {
    this.growthRunner.undo(botId, reviewId);
    return this.view(botId);
  }
  /** Settle a finished match once. Returns the recap to post, or undefined when nothing is posted. */
  settle(match: PersonaMatch, options?: { replayReport?: boolean }): string | undefined {
    const seatOrder = match.seats.map((seat) => seat.id);
    // Matches retain their original seats after a Bot is deleted. Do not let a
    // delayed settlement restore that member in anyone's persistent memories.
    match = {
      ...match,
      seats: match.seats.filter((seat) => !this.store.isForgotten(seat.human ? 'user' : seat.botId || '')),
    };
    if (!match.seats.some((s) => s.botId)) return undefined;
    const result = settleMatch(match);
    if (!result) return undefined;
    return this.store.transaction(() => {
      const at = this.now();
      if (!this.store.claimMatch(match.id, at)) return options?.replayReport ? result.recap : undefined;
      for (const a of result.affinity) this.store.addAffinity({ ...a, createdAt: at });
      for (const h of result.highlights)
        this.store.addHighlight({ ...h, scope: 'match', sourceId: match.id, groupId: match.groupId, createdAt: at });
      this.grow(match, at, seatOrder);
      return result.recap;
    });
  }

  /**
   * A message aimed at this Bot changed how it feels about the sender (群聊人格方案 §3.6). Adds one decaying modifier;
   * the same kind of event between the same two members counts once a day. A new offence while a grudge is still
   * running extends that grudge once by half (rumination slows forgiveness); an apology halves what is left of
   * every running grudge towards the sender. Insults, offences, help and apologies are also remembered with the
   * sender's words, so the Bot can bring them up later.
   */
  appraise(e: {
    botId: string;
    actorId: string;
    actorName: string;
    appraisal: Appraisal;
    quote: string;
    groupId: string;
    sourceId: string;
  }) {
    if (e.botId === e.actorId || this.store.isForgotten(e.botId) || this.store.isForgotten(e.actorId)) return;
    const traits = this.store.profile(e.botId)?.traits || NEUTRAL;
    const change = appraisalModifier(e.appraisal, traits);
    if (!change) return;
    const type = e.appraisal.type as Exclude<AppraisalType, 'none'>;
    const at = this.now();
    const held = this.store.affinity(e.botId, e.actorId);
    if (held.some((m) => m.source.startsWith(`chat:${type}:`) && m.createdAt >= dayStart(at))) return;
    const running = held.filter((m) => m.value < 0 && m.createdAt + m.durationDays * DAY > at);
    this.store.transaction(() => {
      if (change.value < 0) {
        const last = running.filter((m) => !m.source.endsWith(':ruminated')).at(-1);
        if (last) this.store.updateAffinity(last.id, last.durationDays * 1.5, last.source + ':ruminated');
      }
      if (type === 'apology')
        for (const m of running) {
          const left = m.createdAt + m.durationDays * DAY - at;
          this.store.updateAffinity(m.id, (at - m.createdAt + left / 2) / DAY, m.source);
        }
      this.store.addAffinity({
        botId: e.botId,
        targetId: e.actorId,
        value: change.value,
        durationDays: change.durationDays,
        createdAt: at,
        source: `chat:${type}:${e.sourceId}`,
      });
      if (type !== 'thanks' && type !== 'argument')
        this.store.addHighlight({
          botId: e.botId,
          participants: [e.actorId],
          // The human without a display name is shown as 你 in the group; in the Bot's own memory that would read 「你骂了你」.
          summary: `${e.actorName === '你' ? '用户' : e.actorName}${APPRAISAL_KINDS[type].verb}：「${e.quote.slice(0, 40)}${e.quote.length > 40 ? '…' : ''}」`,
          type: `chat_${type}`,
          scope: 'group',
          sourceId: e.sourceId,
          groupId: e.groupId,
          createdAt: at,
        });
    });
    return change;
  }
  /** Remember factual episodes; only legacy experiences use outcome-based growth. Remember the opening plan too. */
  private grow(match: PersonaMatch, at: number, seatOrder: string[]) {
    if (!match.persona) return;
    const experiences = matchExperiences(match.seats, match.decisions || [], match.events, seatOrder);
    for (const [seatId, sp] of Object.entries(match.persona)) {
      const p = this.store.profile(sp.botId);
      if (!p) continue;
      const seat = match.seats.find((s) => s.id === seatId);
      if (seat && sp.plan) p.lastPlans = { ...p.lastPlans, [planRole(seat.role)]: sp.plan.id };
      const mine = experiences.filter((e) => e.botId === sp.botId);
      let growthCount = 0;
      for (const e of mine) {
        const recordOnly = e.growthDisposition === 'record_only';
        if (p.locked && !recordOnly) continue;
        // Do not call growthStep for record-only facts: even a zero reward would pull traits toward the anchor.
        const delta: Traits = recordOnly
          ? { E: 0, A: 0, C: 0, N: 0, O: 0 }
          : growthStep(p.traits, p.anchor, p.n, e, 'game', this.store.movedSince(p.botId, 'game', dayStart(at)));
        if (!recordOnly) {
          p.traits = roundTraits(Object.fromEntries(TRAITS.map((k) => [k, clip(p.traits[k] + delta[k])])) as Traits);
          p.n++;
          growthCount++;
        }
        this.store.addEpisode({
          botId: p.botId,
          scope: 'game',
          sourceId: match.id,
          kind: e.kind,
          summary: e.summary,
          s: e.s,
          o: e.o,
          delta,
          createdAt: at,
        });
      }
      p.updatedAt = at;
      this.store.saveProfile(p);
      if (growthCount) this.store.addHistory(p.botId, p.traits, `对局 ${growthCount} 次成长结算`, at);
    }
  }
  /**
   * The Bot's profile, created on first use. Without one, the draft comes from the MBTI the seat was given (the user's
   * preset or the engine's random draw), so Bots stay different from each other; the user confirms it later.
   */
  ensureProfile(botId: string, mbti?: string): PersonaProfile {
    if (this.store.isForgotten(botId)) throw Error('Bot 的人格档案已删除');
    const existing = this.store.profile(botId);
    if (existing) return existing;
    const p = this.draftProfile(botId, mbti);
    this.store.saveProfile(p);
    this.store.addHistory(botId, p.traits, mbti ? `由 ${mbti} 生成初稿` : '默认初稿', p.createdAt);
    return p;
  }
  /** The profile a Bot would start with, without saving it: looking at the page must not freeze an unplayed draft. */
  private draftProfile(botId: string, mbti?: string): PersonaProfile {
    const traits = mbti ? traitsFromMbti(mbti) : { ...NEUTRAL },
      at = this.now();
    return {
      botId,
      traits,
      anchor: { ...traits },
      n: 0,
      locked: false,
      source: 'mbti',
      confirmed: false,
      lastPlans: {},
      createdAt: at,
      updatedAt: at,
    };
  }
  /** Seeds for a new match (§9.2): traits, last plans for f_explore, and affinity towards everyone at the table. */
  seeds(bots: { botId: string; mbti?: string }[], members: string[]): Record<string, PersonaSeed> {
    const out: Record<string, PersonaSeed> = {};
    for (const b of bots) {
      const p = this.ensureProfile(b.botId, b.mbti);
      const affinity: Record<string, number> = {};
      for (const m of members) if (m !== b.botId) affinity[m] = this.affinity(b.botId, m, p.traits.N);
      out[b.botId] = { traits: p.traits, lastPlans: p.lastPlans, affinity };
    }
    return out;
  }
  view(botId: string, mbti?: string): PersonaView {
    const profile = this.store.profile(botId) || this.draftProfile(botId, mbti);
    return {
      profile,
      mbti: mbtiOf(profile.traits),
      history: this.store.history(botId),
      episodes: this.store.episodes(botId),
      relations: this.store
        .affinityTargets(botId)
        .map((id) => ({ id, affinity: this.affinity(botId, id, profile.traits.N) }))
        .filter((r) => Math.abs(r.affinity) >= 0.01)
        .sort((a, b) => Math.abs(b.affinity) - Math.abs(a.affinity)),
      highlights: this.store.recentHighlights(botId),
      growthReview: this.growthRunner.state(botId),
    };
  }
  /** The user sets the birth personality: both the current value and the anchor move, and growth restarts from it. */
  setTraits(botId: string, traits: Traits, source: PersonaProfile['source'] = 'user', facets?: Record<string, number>) {
    if (
      !traits ||
      TRAITS.some((k) => typeof traits[k] !== 'number' || !Number.isFinite(traits[k]) || traits[k] < 0 || traits[k] > 1)
    )
      throw Error('人格数值无效');
    const t = roundTraits(traits);
    const p = this.ensureProfile(botId);
    this.cancelGrowthReview(botId);
    this.store.transaction(() => {
      this.store.discardGrowthObservations(botId);
      const at = this.now();
      Object.assign(p, { traits: t, anchor: { ...t }, n: 0, source, confirmed: source === 'user', updatedAt: at });
      // Facets describe the estimate they came from; a hand-set profile no longer matches them.
      if (facets) p.facets = facets;
      else delete p.facets;
      this.store.saveProfile(p);
      this.store.addHistory(botId, t, source === 'user' ? '手动设定' : '角色设定估计', at);
    });
    return this.view(botId);
  }
  /**
   * Ask the model for a role-setting estimate using BFI-2 definitions from SOUL.md (§8.1). One call, made only when the user asks for it. The draft is
   * not confirmed until the user saves it, and is refused once the Bot has grown, so experience is never overwritten.
   */
  async draft(botId: string, name: string, soul: string, ask: (system: string, user: string) => Promise<string>) {
    const p = this.ensureProfile(botId);
    if (p.n > 0) throw Error('已有成长记录，请先重置成长再重新估计');
    this.cancelGrowthReview(botId);
    const epoch = this.store.growthEpoch(botId);
    const prompt = birthPrompt(name, soul);
    const { traits, facets } = facetsFrom(await ask(prompt.system, prompt.user));
    const current = this.store.profile(botId);
    if (!current || current.n > 0 || this.store.growthEpoch(botId) !== epoch) throw Error('人格已改变，请重新发起估计');
    return this.setTraits(botId, traits, 'bfi2', facets);
  }
  /**
   * Every group member gets a personality (群聊人格方案 §3.1): a Bot without a profile gets a SOUL estimate, left
   * unconfirmed for the user to adjust. Without a working model it keeps the neutral draft. Runs once per Bot.
   */
  async ensureGroupProfiles(
    bots: { id: string; name: string; soul: string }[],
    ask: (botId: string, system: string, user: string) => Promise<string>,
  ) {
    for (const b of bots) {
      if (this.store.profile(b.id) || this.store.isForgotten(b.id) || this.estimating.has(b.id)) continue;
      this.estimating.add(b.id);
      try {
        await this.draft(b.id, b.name, b.soul, (system, user) => ask(b.id, system, user));
      } catch {
        // The neutral draft draft() saved first stays; the user can estimate again from the profile page.
      } finally {
        this.estimating.delete(b.id);
      }
    }
  }
  /** Accept the draft as this Bot's birth personality. */
  confirm(botId: string, mbti?: string) {
    const p = this.ensureProfile(botId, mbti);
    // A late SOUL estimate must not replace the birth settings the user just accepted.
    this.cancelGrowthReview(botId);
    Object.assign(p, { confirmed: true, updatedAt: this.now() });
    this.store.saveProfile(p);
    return this.view(botId);
  }
  setLocked(botId: string, locked: boolean, mbti?: string) {
    const p = this.ensureProfile(botId, mbti);
    this.cancelGrowthReview(botId);
    p.locked = locked;
    p.updatedAt = this.now();
    this.store.saveProfile(p);
    if (!locked) this.growthRunner.consider(botId);
    return this.view(botId);
  }
  /** Undo all growth: back to the anchor, experience count to zero. Relationships and memories stay. */
  resetGrowth(botId: string) {
    const p = this.ensureProfile(botId);
    this.cancelGrowthReview(botId);
    this.store.transaction(() => {
      const at = this.now();
      Object.assign(p, { traits: { ...p.anchor }, n: 0, updatedAt: at });
      this.store.resetGrowth(botId);
      this.store.discardGrowthObservations(botId);
      this.store.saveProfile(p);
      this.store.addHistory(botId, p.traits, '重置成长', at);
    });
    return this.view(botId);
  }
  affinity(botId: string, targetId: string, n = this.store.profile(botId)?.traits.N ?? DEFAULT_N) {
    return affinityScore(this.store.affinity(botId, targetId), this.now(), n);
  }
  /**
   * Persona lines for one group reply (§10.4): how this Bot regards the people in the conversation, and at most one
   * shared experience with them that was not recalled in the last 7 days. Empty when there is nothing to say.
   */
  /**
   * How this Bot's personality shapes what it says in a group (docs/ai-personality-module.md §10.4): the same
   * expression guidance its game seats get, and a stance on agreeing. Only for Bots with a saved profile; a draft
   * is never invented here. Group chats only: private chats keep the original SOUL (§D.14).
   */
  groupStyle(botId: string) {
    const p = this.store.profile(botId);
    if (!p) return '';
    const conform = tendencies(p.traits).conform;
    const stance =
      conform < -0.3
        ? '\n立场：不同意就直接说出来，不必为了和气附和。'
        : conform > 0.3
          ? '\n立场：同意别人时要补充新的信息或理由，不要只说「同意」。'
          : '';
    return '\n\n[你的说话方式，来自你的性格设定]\n' + styleText(p.traits) + '。' + stance;
  }
  groupFragment(botId: string, people: { id: string; name: string }[]) {
    const others = people.filter((p) => p.id !== botId).slice(0, 2);
    if (!others.length) return '';
    const lines: string[] = [];
    for (const p of others) {
      const word = affinityWord(this.affinity(botId, p.id));
      if (word) lines.push(`你和${p.name}的关系${word}。`);
    }
    const now = this.now();
    const memory = this.store
      .highlightsWith(
        botId,
        others.map((p) => p.id),
      )
      .find((h) => !h.lastUsedAt || now - h.lastUsedAt >= HIGHLIGHT_COOLDOWN_DAYS * DAY);
    if (memory) {
      this.store.markUsed(memory.id, now);
      lines.push(`你们之间发生过的事（可以自然地提起，不必每次都提；只说这里写的内容）：${memory.summary}。`);
    }
    return lines.length ? '\n\n[你的关系与记忆，仅供参考]\n' + lines.join('\n') : '';
  }
  forget(memberId: string) {
    this.store.transaction(() => this.store.forget(memberId));
    this.growthRunner.forget(memberId);
  }
  close() {
    this.growthRunner.close();
    this.store.close();
  }
}
