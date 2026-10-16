import { PersonaStore, type AffinityModifier, type PersonaProfile } from './persona-store';
import type { PersonaView } from '../../../shared/types/persona-types';
import type { GrowthObservation } from '../../../shared/types/persona-growth-types';
import { GrowthRunner, type GrowthReviewerHooks } from './growth-runner';
import { settleMatch } from './settle';
import type { MatchFacts } from './match-facts';
import { APPRAISAL_KINDS, appraisalModifier, contentWeight, type Appraisal, type AppraisalType } from './appraisal';
import { birthPrompt, facetsFrom } from './birth';
import { PRESETS, contentText, isPresetId } from '../../../shared/persona/presets';
import { GRUDGE, bondOf, grudgeConduct, relationsText, sourceIdOf } from './relations';
import { reminderFor, speechPlan, usedCatchphrase, type JudgeInput, type SpeechMemory, type Verdict } from './speech';
import {
  NEUTRAL,
  TRAITS,
  clip,
  growthStep,
  mbtiOf,
  roundTraits,
  styleText,
  tendencies,
  traitsFromMbti,
  type Traits,
} from '../../../shared/persona/persona-model';
import type { PersonaSeed } from '../games/persona-play';

const DAY = 86_400_000;
/** Neutral neuroticism for Bots without a profile (§11.2). */
const DEFAULT_N = 0.5;
const HIGHLIGHT_COOLDOWN_DAYS = 7;
/** Turns after a relationship event during which every reply is checked for staying in character. */
const EVENT_TURNS = 3;
/** A Bot with a preset has one in this many replies checked for its voice. */
const VOICE_EVERY = 5;
/** The share of all other replies checked, to measure how often Bots drift. */
const SAMPLE_RATE = 0.02;

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

const dayStart = (t: number) => t - (t % DAY);

