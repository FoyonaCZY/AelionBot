/**
 * Mahjong (麻将) rules shared by the game mode and the table, for a plain 推倒胡: 136 tiles without flowers, no
 * chow, win on four sets and a pair or on seven pairs. Tiles are codes: 1m–9m (万), 1s–9s (条), 1p–9p (筒) and the
 * honours E S W N C F P (东南西北中发白). The helpers here also work out what a hand still needs, which the table
 * shows people and the prompt gives the AI players, so neither side plays with less arithmetic than the other.
 */

export const TILES = [
  ...['m', 's', 'p'].flatMap((suit) => Array.from({ length: 9 }, (_, i) => `${i + 1}${suit}`)),
  'E',
  'S',
  'W',
  'N',
  'C',
  'F',
  'P',
] as const;
const HONOURS: Record<string, string> = { E: '东', S: '南', W: '西', N: '北', C: '中', F: '发', P: '白' };
const SUIT_NAMES: Record<string, string> = { m: '万', s: '条', p: '筒' };
const NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

const tileIndex = (tile: string) => TILES.indexOf(tile as (typeof TILES)[number]);
/** 5万, 3条, 东. */
export const tileName = (tile: string) => HONOURS[tile] ?? `${NUMBERS[Number(tile[0]) - 1]}${SUIT_NAMES[tile[1]]}`;
/** Suit letter of a numbered tile, or 'z' for an honour. */
export const suitOf = (tile: string) => (HONOURS[tile] ? 'z' : tile[1]);
export const sortTiles = (tiles: string[]) => [...tiles].sort((a, b) => tileIndex(a) - tileIndex(b));

/** The 136 tiles of the wall. */
export function tileSet() {
  return TILES.flatMap((tile) => [tile, tile, tile, tile]);
}
function countsOf(tiles: string[]) {
  const c = Array<number>(34).fill(0);
  for (const tile of tiles) c[tileIndex(tile)]++;
  return c;
}
const numbered = (i: number) => i < 27;
const position = (i: number) => i % 9;

/**
 * Tiles from ready (向听数) of the concealed tiles, given how many sets are already melded: -1 is a complete
 * hand, 0 is ready (one tile wins), 1 needs one useful tile before it is ready, and so on.
 */
/** Results by tile counts: discard advice asks about the same hands again and again. */
const cache = new Map<string, number>();
export function shanten(tiles: string[] | number[], melds = 0) {
  const c = typeof tiles[0] === 'number' ? [...(tiles as number[])] : countsOf(tiles as string[]);
  const key = c.join('') + melds;
  const known = cache.get(key);
  if (known !== undefined) return known;
  if (cache.size > 100000) cache.clear();
  const result = computeShanten(c, melds);
  cache.set(key, result);
  return result;
}
function computeShanten(c: number[], melds: number) {
  let best = 8;
  // Sets and partial sets (taatsu) never count beyond the four sets a hand needs.
  let found = -1;
  // Takes the tiles at these offsets from i out, searches on, and puts them back.
  const attempt = (i: number, offsets: number[], next: () => void) => {
    for (const k of offsets) c[i + k]--;
    next();
    for (const k of offsets) c[i + k]++;
  };
  const dfs = (i: number, sets: number, partial: number) => {
    while (i < 34 && c[i] === 0) i++;
    if (i === 34) {
      const total = sets + melds;
      found = Math.max(found, 2 * total + Math.min(partial, 4 - total));
      return;
    }
    if (c[i] >= 3) {
      c[i] -= 3;
      dfs(i, sets + 1, partial);
      c[i] += 3;
    }
    if (numbered(i) && position(i) <= 6 && c[i + 1] && c[i + 2]) attempt(i, [0, 1, 2], () => dfs(i, sets + 1, partial));
    if (sets + melds + partial < 4) {
      if (c[i] >= 2) {
        c[i] -= 2;
        dfs(i, sets, partial + 1);
        c[i] += 2;
      }
      if (numbered(i) && position(i) <= 7 && c[i + 1]) attempt(i, [0, 1], () => dfs(i, sets, partial + 1));
      if (numbered(i) && position(i) <= 6 && c[i + 2]) attempt(i, [0, 2], () => dfs(i, sets, partial + 1));
    }
    c[i]--;
    dfs(i, sets, partial);
    c[i]++;
  };
  found = -1;
  dfs(0, 0, 0);
  best = Math.min(best, 8 - found);
  for (let i = 0; i < 34; i++)
    if (c[i] >= 2) {
      c[i] -= 2;
      found = -1;
      dfs(0, 0, 0);
      best = Math.min(best, 7 - found);
      c[i] += 2;
    }
  if (melds === 0) {
    const pairs = c.filter((k) => k >= 2).length,
      kinds = c.filter((k) => k > 0).length;
    best = Math.min(best, 6 - pairs + Math.max(0, 7 - kinds));
  }
  return best;
}
export const isWinning = (tiles: string[], melds = 0) =>
  tiles.length === 14 - 3 * melds && shanten(tiles, melds) === -1;

