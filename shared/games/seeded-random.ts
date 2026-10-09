/**
 * Deterministic random numbers for reproducible matches (docs/ai-personality-module.md §15.2).
 * mulberry32 uses 32-bit integer arithmetic only: a multiplicative LCG on JS doubles overflows and cycles
 * after ~10k draws (appendix C round 15), so never replace this with `seed * a + c`.
 */
export interface SeededRandom {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
}
export function seededRandom(seed: number): SeededRandom {
  let state = seed | 0;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n) };
}
export function shuffle<T>(items: T[], random: SeededRandom) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
