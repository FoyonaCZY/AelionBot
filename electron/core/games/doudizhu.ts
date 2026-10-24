/**
 * Dou Di Zhu (斗地主): three players, 17 cards each and three hole cards. Each player bids once, in turn, 1–3 points
 * or passes; the highest bid becomes the landlord, takes the hole cards and leads. The landlord plays against the two
 * farmers; the first side to empty a hand wins. The score is the bid, doubled by each bomb or rocket and by a spring
 * (the other side never played a card); the landlord wins or pays twice, each farmer once.
 *
 * Every legal play is listed in the request (shared/games/doudizhu-rules.ts), so a model picks one by id instead of
 * spelling cards: the program does the counting, the model the judgement.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { GameAction, GamePlayer, GameRequest, GameView } from '../../../shared/types/game-types';
import { GAME_MBTI_TYPES, gameBehaviorPolicy, gamePersonality } from '../../../shared/games/game-personality';
import { seededRandom, shuffle } from '../../../shared/games/seeded-random';
import { classify, deck, legalPlays, sortCards, takeCards, type Play } from '../../../shared/games/doudizhu-rules';
import { log, personaView, viewLogs, type MatchState } from './game-mode';
import type { MatchFacts } from '../persona/match-facts';

export interface DoudizhuState extends MatchState {
  mode: 'doudizhu';
  hands: Record<string, string[]>;
  kitty: string[];
  bids: Record<string, number>;
  /** Seat index that bids first; bidding goes round once from here. */
  bidStart: number;
  /** Seat index whose turn it is (bidding or playing). */
  turn: number;
  landlordId?: string;
  /** The play to beat: who made it and what it was. Cleared when both others pass. */
  lead?: { seatId: string; cards: string[]; play: Play; label: string };
  passes: number;
  /** Each seat's last move in the current trick. */
  last: Record<string, { cards?: string[]; label: string; pass?: boolean }>;
  played: string[];
  /** Plays per seat, for the spring. */
  plays: Record<string, number>;
  bombs: number;
  /** Deals thrown in because nobody bid; after three the first bidder is made landlord at one point. */
  redeals: number;
  winner?: 'landlord' | 'farmer';
  /** AI players may add a line of table talk to their moves. */
  tableTalk?: boolean;
  scores?: Record<string, number>;
  spring?: boolean;
}

export function checkDoudizhuSeats(count: number) {
  if (count !== 3) throw Error('斗地主需要 3 位玩家');
}
const NOTE_KEEP = 3;
/** Time to bid or play. Models get twice a person's: a reasoning model needs most of it just to answer. */
const TURN_MS = { bid: 30000, play: 45000 } as const;
const MODEL_TURN_MS = { bid: 60000, play: 90000 } as const;
const turnMs = (s: DoudizhuState, seatId: string, kind: 'bid' | 'play') =>
  (s.seats.find((p) => p.id === seatId)?.human ? TURN_MS : MODEL_TURN_MS)[kind];
const nameOf = (s: DoudizhuState, id: string) => s.seats.find((p) => p.id === id)?.name || '玩家';
const seatAt = (s: DoudizhuState, i: number) => s.seats[((i % 3) + 3) % 3];
const highBid = (s: DoudizhuState) => Math.max(0, ...Object.values(s.bids));

function deal(s: DoudizhuState) {
  const random = seededRandom((s.seed! + s.redeals * 7919) >>> 0);
  const cards = shuffle(deck(), random);
  s.hands = Object.fromEntries(s.seats.map((p, i) => [p.id, sortCards(cards.slice(i * 17, i * 17 + 17))]));
  s.kitty = sortCards(cards.slice(51));
  s.bids = {};
  s.lead = undefined;
  s.last = {};
  s.bidStart = random.int(3);
  s.turn = s.bidStart;
  s.phase = 'bid';
  s.requests = [];
  log(s, `发牌完成，从 ${seatAt(s, s.bidStart).name} 开始叫地主。`);
  askBid(s);
}
const cardsText = (cards: string[]) => cards.join(' ');

