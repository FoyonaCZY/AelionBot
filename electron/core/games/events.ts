import type { GameEvent } from '../../../shared/types/game-types';

/** Record a structured fact (exile, save) for post-match settlement. Logs stay human-readable text. */
export function event(s: { events?: GameEvent[] }, e: GameEvent) {
  (s.events ||= []).push(e);
}
