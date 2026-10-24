/**
 * Mahjong (麻将), a plain 推倒胡 for four: 136 tiles without flowers, no chow. On your turn you draw and then win,
 * declare a kong or discard; another player's discard may be claimed for a win (和), a kong (杠) or a pung (碰), a
 * win first and then in turn order after the discarder. The hand ends on the first win or when the wall runs out
 * (流局). The winner takes the hand's fan (番) from the discarder, or from each other player on a self-draw.
 *
 * Every legal move is listed in the request, and each discard carries what the hand needs afterwards
 * (shared/games/mahjong-rules.ts): people and AI players get the same arithmetic.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type {
  GameAction,
  GameOption,
  GamePlayer,
  GameRequest,
  GameView,
  MahjongMeld,
} from '../../../shared/types/game-types';
import { GAME_MBTI_TYPES, gameBehaviorPolicy, gamePersonality } from '../../../shared/games/game-personality';
import { seededRandom, shuffle } from '../../../shared/games/seeded-random';
import {
  discardAdvice,
  fansOf,
  isWinning,
  shantenText,
  sortTiles,
  tileName,
  tileSet,
  type Fan,
} from '../../../shared/games/mahjong-rules';
import { log, personaView, viewLogs, type MatchState } from './game-mode';
import type { MatchFacts } from '../persona/match-facts';

export interface MahjongState extends MatchState {
  mode: 'mahjong';
  /** Draws come off the front; kong replacements off the back. */
  wall: string[];
  hands: Record<string, string[]>;
  /** The tile each seat drew this turn, shown apart from the rest of its hand. */
  drawn: Record<string, string | undefined>;
  melds: Record<string, MahjongMeld[]>;
  discards: Record<string, string[]>;
  dealer: number;
  turn: number;
  lastDiscard?: { seatId: string; tile: string };
  /** Answers to the claim requests on the last discard, by seat. */
  claims: Record<string, GameAction>;
  /** The current turn's tile came from a kong replacement (杠上开花). */
  afterKong?: boolean;
  winner?: 'hu' | 'draw';
  /** AI players may add a line of table talk to their moves. */
  tableTalk?: boolean;
  win?: { seatId: string; fromId?: string; tile: string; selfDrawn: boolean; fans: Fan[] };
  scores?: Record<string, number>;
}

export function checkMahjongSeats(count: number) {
  if (count !== 4) throw Error('麻将需要 4 位玩家');
}
const NOTE_KEEP = 3;
/** Time to discard or to claim a discard. Models get twice a person's: a reasoning model needs most of it just to answer. */
const TURN_MS = { discard: 30000, claim: 15000 } as const;
const MODEL_TURN_MS = { discard: 60000, claim: 30000 } as const;
const nameOf = (s: MahjongState, id: string) => s.seats.find((p) => p.id === id)?.name || '玩家';
const human = (s: MahjongState, id: string) => !!s.seats.find((p) => p.id === id)?.human;
const turnMs = (s: MahjongState, seatId: string, kind: 'discard' | 'claim') =>
  (human(s, seatId) ? TURN_MS : MODEL_TURN_MS)[kind];
const seatAt = (s: MahjongState, i: number) => s.seats[((i % 4) + 4) % 4];
const count = (tiles: string[], tile: string) => tiles.filter((t) => t === tile).length;
const removeTiles = (tiles: string[], tile: string, n: number) => {
  for (let i = 0; i < n; i++) tiles.splice(tiles.indexOf(tile), 1);
};