function askBid(s: DoudizhuState) {
  const seat = seatAt(s, s.turn),
    high = highBid(s);
  const options = [1, 2, 3].filter((n) => n > high).map((n) => ({ id: `bid${n}`, label: `叫 ${n} 分` }));
  s.requests = [
    {
      id: randomUUID(),
      seatId: seat.id,
      kind: 'bid',
      targets: options.map((o) => o.id),
      options,
      canPass: true,
      ...(s.tableTalk && !seat.human ? { talk: true } : {}),
      deadlineAt: Date.now() + turnMs(s, seat.id, 'bid'),
    },
  ];
}

function askPlay(s: DoudizhuState) {
  const seat = seatAt(s, s.turn);
  const lead = s.lead && s.lead.seatId !== seat.id ? s.lead.play : undefined;
  // Ids are the ranks themselves (7-7-7-3), readable in the run record and easy for a model to copy.
  const options = legalPlays(s.hands[seat.id], lead).map((o) => ({
    id: o.ranks.join('-'),
    label: o.label,
    cards: o.ranks,
  }));
  s.requests = [
    {
      id: randomUUID(),
      seatId: seat.id,
      kind: 'play',
      targets: options.map((o) => o.id),
      options,
      canPass: !!lead,
      ...(s.tableTalk && !seat.human ? { talk: true } : {}),
      deadlineAt: Date.now() + turnMs(s, seat.id, 'play'),
    },
  ];
}

export function createDoudizhu(
  groupId: string,
  players: GamePlayer[],
  options: { tableTalk?: boolean } = {},
  seed = randomInt(2 ** 32),
): DoudizhuState {
  checkDoudizhuSeats(players.length);
  if (new Set(players.map((p) => p.id)).size !== 3 || players.filter((p) => p.human).length > 1)
    throw Error('玩家信息无效或重复');
  const random = seededRandom(seed);
  const types = shuffle([...GAME_MBTI_TYPES], random);
  let typeIndex = 0;
  const seats = players.map((p) => {
    if (p.human)
      return {
        ...p,
        mbti: undefined,
        behaviorPolicy: undefined,
        personality: undefined,
        alive: true,
        role: 'farmer' as const,
      };
    const mbti = p.mbti || types[typeIndex++],
      accent = random.int(4);
    return {
      ...p,
      mbti,
      behaviorPolicy: gameBehaviorPolicy(mbti, accent),
      personality: gamePersonality(mbti, accent),
      alive: true,
      role: 'farmer' as const,
    };
  });
  const s: DoudizhuState = {
    mode: 'doudizhu',
    id: randomUUID(),
    groupId,
    day: 1,
    phase: 'bid',
    status: 'running',
    seats,
    seed,
    logs: [],
    requests: [],
    accepted: [],
    hands: {},
    kitty: [],
    bids: {},
    bidStart: 0,
    turn: 0,
    passes: 0,
    last: {},
    played: [],
    plays: {},
    bombs: 0,
    redeals: 0,
    ...(options.tableTalk ? { tableTalk: true } : {}),
  };
  log(s, '游戏开始。三人斗地主：先叫地主，地主拿底牌先出；地主一边，两位农民一边，先出完牌的一边获胜。');
  deal(s);
  return s;
}

function becomeLandlord(s: DoudizhuState, seatId: string) {
  const seat = s.seats.find((p) => p.id === seatId)!;
  s.landlordId = seatId;
  for (const p of s.seats) p.role = p.id === seatId ? 'landlord' : 'farmer';
  s.hands[seatId] = sortCards([...s.hands[seatId], ...s.kitty]);
  s.phase = 'play';
  s.turn = s.seats.indexOf(seat);
  s.plays = Object.fromEntries(s.seats.map((p) => [p.id, 0]));
  log(s, `${seat.name} 成为地主（${highBid(s)} 分），底牌是 ${cardsText(s.kitty)}。`);
  askPlay(s);
}

export function validateDoudizhu(s: DoudizhuState, r: GameRequest, a: GameAction) {
  if (!a || typeof a !== 'object') throw Error('行动格式无效');
  if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 500)) throw Error('决策摘要格式无效');
  if (a.text !== undefined && (typeof a.text !== 'string' || a.text.length > 30)) throw Error('牌桌发言最多 30 字');
  if (r.kind !== 'bid' && r.kind !== 'play') throw Error('斗地主没有这种行动');
  if (a.skip === true && a.target === undefined) {
    if (!r.canPass) throw Error('这一手由你先出，不能不要');
    return;
  }
  if (typeof a.target !== 'string' || !r.targets.includes(a.target)) throw Error('出牌不在本轮合法选择中');
}

