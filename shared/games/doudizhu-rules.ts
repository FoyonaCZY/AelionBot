/**
 * Dou Di Zhu (斗地主) rules shared by the game mode and the table: card ranks, what a set of ranks plays as, what
 * beats what, and every legal play from a hand. Suits never matter in this game, so plays are compared by rank
 * only; card ids keep a suit for the table to draw.
 */

/** Ranks low to high. A card's value is its index here. */
export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '小王', '大王'] as const;
export type Rank = (typeof RANKS)[number];
const SUITS = ['♠', '♥', '♣', '♦'] as const;
/** Straights and chains stop at A: 2 and the jokers never join one. */
const CHAIN_TOP = RANKS.indexOf('A');
const SMALL_JOKER = RANKS.indexOf('小王'),
  BIG_JOKER = RANKS.indexOf('大王');

/** The 54 cards: 13 ranks in four suits, then the two jokers. */
export function deck() {
  const cards: string[] = [];
  for (const rank of RANKS.slice(0, 13)) for (const suit of SUITS) cards.push(suit + rank);
  cards.push('小王', '大王');
  return cards;
}
/** The rank of a card id such as ♠10 or 小王. */
export const rankOf = (card: string) => (card === '小王' || card === '大王' ? card : card.slice(1)) as Rank;
export const valueOf = (card: string) => RANKS.indexOf(rankOf(card));
export const suitOf = (card: string) => (card === '小王' || card === '大王' ? '' : card[0]);
/** Low to high, suits in a fixed order within a rank so a hand always reads the same. */
export const sortCards = (cards: string[]) =>
  [...cards].sort(
    (a, b) => valueOf(a) - valueOf(b) || SUITS.indexOf(suitOf(a) as never) - SUITS.indexOf(suitOf(b) as never),
  );

type PlayType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple_single'
  | 'triple_pair'
  | 'straight'
  | 'pair_chain'
  | 'plane'
  | 'plane_single'
  | 'plane_pair'
  | 'four_two'
  | 'four_pairs'
  | 'bomb'
  | 'rocket';
export interface Play {
  type: PlayType;
  /** Value of the deciding rank: the highest rank of a chain, the triples of a plane, the four of four-with-two. */
  main: number;
  /** Number of cards; a play only beats one of the same type and size (bombs and the rocket aside). */
  size: number;
}
const PLAY_NAMES: Record<PlayType, string> = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  triple_single: '三带一',
  triple_pair: '三带二',
  straight: '顺子',
  pair_chain: '连对',
  plane: '飞机',
  plane_single: '飞机带单',
  plane_pair: '飞机带对',
  four_two: '四带二',
  four_pairs: '四带两对',
  bomb: '炸弹',
  rocket: '王炸',
};

const counts = (values: number[]) => {
  const map = new Map<number, number>();
  for (const v of values) map.set(v, (map.get(v) || 0) + 1);
  return map;
};
/** True when values run one by one with no gap and stay at or below A. */
const consecutive = (values: number[]) =>
  values.every((v, i) => i === 0 || v === values[i - 1] + 1) && values[values.length - 1] <= CHAIN_TOP;

/** What a set of ranks plays as, or undefined when it is not a legal combination. */
export function classify(ranks: string[]): Play | undefined {
  const values = ranks.map((r) => RANKS.indexOf(r as Rank));
  if (!values.length || values.some((v) => v < 0)) return;
  values.sort((a, b) => a - b);
  const n = values.length,
    c = counts(values),
    groups = [...c].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const play = (type: PlayType, main: number): Play => ({ type, main, size: n });
  if (n === 2 && values[0] === SMALL_JOKER && values[1] === BIG_JOKER) return play('rocket', BIG_JOKER);
  if (c.size === 1) {
    if (n === 1) return play('single', values[0]);
    if (n === 2) return play('pair', values[0]);
    if (n === 3) return play('triple', values[0]);
    if (n === 4) return play('bomb', values[0]);
  }
  const [top, topCount] = groups[0];
  if (topCount === 3 && c.size === 2) {
    if (n === 4) return play('triple_single', top);
    if (n === 5 && groups[1][1] === 2) return play('triple_pair', top);
  }
  if (topCount === 4) {
    if (n === 6) return play('four_two', top);
    if (n === 8 && groups.slice(1).every(([, k]) => k === 2 || k === 4)) {
      // Two pairs may be one more four of a kind; never with the four itself counted twice.
      const rest = groups.slice(1).reduce((sum, [, k]) => sum + k, 0);
      if (rest === 4) return play('four_pairs', top);
    }
  }
  const distinct = [...c.keys()].sort((a, b) => a - b);
  if (n >= 5 && c.size === n && consecutive(distinct)) return play('straight', distinct[c.size - 1]);
  if (n >= 6 && n % 2 === 0 && [...c.values()].every((k) => k === 2) && c.size >= 3 && consecutive(distinct))
    return play('pair_chain', distinct[c.size - 1]);
  return planeOf(values, c);
}

/** A plane: two or more consecutive triples, bare, with one single per triple or with one pair per triple. */
function planeOf(values: number[], c: Map<number, number>): Play | undefined {
  const n = values.length;
  const triples = [...c].filter(([v, k]) => k >= 3 && v <= CHAIN_TOP).map(([v]) => v);
  triples.sort((a, b) => a - b);
  // Longest runs first and the highest run of a length first, so 333444555+666 reads as 444555666+3 when it can.
  for (let length = triples.length; length >= 2; length--)
    for (let start = triples.length - length; start >= 0; start--) {
      const run = triples.slice(start, start + length);
      if (!consecutive(run)) continue;
      const rest = new Map(c);
      for (const v of run) rest.set(v, rest.get(v)! - 3);
      const left = [...rest.values()].reduce((sum, k) => sum + k, 0);
      const main = run[run.length - 1];
      if (left === 0 && n === length * 3) return { type: 'plane', main, size: n };
      if (left === length && n === length * 4) return { type: 'plane_single', main, size: n };
      if (left === length * 2 && [...rest.values()].every((k) => k % 2 === 0) && n === length * 5)
        return { type: 'plane_pair', main, size: n };
    }
  return;
}

