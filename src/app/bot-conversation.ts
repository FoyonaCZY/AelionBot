import type { Bot, ChatMessage, RunRecord, Snapshot } from '../../shared/types/core';
import { conversationTimeline } from '../../shared/chat/activity';
import { firstDeliveries } from '../../shared/types/attachment-types';
import { isPrivatePeerOrigin } from '../../shared/types/peer-types';

/**
 * What the selected bot's direct conversation shows, derived from the state. Live replies are not part of it: they
 * change many times a second and are read where they are shown (useStreamingReplies).
 */
export function botConversation(state: Snapshot | undefined, bot: Bot | undefined) {
  const currentModel = bot ? state?.botModels?.[bot.id] || state?.model : state?.model;
  const runsById = new Map<string, RunRecord>((state?.runs || []).map((run) => [run.id, run]));
  const messages =
    state?.messages.filter(
      (message) =>
        message.botId === bot?.id &&
        (message.audience === 'user' ||
          !message.runId ||
          !isPrivatePeerOrigin(runsById.get(message.runId)?.peerOrigin)),
    ) || [];
  const runMessages = new Map<string, ChatMessage[]>();
  for (const message of messages)
    if (message.runId) {
      const list = runMessages.get(message.runId) || [];
      list.push(message);
      runMessages.set(message.runId, list);
    }
  const timeline = conversationTimeline(messages);
  const botRuns = (state?.runs || []).filter(
    (run) => run.botId === bot?.id && !isPrivatePeerOrigin(run.peerOrigin) && !run.groupOrigin,
  );
  const lastContext = botRuns.filter((run) => run.contextOverview).at(-1)?.contextOverview;
  const latestRun = botRuns.at(-1);
  const running = Boolean(
    state?.runs.some((run) => run.botId === bot?.id && run.status === 'running' && !run.groupOrigin) ||
    (currentModel?.model &&
      state!.messages.some((message) => message.botId === bot?.id && message.inputState === 'queued')),
  );
  const greeting = state?.greetingBotIds?.includes(bot?.id || '') || false;
  const requests = state?.interactions || [];
  const waiting = requests.find((request) => request.botId === bot?.id && !runsById.get(request.runId)?.groupOrigin);
  return {
    currentModel,
    messages,
    runMessages,
    runsById,
    /** Messages shown with fewer attachments than they hold (see firstDeliveries). */
    shown: firstDeliveries(messages),
    timeline,
    lastContext,
    latestRun,
    running,
    greeting,
    requests,
    waiting,
  };
}

export type BotConversationData = ReturnType<typeof botConversation>;
