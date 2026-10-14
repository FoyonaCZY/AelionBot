/**
 * Who's the Spy (谁是卧底), docs/ai-party-games-design.md §3.1. Civilians share a word, spies hold a close but
 * different one, and an optional blank holds none. Nobody is told whether they are a spy: each seat only knows its
 * own word. Rounds of one-line descriptions are followed by a simultaneous vote; the most-voted seat is out and its
 * role announced.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type {
  GameAction,
  GameEvent,
  GamePlayer,
  GameRequest,
  GameRole,
  GameView,
} from '../../../shared/types/game-types';
import { GAME_MBTI_TYPES, gameBehaviorPolicy, gamePersonality } from '../../../shared/games/game-personality';
import { ROLE_NAMES } from '../../../shared/games/game-boards';
import { seededRandom, shuffle } from '../../../shared/games/seeded-random';
import { gameContent } from './content';
import { event } from './events';
import { log, personaView, viewLogs, type MatchState } from './game-mode';
import type { MatchExperience, MatchFacts, SocialFact } from '../persona/match-facts';

export interface WordPair {
  id: string;
  a: string;
  b: string;
  category: string;
}
export interface UndercoverState extends MatchState {
  mode: 'undercover';
  words: { civilian: string; undercover: string; pairId: string; version: string };
  /** Seats describing in the current round, in speaking order. */
  speakers: string[];
  speechIndex: number;
  /** Votes of the current vote, by seat. */
  answers: Record<string, GameAction>;
  /** 0 for a round's first vote, 1 for the revote among tied seats. */
  voteRound: number;
  /** Seats tied in the first vote: they describe once more and are the only targets of the revote. */
  runoff?: string[];
  winner?: 'civilian' | 'undercover' | 'blank';
  events?: GameEvent[];
}

const UNDERCOVER_SEATS = { min: 4, max: 10 } as const;
export function checkUndercoverSeats(count: number) {
  if (count < UNDERCOVER_SEATS.min || count > UNDERCOVER_SEATS.max) throw Error('谁是卧底需要 4–10 位玩家');
}
/** Longest description and blank guess, in characters. */
export const DESCRIBE_MAX = 60;
export const GUESS_MAX = 20;
const NOTE_KEEP = 3;

/** Letters and digits only, case- and width-folded: what counts as saying a word. */
export const normalizeWord = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');

export function wordPairs() {
  const { data, version } = gameContent<{ pairs: WordPair[] }>('undercover/words.json');
  return { pairs: data.pairs, version };
}

const living = (s: UndercoverState) => s.seats.filter((p) => p.alive);
const nameOf = (s: UndercoverState, id: string) => s.seats.find((p) => p.id === id)?.name || '玩家';
const wordOf = (s: UndercoverState, role: GameRole) =>
  role === 'civilian' ? s.words.civilian : role === 'undercover' ? s.words.undercover : undefined;

function request(s: UndercoverState, seatId: string, kind: GameRequest['kind'], targets: string[] = []) {
  const human = s.seats.find((p) => p.id === seatId)?.human;
  s.requests.push({
    id: randomUUID(),
    seatId,
    kind,
    targets,
    deadlineAt: Date.now() + (kind === 'describe' ? (human ? 90000 : 60000) : 45000),
  });
}

export function createUndercover(
  groupId: string,
  players: GamePlayer[],
  options: { blank?: boolean } = {},
  seed = randomInt(2 ** 32),
  pairs = wordPairs(),
): UndercoverState {
  const n = players.length;
  checkUndercoverSeats(n);
  if (new Set(players.map((p) => p.id)).size !== n || players.filter((p) => p.human).length > 1)
    throw Error('玩家信息无效或重复');
  if (options.blank && n < 7) throw Error('7 人及以上才能加白板');
  const random = seededRandom(seed);
  const spies = n <= 6 ? 1 : 2;
  const deck: GameRole[] = [...Array<GameRole>(spies).fill('undercover'), ...(options.blank ? ['blank' as const] : [])];
  while (deck.length < n) deck.push('civilian');
  shuffle(deck, random);
  const pair = pairs.pairs[random.int(pairs.pairs.length)];
  const swap = random.int(2) === 1;
  const types = shuffle([...GAME_MBTI_TYPES], random);
  let typeIndex = 0;
  const seats = players.map((p, i) => {
    if (p.human)
      return { ...p, mbti: undefined, behaviorPolicy: undefined, personality: undefined, alive: true, role: deck[i] };
    const mbti = p.mbti || types[typeIndex++],
      accent = random.int(4);
    return {
      ...p,
      mbti,
      behaviorPolicy: gameBehaviorPolicy(mbti, accent),
      personality: gamePersonality(mbti, accent),
      alive: true,
      role: deck[i],
    };
  });
  const s: UndercoverState = {
    mode: 'undercover',
    id: randomUUID(),
    groupId,
    day: 1,
    phase: 'speech',
    status: 'running',
    seats,
    seed,
    logs: [],
    requests: [],
    accepted: [],
    words: {
      civilian: swap ? pair.b : pair.a,
      undercover: swap ? pair.a : pair.b,
      pairId: pair.id,
      version: pairs.version,
    },
    speakers: [],
    speechIndex: 0,
    answers: {},
    voteRound: 0,
  };
  log(
    s,
    `游戏开始。${n} 位玩家，其中 ${spies} 位卧底${options.blank ? '、1 位白板' : ''}。每人只知道自己的词，不知道自己是不是卧底。`,
  );
  for (const p of s.seats) {
    const word = wordOf(s, p.role);
    log(s, word ? `你的词是「${word}」。` : '你是白板，没有拿到词。听别人的描述，尽量不被发现。', undefined, [p.id]);
  }
  startRound(s);
  return s;
}

