import type { Bot, ChatMessage, RunRecord } from '../../shared/types/core';
import type { GroupSummary } from '../../shared/types/group-types';

/** Tools that act on a Bot's own desktop; shell and file tools run in the VM without touching the screen. */
const DESKTOP_TOOLS = new Set(['computer', 'request_user_control']);

/**
 * Whose desktop a group's computer card shows: the member that most recently acted on its desktop in this group,
 * else the first current member that has one. Every Bot keeps its own desktop, so the card follows whoever works.
 */
export function groupDesktopBotId(
  group: Pick<GroupSummary, 'id' | 'members'>,
  runs: readonly Pick<RunRecord, 'id' | 'botId' | 'groupOrigin'>[],
  messages: readonly Pick<ChatMessage, 'role' | 'tool' | 'runId' | 'botId'>[],
  bots: readonly Pick<Bot, 'id'>[],
): string | undefined {
  const usable = new Set(bots.map((bot) => bot.id));
  const groupRuns = new Set(runs.filter((run) => run.groupOrigin?.groupId === group.id).map((run) => run.id));
  if (groupRuns.size)
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (
        message.role === 'tool' &&
        DESKTOP_TOOLS.has(message.tool || '') &&
        message.runId &&
        groupRuns.has(message.runId) &&
        usable.has(message.botId)
      )
        return message.botId;
    }
  return group.members.find((member) => !member.leftAt && usable.has(member.id))?.id;
}
