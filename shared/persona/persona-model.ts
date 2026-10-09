/**
 * The persona model (docs/ai-personality-module.md §8). Pure functions shared by the main process and the profile UI.
 * Domain meanings follow BFI-2 (see persona-semantics.ts). The [0, 1] settings, derived tendencies (§8.2),
 * weak-situation choice (§8.3), and growth (§8.4) are engineering hypotheses, not validated BFI-2 algorithms.
 * Nothing here calls a model or touches storage.
 */
import type { GameAction, GameRequest, GameRole } from '../types/game-types';
import type { SeededRandom } from '../games/seeded-random';
import { TRAIT_SEMANTICS } from './persona-semantics';

export const TRAITS = ['E', 'A', 'C', 'N', 'O'] as const;
export type Trait = (typeof TRAITS)[number];
export type Traits = Record<Trait, number>;
export const TENDENCIES = [
  'talk',
  'assert',
  'risk',
  'conform',
  'vengeance',
  'cooperate',
  'persist',
  'explore',
] as const;
export type Tendency = (typeof TENDENCIES)[number];
export type Features = Partial<Record<Tendency, number>>;

export const NEUTRAL: Traits = { E: 0.5, A: 0.5, C: 0.5, N: 0.5, O: 0.5 };
/**
 * ∂tendency/∂trait for d = f(2x − 1) (§8.2). Constant because every tendency is linear in the centred traits;
 * the factor 2 comes from the centring.
 */
export const JACOBIAN: Record<Tendency, Partial<Traits>> = {
  talk: { E: 2 },
  assert: { E: 2 },
  risk: { E: 2 / 5, O: 2 / 5, N: -2 / 5, A: -2 / 5, C: -2 / 5 },
  conform: { A: 2 / 3, C: 2 / 3, N: -2 / 3 },
  vengeance: { N: 1, A: -1 },
  cooperate: { A: 2 },
  persist: { C: 2 },
  explore: { O: 2 },
};
const c = (x: number) => 2 * x - 1;
export function tendencies(t: Traits): Record<Tendency, number> {
  return {
    talk: c(t.E),
    assert: c(t.E),
    risk: (c(t.E) + c(t.O) - c(t.N) - c(t.A) - c(t.C)) / 5,
    conform: (c(t.A) + c(t.C) - c(t.N)) / 3,
    vengeance: (c(t.N) - c(t.A)) / 2,
    cooperate: c(t.A),
    persist: c(t.C),
    explore: c(t.O),
  };
}
export const clip = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const roundTraits = (t: Traits): Traits =>
  Object.fromEntries(TRAITS.map((k) => [k, Math.round(t[k] * 1000) / 1000])) as Traits;

/**
 * Heuristic display label (§8.6): E/I ← E, N/S ← O, F/T ← A, J/P ← C, suffix ← N.
 * Correlations between inventories do not validate this threshold conversion. The -A/-T suffix comes from
 * 16Personalities, not traditional MBTI. This function does not perform a personality assessment.
 */
export function mbtiOf(t: Traits) {
  return (
    (t.E >= 0.5 ? 'E' : 'I') +
    (t.O >= 0.5 ? 'N' : 'S') +
    (t.A >= 0.5 ? 'F' : 'T') +
    (t.C >= 0.5 ? 'J' : 'P') +
    (t.N >= 0.5 ? '-T' : '-A')
  );
}
/**
 * Birth draft from an MBTI preset, the inverse of the mapping above. Each letter moves its domain to 0.3 or 0.7,
 * not to the extremes: McCrae & Costa report correlations of about 0.4–0.7, so a letter is weak evidence of level.
 * MBTI has no neuroticism scale, so N stays neutral. The user confirms or adjusts the draft on the profile page.
 */
export function traitsFromMbti(type: string): Traits {
  const has = (x: string) => type.toUpperCase().includes(x);
  return {
    E: has('E') ? 0.7 : 0.3,
    O: has('N') ? 0.7 : 0.3,
    A: has('F') ? 0.7 : 0.3,
    C: has('J') ? 0.7 : 0.3,
    N: 0.5,
  };
}

/* ------------------------------------------------------------------ opening plans (§9.2) */

