import { resolveChatReply } from './message-replies';
import { workCommand } from '../../../shared/types/work-types';
import { effectiveWorkspace } from '../storage/workspaces';
import { Attachments } from '../attachments/attachments';
import type { HostComputer } from '../host/host';
import type { Store } from '../storage/store';
import type { HarnessRunOptions } from './peer-runtime-types';
import type { BotMention, ChatMessage } from '../../../shared/types/core';
import type { ScheduledTrigger } from '../../../shared/types/scheduled-types';
import { chatInputText, validateChatInput } from './chat-input';
import { pinDescription, updatePins, validPin, type PinActor, type PinInput } from '../../../shared/chat/reactions';
import { AppError } from '../../../shared/errors';
import { laneMatches, runLane } from './run-lanes';

export function pinChat(store: Store, botId: string, actor: PinActor, input: PinInput, runId?: string) {
  validPin(input);
  store.bot(botId);
  const target = store.data.messages.find(
    (message) =>
      message.id === input.messageId &&
      message.botId === botId &&
      !message.reaction &&
      ['user', 'assistant'].includes(message.role) &&
      (message.content || message.attachments?.length) &&
      (!message.status || message.status === 'done') &&
      (!message.runId || !store.data.runs.find((run) => run.id === message.runId)?.groupOrigin),
  );
  if (!target) throw new AppError('chat.reaction_target_invalid', '只能回应当前聊天里已发送的文字消息');
  const reactingUser =
    actor.kind === 'bot' &&
    runId &&
    store.data.runs.some((run) => run.id === runId && run.botId === botId && run.status === 'running') &&
    store.data.messages.find(
      (message) =>
        message.botId === botId &&
        message.runId === runId &&
        message.role === 'user' &&
        message.reaction?.messageId === target.id &&
        !message.reaction.removed &&
        target.pins?.some((pin) => pin.actor.id === 'user' && pin.emoji === message.reaction!.emoji),
    );
  if (actor.kind === 'bot' && target.role !== 'user' && !reactingUser)
    throw new AppError('chat.reaction_target_ambiguous', '请选择用户的消息，或当前用户表态所指向的原消息');
  if (!updatePins(target, actor, input)) return { pinned: !input.remove, alreadyApplied: true, messageId: target.id };
  store.touch(target);
  const event = store.message(
    botId,
    actor.kind === 'user' ? 'user' : 'event',
    pinDescription(actor, input, target.content),
    {
      reaction: { messageId: target.id, emoji: input.emoji, removed: Boolean(input.remove) },
      ...(runId ? { runId } : {}),
      // A reaction belongs to the conversation of the message it reacts to.
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    },
  );
  return { pinned: !input.remove, messageId: target.id, eventId: event.id };
}