export class PersonaService {
  readonly store: PersonaStore;
  private growthRunner: GrowthRunner;
  private estimating = new Set<string>();
  // Per-session speech state. Losing it on restart only resets catchphrase pacing and pending reminders.
  private speech = new Map<string, SpeechMemory>();
  private eventTurns = new Map<string, number>();
  private spoken = new Map<string, number>();
  /** By Bot and group: a reminder names people of the group it came from. */
  private reminders = new Map<string, string>();
  constructor(
    dir: string,
    private now: () => number = Date.now,
    private random: () => number = Math.random,
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
  settle(match: MatchFacts, options?: { replayReport?: boolean }): string | undefined {
    // Matches retain their original seats after a Bot is deleted. Do not let a
    // delayed settlement restore that member in anyone's persistent memories.
    const seats = match.seats.filter((seat) => !this.store.isForgotten(seat.human ? 'user' : seat.botId || ''));
    const present = new Set(seats.map((seat) => seat.id));
    match = { ...match, seats, experiences: match.experiences.filter((e) => e.seats.every((id) => present.has(id))) };
    if (!match.seats.some((s) => s.botId)) return undefined;
    const result = settleMatch(match);
    if (!result) return undefined;
    return this.store.transaction(() => {
      const at = this.now();
      if (!this.store.claimMatch(match.id, at)) return options?.replayReport ? result.recap : undefined;
      for (const a of result.affinity) this.store.addAffinity({ ...a, createdAt: at });
      for (const h of result.highlights)
        this.store.addHighlight({ ...h, scope: 'match', sourceId: match.id, groupId: match.groupId, createdAt: at });
      this.grow(match, at);
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
    const profile = this.store.profile(e.botId);
    const base = appraisalModifier(e.appraisal, profile?.traits || NEUTRAL);
    if (!base) return;
    const type = e.appraisal.type as Exclude<AppraisalType, 'none'>;
    const weighted = base.value * contentWeight(type, base.value, profile || {}, e.actorId);
    const change = { ...base, value: Math.round(Math.max(-1, Math.min(1, weighted)) * 1000) / 1000 };
    if (!change.value) return;
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
      // Being talked round shortens grudges towards everyone else a little: a tenth of what is left, up to
      // four tenths for the most agreeable. It never ends one; only an apology from the offender halves it.
      if (type === 'mediation') {
        const ease = 0.1 + 0.3 * (profile?.traits.A ?? NEUTRAL.A);
        for (const other of this.store.affinityTargets(e.botId).filter((id) => id !== e.actorId))
          for (const m of this.store.affinity(e.botId, other)) {
            const left = m.createdAt + m.durationDays * DAY - at;
            if (m.value < 0 && left > 0)
              this.store.updateAffinity(m.id, (at - m.createdAt + left * (1 - ease)) / DAY, m.source);
          }
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
    if (type !== 'thanks' && type !== 'help') this.eventTurns.set(e.botId, EVENT_TURNS);
    return change;
  }
  /** Remember factual episodes; only legacy experiences use outcome-based growth. Remember the opening plan too. */
  private grow(match: MatchFacts, at: number) {
    if (!match.persona) return;
    const experiences = match.experiences;
    for (const [seatId, sp] of Object.entries(match.persona)) {
      // A preset chosen for one match was not this Bot being itself, so it neither grows nor sets its plans.
      if (sp.preset) continue;
      const p = this.store.profile(sp.botId);
      if (!p) continue;
      const seat = match.seats.find((s) => s.id === seatId);
      if (seat?.planKey && sp.plan) p.lastPlans = { ...p.lastPlans, [seat.planKey]: sp.plan.id };
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
      const voice = contentText(p, () => undefined, 'rate').trim();
      out[b.botId] = { traits: p.traits, lastPlans: p.lastPlans, affinity, ...(voice ? { voice } : {}) };
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
        .map((id) => {
          const bond = this.bond(botId, id);
          return {
            id,
            affinity: this.affinity(botId, id, profile.traits.N),
            closeness: Math.round(bond.closeness * 1000) / 1000,
            grudge: Math.round(bond.grudge * 1000) / 1000,
          };
        })
        // Good and bad can cancel out in the net value; a grudge still shows.
        .filter((r) => Math.abs(r.affinity) >= 0.01 || r.closeness >= 0.01 || r.grudge >= 0.01)
        .sort((a, b) => Math.max(Math.abs(b.affinity), b.grudge) - Math.max(Math.abs(a.affinity), a.grudge)),
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
      // Hand-set or re-estimated traits no longer match the preset's name; its learned contents stay.
      if (source !== 'preset') delete p.preset;
      this.store.saveProfile(p);
      this.store.addHistory(
        botId,
        t,
        source === 'user' ? '手动设定' : source === 'preset' ? '应用预设' : '角色设定估计',
        at,
      );
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
  /**
   * Give this Bot a named preset (群聊人格方案 §4.6): its traits become the birth personality and its learned
   * contents are set to the preset's. An empty id clears the preset's contents and keeps the traits.
   * Experience keeps changing both afterwards unless growth is locked.
   */
  applyPreset(botId: string, id: string, focus?: string) {
    if (!id) {
      const p = this.ensureProfile(botId);
      for (const k of ['preset', 'motives', 'selfView', 'strategies', 'expression', 'focus'] as const) delete p[k];
      p.updatedAt = this.now();
      this.store.saveProfile(p);
      return this.view(botId);
    }
    if (!isPresetId(id)) throw Error('未知的人格预设');
    const preset = PRESETS[id];
    this.setTraits(botId, preset.traits, 'preset');
    const p = this.store.profile(botId)!;
    Object.assign(p, {
      preset: id,
      confirmed: true,
      motives: preset.motives,
      selfView: preset.selfView,
      strategies: preset.strategies,
      expression: preset.expression,
      ...(preset.focus ? { focus: focus || preset.focus } : {}),
    });
    if (!preset.focus) delete p.focus;
    this.store.saveProfile(p);
    return this.view(botId);
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
  groupStyle(
    botId: string,
    nameOf: (id: string) => string | undefined = () => undefined,
    members: { id: string; name: string }[] = [],
  ) {
    const p = this.store.profile(botId);
    const relations = this.relationsText(botId, members);
    if (!p) return relations;
    const conform = tendencies(p.traits).conform;
    const stance =
      conform < -0.3
        ? '\n立场：不同意就直接说出来，不必为了和气附和。'
        : conform > 0.3
          ? '\n立场：同意别人时要补充新的信息或理由，不要只说「同意」。'
          : '';
    return (
      '\n\n[你的说话方式，来自你的性格设定]\n' +
      styleText(p.traits) +
      '。' +
      stance +
      contentText(p, nameOf) +
      relations
    );
  }
  bond(botId: string, targetId: string) {
    return bondOf(this.store.affinity(botId, targetId), this.now(), this.store.profile(botId)?.traits.N ?? DEFAULT_N);
  }
  /** Every other member's relationship with this Bot, with the remembered reason for a grudge. */
  private relationsText(botId: string, members: { id: string; name: string }[]) {
    const others = members.filter((m) => m.id !== botId && !this.store.isForgotten(m.id));
    const lines = others.map((m) => {
      const bond = this.bond(botId, m.id);
      const hurtFrom = bond.hurt && sourceIdOf(bond.hurt);
      const cause =
        bond.grudge >= GRUDGE && hurtFrom
          ? this.store.highlightsWith(botId, [m.id]).find((h) => h.sourceId === hurtFrom)?.summary
          : undefined;
      // The human without a display name is 你 in the group, which reads as the Bot itself here.
      return { name: m.name === '你' ? '用户' : m.name, bond, ...(cause ? { cause } : {}) };
    });
    const p = this.store.profile(botId);
    return relationsText(lines, grudgeConduct(p || {}, p?.traits || NEUTRAL));
  }
  /**
   * What changes from turn to turn: one shared memory with the people in this message that was not recalled in
   * the last 7 days, this turn's speech plan, and a reminder left by the last character check.
   */
  groupFragment(botId: string, people: { id: string; name: string }[], groupId = '') {
    const others = people.filter((p) => p.id !== botId).slice(0, 2);
    const parts: string[] = [];
    const now = this.now();
    const memory = this.store
      .highlightsWith(
        botId,
        others.map((p) => p.id),
      )
      .find((h) => !h.lastUsedAt || now - h.lastUsedAt >= HIGHLIGHT_COOLDOWN_DAYS * DAY);
    if (memory) {
      this.store.markUsed(memory.id, now);
      parts.push(
        `\n\n[想起的事]\n你们之间发生过的事（可以自然地提起，不必每次都提；只说这里写的内容）：${memory.summary}。`,
      );
    }
    const p = this.store.profile(botId);
    if (p) parts.push(speechPlan(p, this.speech.get(botId) || { used: [] }, this.random));
    const reminder = this.reminders.get(`${botId}:${groupId}`);
    if (reminder) {
      this.reminders.delete(`${botId}:${groupId}`);
      parts.push(`\n\n${reminder}`);
    }
    return parts.join('');
  }
  /**
   * A reply this Bot published. Records its catchphrase for pacing, and returns what to check when this turn is
   * one worth checking, decided in code: someone it resents is involved, a relationship event happened in the
   * last few turns, one in five turns of a preset's voice, or a small random sample. Undefined otherwise.
   */
  spoke(botId: string, text: string, people: { id: string; name: string }[]): JudgeInput | undefined {
    const p = this.store.profile(botId);
    if (!p || !text.trim()) return undefined;
    const memory = this.speech.get(botId) || { used: [] };
    memory.used = [...memory.used, usedCatchphrase(p, text)].slice(-12);
    this.speech.set(botId, memory);
    const count = (this.spoken.get(botId) || 0) + 1;
    this.spoken.set(botId, count);
    const turns = this.eventTurns.get(botId) || 0;
    if (turns) this.eventTurns.set(botId, turns - 1);
    const others = people.filter((x) => x.id !== botId);
    const bonds = others.map((x) => ({ ...x, bond: this.bond(botId, x.id) }));
    const key =
      bonds.some((x) => x.bond.grudge >= GRUDGE) ||
      turns > 0 ||
      (!!p.preset && count % VOICE_EVERY === 0) ||
      this.random() < SAMPLE_RATE;
    if (!key) return undefined;
    return {
      speaker: p.preset ? PRESETS[p.preset].name : '这个成员',
      persona: contentText(p, () => undefined).trim() || styleText(p.traits),
      relations: this.relationsText(botId, others).trim() || '没有特别的关系',
      reply: text.slice(0, 600),
    };
  }
  /** Leave a reminder for the next turn when a check found the reply out of character. */
  judged(botId: string, verdict: Verdict, people: { id: string; name: string }[], groupId = '') {
    const resented = people
      .filter((x) => x.id !== botId)
      .filter((x) => {
        const b = this.bond(botId, x.id);
        return b.grudge >= GRUDGE && !b.apologized;
      })
      .map((x) => x.name);
    // A Bot without catchphrases or habits has no voice to return to; telling it to would make it invent some.
    const voiced = !!contentText(this.store.profile(botId) || {}, () => undefined).trim();
    const reminder = verdict === 'out_of_voice' && !voiced ? '' : reminderFor(verdict, resented);
    if (reminder) this.reminders.set(`${botId}:${groupId}`, reminder);
    else if (verdict === 'ok') this.reminders.delete(`${botId}:${groupId}`);
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