/** Whether \`next\` may be played on \`lead\`. */
export function beats(next: Play, lead: Play) {
  if (next.type === 'rocket') return true;
  if (lead.type === 'rocket') return false;
  if (next.type === 'bomb') return lead.type !== 'bomb' || next.main > lead.main;
  if (lead.type === 'bomb') return false;
  return next.type === lead.type && next.size === lead.size && next.main > lead.main;
}

export interface PlayOption {
  ranks: Rank[];
  play: Play;
  label: string;
}
/** Main ranks first, then kickers: 三带一 777+3, 飞机带单 444555+69. */
function label(play: Play, ranks: string[]) {
  const name = PLAY_NAMES[play.type];
  if (play.type === 'rocket') return name;
  const groups: Partial<Record<PlayType, [triples: number, width: number]>> = {
    triple_single: [1, 3],
    triple_pair: [1, 3],
    plane_single: [play.size / 4, 3],
    plane_pair: [play.size / 5, 3],
    four_two: [1, 4],
    four_pairs: [1, 4],
  };
  const group = groups[play.type];
  if (!group) return `${name} ${ranks.join('')}`;
  const [length, width] = group;
  const main: string[] = [],
    kick = [...ranks];
  for (let v = play.main - length + 1; v <= play.main; v++)
    for (let i = 0; i < width; i++) {
      kick.splice(kick.indexOf(RANKS[v]), 1);
      main.push(RANKS[v]);
    }
  return `${name} ${main.join('')}+${kick.join('')}`;
}

/**
 * Every legal play from a hand, lowest first within each type: everything when leading, only what beats \`lead\`
 * otherwise. Kickers for triples come from each other rank; planes and four-with-two take their smallest kickers,
 * so a hand of seventeen cards stays at a few dozen choices.
 */
export function legalPlays(hand: string[], lead?: Play): PlayOption[] {
  const c = counts(hand.map(valueOf));
  const have = (v: number, k: number) => (c.get(v) || 0) >= k;
  const values = [...c.keys()].sort((a, b) => a - b);
  const out: PlayOption[] = [];
  const seen = new Set<string>();
  const add = (vs: number[]) => {
    const ranks = vs.sort((a, b) => a - b).map((v) => RANKS[v]);
    const key = ranks.join(',');
    if (seen.has(key)) return;
    const play = classify(ranks);
    if (!play || (lead && !beats(play, lead))) return;
    seen.add(key);
    out.push({ ranks, play, label: label(play, ranks) });
  };
  const repeat = (v: number, k: number) => Array<number>(k).fill(v);
  // Kickers: the lowest ranks outside the main ones, each used once.
  const kickers = (exclude: number[], k: number, size: 1 | 2) =>
    values.filter((v) => !exclude.includes(v) && have(v, size)).slice(0, k);
  // Every run of at least `min` consecutive ranks up to A that the hand holds `k` of each.
  const runs = (min: number, k: number) => {
    const found: number[][] = [];
    for (let length = min; length <= CHAIN_TOP + 1; length++)
      for (let start = 0; start + length - 1 <= CHAIN_TOP; start++) {
        const run = Array.from({ length }, (_, i) => start + i);
        if (run.every((v) => have(v, k))) found.push(run);
      }
    return found;
  };
  for (const v of values) add([v]);
  for (const v of values) if (have(v, 2)) add(repeat(v, 2));
  for (const v of values)
    if (have(v, 3)) {
      add(repeat(v, 3));
      for (const w of values) if (w !== v) add([...repeat(v, 3), w]);
      for (const w of values) if (w !== v && have(w, 2)) add([...repeat(v, 3), w, w]);
    }
  for (const run of runs(5, 1)) add([...run]);
  for (const run of runs(3, 2)) add(run.flatMap((v) => repeat(v, 2)));
  for (const run of runs(2, 3)) {
    add(run.flatMap((v) => repeat(v, 3)));
    const singles = kickers(run, run.length, 1);
    if (singles.length === run.length) add([...run.flatMap((v) => repeat(v, 3)), ...singles]);
    const pairs = kickers(run, run.length, 2);
    if (pairs.length === run.length) add([...run.flatMap((v) => repeat(v, 3)), ...pairs.flatMap((v) => [v, v])]);
  }
  for (const v of values)
    if (have(v, 4)) {
      const singles = kickers([v], 2, 1);
      if (singles.length === 2) add([...repeat(v, 4), ...singles]);
      const pairs = kickers([v], 2, 2);
      if (pairs.length === 2) add([...repeat(v, 4), ...pairs.flatMap((w) => [w, w])]);
      add(repeat(v, 4));
    }
  if (have(SMALL_JOKER, 1) && have(BIG_JOKER, 1)) add([SMALL_JOKER, BIG_JOKER]);
  return out;
}

/** The cards of a hand that make up the given ranks, or undefined when the hand does not hold them. */
export function takeCards(hand: string[], ranks: string[]) {
  const left = [...hand],
    taken: string[] = [];
  for (const rank of ranks) {
    const i = left.findIndex((card) => rankOf(card) === rank);
    if (i < 0) return;
    taken.push(...left.splice(i, 1));
  }
  return { taken, left };
}
