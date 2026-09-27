import type { Bot, ChatMessage, Snapshot } from '../../shared/types/core';
import { conversationTimeline } from '../../shared/chat/activity';
import { isPrivatePeerOrigin } from '../../shared/types/peer-types';

/** What the selected bot's direct conversation shows, derived from the snapshot on every render. */
export function botConversation(state: Snapshot | undefined, bot: Bot | undefined) {
  const currentModel = bot ? state?.botModels?.[bot.id] || state?.model : state?.model;
  const messages =
    state?.messages.filter(
      (message) =>
        message.botId === bot?.id &&
        (message.audience === 'user' ||
          !state.runs.some((run) => run.id === message.runId && isPrivatePeerOrigin(run.peerOrigin))),
    ) || [];
  const runMessages = new Map<string, ChatMessage[]>();
  for (const message of messages)
    if (message.runId) {
      const list = runMessages.get(message.runId) || [];
      list.push(message);
      runMessages.set(message.runId, list);
    }
  const timeline = conversationTimeline(messages);
  const liveReplies = (state?.streamingReplies || []).filter((reply) => reply.main && reply.botId === bot?.id),
    liveSignature = liveReplies.map((reply) => reply.id + ':' + reply.content).join('|');
  const lastContext = state?.runs
    .filter(
      (run) => run.botId === bot?.id && !isPrivatePeerOrigin(run.peerOrigin) && !run.groupOrigin && run.contextOverview,
    )
    .at(-1)?.contextOverview;
  const latestRun = state?.runs
    .filter((run) => run.botId === bot?.id && !isPrivatePeerOrigin(run.peerOrigin) && !run.groupOrigin)
    .at(-1);
  const running = Boolean(
    state?.runs.some((run) => run.botId === bot?.id && run.status === 'running' && !run.groupOrigin) ||
    (currentModel?.model &&
      state!.messages.some((message) => message.botId === bot?.id && message.inputState === 'queued')),
  );
  const greeting = state?.greetingBotIds?.includes(bot?.id || '') || false;
  const requests = state?.interactions || [];
  const waiting = requests.find(
    (request) => request.botId === bot?.id && !state?.runs.find((run) => run.id === request.runId)?.groupOrigin,
  );
  return {
    currentModel,
    messages,
    runMessages,
    timeline,
    liveReplies,
    liveSignature,
    lastContext,
    latestRun,
    running,
    greeting,
    requests,
    waiting,
  };
}

export type BotConversationData = ReturnType<typeof botConversation>;