export function acceptDoudizhu(s: DoudizhuState, id: string, a: GameAction, timeout = false) {
  if (s.accepted.includes(id)) return;
  if (s.status !== 'running') throw Error('对局未运行');
  const r = s.requests.find((x) => x.id === id);
  if (!r) throw Error('行动请求已经失效');
  if (!timeout) validateDoudizhu(s, r, a);
  s.accepted.push(id);
  s.requests = [];
  const note = a.note?.trim();
  if (note && !timeout) {
    const notes = ((s.notes ||= {})[r.seatId] ||= []);
    notes.push(note.slice(0, 300));
    if (notes.length > NOTE_KEEP) notes.splice(0, notes.length - NOTE_KEEP);
  }
  const name = nameOf(s, r.seatId),
    talk = timeout || !r.talk ? '' : a.text?.trim();
  const option = r.options?.find((o) => o.id === a.target);
  if (r.kind === 'bid') {
    const bid = option ? Number(option.id.slice(3)) : 0;
    s.bids[r.seatId] = bid;
    log(s, bid ? `${name} 叫 ${bid} 分。` : `${name} 不叫。`);
    if (talk) log(s, talk, r.seatId);
    if (bid === 3) return becomeLandlord(s, r.seatId);
    s.turn++;
    if (Object.keys(s.bids).length < 3) return askBid(s);
    const high = highBid(s);
    if (high)
      return becomeLandlord(
        s,
        Object.keys(s.bids).find((id) => s.bids[id] === high)!,
      );
    s.redeals++;
    if (s.redeals >= 3) {
      s.bids[seatAt(s, s.bidStart).id] = 1;
      log(s, `连续 ${s.redeals} 次无人叫地主，由 ${seatAt(s, s.bidStart).name} 以 1 分做地主。`);
      return becomeLandlord(s, seatAt(s, s.bidStart).id);
    }
    log(s, '无人叫地主，重新发牌。');
    return deal(s);
  }
  // A seat that passes while it could not pass (only on a timeout) plays its lowest single instead.
  const chosen = option || (!r.canPass ? r.options?.[0] : undefined);
  if (!chosen || !chosen.cards) {
    s.passes++;
    s.last[r.seatId] = { label: '不要', pass: true };
    log(s, timeout ? `${name} 超时，不要。` : `${name} 不要。`);
    if (talk) log(s, talk, r.seatId);
    s.turn++;
    if (s.passes >= 2) {
      // Both others passed: the trick goes to the last player, who leads anything.
      s.lead = undefined;
      s.passes = 0;
      s.last = {};
    }
    return askPlay(s);
  }
  const play = classify(chosen.cards)!;
  const cards = takeCards(s.hands[r.seatId], chosen.cards)!;
  s.hands[r.seatId] = cards.left;
  s.played.push(...cards.taken);
  s.plays[r.seatId] = (s.plays[r.seatId] || 0) + 1;
  if (play.type === 'bomb' || play.type === 'rocket') s.bombs++;
  s.lead = { seatId: r.seatId, cards: cards.taken, play, label: chosen.label };
  s.passes = 0;
  s.last[r.seatId] = { cards: cards.taken, label: chosen.label };
  const left = cards.left.length;
  log(
    s,
    `${name} 出 ${chosen.label}（${cardsText(cards.taken)}）${timeout ? '，超时自动出牌' : ''}。` +
      (left && left <= 2 ? `剩 ${left} 张。` : ''),
  );
  if (talk) log(s, talk, r.seatId);
  if (!left) return finish(s, r.seatId);
  s.turn++;
  askPlay(s);
}