export type PlanRole = 'wolf' | 'seer' | 'witch' | 'villager';
export interface Plan {
  id: string;
  role: PlanRole;
  name: string;
  detail: string;
  /** Hand-labelled behaviour features (§9.2); f_explore is computed per Bot. */
  f: Features;
  /** Plans whose execution can be checked from public claims (§9.2); others never feed `persist`. */
  claims?: boolean;
}
export const PLANS: Plan[] = [
  {
    id: 'wolf_jump',
    role: 'wolf',
    name: '悍跳',
    detail: '假宣称预言家，与真预言家对跳',
    f: { risk: 1, assert: 1 },
    claims: true,
  },
  {
    id: 'wolf_deep',
    role: 'wolf',
    name: '深水',
    detail: '隐藏身份，跟随好人主流',
    f: { risk: -1, assert: -1, conform: 1 },
  },
  {
    id: 'wolf_hook',
    role: 'wolf',
    name: '倒钩',
    detail: '站边真预言家，必要时踩队友',
    f: { conform: -1, cooperate: -1 },
  },
  {
    id: 'seer_open',
    role: 'seer',
    name: '首日起跳',
    detail: '第一天白天就报出查验结果',
    f: { risk: 1, assert: 1 },
    claims: true,
  },
  { id: 'seer_hide', role: 'seer', name: '暂藏', detail: '先不公开身份，视局势再报查验', f: { risk: -1, assert: -1 } },
  {
    id: 'witch_open',
    role: 'witch',
    name: '明示身份',
    detail: '公开用药信息，带领好人',
    f: { risk: 1, assert: 1 },
    claims: true,
  },
  { id: 'witch_hide', role: 'witch', name: '隐藏身份', detail: '不公开身份和用药', f: { risk: -1, assert: -1 } },
  {
    id: 'villager_lead',
    role: 'villager',
    name: '积极分析',
    detail: '主动点名、推动投票',
    f: { assert: 1, conform: -1 },
  },
  {
    id: 'villager_follow',
    role: 'villager',
    name: '跟随判断',
    detail: '听取神职信息后跟票',
    f: { assert: -1, conform: 1 },
  },
];
/** Hunter, guard and idiot play as villagers for the opening plan; their key decisions are handled per request. */
export const planRole = (role: GameRole): PlanRole =>
  role === 'wolf' || role === 'seer' || role === 'witch' ? role : 'villager';
/* ------------------------------------------------------------------ weak-situation choice (§8.3) */

/** Choice weights; these are product parameters, not psychological constants. */
export const CHOICE_PARAMETERS = { rankPenalty: 1.0, temperature: 0.3 } as const;
const RHO = CHOICE_PARAMETERS.rankPenalty;
const TAU = CHOICE_PARAMETERS.temperature;
const fit = (d: Record<Tendency, number>, f: Features) => TENDENCIES.reduce((sum, k) => sum + d[k] * (f[k] || 0), 0);
export interface Option<T> {
  value: T;
  f: Features;
  /** Model order, 0 for its first choice; plans have no model order. */
  rank: number;
}
export interface Pick<T> {
  value: T;
  index: number;
  /** Probability of the chosen option. */
  prob: number;
  probs: number[];
  fits: number[];
}
/** Softmax over u = fit − ρ·rank. Sampling, not argmax: traits are distributions of states (Fleeson, 2001). */
export function choose<T>(traits: Traits, options: Option<T>[], random: SeededRandom): Pick<T> {
  const d = tendencies(traits),
    fits = options.map((o) => fit(d, o.f)),
    u = options.map((o, i) => (fits[i] - RHO * o.rank) / TAU),
    max = Math.max(...u),
    w = u.map((x) => Math.exp(x - max)),
    total = w.reduce((a, b) => a + b, 0),
    probs = w.map((x) => x / total);
  let x = random.next(),
    index = 0;
  while (index < probs.length - 1 && (x -= probs[index]) >= 0) index++;
  return { value: options[index].value, index, prob: probs[index], probs, fits };
}

/* ------------------------------------------------------------------ key-decision features (§8.3 table) */