function startRound(s: UndercoverState) {
  const alive = living(s);
  const offset = (s.day - 1) % alive.length;
  s.phase = 'speech';
  s.voteRound = 0;
  delete s.runoff;
  s.speakers = [...alive.slice(offset), ...alive.slice(0, offset)].map((p) => p.id);
  s.speechIndex = 0;
  s.answers = {};
  s.requests = [];
  log(s, `第 ${s.day} 轮描述，从 ${nameOf(s, s.speakers[0])} 开始。`);
  nextSpeaker(s);
}
function nextSpeaker(s: UndercoverState) {
  s.requests = [];
  const id = s.speakers[s.speechIndex];
  if (id) request(s, id, 'describe');
  else voting(s);
}
function voting(s: UndercoverState) {
  s.phase = 'vote';
  s.answers = {};
  s.requests = [];
  log(s, s.runoff ? `在 ${s.runoff.map((id) => nameOf(s, id)).join('、')} 之中重新投票。` : '开始投票。');
  const targets = s.runoff || living(s).map((p) => p.id);
  for (const p of living(s))
    request(
      s,
      p.id,
      'vote',
      targets.filter((id) => id !== p.id),
    );
}

/** Spies win once they match the civilians or reach the final three; a blank alone needs the same. */
function finishIfWon(s: UndercoverState) {
  const alive = living(s),
    civilians = alive.filter((p) => p.role === 'civilian').length,
    spies = alive.filter((p) => p.role === 'undercover').length,
    blanks = alive.filter((p) => p.role === 'blank').length;
  let winner: UndercoverState['winner'];
  if (spies + blanks === 0) winner = 'civilian';
  else if (spies > 0 && (spies >= civilians || alive.length <= 3)) winner = 'undercover';
  else if (spies === 0 && (blanks >= civilians || alive.length <= 3)) winner = 'blank';
  if (!winner) return false;
  finish(s, winner);
  return true;
}
function finish(s: UndercoverState, winner: NonNullable<UndercoverState['winner']>) {
  s.winner = winner;
  s.status = 'finished';
  s.phase = 'finished';
  s.requests = [];
  log(s, winner === 'civilian' ? '平民获胜' : winner === 'undercover' ? '卧底获胜' : '白板获胜');
  log(s, `平民的词是「${s.words.civilian}」，卧底的词是「${s.words.undercover}」。`);
}
function nextRound(s: UndercoverState) {
  if (finishIfWon(s)) return;
  s.day++;
  if (s.day > 20) {
    s.status = 'paused';
    s.error = '达到 20 轮运行上限，请结束本局';
    return;
  }
  startRound(s);
}

export function validateUndercover(s: UndercoverState, r: GameRequest, a: GameAction) {
  if (!a || typeof a !== 'object') throw Error('行动格式无效');
  if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > 500)) throw Error('决策摘要格式无效');
  if (r.kind === 'describe') {
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (!text || text.length > DESCRIBE_MAX) throw Error(`描述应为 1–${DESCRIBE_MAX} 字`);
    const word = wordOf(s, s.seats.find((p) => p.id === r.seatId)!.role);
    if (word && normalizeWord(text).includes(normalizeWord(word))) throw Error('描述里不能出现自己的词');
  } else if (r.kind === 'blank_guess') {
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (!text || text.length > GUESS_MAX) throw Error(`猜词应为 1–${GUESS_MAX} 字`);
  } else if (r.kind === 'vote') {
    if (a.skip === true && a.target === undefined) return;
    if (typeof a.target !== 'string' || !r.targets.includes(a.target)) throw Error('目标不在本轮合法选择中');
  } else throw Error('谁是卧底没有这种行动');
}

