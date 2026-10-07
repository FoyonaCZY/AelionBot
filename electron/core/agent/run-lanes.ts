/**
 * A Bot works on one thing at a time per lane, and on its lanes at the same time: its main lane (the private chat,
 * with its group and delegated work) and one lane per work session.
 */
export const runLane = (botId: string, sessionId?: string | null) => (sessionId ? `${botId}#${sessionId}` : botId);
/** The Bot a lane belongs to. */
const laneBot = (lane: string) => lane.split('#')[0];
/** The work session a lane belongs to; undefined for the main lane. */
const laneSession = (lane: string): string | undefined => lane.split('#')[1];
/**
 * Whether a lane is one asked about: `sessionId` undefined asks about every lane of the Bot, null about its main lane
 * and a string about that work session's.
 */
export const laneMatches = (lane: string, botId: string, sessionId?: string | null) =>
  laneBot(lane) === botId && (sessionId === undefined || (laneSession(lane) ?? null) === sessionId);