export function createMahjong(
  groupId: string,
  players: GamePlayer[],
  options: { tableTalk?: boolean } = {},
  seed = randomInt(2 ** 32),
): MahjongState {
  checkMahjongSeats(players.length);
  if (new Set(players.map((p) => p.id)).size !== 4 || players.filter((p) => p.human).length > 1)
    throw Error('玩家信息无效或重复');
  const random = seededRandom(seed);
  const types = shuffle([...GAME_MBTI_TYPES], random);
  const dealer = random.int(4);
  let typeIndex = 0;
  const seats = players.map((p, i) => {
    const role = i === dealer ? ('dealer' as const) : ('player' as const);
    if (p.human) return { ...p, mbti: undefined, behaviorPolicy: undefined, personality: undefined, alive: true, role };
    const mbti = p.mbti || types[typeIndex++],
      accent = random.int(4);
    return {
      ...p,
      mbti,
      behaviorPolicy: gameBehaviorPolicy(mbti, accent),
      personality: gamePersonality(mbti, accent),
      alive: true,
      role,
    };
  });
  const wall = shuffle(tileSet(), random);
  const s: MahjongState = {
    mode: 'mahjong',
    id: randomUUID(),
    groupId,
    day: 1,
    phase: 'play',
    status: 'running',
    seats,
    seed,
    logs: [],
    requests: [],
    accepted: [],
    wall,
    hands: Object.fromEntries(seats.map((p) => [p.id, sortTiles(wall.splice(0, 13))])),
    drawn: {},
    melds: Object.fromEntries(seats.map((p) => [p.id, []])),
    discards: Object.fromEntries(seats.map((p) => [p.id, []])),
    dealer,
    turn: dealer,
    claims: {},
    ...(options.tableTalk ? { tableTalk: true } : {}),
  };
  log(s, `游戏开始。四人推倒胡（不吃，可碰、杠、和），${seats[dealer].name} 坐庄。`);
  draw(s);
  return s;
}

/** The current seat draws a tile and is asked for its turn; an empty wall ends the hand in a draw. */
function draw(s: MahjongState, fromBack = false) {
  const seat = seatAt(s, s.turn);
  const tile = fromBack ? s.wall.pop() : s.wall.shift();
  if (!tile) return exhausted(s);
  s.hands[seat.id].push(tile);
  s.drawn = { [seat.id]: tile };
  askTurn(s);
}

/** Tiles this seat can see: every river, every meld and its own hand (advice counts what is still unseen). */
const seen = (s: MahjongState) => [
  ...Object.values(s.discards).flat(),
  ...Object.values(s.melds)
    .flat()
    .flatMap((m) => Array(m.kind === 'peng' ? 3 : 4).fill(m.tile) as string[]),
];

function askTurn(s: MahjongState) {
  const seat = seatAt(s, s.turn),
    hand = s.hands[seat.id],
    melds = s.melds[seat.id];
  const options: GameOption[] = [];
  const drawn = s.drawn[seat.id];
  if (drawn && isWinning(hand, melds.length)) options.push({ id: 'hu', label: '自摸和牌', cards: [drawn] });
  if (s.wall.length) {
    for (const tile of new Set(hand))
      if (count(hand, tile) === 4) options.push({ id: `ag:${tile}`, label: `暗杠 ${tileName(tile)}`, cards: [tile] });
    for (const m of melds)
      if (m.kind === 'peng' && hand.includes(m.tile))
        options.push({ id: `jg:${m.tile}`, label: `加杠 ${tileName(m.tile)}`, cards: [m.tile] });
  }
  const advice = discardAdvice(hand, melds.length, seen(s));
  // The drawn tile first, so a timed-out turn discards what was just drawn (摸切).
  advice.sort((a, b) => (a.tile === drawn ? -1 : b.tile === drawn ? 1 : 0));
  for (const a of advice)
    options.push({
      id: `d:${a.tile}`,
      label: `打 ${tileName(a.tile)}`,
      cards: [a.tile],
      hint:
        a.shanten === 0
          ? `打后听牌，和 ${a.useful.map(tileName).join(' ')}（剩 ${a.count} 张）`
          : `打后${shantenText(a.shanten)}，进张 ${a.count} 张${a.useful.length ? '：' + a.useful.map(tileName).join(' ') : ''}`,
    });
  s.requests = [
    {
      id: randomUUID(),
      seatId: seat.id,
      kind: 'discard',
      targets: options.map((o) => o.id),
      options,
      ...(s.tableTalk && !seat.human ? { talk: true } : {}),
      deadlineAt: Date.now() + turnMs(s, seat.id, 'discard'),
    },
  ];
}