/** Seven different pairs, the only hand that is not four sets and a pair. */
const sevenPairs = (c: number[]) => c.filter((k) => k === 2).length === 7;
/** Whether the concealed tiles split into triplets and one pair only (碰碰胡 with the melds). */
function allTriplets(c: number[]) {
  const pairs = c.filter((k) => k === 2).length;
  return pairs === 1 && c.every((k) => k === 0 || k === 2 || k === 3);
}

export interface Fan {
  name: string;
  fan: number;
}
/**
 * The fan (番) of a winning hand. Concealed tiles include the winning tile; melds are the claimed and declared
 * sets. Base 1, plus each pattern that applies.
 */
export function fansOf(input: {
  tiles: string[];
  melds: { kind: 'peng' | 'gang' | 'angang'; tile: string }[];
  selfDrawn: boolean;
  afterKong?: boolean;
  lastTile?: boolean;
}): Fan[] {
  const c = countsOf(input.tiles);
  const fans: Fan[] = [{ name: '平胡', fan: 1 }];
  const all = [...input.tiles, ...input.melds.map((m) => m.tile)];
  const suits = new Set(all.map(suitOf));
  const open = input.melds.some((m) => m.kind !== 'angang');
  if (input.melds.length === 0 && sevenPairs(c)) fans.push({ name: '七对', fan: 2 });
  else if (allTriplets(c)) fans.push({ name: '碰碰胡', fan: 2 });
  if (!suits.has('z') && suits.size === 1) fans.push({ name: '清一色', fan: 4 });
  else if (suits.has('z') && suits.size === 2) fans.push({ name: '混一色', fan: 2 });
  else if (suits.size === 1) fans.push({ name: '字一色', fan: 6 });
  if (!open) fans.push({ name: '门清', fan: 1 });
  if (input.selfDrawn) fans.push({ name: '自摸', fan: 1 });
  if (input.afterKong) fans.push({ name: '杠上开花', fan: 1 });
  if (input.lastTile) fans.push({ name: input.selfDrawn ? '海底捞月' : '河底捞鱼', fan: 1 });
  return fans;
}

/**
 * For each tile the hand could discard: tiles from ready afterwards and the useful draws (进张) — every tile that
 * would bring it one step closer, with how many of them are still unseen by this player.
 */
export function discardAdvice(hand: string[], melds: number, seen: string[]) {
  const unseen = Array<number>(34).fill(4);
  for (const tile of [...hand, ...seen]) unseen[tileIndex(tile)]--;
  const c = countsOf(hand);
  const out: { tile: string; shanten: number; useful: string[]; count: number }[] = [];
  for (let i = 0; i < 34; i++) {
    if (!c[i]) continue;
    c[i]--;
    const after = shanten(c, melds);
    const useful: string[] = [];
    let count = 0;
    for (let j = 0; j < 34; j++) {
      if (unseen[j] <= 0 || c[j] >= 4) continue;
      c[j]++;
      if (shanten(c, melds) < after) {
        useful.push(TILES[j]);
        count += unseen[j];
      }
      c[j]--;
    }
    c[i]++;
    out.push({ tile: TILES[i], shanten: after, useful, count });
  }
  return out;
}
export const shantenText = (n: number) => (n < 0 ? '和牌' : n === 0 ? '听牌' : `${n} 向听`);
