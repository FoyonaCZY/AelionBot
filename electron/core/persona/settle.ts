import type { GameEvent, GameRole } from '../../../shared/types/game-types';
import type { PersonaDecision } from '../games/persona-play';

/** The parts of a finished match that settlement reads. Seat ids are per match; botId is the member Bot. */
interface SettleSeat {
  id: string;
  name: string;
  human: boolean;
  botId?: string;
  role: GameRole;
}
export interface SettleMatch {
  id: string;
  groupId: string;
  winner?: 'wolves' | 'village';
  seats: SettleSeat[];
  events: GameEvent[];
  /** New matches retain same-camp exile as a fact without inferring betrayal or a grudge. */
  personaPolicy?: 'model_semantic_v1';
  decisions?: PersonaDecision[];
}
interface AffinityChange {
  botId: string;
  targetId: string;
  value: number;
  durationDays: number;
  source: string;
}
interface HighlightDraft {
  botId: string;
  participants: string[];
  summary: string;
  type: 'exiled_by_teammate' | 'saved_by_witch' | 'match';
}
export interface Settlement {
  affinity: AffinityChange[];
  highlights: HighlightDraft[];
  recap: string;
}
const ROLE: Record<GameRole, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  villager: '村民',
  hunter: '猎人',
  idiot: '白痴',
  guard: '守卫',
};
const camp = (role: GameRole) => (role === 'wolf' ? 'wolves' : 'village');
/** The persona identity of a seat: its Bot, 'user' for the human, none for temporary guests. */
const who = (s: SettleSeat) => (s.human ? 'user' : s.botId);

/**
 * Rule-based settlement of one finished match (docs/ai-personality-module.md §9.6, stage 1).
 * Only unusual events move affinity; being exiled or killed by the other side is normal play and is not recorded.
 * A match stopped without a winner is not settled.
 */
export function settleMatch(m: SettleMatch): Settlement | undefined {
  if (!m.winner) return undefined;
  const seat = new Map(m.seats.map((s) => [s.id, s]));
  const affinity: AffinityChange[] = [];
  const highlights: HighlightDraft[] = [];
  const key: string[] = [];
  const semantic =
    m.personaPolicy === 'model_semantic_v1' || m.decisions?.some((d) => d.selectionMethod === 'model_semantic_v1');
  for (const e of m.events) {
    if (e.type === 'exile') {
      const out = seat.get(e.seatId);
      if (!out) continue;
      const mates = e.voters
        .map((v) => seat.get(v))
        .filter((v): v is SettleSeat => !!v && camp(v.role) === camp(out.role));
      if (!mates.length) continue;
      key.push(`第 ${e.day} 天，${out.name} 被同阵营的 ${mates.map((v) => v.name).join('、')} 投票放逐`);
      const me = out.botId;
      if (!me) continue;
      for (const v of mates) {
        const target = who(v);
        if (!target || target === me) continue;
        // The action may be a planned wolf sacrifice or an honest mistake. Record what happened, not a motive.
        if (!semantic)
          affinity.push({
            botId: me,
            targetId: target,
            value: -0.4,
            durationDays: 30,
            source: `match:${m.id}:exiled_by_teammate`,
          });
      }
      highlights.push({
        botId: me,
        participants: mates.map(who).filter((x): x is string => !!x),
        summary: `第 ${e.day} 天，你（${ROLE[out.role]}）被同阵营的 ${mates.map((v) => v.name).join('、')} 投票放逐`,
        type: 'exiled_by_teammate',
      });
    } else if (e.type === 'save') {
      const saved = seat.get(e.seatId),
        witch = seat.get(e.witchId);
      if (!saved || !witch) continue;
      key.push(`第 ${e.day} 夜，女巫 ${witch.name} 救下了 ${saved.name}`);
      const me = saved.botId,
        target = who(witch);
      if (!me || !target || target === me) continue;
      affinity.push({
        botId: me,
        targetId: target,
        value: 0.3,
        durationDays: 30,
        source: `match:${m.id}:saved_by_witch`,
      });
      highlights.push({
        botId: me,
        participants: [target],
        summary: `第 ${e.day} 夜，女巫 ${witch.name} 用解药救下了你`,
        type: 'saved_by_witch',
      });
    }
  }
  const winners = m.seats.filter((s) => camp(s.role) === m.winner);
  for (const a of winners)
    for (const b of winners) {
      const me = a.botId,
        target = who(b);
      if (a === b || !me || !target || target === me) continue;
      affinity.push({
        botId: me,
        targetId: target,
        value: 0.1,
        durationDays: 14,
        source: `match:${m.id}:won_together`,
      });
    }
  const lineup = m.seats.map((s) => `${s.name}（${ROLE[s.role]}）`).join('、');
  const result = m.winner === 'village' ? '好人阵营获胜' : '狼人阵营获胜';
  for (const s of m.seats) {
    if (!s.botId) continue;
    const won = camp(s.role) === m.winner;
    highlights.push({
      botId: s.botId,
      participants: m.seats
        .filter((o) => o !== s)
        .map(who)
        .filter((x): x is string => !!x),
      summary: `一局狼人杀：你是${ROLE[s.role]}，${won ? '赢了' : '输了'}（${result}）${key.length ? '；' + key.join('；') : ''}`,
      type: 'match',
    });
  }
  const recap = [
    `狼人杀战报：${result}。`,
    `身份：${lineup}。`,
    ...(key.length ? [`关键事件：${key.join('；')}。`] : []),
  ].join('\n');
  return { affinity, highlights, recap };
}
