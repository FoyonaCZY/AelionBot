import type { Bot, ChatMessage, RunRecord, WorkSession } from '../../shared/types/core';
import type { GroupSummary } from '../../shared/types/group-types';
import { isPrivatePeerOrigin } from '../../shared/types/peer-types';

const timestamp = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};
const later = (a: string, b?: string) => (b && timestamp(b) > timestamp(a) ? b : a);

/** A work session in the list, under its Bot: the last message shown for it and when it was last active. */
export type SessionRow = { session: WorkSession; last?: ChatMessage; time: string };

/**
 * Bots in the list, the most recently active first. A Bot's row shows its main chat; its work sessions sit under it
 * and keep it up the list while they are active (archived ones do not).
 */
export function botConversationRows(
  bots: Bot[],
  messages: ChatMessage[],
  runs: RunRecord[] = [],
  sessions: WorkSession[] = [],
) {
  const privateRuns = new Set(runs.filter((run) => isPrivatePeerOrigin(run.peerOrigin)).map((run) => run.id));
  const latest = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (
      message.role === 'tool' ||
      message.reaction ||
      (!message.content.trim() && !message.attachments?.length) ||
      (privateRuns.has(message.runId || '') && message.audience !== 'user')
    )
      continue;
    const key = message.sessionId ? 'session:' + message.sessionId : message.botId;
    const previous = latest.get(key);
    if (!previous || timestamp(message.time) >= timestamp(previous.time)) latest.set(key, message);
  }
  return bots
    .map((bot, index) => {
      const last = latest.get(bot.id);
      const own: SessionRow[] = sessions
        .filter((session) => session.botId === bot.id)
        .map((session) => {
          const sessionLast = latest.get('session:' + session.id);
          return { session, last: sessionLast, time: later(session.updatedAt, sessionLast?.time) };
        })
        .sort((a, b) => timestamp(b.time) - timestamp(a.time));
      const time = own
        .filter((row) => !row.session.archivedAt)
        .reduce((value, row) => later(value, row.time), last?.time || bot.createdAt);
      return { bot, last, sessions: own, time, index };
    })
    .sort((a, b) => timestamp(b.time) - timestamp(a.time) || a.index - b.index);
}

type ConversationRow = (
  { kind: 'bot'; bot: Bot; last?: ChatMessage; sessions: SessionRow[] } | { kind: 'group'; group: GroupSummary }
) & {
  time: string;
};

export function conversationRows(
  bots: Bot[],
  messages: ChatMessage[],
  groups: GroupSummary[] = [],
  runs: RunRecord[] = [],
  sessions: WorkSession[] = [],
): ConversationRow[] {
  const rows: ConversationRow[] = [
    ...botConversationRows(bots, messages, runs, sessions).map(({ bot, last, sessions, time }) => ({
      kind: 'bot' as const,
      bot,
      last,
      sessions,
      time,
    })),
    ...groups.map((group) => ({ kind: 'group' as const, group, time: group.updatedAt })),
  ];
  return rows.sort((a, b) => timestamp(b.time) - timestamp(a.time));
}