export function acceptUndercover(s: UndercoverState, id: string, a: GameAction, timeout = false) {
  if (s.accepted.includes(id)) return;
  if (s.status !== 'running') throw Error('对局未运行');
  const r = s.requests.find((x) => x.id === id);
  if (!r) throw Error('行动请求已经失效');
  if (!timeout) validateUndercover(s, r, a);
  s.accepted.push(id);
  s.requests = s.requests.filter((x) => x.id !== id);
  const note = a.note?.trim();
  if (note && !timeout) {
    const notes = ((s.notes ||= {})[r.seatId] ||= []);
    notes.push(note.slice(0, 300));
    if (notes.length > NOTE_KEEP) notes.splice(0, notes.length - NOTE_KEEP);
  }
  const name = nameOf(s, r.seatId);
  if (r.kind === 'describe') {
    if (timeout) log(s, `${name} 描述超时，跳过。`);
    else log(s, a.text!.trim(), r.seatId);
    s.speechIndex++;
    nextSpeaker(s);
    return;
  }
  if (r.kind === 'blank_guess') {
    const guess = timeout ? '' : a.text!.trim();
    const correct = !!guess && normalizeWord(guess) === normalizeWord(s.words.civilian);
    event(s, { type: 'blank_guess', day: s.day, seatId: r.seatId, correct });
    log(s, guess ? `${name} 猜平民的词是「${guess}」，猜${correct ? '对' : '错'}了。` : `${name} 放弃猜词。`);
    if (correct) finish(s, 'blank');
    else nextRound(s);
    return;
  }
  s.answers[r.seatId] = timeout || a.skip ? { skip: true } : { target: a.target };
  if (s.requests.length) return;
  resolveVote(s);
}

function resolveVote(s: UndercoverState) {
  const counts = new Map<string, number>();
  for (const p of living(s)) {
    const target = s.answers[p.id]?.target;
    if (target) counts.set(target, (counts.get(target) || 0) + 1);
    log(s, target ? `${p.name} 投给 ${nameOf(s, target)}。` : `${p.name} 弃权。`);
  }
  const max = Math.max(0, ...counts.values()),
    top = [...counts].filter(([, n]) => n === max).map(([id]) => id);
  if (top.length > 1 && s.voteRound === 0) {
    s.voteRound = 1;
    s.runoff = s.seats.filter((p) => top.includes(p.id)).map((p) => p.id);
    s.speakers = [...s.runoff];
    s.speechIndex = 0;
    s.phase = 'speech';
    log(s, `平票，${s.runoff.map((id) => nameOf(s, id)).join('、')} 各补充一句描述后重新投票。`);
    nextSpeaker(s);
    return;
  }
  if (top.length !== 1) {
    log(s, top.length ? '再次平票，本轮无人出局。' : '全部弃权，本轮无人出局。');
    nextRound(s);
    return;
  }
  const out = s.seats.find((p) => p.id === top[0])!;
  out.alive = false;
  event(s, {
    type: 'exile',
    day: s.day,
    seatId: out.id,
    voters: living(s)
      .concat(out)
      .filter((p) => s.answers[p.id]?.target === out.id)
      .map((p) => p.id),
  });
  log(s, `${out.name} 出局，身份是${ROLE_NAMES[out.role]}。`);
  if (out.role === 'blank' && living(s).some((p) => p.role === 'undercover' || p.role === 'civilian')) {
    s.phase = 'resolution';
    s.requests = [];
    log(s, `${out.name} 是白板，可以猜一次平民的词，猜中则白板获胜。`);
    request(s, out.id, 'blank_guess');
    return;
  }
  nextRound(s);
}

