/**
 * Forking a chat: a new work session that starts where the Bot's main chat or one of its work sessions stood after its
 * last completed task. It takes the messages up to the end of that task, the model history behind them and the
 * chat's folder and permission mode. Work that came later (running, failed or stopped tasks, waiting input) stays
 * behind, as do group and delegated work, which only the main chat can take part in. The two chats go their own ways
 * from there; files on disk are shared, as for any two chats in the same folder.
 */
import { randomUUID } from 'node:crypto';
import type { ChatMessage, RunRecord, WorkSession } from '../../../shared/types/core';
import type { HostPermissionMode } from '../../../shared/types/permission-types';
import { workspaceKey } from '../../../shared/types/work-types';
import { AppError } from '../../../shared/errors';
import { Store } from '../storage/store';
import { chatInputText } from './chat-input';

export function forkConversation(
  store: Store,
  input: { botId: string; sessionId?: string },
  /** The permission mode a chat works in (HostApprovals.modeForScope). */
  modeOf: (scope: { kind: 'bot'; id: string; sessionId?: string }) => HostPermissionMode,
): WorkSession {
  const bot = store.bot(String(input?.botId || '')),
    sessionId = typeof input?.sessionId === 'string' && input.sessionId ? input.sessionId : undefined,
    source = sessionId ? store.data.workSessions?.find((item) => item.id === sessionId) : undefined;
  if (sessionId && source?.botId !== bot.id) throw new AppError('session.not_found', '工作会话不存在');
  const runs = new Map(store.data.runs.filter((run) => run.botId === bot.id).map((run) => [run.id, run]));
  const messages = store.data.messages.filter((message) => message.botId === bot.id && message.sessionId === sessionId);
  const own = (run?: RunRecord) => !run?.groupOrigin && !run?.peerOrigin;
  let end = -1;
  for (let index = messages.length - 1; index >= 0 && end < 0; index--) {
    const run = runs.get(messages[index].runId || '');
    if (run?.status === 'completed' && own(run)) end = index;
  }
  if (end < 0) throw new AppError('session.fork_empty', '这个会话还没有完成过任务，没有可以 fork 的记录');
  const kept = messages
    .slice(0, end + 1)
    .filter(
      (message) =>
        own(runs.get(message.runId || '')) &&
        !message.groupTaskSource &&
        !message.groupLink &&
        !message.taskSource &&
        !message.peer &&
        !message.peerSummaryFor &&
        message.inputState !== 'queued',
    );

  const now = new Date().toISOString();
  const session: WorkSession = {
    id: randomUUID(),
    botId: bot.id,
    name: `${(source?.name || bot.name).slice(0, 72)} (fork)`,
    createdAt: now,
    updatedAt: now,
  };
  const runIds = new Map<string, string>(),
    messageIds = new Map<string, string>();
  for (const message of kept) {
    messageIds.set(message.id, randomUUID());
    if (message.runId && runs.has(message.runId) && !runIds.has(message.runId)) runIds.set(message.runId, randomUUID());
  }
  const copiedRuns = [...runIds].map(([from, to]) => {
    const {
      workItemId: _workItem,
      designSessionId: _design,
      groupReplyMessageId: _groupReply,
      resumedFromRunId,
      supersedesRunId,
      ...run
    } = structuredClone(runs.get(from)!);
    return {
      ...run,
      id: to,
      sessionId: session.id,
      ...(resumedFromRunId && runIds.has(resumedFromRunId) ? { resumedFromRunId: runIds.get(resumedFromRunId) } : {}),
      ...(supersedesRunId && runIds.has(supersedesRunId) ? { supersedesRunId: runIds.get(supersedesRunId) } : {}),
    } as RunRecord;
  });
  const copiedMessages = kept.map((message) => {
    const { designSessionId: _design, openDesignSessionId: _openDesign, ...copy } = structuredClone(message);
    const next: ChatMessage = { ...copy, id: messageIds.get(message.id)!, sessionId: session.id };
    if (message.runId) {
      if (runIds.has(message.runId)) next.runId = runIds.get(message.runId);
      else delete next.runId;
    }
    if (next.reply && messageIds.has(next.reply.messageId))
      next.reply.messageId = messageIds.get(next.reply.messageId)!;
    if (next.reaction && messageIds.has(next.reaction.messageId))
      next.reaction.messageId = messageIds.get(next.reaction.messageId)!;
    return next;
  });

  // The model history up to the input of the first task after the cut; all of it when that input is not found.
  const sourceKey = sessionId ? Store.sessionHistoryKey(sessionId) : bot.id,
    history = store.data.conversations[sourceKey] || [];
  const later = messages
    .slice(end + 1)
    .find((message) => message.role === 'user' && message.runId && own(runs.get(message.runId)));
  let cut = history.length;
  if (later) {
    const text = chatInputText(later);
    for (let index = history.length - 1; index >= 0; index--) {
      const wire = history[index];
      if (wire.role === 'user' && typeof wire.content === 'string' && wire.content.startsWith(text)) {
        cut = index;
        break;
      }
    }
  }

  const from = { kind: 'bot' as const, id: bot.id, ...(sessionId ? { sessionId } : {}) },
    to = { kind: 'bot' as const, id: bot.id, sessionId: session.id },
    folder = store.data.conversationWorkspaces?.[workspaceKey(from)];
  store.replaceData({
    ...store.data,
    workSessions: [...(store.data.workSessions || []), session],
    messages: [...store.data.messages, ...copiedMessages],
    runs: [...store.data.runs, ...copiedRuns],
    conversations: {
      ...store.data.conversations,
      [Store.sessionHistoryKey(session.id)]: structuredClone(history.slice(0, cut)),
    },
    conversationWorkspaces: {
      ...store.data.conversationWorkspaces,
      ...(folder ? { [workspaceKey(to)]: folder } : {}),
    },
    hostPermissionModes: {
      ...store.data.hostPermissionModes,
      [workspaceKey(to)]: modeOf(from),
    },
  });
  return session;
}