function exhausted(s: MahjongState) {
  s.winner = 'draw';
  s.status = 'finished';
  s.phase = 'finished';
  s.requests = [];
  s.scores = Object.fromEntries(s.seats.map((p) => [p.id, 0]));
  log(s, '牌墙摸完，流局');
}

function finishWin(s: MahjongState, seatId: string, tile: string, fromId?: string) {
  const fans = fansOf({
    tiles: s.hands[seatId],
    melds: s.melds[seatId],
    selfDrawn: !fromId,
    afterKong: !fromId && s.afterKong,
    lastTile: s.wall.length === 0,
  });
  const total = fans.reduce((sum, f) => sum + f.fan, 0);
  s.win = { seatId, ...(fromId ? { fromId } : {}), tile, selfDrawn: !fromId, fans };
  s.scores = Object.fromEntries(
    s.seats.map((p) => [
      p.id,
      p.id === seatId ? (fromId ? total : total * 3) : fromId ? (p.id === fromId ? -total : 0) : -total,
    ]),
  );
  s.winner = 'hu';
  s.status = 'finished';
  s.phase = 'finished';
  s.requests = [];
  log(
    s,
    fromId
      ? `${nameOf(s, seatId)} 和牌，${nameOf(s, fromId)} 点炮（${tileName(tile)}）。`
      : `${nameOf(s, seatId)} 自摸和牌（${tileName(tile)}）。`,
  );
  log(s, `${fans.map((f) => `${f.name} ${f.fan}`).join('、')}，共 ${total} 番。`);
}

export function validateMahjong(s: MahjongState, r: GameRequest, a: GameAction) {
  if (!a || typeof a !== 'object') throw Error('行动格式无效');
  if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 500)) throw Error('决策摘要格式无效');
  if (a.text !== undefined && (typeof a.text !== 'string' || a.text.length > 30)) throw Error('牌桌发言最多 30 字');
  if (r.kind !== 'discard' && r.kind !== 'claim') throw Error('麻将没有这种行动');
  if (a.skip === true && a.target === undefined) {
    if (!r.canPass) throw Error('轮到你出牌，必须打出一张');
    return;
  }
  if (typeof a.target !== 'string' || !r.targets.includes(a.target)) throw Error('不在本轮合法选择中');
}

