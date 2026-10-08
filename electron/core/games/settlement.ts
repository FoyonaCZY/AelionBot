import type { GroupChats } from '../group/group-chats';
import type { PersonaService } from '../persona/persona-service';
import { collectGrowthObservations } from '../persona/growth-observations';
import type { WerewolfState } from './werewolf';

/** Replay-safe completion of the three durable effects. Only return after every effect is acknowledged. */
export function settleFinishedGame(
  match: WerewolfState,
  persona: Pick<PersonaService, 'settle' | 'recordGrowthObservations'> | undefined,
  groups: Pick<GroupChats, 'postGameResult'> | undefined,
) {
  if (!match.winner) return;
  if (!persona || !groups) throw Error('对局结算服务尚未就绪');
  const report = persona.settle({ ...match, events: match.events || [] }, { replayReport: true });
  if (Object.keys(match.persona || {}).length) persona.recordGrowthObservations(collectGrowthObservations(match));
  if (report) groups.postGameResult(match.groupId, report, match.id, { adoptLegacy: match.settlementLegacy });
}
