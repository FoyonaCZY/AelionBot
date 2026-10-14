/**
 * Werewolf's episodes for the persona module: what each Bot's key decisions turned out to be once roles were
 * revealed. Semantic decisions are record-only: a revealed role does not tell us
 * why a choice was made, and the model's interpretation is not evidence of a lasting trait change. The old
 * outcome-based growth rules remain only for legacy decisions so existing match settlement can be replayed.
 */
import type { GameEvent, GameRole } from '../../../shared/types/game-types';
import type { MatchExperience } from '../persona/match-facts';
import type { PersonaDecision } from './persona-play';

interface GrowthSeat {
  id: string;
  name: string;
  botId?: string;
  role: GameRole;
}
const camp = (role: GameRole) => (role === 'wolf' ? 'wolves' : 'village');

export function matchExperiences(
  seats: GrowthSeat[],
  decisions: PersonaDecision[],
  events: GameEvent[],
  seatOrder = seats.map((s) => s.id),
): MatchExperience[] {
  const seat = (id: string) => seats.find((p) => p.id === id);
  // Filtering forgotten members must not change the original table's seat numbers.
  const label = (id: string) => `${seatOrder.indexOf(id) + 1} 号`;
  const out: MatchExperience[] = [];
  for (const d of decisions) {
    const actor = seat(d.seatId);
    const recordOnly = d.selectionMethod === 'model_semantic_v1' || d.growthDisposition === 'record_only';
    if (!actor?.botId || (d.strong && !recordOnly)) continue;
    const base = {
      botId: actor.botId,
      kind: d.kind,
      s: recordOnly ? {} : d.features,
      ...(recordOnly ? { growthDisposition: 'record_only' as const } : {}),
    };
    const target = d.subject ? seat(d.subject) : undefined;
    // Votes, shots and potions: right when they land on the camp they should (enemy for hostile acts, own for saves).
    if ((d.kind === 'vote' || d.kind === 'shoot' || (d.kind === 'witch' && d.chosen.potion === 'poison')) && target) {
      const right = camp(target.role) !== camp(actor.role);
      const verb = d.kind === 'vote' ? '投票给' : d.kind === 'shoot' ? '开枪带走' : '毒了';
      out.push({
        ...base,
        o: recordOnly ? 0 : right ? 1 : -1,
        summary: `${verb} ${label(target.id)}，揭晓是${target.role === 'wolf' ? '狼人' : '好人'}`,
        seats: [actor.id, target.id],
      });
    } else if (d.kind === 'witch' && d.chosen.potion === 'save' && target) {
      const right = camp(target.role) === camp(actor.role);
      out.push({
        ...base,
        o: recordOnly ? 0 : right ? 1 : -1,
        summary: `救了 ${label(target.id)}，揭晓是${target.role === 'wolf' ? '狼人' : '好人'}`,
        seats: [actor.id, target.id],
      });
    } else if (d.kind === 'sheriff_join' && d.chosen.choice) {
      // 2·(elected − 1/k): subtract the chance one of k standing candidates wins anyway, so the rule that only one
      // can be elected does not teach every Bot to stay out (appendix C round 8).
      const vote = events.find(
        (e): e is Extract<GameEvent, { type: 'elect' }> => e.type === 'elect' && e.day === d.day,
      );
      if (!vote) continue;
      const standing = vote.applicants.filter((id) => !(vote.withdrawn || []).includes(id));
      if (!standing.includes(d.seatId) || standing.length < 2) continue;
      const elected = vote.seatId === d.seatId;
      out.push({
        ...base,
        o: recordOnly ? 0 : 2 * ((elected ? 1 : 0) - 1 / standing.length),
        summary: `上警竞选，${standing.length} 人参选，${elected ? '当选警长' : '落选'}`,
        seats: [actor.id],
      });
    }
  }
  return out;
}