/** Model-supplied alternatives for a key decision (§9.4). The first is the model's own pick. */
export interface Candidate {
  semantic?: import('./persona-assessment').CandidateSemantic;
  target?: string;
  potion?: 'save' | 'poison' | 'skip';
  choice?: boolean;
  skip?: boolean;
  reasonable?: boolean;
  decisive?: boolean;
}
/** Requests where personality may choose among reasonable candidates (§8.3). */
export const KEY_DECISIONS: GameRequest['kind'][] = [
  'vote',
  'sheriff_vote',
  'shoot',
  'witch',
  'badge',
  'sheriff_join',
  'withdraw',
];
export interface DecisionContext {
  kind: GameRequest['kind'];
  /** Seats the actor knows are on its own side (wolf teammates; empty for the village). */
  allies: string[];
  /** Seat most nominated in today's public speeches, if any (§8.3 f_conform). */
  nominated?: string;
  /** Affinity of the actor's Bot towards the Bot in each seat, −1..1. */
  affinity: Record<string, number>;
  /** The plan's assert sign for sheriff decisions: +1 when the plan says join, −1 when it says stay out. */
  planAssert?: number;
}
export const sameAction = (a: Candidate, b: Candidate) =>
  (a.target || undefined) === (b.target || undefined) &&
  (a.potion || undefined) === (b.potion || undefined) &&
  a.choice === b.choice &&
  Boolean(a.skip) === Boolean(b.skip);
export const toAction = (a: Candidate, base: GameAction): GameAction => ({
  ...base,
  target: a.skip ? undefined : a.target,
  potion: a.potion,
  choice: a.choice,
  skip: a.skip,
});

/* ------------------------------------------------------------------ growth (§8.4) */

const GROWTH_PARAMETERS = { initialRate: 0.02, experienceScale: 50, anchorPull: 0.005 } as const;
const ETA0 = GROWTH_PARAMETERS.initialRate;
const K = GROWTH_PARAMETERS.experienceScale;
const THETA = GROWTH_PARAMETERS.anchorPull;
export const DAILY_CAP = { game: 0.02, chat: 0.003 } as const;
export type Scope = keyof typeof DAILY_CAP;
export interface Experience {
  /** The expressed behaviour's features s. */
  s: Features;
  /** Direct reaction to that behaviour; ±1 for votes, structural-baseline-corrected and ×2 for sheriff and claims. */
  o: number;
}
/**
 * Experimental product rule: Δtrait = η·Jᵀ·(r·s) − θ(trait − trait0), r = o·E for rewards and o·N for punishments.
 * TESSERA does not specify or validate this numerical update. Retained for legacy experience settlement.
 * `used` is how much each trait already moved today in this scope; the returned delta respects the daily cap.
 */
export function growthStep(
  trait: Traits,
  anchor: Traits,
  n: number,
  e: Experience,
  scope: Scope,
  used: Partial<Traits> = {},
): Traits {
  const eta = ETA0 / (1 + n / K),
    r = e.o * (e.o > 0 ? trait.E : trait.N),
    cap = DAILY_CAP[scope];
  const delta = {} as Traits;
  for (const k of TRAITS) {
    let push = 0;
    for (const d of TENDENCIES) push += (JACOBIAN[d][k] || 0) * r * (e.s[d] || 0);
    const raw = eta * push - THETA * (trait[k] - anchor[k]),
      room = Math.max(0, cap - Math.abs(used[k] || 0));
    delta[k] = clip(raw, -room, room);
    if (trait[k] + delta[k] > 1) delta[k] = 1 - trait[k];
    if (trait[k] + delta[k] < 0) delta[k] = -trait[k];
  }
  return delta;
}

/* ------------------------------------------------------------------ expression (§8.5) */

/** Speech length cap: base × (0.6 + 0.8·E). Extraverts talk more (Mehl et al., 2006). */
export const speechLimit = (t: Traits, base = 150) => Math.round(base * (0.6 + 0.8 * t.E));
export function styleText(t: Traits) {
  const parts = [`发言不超过 ${speechLimit(t)} 字`];
  for (const k of TRAITS) {
    const domain = TRAIT_SEMANTICS[k];
    if (t[k] >= 0.65) parts.push(`${domain.name}：${domain.expression[1]}`);
    else if (t[k] <= 0.35) parts.push(`${domain.name}：${domain.expression[0]}`);
  }
  parts.push(
    '这些是表达倾向，需结合当前情境；不由性格推断能力、立场或具体对象的可信度。友善不要求附和，坚持计划允许依据新证据调整，开放不要求冒险，情绪敏感不要求报复',
  );
  return parts.join('；');
}
