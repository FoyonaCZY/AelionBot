import type { GameEvent, GameRole } from '../../../shared/types/game-types';
import { planRole } from '../../../shared/persona/persona-model';
import type { MatchFacts, SocialFact } from '../persona/match-facts';
import type { PersonaDecision, SeatPersona } from './persona-play';
import { matchExperiences } from './werewolf-experiences';

/** The parts of a finished Werewolf match that settlement reads. */
export interface WerewolfResult {
  id: string;
  groupId: string;
  winner?: 'wolves' | 'village';
  seats: { id: string; name: string; human: boolean; botId?: string; role: GameRole }[];
  events: GameEvent[];
  personaPolicy?: 'model_semantic_v1';
  decisions?: PersonaDecision[];
  persona?: Record<string, SeatPersona>;
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

/** Werewolf in the persona module's terms: camps are teams, a same-camp exile and a witch's save are social facts. */
export function werewolfFacts(m: WerewolfResult): MatchFacts {
  const seat = new Map(m.seats.map((s) => [s.id, s]));
  const social: SocialFact[] = [];
  for (const e of m.events) {
    if (e.type === 'exile') {
      const out = seat.get(e.seatId);
      if (!out) continue;
      const mates = e.voters.filter((v) => seat.has(v) && camp(seat.get(v)!.role) === camp(out.role));
      if (!mates.length) continue;
      social.push({
        type: 'ally_vote',
        name: 'exiled_by_teammate',
        to: out.id,
        from: mates,
        key: `第 ${e.day} 天，{to} 被同阵营的 {from} 投票放逐`,
        highlight: `第 ${e.day} 天，你（${ROLE[out.role]}）被同阵营的 {from} 投票放逐`,
      });
    } else if (e.type === 'save') {
      if (!seat.has(e.seatId) || !seat.has(e.witchId)) continue;
      social.push({
        type: 'aid',
        name: 'saved_by_witch',
        from: e.witchId,
        to: e.seatId,
        key: `第 ${e.day} 夜，女巫 {from} 救下了 {to}`,
        highlight: `第 ${e.day} 夜，女巫 {from} 用解药救下了你`,
      });
    }
  }
  return {
    id: m.id,
    groupId: m.groupId,
    game: '狼人杀',
    seats: m.seats.map((s) => ({
      id: s.id,
      name: s.name,
      human: s.human,
      ...(s.botId ? { botId: s.botId } : {}),
      team: camp(s.role),
      role: ROLE[s.role],
      planKey: planRole(s.role),
    })),
    ...(m.winner ? { winners: [m.winner] } : {}),
    result: m.winner === 'village' ? '好人阵营获胜' : '狼人阵营获胜',
    social,
    experiences: matchExperiences(m.seats, m.decisions || [], m.events),
    ...(m.personaPolicy ? { personaPolicy: m.personaPolicy } : {}),
    ...(m.decisions ? { decisions: m.decisions } : {}),
    ...(m.persona ? { persona: m.persona } : {}),
  };
}