export class ChatPinQueue {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  /** Keyed by lane (see runLane): each of a Bot's chats has its own worker and superseded run. */
  private workers = new Set<string>();
  private superseded = new Map<string, string>();
  constructor(
    private store: Store,
    private runner: {
      /** Whether the Bot works in this lane: its main chat (`sessionId` null) or one work session. */
      isRunning: (id: string, sessionId: string | null) => boolean;
      run: (id: string, input: string, options: HarnessRunOptions) => Promise<void>;
      /** Lets the Bot's running work yield to new input in this conversation; returns the run it superseded. */
      refresh?: (id: string, sessionId?: string) => string | undefined;
    },
    private changed: () => void,
    private attachments = new Attachments(store),
    private host?: HostComputer,
  ) {}
  private queued(message: ChatMessage) {
    return (
      message.role === 'user' &&
      !message.runId &&
      (message.inputState === 'queued' || Boolean(message.reaction && !message.inputState))
    );
  }
  /** Whether any of these Bots has queued input or a worker, in one pass over the messages. */
  anyPending(botIds: string[]) {
    const ids = new Set(botIds);
    for (const id of ids) if (this.hasWorker(id)) return true;
    return this.store.data.messages.some((message) => ids.has(message.botId) && this.queued(message));
  }
  /** Whether the Bot has input waiting or starting: anywhere, in its main chat (`sessionId` null) or one session. */
  hasPending(id: string, sessionId?: string | null) {
    return (
      this.hasWorker(id, sessionId) ||
      this.store.data.messages.some(
        (message) =>
          message.botId === id &&
          this.queued(message) &&
          (sessionId === undefined || (message.sessionId ?? null) === sessionId),
      )
    );
  }
  private hasWorker(id: string, sessionId?: string | null) {
    for (const lane of this.workers) if (laneMatches(lane, id, sessionId)) return true;
    return false;
  }
  private received(botId: string, sessionId?: string) {
    const previous = this.runner.refresh?.(botId, sessionId);
    if (previous) this.superseded.set(runLane(botId, sessionId), previous);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.changed();
    this.wake();
  }
  send(input: {
    designSessionId?: string;
    botId: string;
    sessionId?: string;
    message: string;
    previewPrompt?: string;
    replyToMessageId?: string;
    mentions?: BotMention[];
    attachmentIds?: string[];
  }) {
    if (this.closed) throw new Error('客户端正在退出');
    if (
      input.previewPrompt !== undefined &&
      (typeof input.previewPrompt !== 'string' || input.previewPrompt.length > 12000)
    )
      throw Error('无效预览意见');
    const attachments = this.attachments.forDraft({ kind: 'bot', id: input?.botId }, input?.attachmentIds),
      mentions = validateChatInput(
        this.store,
        input?.botId,
        input?.message,
        input?.mentions,
        Boolean(attachments.length),
      );
    if (!this.store.modelFor(input.botId).model) throw new Error('请先为这个 Bot 选择模型');
    const sessionId = input.sessionId || undefined;
    if (
      sessionId !== undefined &&
      !this.store.data.workSessions?.some((session) => session.id === sessionId && session.botId === input.botId)
    )
      throw new AppError('session.not_found', '工作会话不存在');
    const command = workCommand(input.message);
    if (command && !command.objective)
      throw new AppError('task.objective_missing', `请在 /${command.kind} 后填写任务内容`);
    const reply = resolveChatReply(this.store, input.botId, input.replyToMessageId);
    this.store.message(input.botId, 'user', input.message, {
      mentions,
      attachments,
      designSessionId: input.designSessionId,
      ...(input.previewPrompt !== undefined ? { previewPrompt: input.previewPrompt } : {}),
      ...(reply ? { reply } : {}),
      ...(sessionId ? { sessionId } : {}),
      workspaceDir: effectiveWorkspace(this.store, this.host, {
        kind: 'bot',
        id: input.botId,
        ...(sessionId ? { sessionId } : {}),
      }),
      inputState: 'queued',
    });
    this.touchSession(sessionId);
    this.received(input.botId, sessionId);
  }
  /** Queues a scheduled task's prompt in the Bot's main chat, or in its work session `sessionId`. */
  schedule(botId: string, message: string, scheduled: ScheduledTrigger, sessionId?: string) {
    if (this.closed) throw new Error('客户端正在退出');
    validateChatInput(this.store, botId, message);
    if (
      sessionId &&
      !this.store.data.workSessions?.some((session) => session.id === sessionId && session.botId === botId)
    )
      throw new AppError('session.not_found', '工作会话不存在');
    if (this.store.data.messages.some((message) => message.scheduled?.occurrenceId === scheduled.occurrenceId)) return;
    this.store.message(botId, 'user', message, {
      scheduled,
      inputState: 'queued',
      ...(sessionId ? { sessionId } : {}),
    });
    this.changed();
    this.wake();
  }
  pin(input: PinInput & { botId: string }) {
    if (this.closed) throw new Error('客户端正在退出');
    const result = pinChat(this.store, input.botId, { kind: 'user', id: 'user', name: '你' }, input);
    if (result.eventId) {
      const event = this.store.data.messages.find((message) => message.id === result.eventId)!;
      event.inputState = 'queued';
      this.store.save();
      this.received(input.botId, event.sessionId);
    } else this.changed();
  }
  wake() {
    if (
      this.closed ||
      this.timer ||
      !this.store.data.messages.some((message) => this.queued(message) && this.store.modelFor(message.botId).model)
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Each of a Bot's chats is its own lane: its main chat and every work session start as soon as they are free.
      const lanes = new Map<string, ChatMessage[]>();
      for (const message of this.store.data.messages)
        if (this.queued(message)) {
          const lane = runLane(message.botId, message.sessionId);
          lanes.set(lane, [...(lanes.get(lane) || []), message]);
        }
      for (const [lane, queued] of lanes) {
        const botId = queued[0].botId,
          sessionId = queued[0].sessionId;
        if (
          !this.store.modelFor(botId).model ||
          this.runner.isRunning(botId, sessionId ?? null) ||
          this.workers.has(lane)
        )
          continue;
        const human = queued.filter((message) => !message.scheduled),
          candidate = human.length ? human : queued.slice(0, 1),
          first = candidate[0],
          batch = candidate.filter((message) => message.designSessionId === first.designSessionId),
          latest = batch.at(-1)!;
        this.workers.add(lane);
        const supersedesRunId = this.superseded.get(lane);
        this.superseded.delete(lane);
        void this.runner
          .run(botId, chatInputText(latest, false), {
            designSessionId: latest.designSessionId,
            ...(latest.sessionId ? { sessionId: latest.sessionId } : {}),
            inputMessageIds: batch.map((message) => message.id),
            reactionMessageId: latest.reaction ? latest.id : undefined,
            mentions: latest.reaction ? undefined : latest.mentions,
            supersedesRunId,
          })
          .catch((error) => {
            for (const message of batch) if (!message.runId) message.inputState = 'cancelled';
            if (this.store.data.bots.some((bot) => bot.id === botId))
              this.store.message(
                botId,
                'event',
                `这次输入未能处理：${String((error as Error).message).slice(0, 300)}`,
                sessionId ? { sessionId } : {},
              );
          })
          .finally(() => {
            this.workers.delete(lane);
            this.store.save();
            this.changed();
            this.wake();
          });
      }
    }, 80);
  }
  /** Cancels queued input: all of the Bot's, or only one conversation's (`null` for its main chat). */
  cancel(botId: string, sessionId?: string | null) {
    for (const message of this.store.data.messages)
      if (
        message.botId === botId &&
        this.queued(message) &&
        (sessionId === undefined || (message.sessionId ?? null) === sessionId)
      )
        message.inputState = 'cancelled';
    for (const lane of this.superseded.keys()) if (laneMatches(lane, botId, sessionId)) this.superseded.delete(lane);
    this.store.save();
    this.changed();
  }
  /** A work session moves up the conversation list when the user writes in it. */
  private touchSession(sessionId?: string) {
    const session = sessionId ? this.store.data.workSessions?.find((item) => item.id === sessionId) : undefined;
    if (!session) return;
    session.updatedAt = new Date().toISOString();
    delete session.archivedAt;
  }
  dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    let dirty = false;
    for (const message of this.store.data.messages)
      if (this.queued(message)) {
        message.inputState = 'interrupted';
        dirty = true;
      }
    if (dirty) this.store.save();
  }
}