export function acceptMahjong(s: MahjongState, id: string, a: GameAction, timeout = false) {
  if (s.accepted.includes(id)) return;
  if (s.status !== 'running') throw Error('对局未运行');
  const r = s.requests.find((x) => x.id === id);
  if (!r) throw Error('行动请求已经失效');
  if (!timeout) validateMahjong(s, r, a);
  s.accepted.push(id);
  s.requests = s.requests.filter((x) => x.id !== id);
  const note = a.note?.trim();
  if (note && !timeout) {
    const notes = ((s.notes ||= {})[r.seatId] ||= []);
    notes.push(note.slice(0, 300));
    if (notes.length > NOTE_KEEP) notes.splice(0, notes.length - NOTE_KEEP);
  }
  const talk = timeout || !r.talk ? '' : a.text?.trim();
  if (r.kind === 'claim') {
    s.claims[r.seatId] = a.skip || !a.target ? { skip: true } : { target: a.target };
    if (talk) log(s, talk, r.seatId);
    if (!s.requests.length) resolveClaims(s);
    return;
  }
  // Your own turn. A timeout discards the first option, the tile just drawn.
  const target = a.target || r.targets.find((t) => t.startsWith('d:'))!;
  const seatId = r.seatId,
    name = nameOf(s, seatId),
    hand = s.hands[seatId];
  if (target === 'hu') {
    if (talk) log(s, talk, seatId);
    return finishWin(s, seatId, s.drawn[seatId]!);
  }
  const [kind, tile] = target.split(':');
  if (kind === 'ag' || kind === 'jg') {
    if (kind === 'ag') {
      removeTiles(hand, tile, 4);
      s.melds[seatId].push({ kind: 'angang', tile });
    } else {
      removeTiles(hand, tile, 1);
      s.melds[seatId].find((m) => m.kind === 'peng' && m.tile === tile)!.kind = 'gang';
    }
    s.hands[seatId] = sortTiles(hand);
    log(s, `${name} ${kind === 'ag' ? '暗杠' : '加杠'} ${tileName(tile)}，补一张牌。`);
    if (talk) log(s, talk, seatId);
    s.afterKong = true;
    return draw(s, true);
  }
  removeTiles(hand, tile, 1);
  s.hands[seatId] = sortTiles(hand);
  s.discards[seatId].push(tile);
  s.drawn = {};
  s.afterKong = false;
  s.lastDiscard = { seatId, tile };
  log(s, `${name} 打出 ${tileName(tile)}${timeout ? '（超时自动摸切）' : ''}。`);
  if (talk) log(s, talk, seatId);
  // Who may claim it: a win, then a kong or a pung. Only seats with a claim are asked.
  s.claims = {};
  const from = s.seats.findIndex((p) => p.id === seatId);
  for (let k = 1; k < 4; k++) {
    const seat = seatAt(s, from + k),
      own = s.hands[seat.id],
      melds = s.melds[seat.id];
    const options: GameOption[] = [];
    if (isWinning([...own, tile], melds.length))
      options.push({ id: 'hu', label: `和 ${tileName(tile)}`, cards: [tile] });
    if (count(own, tile) >= 3 && s.wall.length)
      options.push({ id: 'gang', label: `杠 ${tileName(tile)}`, cards: [tile] });
    if (count(own, tile) >= 2) options.push({ id: 'peng', label: `碰 ${tileName(tile)}`, cards: [tile] });
    if (!options.length) continue;
    s.requests.push({
      id: randomUUID(),
      seatId: seat.id,
      kind: 'claim',
      targets: options.map((o) => o.id),
      options,
      canPass: true,
      ...(s.tableTalk && !seat.human ? { talk: true } : {}),
      deadlineAt: Date.now() + turnMs(s, seat.id, 'claim'),
    });
  }
  if (!s.requests.length) nextTurn(s);
}

function nextTurn(s: MahjongState) {
  s.turn = (s.turn + 1) % 4;
  draw(s);
}

/** All claims are in: the first win in turn order after the discarder, else the kong or pung, else play on. */
function resolveClaims(s: MahjongState) {
  const discard = s.lastDiscard!;
  const from = s.seats.findIndex((p) => p.id === discard.seatId);
  const order = [1, 2, 3].map((k) => seatAt(s, from + k).id);
  const wants = (kind: string) => order.find((id) => s.claims[id]?.target === kind);
  const winner = wants('hu');
  if (winner) {
    s.hands[winner].push(discard.tile);
    s.discards[discard.seatId].pop();
    return finishWin(s, winner, discard.tile, discard.seatId);
  }
  const claimer = wants('gang') || wants('peng');
  if (!claimer) return nextTurn(s);
  const kong = s.claims[claimer].target === 'gang';
  removeTiles(s.hands[claimer], discard.tile, kong ? 3 : 2);
  s.discards[discard.seatId].pop();
  s.melds[claimer].push({ kind: kong ? 'gang' : 'peng', tile: discard.tile, from: discard.seatId });
  s.turn = s.seats.findIndex((p) => p.id === claimer);
  s.lastDiscard = undefined;
  log(s, `${nameOf(s, claimer)} ${kong ? '杠' : '碰'} ${tileName(discard.tile)}。`);
  if (kong) {
    s.afterKong = true;
    return draw(s, true);
  }
  s.drawn = {};
  askTurn(s);
}

