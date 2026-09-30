import type { GameLog, GameView } from '../../shared/types/game-types';

type Seat = GameView['seats'][number];
export type Period = 'night' | 'day' | 'finished';

export const periodOf = (game: Pick<GameView, 'phase' | 'status'>): Period =>
  game.status === 'finished' || game.phase === 'finished' ? 'finished' : game.phase === 'night' ? 'night' : 'day';

/** Seat number (1-based) for an id, or 0 when the id is not seated. */
export const seatNumber = (game: GameView, id?: string) => (id ? game.seats.findIndex((p) => p.id === id) + 1 : 0);

export interface PhaseStep {
  key: 'night' | 'election' | 'speech' | 'vote';
  state: 'done' | 'now' | 'next';
}
/** The stepper for the current day: night, the day-one sheriff election, speeches, then the exile vote. */
export function phaseSteps(game: GameView): PhaseStep[] {
  const keys: PhaseStep['key'][] = [
    'night',
    ...(game.day === 1 && game.board ? (['election'] as const) : []),
    'speech',
    'vote',
  ];
  const at = game.phase === 'resolution' ? (game.stage?.includes('放逐') ? 'vote' : 'speech') : game.phase;
  const now = keys.indexOf(at as PhaseStep['key']);
  return keys.map((key, index) => ({
    key,
    state: game.status === 'finished' || index < now ? 'done' : index === now ? 'now' : 'next',
  }));
}

/** Private results the rules engine sent only to the human: checks, potions, wolf-team notes. */
export function personalClues(game: GameView): GameLog[] {
  if (!game.humanId) return [];
  // The view strips audiences; personal lines carry scope, and other players' private lines start with 【…】.
  return game.logs.filter(
    (log) =>
      !log.seatId &&
      log.scope === 'personal' &&
      !log.text.startsWith('【') &&
      /查验结果|解药|毒药|狼队友|同伴/.test(log.text),
  );
}

export interface TallyRow {
  target: Seat;
  voters: Array<{ seat: Seat; weight: number }>;
  total: number;
}
export type TranscriptItem =
  { kind: 'log'; log: GameLog } | { kind: 'tally'; id: number; day: number; rows: TallyRow[]; abstain: Seat[] };

const bySeatName = (game: GameView) => {
  // Longest names first so "大鲸鱼" is not matched inside "中大鲸鱼"-style names.
  const seats = [...game.seats].sort((a, b) => b.name.length - a.name.length);
  return (text: string) => seats.find((seat) => text.startsWith(seat.name));
};
const VOTE = /^(.+?) 投给 (.+?)(?:（([\d.]+) 票）)?。$/;
const ABSTAIN = /^(.+?) (?:弃票|弃权)。$/;
/**
 * Groups each run of consecutive "A 投给 B" / "A 弃票" system lines into one tally, so a vote reads as a table of
 * who voted for whom instead of twelve separate lines. Anything that does not parse stays a plain log line.
 */
export function transcriptItems(game: GameView): TranscriptItem[] {
  const find = bySeatName(game),
    items: TranscriptItem[] = [];
  let open: Extract<TranscriptItem, { kind: 'tally' }> | undefined;
  for (const log of game.logs) {
    const vote = log.seatId ? null : VOTE.exec(log.text),
      abstain = log.seatId || vote ? null : ABSTAIN.exec(log.text);
    const voter = vote ? find(vote[1]) : abstain ? find(abstain[1]) : undefined,
      target = vote ? find(vote[2]) : undefined;
    if (!voter || (vote && !target)) {
      open = undefined;
      items.push({ kind: 'log', log });
      continue;
    }
    if (!open || open.day !== log.day) {
      open = { kind: 'tally', id: log.id, day: log.day, rows: [], abstain: [] };
      items.push(open);
    }
    if (!target) {
      open.abstain.push(voter);
      continue;
    }
    let row = open.rows.find((entry) => entry.target.id === target.id);
    if (!row) open.rows.push((row = { target, voters: [], total: 0 }));
    const weight = Number(vote![3] || 1);
    row.voters.push({ seat: voter, weight });
    row.total += weight;
  }
  for (const item of items) if (item.kind === 'tally') item.rows.sort((a, b) => b.total - a.total);
  return items;
}

/** How a seat left the game, read from the shared log; undefined while alive or when no line names it. */
export function seatFate(game: GameView, seat: Seat): { day: number; text: string } | undefined {
  if (seat.alive) return;
  for (const log of game.logs) {
    if (log.seatId || !log.text.includes(seat.name)) continue;
    if (log.text.includes(`${seat.name} 被放逐`)) return { day: log.day, text: '被放逐' };
    // The shot line names the hunter first; only the seat after 开枪， was shot.
    if (log.text.includes(`开枪，${seat.name} 出局`)) return { day: log.day, text: '被猎人带走' };
    if (/^猎人 .+ 开枪/.test(log.text)) continue;
    if (/天亮了，.+ 出局/.test(log.text) || log.text.includes(`${seat.name} 出局`))
      return { day: log.day, text: '夜里出局' };
  }
  return;
}

/** Shared milestones for the match report: sheriff, night deaths, exiles, shots, idiot flips and the result. */
export function reportTimeline(game: GameView): GameLog[] {
  return game.logs.filter(
    (log) =>
      !log.seatId &&
      log.scope !== 'personal' &&
      /当选警长|警徽流失|天亮了|被放逐|开枪|翻牌|无人被放逐|获胜/.test(log.text),
  );
}

/**
 * Keeps the setup selection in step with the group: members who left lose their seat, and newly joined members take
 * free seats up to the limit. Returns the same array when nothing changed so React can skip the update.
 */
export function syncSeats(current: string[], members: string[], joined: string[], limit: number) {
  const kept = current.filter((id) => members.includes(id)),
    next = [...kept, ...joined.filter((id) => members.includes(id) && !kept.includes(id))].slice(0, limit);
  return next.length === current.length && next.every((id, i) => id === current[i]) ? current : next;
}

/** Minutes between the first and last logged event, when the log carries times. */
export function matchMinutes(game: GameView) {
  const times = game.logs.map((log) => log.time).filter((time): time is number => typeof time === 'number');
  return times.length > 1 ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 60000)) : undefined;
}