export function viewUndercover(s: UndercoverState, viewerId?: string, omniscient = false): GameView {
  const self = s.seats.find((p) => p.id === viewerId);
  const reveal = s.status === 'finished' || (!s.seats.some((p) => p.human) && omniscient);
  const timed = s.requests.filter((r) => r.deadlineAt || r.remainingMs !== undefined);
  const human = (id: string) => !!s.seats.find((p) => p.id === id)?.human;
  const clockRequest = (timed.some((r) => human(r.seatId)) ? timed.filter((r) => human(r.seatId)) : timed)
    .slice()
    .sort((a, b) => (a.deadlineAt || a.remainingMs || 0) - (b.deadlineAt || b.remainingMs || 0))[0];
  return {
    mode: 'undercover',
    revision: s.revision,
    clock: clockRequest
      ? {
          deadlineAt: human(clockRequest.seatId) ? clockRequest.deadlineAt : undefined,
          remainingMs: human(clockRequest.seatId) ? clockRequest.remainingMs : undefined,
          seatId: clockRequest.kind === 'describe' ? clockRequest.seatId : undefined,
        }
      : undefined,
    id: s.id,
    groupId: s.groupId,
    day: s.day,
    phase: s.phase,
    status: s.status,
    seats: s.seats.map(({ role, ...seat }) => ({
      ...seat,
      // A seat's role is announced when it is voted out; a blank knows it is blank; nobody else learns their own.
      ...(reveal || !seat.alive || (seat.id === viewerId && role === 'blank') ? { role } : {}),
    })),
    logs: viewLogs(s, viewerId, reveal),
    pending: s.requests.filter((r) => r.seatId === viewerId),
    winner: s.winner,
    words: {
      ...(self && wordOf(s, self.role) ? { own: wordOf(s, self.role) } : {}),
      ...(reveal ? { civilian: s.words.civilian, undercover: s.words.undercover } : {}),
    },
    ...(s.status === 'finished' && s.trace?.length ? { endedAt: s.trace.at(-1)!.time } : {}),
    error: s.error,
    humanId: s.seats.find((p) => p.human)?.id,
    ...(viewerId && s.notes?.[viewerId]?.length ? { notes: [...s.notes[viewerId]] } : {}),
    ...personaView(s, viewerId, reveal),
  };
}

/** Who's the Spy in the persona module's terms (docs/ai-party-games-design.md §2.3). */
export function undercoverFacts(s: UndercoverState): MatchFacts {
  const seat = new Map(s.seats.map((p) => [p.id, p]));
  const label = (id: string) => `${s.seats.findIndex((p) => p.id === id) + 1} 号`;
  const social: SocialFact[] = [];
  for (const e of s.events || []) {
    if (e.type !== 'exile') continue;
    const out = seat.get(e.seatId)!;
    const mates = e.voters.filter((v) => seat.get(v)?.role === out.role);
    if (!mates.length) continue;
    social.push({
      type: 'ally_vote',
      name: 'exiled_by_teammate',
      to: out.id,
      from: mates,
      key: `第 ${e.day} 轮，{to} 被同阵营的 {from} 投出`,
      highlight: `第 ${e.day} 轮，你（${ROLE_NAMES[out.role]}）被同阵营的 {from} 投出`,
    });
  }
  // Every key decision is record-only: what was chosen and what the vote turned out to hit.
  const experiences: MatchExperience[] = [];
  for (const d of s.decisions || []) {
    const actor = seat.get(d.seatId),
      target = d.subject ? seat.get(d.subject) : undefined;
    if (!actor?.botId || d.kind !== 'vote' || !target) continue;
    experiences.push({
      botId: actor.botId,
      kind: d.kind,
      s: {},
      o: 0,
      growthDisposition: 'record_only',
      summary: `投票给 ${label(target.id)}，揭晓是${ROLE_NAMES[target.role]}`,
      seats: [actor.id, target.id],
    });
  }
  const guessed = (s.events || []).some((e) => e.type === 'blank_guess' && e.correct);
  return {
    id: s.id,
    groupId: s.groupId,
    game: '谁是卧底',
    seats: s.seats.map((p) => ({
      id: p.id,
      name: p.name,
      human: p.human,
      ...(p.botId ? { botId: p.botId } : {}),
      team: p.role,
      role: ROLE_NAMES[p.role],
      planKey: 'undercover:player',
    })),
    ...(s.winner ? { winners: [s.winner] } : {}),
    result:
      s.winner === 'civilian'
        ? '平民获胜'
        : s.winner === 'undercover'
          ? '卧底获胜'
          : guessed
            ? '白板猜中平民的词，白板获胜'
            : '白板获胜',
    details: [`词：平民「${s.words.civilian}」，卧底「${s.words.undercover}」。`],
    social,
    experiences,
    ...(s.personaPolicy ? { personaPolicy: s.personaPolicy } : {}),
    ...(s.decisions ? { decisions: s.decisions } : {}),
    ...(s.persona ? { persona: s.persona } : {}),
  };
}