export function viewMahjong(s: MahjongState, viewerId?: string, omniscient = false): GameView {
  const reveal = s.status === 'finished' || (!s.seats.some((p) => p.human) && omniscient);
  const own = (id: string) => {
    const drawn = s.drawn[id];
    const rest = [...s.hands[id]];
    if (drawn) rest.splice(rest.lastIndexOf(drawn), 1);
    return [...sortTiles(rest), ...(drawn ? [drawn] : [])];
  };
  const timed = s.requests.find((r) => human(s, r.seatId)) || s.requests[0];
  // A model's claim stays off the clock: a countdown would tell the table someone may claim.
  const shown = !!timed && (timed.kind === 'discard' || human(s, timed.seatId));
  return {
    mode: 'mahjong',
    revision: s.revision,
    clock: timed
      ? {
          deadlineAt: shown ? timed.deadlineAt : undefined,
          remainingMs: shown ? timed.remainingMs : undefined,
          seatId: timed.kind === 'discard' ? timed.seatId : undefined,
          totalMs: turnMs(s, timed.seatId, timed.kind === 'claim' ? 'claim' : 'discard'),
        }
      : undefined,
    id: s.id,
    groupId: s.groupId,
    day: s.day,
    phase: s.phase,
    status: s.status,
    seats: s.seats.map((seat) => ({ ...seat })),
    logs: viewLogs(s, viewerId, reveal),
    pending: s.requests.filter((r) => r.seatId === viewerId),
    winner: s.winner,
    tiles: {
      ...(viewerId && s.hands[viewerId] ? { hand: own(viewerId) } : {}),
      ...(viewerId && s.drawn[viewerId] ? { drawn: s.drawn[viewerId] } : {}),
      ...(reveal ? { hands: Object.fromEntries(s.seats.map((p) => [p.id, own(p.id)])) } : {}),
      counts: Object.fromEntries(s.seats.map((p) => [p.id, s.hands[p.id].length])),
      melds: structuredClone(s.melds),
      discards: structuredClone(s.discards),
      wall: s.wall.length,
      dealerId: s.seats[s.dealer].id,
      // While others decide on a discard nobody is on turn.
      ...(s.status === 'running' && s.requests[0]?.kind === 'discard' ? { turnId: seatAt(s, s.turn).id } : {}),
      ...(s.lastDiscard ? { lastDiscard: { ...s.lastDiscard } } : {}),
      ...(s.win ? { win: structuredClone(s.win) } : {}),
      ...(s.scores ? { scores: { ...s.scores } } : {}),
    },
    ...(s.status === 'finished' && s.trace?.length ? { endedAt: s.trace.at(-1)!.time } : {}),
    error: s.error,
    humanId: s.seats.find((p) => p.human)?.id,
    ...(viewerId && s.notes?.[viewerId]?.length ? { notes: [...s.notes[viewerId]] } : {}),
    ...personaView(s, viewerId, reveal),
  };
}

export function mahjongFacts(s: MahjongState): MatchFacts {
  const total = s.win?.fans.reduce((sum, f) => sum + f.fan, 0) || 0;
  return {
    id: s.id,
    groupId: s.groupId,
    game: '麻将',
    // No teams: every seat plays for itself.
    seats: s.seats.map((p) => ({
      id: p.id,
      name: p.name,
      human: p.human,
      ...(p.botId ? { botId: p.botId } : {}),
      team: p.id,
      role: p.role === 'dealer' ? '庄家' : '闲家',
    })),
    ...(s.winner ? { winners: s.win ? [s.win.seatId] : [] } : {}),
    result: s.win
      ? s.win.selfDrawn
        ? `${nameOf(s, s.win.seatId)} 自摸和牌，${total} 番`
        : `${nameOf(s, s.win.seatId)} 和牌，${nameOf(s, s.win.fromId!)} 点炮，${total} 番`
      : '流局',
    details: s.win ? [`番种：${s.win.fans.map((f) => `${f.name} ${f.fan}`).join('、')}。`] : [],
    social: [],
    experiences: [],
    ...(s.personaPolicy ? { personaPolicy: s.personaPolicy } : {}),
  };
}