function finish(s: DoudizhuState, winnerId: string) {
  const landlord = s.landlordId!;
  s.winner = winnerId === landlord ? 'landlord' : 'farmer';
  // Spring: the farmers never played; or the landlord played only the opening lead.
  s.spring =
    s.winner === 'landlord' ? s.seats.every((p) => p.id === landlord || !s.plays[p.id]) : (s.plays[landlord] || 0) <= 1;
  const unit = Math.max(1, highBid(s)) * 2 ** (s.bombs + (s.spring ? 1 : 0));
  const sign = s.winner === 'landlord' ? 1 : -1;
  s.scores = Object.fromEntries(s.seats.map((p) => [p.id, p.id === landlord ? sign * unit * 2 : -sign * unit]));
  s.status = 'finished';
  s.phase = 'finished';
  s.requests = [];
  log(s, s.winner === 'landlord' ? '地主获胜' : '农民获胜');
  log(
    s,
    `底分 ${Math.max(1, highBid(s))}，炸弹 ${s.bombs} 个${s.spring ? '，春天' : ''}，本局 ${unit} 倍：` +
      s.seats.map((p) => `${p.name} ${s.scores![p.id] > 0 ? '+' : ''}${s.scores![p.id]}`).join('，') +
      '。',
  );
}

export function viewDoudizhu(s: DoudizhuState, viewerId?: string, omniscient = false): GameView {
  const reveal = s.status === 'finished' || (!s.seats.some((p) => p.human) && omniscient);
  const timed = s.requests[0];
  return {
    mode: 'doudizhu',
    revision: s.revision,
    clock: timed
      ? {
          deadlineAt: timed.deadlineAt,
          remainingMs: timed.remainingMs,
          seatId: timed.seatId,
          totalMs: turnMs(s, timed.seatId, timed.kind === 'bid' ? 'bid' : 'play'),
        }
      : undefined,
    id: s.id,
    groupId: s.groupId,
    day: s.day,
    phase: s.phase,
    status: s.status,
    seats: s.seats.map(({ role, ...seat }) => ({ ...seat, ...(s.landlordId ? { role } : {}) })),
    logs: viewLogs(s, viewerId, reveal),
    pending: s.requests.filter((r) => r.seatId === viewerId),
    winner: s.winner,
    cards: {
      ...(viewerId && s.hands[viewerId] ? { hand: [...s.hands[viewerId]] } : {}),
      ...(reveal ? { hands: structuredClone(s.hands) } : {}),
      counts: Object.fromEntries(s.seats.map((p) => [p.id, s.hands[p.id]?.length || 0])),
      bids: { ...s.bids },
      ...(s.landlordId ? { landlordId: s.landlordId, kitty: [...s.kitty] } : {}),
      bid: highBid(s),
      multiplier: Math.max(1, highBid(s)) * 2 ** (s.bombs + (s.spring ? 1 : 0)),
      ...(s.lead ? { lead: { seatId: s.lead.seatId, cards: [...s.lead.cards], label: s.lead.label } } : {}),
      last: structuredClone(s.last),
      played: [...s.played],
      ...(s.scores ? { scores: { ...s.scores } } : {}),
      ...(s.spring ? { spring: true } : {}),
    },
    ...(s.status === 'finished' && s.trace?.length ? { endedAt: s.trace.at(-1)!.time } : {}),
    error: s.error,
    humanId: s.seats.find((p) => p.human)?.id,
    ...(viewerId && s.notes?.[viewerId]?.length ? { notes: [...s.notes[viewerId]] } : {}),
    ...personaView(s, viewerId, reveal),
  };
}

export function doudizhuFacts(s: DoudizhuState): MatchFacts {
  const landlord = s.seats.find((p) => p.id === s.landlordId);
  return {
    id: s.id,
    groupId: s.groupId,
    game: '斗地主',
    seats: s.seats.map((p) => ({
      id: p.id,
      name: p.name,
      human: p.human,
      ...(p.botId ? { botId: p.botId } : {}),
      team: p.role,
      role: p.role === 'landlord' ? '地主' : '农民',
    })),
    ...(s.winner ? { winners: [s.winner] } : {}),
    result: s.winner === 'landlord' ? `地主 ${landlord?.name} 获胜` : '农民获胜',
    details: s.scores
      ? [
          `底分 ${Math.max(1, highBid(s))}，炸弹 ${s.bombs} 个${s.spring ? '，春天' : ''}。得分：${s.seats
            .map((p) => `${p.name} ${s.scores![p.id] > 0 ? '+' : ''}${s.scores![p.id]}`)
            .join('，')}。`,
        ]
      : [],
    social: [],
    experiences: [],
    ...(s.personaPolicy ? { personaPolicy: s.personaPolicy } : {}),
  };
}
