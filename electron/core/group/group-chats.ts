import { buildGroupDecisionInput, type GroupDecisions } from './laya-decision';
import { previewFeedbackDisplay } from '../../../shared/preview/preview-feedback';
import { groupEventPrompt, groupMustAnswerNote, groupReviewNote, GROUP_STATE_EVENT_PROMPT } from './group-prompt';
import { answerFrom, botMessageCount, noticed, sinceUser, triage } from './group-triage';
import { isGroupAnswer, replyTarget } from '../../../shared/chat/group-answers';
import { userDisplayName } from '../../../shared/chat/user-profile';
import { resolveGroupReply } from '../agent/message-replies';
import { workCommand, type WorkItem } from '../../../shared/types/work-types';
import { botIdentity } from '../../../shared/chat/bot-colors';
import { effectiveWorkspace } from '../storage/workspaces';
import type { HostComputer } from '../host/host';
import { randomUUID, createHash } from 'node:crypto';
import type { GroupMessage } from '../../../shared/types/group-types';
import type { Bot, BotMention, RunRecord } from '../../../shared/types/core';
import {
  GROUP_LIMITS,
  groupPending,
  type GroupDelivery,
  type GroupLifecycleEvent,
  type GroupPage,
  type GroupRoom,
  type GroupRound,
  type GroupSender,
  type GroupSummary,
  type GroupsView,
} from '../../../shared/types/group-types';
import { hasSilenceMarker, normalized } from './group-response';
import { isEmptyGroupReply } from '../../../shared/chat/group-empty-reply';
import { rememberPublished } from './group-history';
import { pinDescription, updatePins, validPin, type PinInput } from '../../../shared/chat/reactions';
import { readableContent } from '../../../shared/chat/activity';
import { botMentions } from '../../../shared/chat/mentions';
import { Attachments } from '../attachments/attachments';
import { groupReplyContent } from '../../../shared/chat/message-envelope';
import { attachmentSummary } from '../../../shared/types/attachment-types';
import { Store } from '../storage/store';
import type { HarnessRunOptions } from '../agent/peer-runtime-types';
import type { GroupGateway } from './group-runtime-types';
import type { ScheduledTrigger } from '../../../shared/types/scheduled-types';
import { AppError } from '../../../shared/errors';

interface Runner {
  isRunning: (id: string) => boolean;
  run: (id: string, input: string, options: HarnessRunOptions) => Promise<void>;
  cancel: (id: string) => void;
  refresh?: (id: string) => void;
}
interface Worker {
  botId: string;
  groupId: string;
  rootId: string;
  deliveries: GroupDelivery[];
  controller: AbortController;
  runId?: string;
  preempted?: boolean;
  /** The last room message this run has taken into account before its final reply. */
  seenSeq: number;
  /** One-time notes already sent back to the model before its final reply. */
  noted: Set<'must'>;
}
type FinalReplyDecision = { kind: 'silent' } | { kind: 'publish'; content: string };
const now = () => new Date().toISOString();
const identity = botIdentity;
const human: GroupSender = { kind: 'user', id: 'user', name: '你' };
const system: GroupSender = { kind: 'system', id: 'system', name: '系统' };
function required(value: unknown, label: string, max: number) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw new Error(`${label}无效`);
  return value.trim();
}
const workLane = (message: GroupMessage | undefined) =>
  message?.workItemId || (message?.sender.kind === 'user' && workCommand(message.content) ? message.id : undefined);
const pendingOrResumable = (delivery: GroupDelivery) =>
  groupPending(delivery.status) || (delivery.status === 'interrupted' && delivery.resumable === true);
const publicationFailure = (error: unknown) => `群消息补发失败：${String((error as Error).message).slice(0, 300)}`;
const INTERRUPTED_REASONS = ['应用重启，等待用户继续', '应用退出，等待用户继续'];
/**
 * Quitting or restarting is not the user stopping the discussion. Only rounds that still had work in flight are
 * marked stopped and offered for resuming; a round whose work already finished stays as it was.
 */
function interruptPending(store: Store, reason: string) {
  const cut = new Set<string>();
  for (const delivery of store.data.groupDeliveries)
    if (groupPending(delivery.status)) {
      delivery.status = 'interrupted';
      delivery.reason = reason;
      if (delivery.recipientId !== 'user') delivery.resumable = true;
      cut.add(delivery.rootId);
    } else if (pendingOrResumable(delivery)) cut.add(delivery.rootId);
  for (const round of store.data.groupRounds)
    if (round.status === 'active' && cut.has(round.id)) {
      round.status = 'stopped';
      round.reason = reason;
    }
}
export class GroupChats implements GroupGateway {
  private revision = 0;
  private enabled = false;
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private workers = new Map<string, Worker>();
  /** Laya relevance checks in flight, by delivery. */
  private deciding = new Map<string, AbortController>();
  constructor(
    private store: Store,
    private runner: Runner,
    private changed: () => void,
    private attachments = new Attachments(store),
    private host?: HostComputer,
    private laya?: GroupDecisions,
    /** Persona lines (affinity, shared memories) appended to a Bot's group context; empty string when none. */
    private persona?: (botId: string, people: { id: string; name: string }[]) => string,
  ) {
    // Publication may commit just before the process exits, before the inbox receipt is saved.
    const recovering = store.data.groupDeliveries.filter(pendingOrResumable);
    const recoveringRuns = new Set(recovering.map((delivery) => delivery.runId));
    const committedReplies = new Map<RunRecord, { room: GroupRoom; message: GroupMessage }>();
    for (const entry of store.data.groupOutbox || [])
      if (entry.status === 'sent' && entry.messageId && recoveringRuns.has(entry.runId)) {
        const run = store.data.runs.find(
          (r) =>
            r.id === entry.runId &&
            r.botId === entry.botId &&
            r.groupOrigin?.groupId === entry.groupId &&
            r.status === 'completed',
        );
        const room = store.data.groups.find((g) => g.id === entry.groupId),
          message = room?.messages.find((m) => m.id === entry.messageId);
        if (run && room && message?.kind === 'message' && message.seq > (committedReplies.get(run)?.message.seq || 0))
          committedReplies.set(run, { room, message });
      }
    for (const run of store.data.runs) {
      if (run.status !== 'completed' || !run.groupOrigin || !recoveringRuns.has(run.id)) continue;
      const room = store.data.groups.find((g) => g.id === run.groupOrigin!.groupId);
      if (!room) continue;
      const deliveries = recovering.filter((d) => d.runId === run.id && d.groupId === room.id && pendingOrResumable(d));
      if (!deliveries.length) continue;
      const published = this.publishedReplies(room, run).at(-1),
        legacy = committedReplies.get(run)?.message,
        reply = legacy && (!published || legacy.seq > published.seq) ? legacy : published;
      const round = this.round(run.groupOrigin.rootId);
      // A persisted model answer can precede its publication. Recover through the same
      // outbox path as a live run, including deduplication and attachment handling.
      if (
        round.status === 'stopped' &&
        (INTERRUPTED_REASONS.includes(round.reason || '') ||
          deliveries.some((delivery) => delivery.resumable && delivery.retryRunId === run.id))
      ) {
        round.status = 'active';
        delete round.reason;
      }
      try {
        this.finishReply(room, run, round, deliveries, reply);
      } catch (error) {
        // A failed publication must not prevent startup or rerun completed model work.
        // Limit enforcement may already have settled these deliveries as limited.
        // Startup pauses pending rounds below, after every completed run gets its recovery attempt.
        this.deferReply(run, deliveries, publicationFailure(error), false);
      }
    }
    // Earlier versions stopped finished rounds on quit; those have nothing to resume.
    for (const round of store.data.groupRounds)
      if (
        round.status === 'stopped' &&
        INTERRUPTED_REASONS.includes(round.reason || '') &&
        !store.data.groupDeliveries.some((d) => d.rootId === round.id && d.resumable)
      ) {
        round.status = 'active';
        delete round.reason;
      }
    interruptPending(store, '应用重启，等待用户继续');
    store.save();
  }
  get busy() {
    return this.workers.size > 0;
  }
  /** Public progress is not an answer; a non-withdrawn reaction is. */
  private publishedReplies(room: GroupRoom, run: RunRecord) {
    return room.messages.filter(
      (message) => message.sender.id === run.botId && message.runIds?.includes(run.id) && isGroupAnswer(message),
    );
  }
  /** Keep each explicit answer's receipt; a final summary can acknowledge the remaining batch. */
  private acknowledgeReplies(room: GroupRoom, run: RunRecord, deliveries: GroupDelivery[], fallback: GroupMessage) {
    const replies = this.publishedReplies(room, run).reverse();
    run.groupReplyMessageId = fallback.id;
    this.store.touch(run);
    for (const delivery of deliveries) {
      const reply =
        replies.find(
          (message) =>
            message.answers === delivery.messageId ||
            replyTarget(message) === delivery.messageId ||
            message.reaction?.messageId === delivery.messageId,
        ) || fallback;
      delivery.status = 'replied';
      delivery.replyMessageId = reply.id;
      delete delivery.reason;
      delete delivery.resumable;
    }
  }
  /** A publication pause retains completed work; a user stop clears these resumable receipts. */
  private publicationPaused(round: GroupRound) {
    return (
      round.status === 'stopped' &&
      this.store.data.groupDeliveries.some(
        (delivery) =>
          delivery.rootId === round.id &&
          delivery.resumable &&
          delivery.retryRunId === delivery.runId &&
          this.store.data.runs.some((run) => run.id === delivery.retryRunId && run.status === 'completed'),
      )
    );
  }
  /** A completed model run still owns its unpublished answer after every failed publication attempt. */
  private deferReply(run: RunRecord, deliveries: GroupDelivery[], reason: string, pause = true) {
    for (const delivery of deliveries) {
      if (!pendingOrResumable(delivery)) continue;
      const round = this.round(delivery.rootId);
      if (round.status !== 'active' && !this.publicationPaused(round)) continue;
      delivery.status = 'interrupted';
      delivery.resumable = true;
      delivery.retryRunId = run.id;
      delivery.reason = reason;
    }
    if (!pause) return;
    for (const delivery of deliveries)
      if (delivery.resumable && delivery.retryRunId === run.id) {
        const round = this.round(delivery.rootId);
        if (round.status === 'active') {
          round.status = 'stopped';
          round.reason = reason;
        }
      }
  }
  layaChanged() {
    this.revision++;
    this.changed();
  }
  start() {
    this.enabled = true;
    this.wake();
  }
  wake() {
    if (
      !this.enabled ||
      this.closing ||
      this.timer ||
      !this.store.data.groupDeliveries.some((d) => d.status === 'queued')
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pump();
    }, 100);
  }
  private touch() {
    this.revision++;
    this.store.save();
    this.changed();
    this.wake();
  }
  private room(id: string) {
    const room = this.store.data.groups.find((room) => room.id === id);
    if (!room) throw new Error('群聊不存在或已删除');
    return room;
  }
  private round(id: string) {
    const round = this.store.data.groupRounds.find((round) => round.id === id);
    if (!round) throw new Error('群聊轮次不存在');
    return round;
  }
  private members(room: GroupRoom) {
    return room.members.filter((member) => !member.leftAt && this.store.data.bots.some((bot) => bot.id === member.id));
  }
  private member(room: GroupRoom, id: string) {
    if (!this.members(room).some((member) => member.id === id))
      throw new AppError('group.not_member', '只能访问自己加入的群聊');
  }
  private identities(room: GroupRoom) {
    return this.members(room).map((member) => identity(this.store.bot(member.id)));
  }
  /** Intercept the model's final group reply before it reaches the shared publisher. */
  private beforeFinalReplyPublish(content: string, attachments?: GroupMessage['attachments']): FinalReplyDecision {
    // Silence applies only to the text channel; completed file work still needs publication.
    if (hasSilenceMarker(content)) content = attachmentSummary(attachments);
    return content ? { kind: 'publish', content } : { kind: 'silent' };
  }
  receive(botId: string, runId: string) {
    const worker = this.workers.get(botId);
    if (!worker || worker.runId !== runId || worker.controller.signal.aborted) return [];
    const room = this.room(worker.groupId);
    this.member(room, botId);
    const run = this.store.data.runs.find((r) => r.id === runId),
      designId = room.messages.find((m) => m.id === worker.deliveries[0]?.messageId)?.designSessionId;
    // Messages may reach this safe boundary before the pump has triaged them.
    const holds: number[] = [];
    for (const delivery of this.store.data.groupDeliveries)
      if (
        delivery.groupId === room.id &&
        delivery.recipientId === botId &&
        delivery.status === 'queued' &&
        !delivery.triage
      )
        this.triageDelivery(room, delivery, holds);
    if (holds.length) this.wake();
    const deliveries = this.store.data.groupDeliveries
      .filter((d) => {
        if (
          d.groupId !== room.id ||
          d.recipientId !== botId ||
          d.status !== 'queued' ||
          d.triage !== 'wake' ||
          this.round(d.rootId).status !== 'active'
        )
          return false;
        const message = room.messages.find((m) => m.id === d.messageId);
        if (
          message?.designSessionId !== designId ||
          (workLane(message) && (!message?.workItemId || message.workItemId !== run?.workItemId))
        )
          return false;
        return true;
      })
      .slice(0, 8);
    for (const delivery of deliveries) {
      delivery.status = 'running';
      delivery.runId = runId;
      worker.deliveries.push(delivery);
    }
    if (deliveries.length) this.touch();
    const received = deliveries.map((d) => room.messages.find((m) => m.id === d.messageId)!).filter(Boolean);
    for (const message of received) worker.seenSeq = Math.max(worker.seenSeq, message.seq);
    return received;
  }
  /**
   * Checked when a run is about to end with a final reply. Returns a note to send the model back once,
   * or nothing to settle the reply now (design sections 6.2 and 7.4).
   */
  beforeFinal(botId: string, runId: string, content: string) {
    const worker = this.workers.get(botId);
    if (!worker || worker.runId !== runId || worker.controller.signal.aborted) return;
    const room = this.store.data.groups.find((item) => item.id === worker.groupId);
    if (!room) return;
    const silent = !content || hasSilenceMarker(content),
      own = new Set(worker.deliveries.map((delivery) => delivery.messageId)),
      excerpt = (message: GroupMessage) => ({
        messageId: message.id,
        from: message.sender.name,
        content: groupReplyContent(
          message.content,
          message.sender.kind === 'bot' ? message.sender.id : undefined,
        ).slice(0, 300),
      });
    // Look once more before speaking: someone answered the same message, or the user said something new.
    const arrived = room.messages.filter(
      (message) =>
        message.seq > worker.seenSeq &&
        message.sender.id !== botId &&
        message.kind !== 'reaction' &&
        ((message.sender.kind === 'user' && message.kind === 'message') ||
          [replyTarget(message), message.answers].some((id) => id && own.has(id))),
    );
    worker.seenSeq = room.messages.at(-1)?.seq || worker.seenSeq;
    if (arrived.length && !silent) return groupReviewNote(content, arrived.slice(-5).map(excerpt));
    const unanswered = worker.deliveries
      .filter((delivery) => delivery.must)
      .map((delivery) => room.messages.find((message) => message.id === delivery.messageId)!)
      .filter((message) => message && !answerFrom(room, message, botId));
    if (silent && unanswered.length && !worker.noted.has('must')) {
      worker.noted.add('must');
      return groupMustAnswerNote(unanswered.slice(-5).map(excerpt));
    }
  }
  /** Persist a private outbox entry first; publish text, delivery records and the receipt together. */
  private publish(
    room: GroupRoom,
    run: RunRecord,
    round: GroupRound,
    content: string,
    mentions: BotMention[],
    fields: {
      key: string;
      kind?: 'message' | 'progress';
      replyTo?: string;
      answers?: string;
      attachments?: GroupMessage['attachments'];
    },
  ) {
    this.member(room, run.botId);
    if (round.status !== 'active' || !['running', 'completed'].includes(run.status)) throw Error('本轮讨论已停止');
    if (hasSilenceMarker(content)) throw Error('静默标记是内部控制文本，不能作为群消息发布');
    const outbox = (this.store.data.groupOutbox ||= []),
      kind = fields.kind || 'message';
    const fingerprint = (
      value: {
        content: string;
        mentions?: BotMention[];
        attachments?: GroupMessage['attachments'];
        kind?: 'message' | 'progress';
        replyTo?: string;
        answers?: string;
      },
      includeTarget = true,
    ) =>
      JSON.stringify([
        value.kind || 'message',
        includeTarget ? value.replyTo || value.answers || null : null,
        value.content,
        value.mentions?.map((m) => m.id) || [],
        value.attachments?.map((a) => a.id) || [],
      ]);
    let entry = outbox.find(
      (item) =>
        item.botId === run.botId && item.groupId === room.id && item.rootId === round.id && item.key === fields.key,
    );
    const publication = {
      content,
      mentions,
      attachments: fields.attachments,
      kind,
      replyTo: fields.replyTo,
      answers: fields.answers,
    };
    // A final key deduplicates this sender's exact answer within one round, even
    // after peers' replies change its inferred target. Explicit keys commit their target too.
    const includeTarget = !fields.key.startsWith('final:');
    if (entry && fingerprint(entry, includeTarget) !== fingerprint(publication, includeTarget))
      throw new AppError('group.outbox_conflict', '同一发件标识不能用于不同内容');
    // Reuse the same publication even if an older version generated a different automatic key.
    entry ||= outbox.find(
      (item) =>
        item.botId === run.botId &&
        item.groupId === room.id &&
        item.runId === run.id &&
        fingerprint(item) === fingerprint(publication),
    );
    if (entry?.messageId) {
      const sent = room.messages.find((m) => m.id === entry!.messageId);
      if (sent) return sent;
      throw Error('发件回执对应的消息缺失');
    }
    if (this.enforceBotLimit(room))
      throw new AppError('group.bot_limit', `Bot 发言已达 ${GROUP_LIMITS.botStreak} 条，等待用户继续`);
    if (!entry) {
      entry = {
        id: randomUUID(),
        botId: run.botId,
        groupId: room.id,
        rootId: round.id,
        runId: run.id,
        key: fields.key,
        content,
        mentions,
        attachments: fields.attachments,
        kind,
        replyTo: fields.replyTo,
        answers: fields.answers,
        status: 'pending',
        createdAt: now(),
        designSessionId: run.designSessionId,
      };
      outbox.push(entry);
      try {
        // Desktop save() is deferred; a publication acknowledgement requires a disk commit.
        this.store.flush();
      } catch (error) {
        outbox.pop();
        throw error;
      }
    }
    const previous = {
      messages: room.messages.length,
      deliveries: this.store.data.groupDeliveries.length,
      updatedAt: room.updatedAt,
      activeRootId: room.activeRootId,
      botMessages: round.botMessages,
    };
    let message: GroupMessage;
    try {
      message = this.append(
        room,
        { kind: 'bot', ...identity(this.store.bot(run.botId)) },
        entry.content,
        round,
        entry.mentions,
        entry.kind,
        entry.replyTo,
        {
          attachments: entry.attachments,
          designSessionId: entry.designSessionId,
          runIds: [run.id],
          ...(entry.answers ? { answers: entry.answers } : {}),
        },
      );
      entry.status = 'sent';
      entry.messageId = message.id;
      this.store.flush();
    } catch (error) {
      const added = new Set(room.messages.slice(previous.messages).map((m) => m.id));
      room.messages.splice(previous.messages);
      this.store.data.groupDeliveries.splice(previous.deliveries);
      room.updatedAt = previous.updatedAt;
      room.activeRootId = previous.activeRootId;
      round.botMessages = previous.botMessages;
      for (const history of Object.values(this.store.data.groupContexts))
        for (let i = history.length - 1; i >= 0; i--)
          if (added.has(history[i].groupMessageId || '')) history.splice(i, 1);
      entry.status = 'pending';
      delete entry.messageId;
      throw error;
    }
    this.revision++;
    this.enforceBotLimit(room, message);
    this.changed();
    this.wake();
    return message;
  }
  prepareReply(botId: string, runId: string, content: string) {
    const run = this.store.data.runs.find((run) => run.id === runId && run.botId === botId && run.status === 'running');
    if (!run?.groupOrigin) throw new Error('群聊任务已结束');
    const room = this.room(run.groupOrigin.groupId);
    this.member(room, botId);
    return botMentions(content, this.identities(room), botId);
  }
  publishProgress(botId: string, runId: string, content: string) {
    const run = this.store.data.runs.find((run) => run.id === runId && run.botId === botId && run.status === 'running');
    if (!run?.groupOrigin) throw new Error('群任务已结束');
    const room = this.room(run.groupOrigin.groupId),
      worker = this.workers.get(botId);
    this.member(room, botId);
    if (!worker || worker.runId !== runId || worker.controller.signal.aborted) throw new Error('群消息已更新');
    if (isEmptyGroupReply(content)) return;
    const previous = [...room.messages]
      .reverse()
      .find((message) => message.sender.id === botId && message.kind === 'progress');
    if (previous?.content === content) return;
    const round = this.round(run.groupOrigin.rootId);
    if (round.status !== 'active') throw new Error('本轮讨论已停止');
    this.publish(room, run, round, content, [], {
      key: 'progress:' + createHash('sha256').update(content).digest('hex'),
      kind: 'progress',
    });
  }
  private botIds(value: unknown, min: number) {
    if (
      !Array.isArray(value) ||
      value.length < min ||
      value.length > GROUP_LIMITS.bots ||
      value.some((id) => typeof id !== 'string') ||
      new Set(value).size !== value.length
    )
      throw new Error(`请选择 ${min}–${GROUP_LIMITS.bots} 位 Bot`);
    return value.map((id) => this.store.bot(id));
  }
  private summary(room: GroupRoom): GroupSummary {
    const round = room.activeRootId
        ? this.store.data.groupRounds.find((item) => item.id === room.activeRootId)
        : undefined,
      workers = [...this.workers.values()].filter((worker) => worker.groupId === room.id),
      // Notices about the discussion itself (limits, nobody answered) are not what the group is saying.
      last = [...room.messages]
        .reverse()
        .find(
          (message) =>
            !message.notice &&
            !(
              message.sender.kind === 'bot' &&
              !message.attachments?.length &&
              isEmptyGroupReply(groupReplyContent(message.content, message.sender.id))
            ),
        );
    return {
      id: room.id,
      name: room.name,
      members: room.members.map((member) => {
        const live = this.store.data.bots.find((bot) => bot.id === member.id);
        if (!live) return member;
        const { avatarStyle: _avatarStyle, ...stored } = member;
        return { ...stored, ...identity(live) };
      }),
      createdBy: room.createdBy,
      updatedAt: room.updatedAt,
      preview:
        groupReplyContent(
          last ? previewFeedbackDisplay(last).content : '',
          last?.sender.kind === 'bot' ? last.sender.id : undefined,
        ).slice(0, 100) || attachmentSummary(last?.attachments),
      unread: room.messages.filter(
        (message) =>
          message.seq > room.lastReadSeq &&
          message.sender.kind === 'bot' &&
          !(
            ['message', 'progress'].includes(message.kind) &&
            !message.attachments?.length &&
            isEmptyGroupReply(groupReplyContent(message.content, message.sender.id))
          ),
      ).length,
      lastSeq: room.messages.at(-1)?.seq || 0,
      pending: this.store.data.groupDeliveries.filter((d) => d.groupId === room.id && groupPending(d.status)).length,
      ...(round
        ? { round: { id: round.id, status: round.status, botMessages: round.botMessages, reason: round.reason } }
        : {}),
      activities: [
        ...workers.map((worker) => ({ botId: worker.botId, phase: 'running' as const })),
        ...[
          ...new Set(
            this.store.data.groupDeliveries
              .filter((d) => d.groupId === room.id && d.status === 'deciding' && !this.workers.has(d.recipientId))
              .map((d) => d.recipientId),
          ),
        ].map((botId) => ({ botId, phase: 'deciding' as const })),
      ],
    };
  }
  snapshot(): GroupsView {
    return {
      revision: this.revision,
      rooms: this.store.data.groups
        .map((room) => this.summary(room))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      limits: GROUP_LIMITS,
    };
  }
  read(input: { id: string; before?: string }): GroupPage {
    const room = this.room(required(input?.id, '群聊 ID', 80));
    let end = room.messages.length;
    if (input.before) {
      end = room.messages.findIndex((message) => message.id === input.before);
      if (end < 0) throw new Error('消息位置已失效');
    }
    const start = Math.max(0, end - 60),
      messages = room.messages
        .slice(start, end)
        .map((message) =>
          message.sender.kind === 'bot' && !message.mentions
            ? { ...message, ...botMentions(message.content, this.identities(room), message.sender.id, false) }
            : message,
        ),
      ids = new Set(messages.map((message) => message.id));
    const deliveries = this.store.data.groupDeliveries.filter(
      (delivery) => delivery.groupId === room.id && ids.has(delivery.messageId),
    );
    const decisionIds = new Set(deliveries.map((delivery) => delivery.layaDecisionId || delivery.id));
    const laya = this.laya?.isReady
      ? {
          runtime: this.laya.runtimeName,
          enabled: true,
          ready: true,
          decisions: this.laya.read(decisionIds).flatMap((event) => {
            const delivery = this.store.data.groupDeliveries.find(
              (item) => item.id === event.sourceId && item.groupId === room.id,
            );
            return delivery
              ? [
                  {
                    ...event,
                    messageId: delivery.messageId,
                    deliveryStatus: delivery.status,
                    replyMessageId: delivery.replyMessageId,
                    runId: delivery.runId,
                    reason: delivery.reason,
                  },
                ]
              : [];
          }),
        }
      : undefined;
    return structuredClone({
      group: this.summary(room),
      messages,
      pins: Object.fromEntries(
        room.messages.filter((message) => message.pins?.length).map((message) => [message.id, message.pins!]),
      ),
      deliveries: laya ? deliveries : deliveries.map(({ layaDecisionId: _, ...delivery }) => delivery),
      laya,
      ...(start > 0 ? { before: messages[0].id } : {}),
    });
  }
  markRead(input: { id: string; seq: number }) {
    const room = this.room(required(input?.id, '群聊 ID', 80));
    if (!Number.isInteger(input.seq) || input.seq < 0 || input.seq > (room.messages.at(-1)?.seq || 0))
      throw new Error('消息位置无效');
    if (input.seq <= room.lastReadSeq) return;
    room.lastReadSeq = input.seq;
    for (const delivery of this.store.data.groupDeliveries.filter(
      (d) => d.groupId === room.id && d.recipientId === 'user' && d.status === 'delivered',
    )) {
      if ((room.messages.find((message) => message.id === delivery.messageId)?.seq || 0) <= input.seq)
        delivery.status = 'read';
    }
    this.touch();
  }
  private newRound(room: GroupRoom, request: string, originKey?: string) {
    const round: GroupRound = {
      id: randomUUID(),
      groupId: room.id,
      request: request.slice(0, 8000),
      status: 'active',
      createdAt: now(),
      botMessages: 0,
      createdGroups: 0,
      originKey,
    };
    this.store.data.groupRounds.push(round);
    room.activeRootId = round.id;
    return round;
  }
  private append(
    room: GroupRoom,
    sender: GroupSender,
    content: string,
    round?: GroupRound,
    mentions?: BotMention[],
    kind: import('../../../shared/types/group-types').GroupMessage['kind'] = sender.kind === 'system'
      ? 'system'
      : 'message',
    replyTo?: string,
    extra: Partial<
      Pick<
        import('../../../shared/types/group-types').GroupMessage,
        | 'id'
        | 'reaction'
        | 'runIds'
        | 'event'
        | 'attachments'
        | 'scheduled'
        | 'workItemId'
        | 'reply'
        | 'previewPrompt'
        | 'designSessionId'
        | 'answers'
        | 'notice'
      >
    > = {},
  ) {
    if (sender.kind === 'bot' && hasSilenceMarker(content))
      throw new Error('静默标记是内部控制文本，不能作为群消息发布');
    if (sender.kind === 'user') sender = { ...sender, name: userDisplayName(this.store.data.userProfile) };
    const message: import('../../../shared/types/group-types').GroupMessage = {
      ...(sender.kind === 'user'
        ? { workspaceDir: effectiveWorkspace(this.store, this.host, { kind: 'group', id: room.id }) }
        : {}),
      id: randomUUID(),
      seq: (room.messages.at(-1)?.seq || 0) + 1,
      groupId: room.id,
      sender,
      kind,
      content,
      time: now(),
      rootId: round?.id,
      mentions,
      replyTo,
      ...extra,
    };
    room.messages.push(message);
    rememberPublished(this.store, message);
    room.updatedAt = message.time;
    if (round) {
      const current = this.store.data.groupRounds.findIndex((r) => r.id === room.activeRootId);
      if (current < 0 || this.store.data.groupRounds.indexOf(round) >= current) room.activeRootId = round.id;
      for (const recipientId of ['user', ...this.members(room).map((member) => member.id)].filter(
        (id) => id !== sender.id,
      ))
        this.store.data.groupDeliveries.push({
          id: randomUUID(),
          groupId: room.id,
          messageId: message.id,
          recipientId,
          rootId: round.id,
          status: recipientId === 'user' ? 'delivered' : 'queued',
          createdAt: message.time,
        });
      if (sender.kind === 'bot' && (kind === 'message' || kind === 'progress')) {
        round.botMessages++;
      }
    }
    return message;
  }
  private lifecycle(room: GroupRoom, content: string, event: Omit<GroupLifecycleEvent, 'members'>, round?: GroupRound) {
    round ||= this.store.data.groupRounds.find((item) => item.id === room.activeRootId && item.status === 'active');
    round ||= this.newRound(room, `群状态变化：${content}。这是成员关系通知，不是新的工作任务或操作授权。`);
    return this.append(room, system, content, round, undefined, 'system', undefined, {
      event: { ...event, members: this.identities(room) },
    });
  }
  private createRoom(name: string, bots: Bot[], sender: GroupSender, round?: GroupRound) {
    const room: GroupRoom = {
      id: randomUUID(),
      name,
      members: bots.map((bot) => ({ ...identity(bot), joinedAt: now() })),
      createdBy: sender,
      createdAt: now(),
      updatedAt: now(),
      messages: [],
      lastReadSeq: 0,
    };
    this.store.data.groups.push(room);
    this.lifecycle(
      room,
      `${sender.name} 创建了群聊`,
      { type: 'created', actor: sender, joined: bots.map(identity), left: [] },
      round,
    );
    return room;
  }
  create(input: { name: string; botIds: string[] }) {
    const name = required(input?.name, '群名称', 80),
      bots = this.botIds(input?.botIds, 2);
    const room = this.createRoom(name, bots, human);
    this.touch();
    return this.summary(room);
  }
  update(input: { id: string; name: string; botIds: string[] }) {
    this.changeMembers(input, human);
  }
  private changeMembers(input: { id: string; name: string; botIds: string[] }, actor: GroupSender, round?: GroupRound) {
    const room = this.room(required(input?.id, '群聊 ID', 80)),
      name = required(input.name, '群名称', 80),
      bots = this.botIds(input.botIds, 1),
      ids = new Set(bots.map((bot) => bot.id));
    const previous = this.members(room),
      joined = bots.filter((bot) => !previous.some((member) => member.id === bot.id)).map(identity),
      left = previous.filter((member) => !ids.has(member.id)).map((member) => identity(this.store.bot(member.id)));
    for (const member of previous)
      if (!ids.has(member.id)) {
        member.leftAt = now();
        this.cancelMember(room.id, member.id, '已移出群聊');
      }
    for (const bot of bots)
      if (!previous.some((member) => member.id === bot.id)) {
        const old = room.members.find((member) => member.id === bot.id);
        if (old) {
          delete old.leftAt;
          old.joinedAt = now();
        } else room.members.push({ ...identity(bot), joinedAt: now() });
      }
    if (room.name !== name) {
      room.name = name;
      this.append(room, system, `群名称改为「${name}」`);
    }
    if (joined.length || left.length) {
      const content = [
        joined.length ? `${joined.map((bot) => bot.name).join('、')} 加入了群聊` : '',
        left.length ? `${left.map((bot) => bot.name).join('、')} 已移出群聊` : '',
      ]
        .filter(Boolean)
        .join('；');
      this.lifecycle(room, content, { type: 'members_changed', actor, joined, left }, round);
    }
    this.touch();
  }
  delete(id: string) {
    const room = this.room(required(id, '群聊 ID', 80));
    this.stop(id);
    this.store.data.workItems = this.store.data.workItems?.filter(
      (item) => item.scope.kind !== 'group' || item.scope.id !== id,
    );
    if (this.store.data.conversationWorkspaces) delete this.store.data.conversationWorkspaces['group:' + id];
    if (this.store.data.hostPermissionModes) delete this.store.data.hostPermissionModes['group:' + id];
    this.store.data.groups = this.store.data.groups.filter((item) => item !== room);
    this.store.data.groupDeliveries = this.store.data.groupDeliveries.filter((d) => d.groupId !== id);
    this.store.data.groupOutbox = this.store.data.groupOutbox?.filter((item) => item.groupId !== id);
    this.touch();
  }
  pinUser(input: PinInput & { groupId: string }) {
    return this.pin(this.room(required(input?.groupId, '群聊 ID', 80)), human, input);
  }
  private pin(room: GroupRoom, sender: GroupSender, input: PinInput, round?: GroupRound, runId?: string) {
    validPin(input);
    if (round && round.status !== 'active') throw new Error('本轮讨论已停止');
    if (sender.kind === 'system') throw new Error('系统消息不能表态');
    if (sender.kind === 'bot') this.member(room, sender.id);
    const target = room.messages.find(
      (message) => message.id === input.messageId && ['message', 'progress'].includes(message.kind),
    );
    if (!target) throw new AppError('group.reaction_target_invalid', '只能回应群里已发送的文字消息');
    if (sender.kind === 'bot' && target.sender.id === sender.id) throw new Error('请选择其他成员的消息进行回应');
    const previous = {
      pins: target.pins,
      messages: room.messages.length,
      deliveries: this.store.data.groupDeliveries.length,
      rounds: this.store.data.groupRounds.length,
      activeRootId: room.activeRootId,
      updatedAt: room.updatedAt,
      botMessages: round?.botMessages,
    };
    if (!updatePins(target, sender, input))
      return { pinned: !input.remove, alreadyApplied: true, messageId: target.id };
    const content = pinDescription(sender, input, target.content);
    let event: GroupMessage;
    try {
      round ||= this.newRound(room, '用户的表情态度（不是新任务或授权）：' + content);
      event = this.append(room, sender, content, round, undefined, 'reaction', target.id, {
        reaction: { messageId: target.id, emoji: input.emoji, removed: Boolean(input.remove) },
        ...(runId ? { runIds: [runId] } : {}),
      });
      // Persist the badge and its event together before acknowledging the reaction.
      this.store.flush();
    } catch (error) {
      target.pins = previous.pins;
      room.messages.splice(previous.messages);
      this.store.data.groupDeliveries.splice(previous.deliveries);
      this.store.data.groupRounds.splice(previous.rounds);
      room.activeRootId = previous.activeRootId;
      room.updatedAt = previous.updatedAt;
      if (round && previous.botMessages !== undefined) round.botMessages = previous.botMessages;
      throw error;
    }
    this.revision++;
    this.changed();
    this.wake();
    return { pinned: !input.remove, messageId: target.id, eventId: event.id };
  }
  private mentions(room: GroupRoom, content: string, value?: BotMention[]) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 12) throw new Error('提及的成员无效');
    let end = 0;
    return value.map((mention) => {
      if (
        !mention ||
        typeof mention.name !== 'string' ||
        !Number.isInteger(mention.start) ||
        !Number.isInteger(mention.end) ||
        mention.start < end ||
        mention.end > content.length ||
        content.slice(mention.start, mention.end) !== `@${mention.name}`
      )
        throw new Error('提及的位置已变化，请重新选择');
      this.member(room, mention.id);
      end = mention.end;
      return { ...identity(this.store.bot(mention.id)), name: mention.name, start: mention.start, end: mention.end };
    });
  }
  send(input: {
    designSessionId?: string;
    id: string;
    message: string;
    previewPrompt?: string;
    replyToMessageId?: string;
    mentions?: BotMention[];
    attachmentIds?: string[];
  }) {
    if (
      input.previewPrompt !== undefined &&
      (typeof input.previewPrompt !== 'string' || input.previewPrompt.length > 12000)
    )
      throw Error('无效预览意见');
    const command = workCommand(input?.message || '');
    if (command && !command.objective) throw Error(`请在 /${command.kind} 后填写任务内容`);
    const room = this.room(required(input?.id, '群聊 ID', 80)),
      attachments = this.attachments.forDraft({ kind: 'group', id: room.id }, input.attachmentIds);
    if (typeof input.message !== 'string') throw Error('消息无效');
    required(input.message || attachmentSummary(attachments), '消息', 32000);
    const reply = resolveGroupReply(room, input.replyToMessageId),
      replied = reply ? room.messages.find((m) => m.id === reply.messageId) : undefined,
      designSessionId = input.designSessionId || replied?.designSessionId;
    const mentions = this.mentions(room, input.message, input.mentions),
      round = this.newRound(room, input.message || `用户发送了 ${attachments.length} 个附件。`);
    this.settleInterrupted(room.id);
    this.append(room, human, input.message, round, mentions, 'message', undefined, {
      attachments,
      designSessionId,
      ...(input.previewPrompt !== undefined ? { previewPrompt: input.previewPrompt } : {}),
      ...(reply ? { reply } : {}),
    });
    this.touch();
  }
  /**
   * Post a finished game's report to its group. It is a plain system notice outside any round, so it wakes no Bot;
   * the key events it describes reach each Bot later through its persona context.
   */
  postGameResult(groupId: string, report: string, matchId?: string, options?: { adoptLegacy?: boolean }) {
    if (this.closing) throw new Error('客户端正在退出，战报尚未发布');
    const room = this.store.data.groups.find((g) => g.id === groupId);
    if (!room || !report.trim()) return;
    const id = matchId ? `game-result:${matchId}` : undefined;
    // Only a migrated pre-receipt checkpoint may adopt an old unkeyed report.
    // New matches always use their identity, even if their recap text is identical.
    const legacy =
      options?.adoptLegacy &&
      room.messages.some(
        (message) =>
          message.kind === 'system' &&
          message.sender.kind === 'system' &&
          !message.id.startsWith('game-result:') &&
          message.content === report.slice(0, 4000),
      );
    if (!legacy && (!id || !room.messages.some((message) => message.id === id)))
      this.append(room, system, report.slice(0, 4000), undefined, undefined, 'system', undefined, id ? { id } : {});
    // A failed write leaves the same event available for retry. Even a deduplicated
    // event must reach disk before the game's settlement may be acknowledged.
    this.store.flush();
    this.revision++;
    this.changed();
  }
  private personaContext(room: GroupRoom, botId: string, message?: GroupMessage) {
    if (!this.persona || !message) return '';
    const people: { id: string; name: string }[] = [];
    const add = (id: string, name: string) => {
      if (id !== botId && !people.some((p) => p.id === id)) people.push({ id, name });
    };
    if (message.sender.kind === 'user') add('user', userDisplayName(this.store.data.userProfile));
    else if (message.sender.kind === 'bot') add(message.sender.id, message.sender.name);
    for (const m of message.mentions || []) add(m.id, m.name);
    try {
      return people.length ? this.persona(botId, people) : '';
    } catch {
      return ''; // persona data is optional context; its failure must not block a reply
    }
  }
  schedule(id: string, prompt: string, scheduled: ScheduledTrigger) {
    if (this.closing) throw new Error('客户端正在退出');
    const room = this.room(id);
    required(prompt, '任务内容', 8000);
    if (room.messages.some((message) => message.scheduled?.occurrenceId === scheduled.occurrenceId)) return;
    const round = this.newRound(
      room,
      `定时任务「${scheduled.title}」的本次执行（计划时间 ${scheduled.scheduledFor}）：${prompt}\n这是已保存计划的触发，请直接完成本次任务，不要重新创建同一计划。原有工具权限仍然适用。`,
    );
    this.append(room, system, prompt, round, undefined, 'message', undefined, { scheduled });
    this.touch();
  }
  startWork(item: WorkItem) {
    const room = this.room(item.scope.id),
      bot = this.store.bot(item.botId);
    this.member(room, bot.id);
    const round = this.newRound(room, item.objective),
      content =
        '@' + bot.name + ' ' + (item.kind === 'plan' ? '开始执行已确认的计划：' : '继续执行目标：') + item.objective;
    this.append(
      room,
      human,
      content,
      round,
      [{ ...identity(bot), start: 0, end: bot.name.length + 1 }],
      'message',
      undefined,
      { workItemId: item.id },
    );
    this.touch();
  }
  continue(id: string) {
    const room = this.room(required(id, '群聊 ID', 80)),
      previous = room.activeRootId ? this.round(room.activeRootId) : undefined;
    if (previous?.status === 'active') throw new Error('这一轮仍可继续讨论');
    // Work cut off by a restart resumes where it was: same recipients, same runs, same plans.
    const interrupted = this.store.data.groupDeliveries.filter(
      (d) => d.groupId === room.id && d.status === 'interrupted' && d.resumable,
    );
    if (interrupted.length) {
      for (const delivery of interrupted) {
        delete delivery.resumable;
        const round = this.round(delivery.rootId);
        round.status = 'active';
        delete round.reason;
        delivery.status = 'queued';
        delivery.triage = 'wake';
        delete delivery.reason;
      }
      this.touch();
      return;
    }
    const round = this.newRound(
      room,
      previous?.request || room.messages.filter((m) => m.kind === 'message').at(-1)?.content || '继续群聊',
    );
    this.append(room, human, '继续本轮讨论', round, undefined, 'continue');
    this.touch();
  }
  /** The user moved on: interrupted work is no longer offered for resuming. */
  private settleInterrupted(groupId: string) {
    for (const delivery of this.store.data.groupDeliveries)
      if (delivery.groupId === groupId && delivery.resumable) delete delivery.resumable;
  }
  stop(id: string) {
    this.settleInterrupted(required(id, '群聊 ID', 80));
    const room = this.room(required(id, '群聊 ID', 80)),
      roots = new Set(
        this.store.data.groupDeliveries.filter((d) => d.groupId === id && groupPending(d.status)).map((d) => d.rootId),
      );
    if (room.activeRootId) roots.add(room.activeRootId);
    for (const rootId of roots) {
      const round = this.round(rootId);
      round.status = 'stopped';
      round.reason = '你停止了本轮讨论';
      for (const delivery of this.store.data.groupDeliveries.filter(
        (d) => d.rootId === rootId && groupPending(d.status),
      )) {
        delivery.status = 'cancelled';
        delivery.reason = round.reason;
        this.deciding.get(delivery.id)?.abort();
      }
      for (const worker of this.workers.values())
        if (worker.rootId === rootId) {
          worker.controller.abort();
          if (worker.runId) this.runner.cancel(worker.botId);
        }
    }
    this.touch();
  }
  private cancelMember(groupId: string, botId: string, reason: string) {
    for (const delivery of this.store.data.groupDeliveries.filter(
      (d) => d.groupId === groupId && d.recipientId === botId && groupPending(d.status),
    )) {
      delivery.status = 'cancelled';
      delivery.reason = reason;
      this.deciding.get(delivery.id)?.abort();
    }
    const worker = this.workers.get(botId);
    if (worker?.groupId === groupId) {
      worker.controller.abort();
      if (worker.runId) this.runner.cancel(botId);
    }
  }
  deletingBot(id: string) {
    for (const room of this.store.data.groups) {
      const member = room.members.find((member) => member.id === id && !member.leftAt);
      if (member) {
        member.leftAt = now();
        this.cancelMember(room.id, id, 'Bot 已删除');
        this.lifecycle(room, `${member.name} 已删除`, {
          type: 'members_changed',
          actor: human,
          joined: [],
          left: [identity(member)],
        });
      }
    }
    this.touch();
  }
  preempt(id: string) {
    for (const worker of this.workers.values())
      if (worker.botId === id && !worker.runId) {
        worker.preempted = true;
        worker.controller.abort();
      }
  }
  yieldToUser(botId: string) {
    const worker = this.workers.get(botId);
    if (!worker) return;
    worker.preempted = true;
    worker.controller.abort();
    if (worker.runId) this.runner.refresh?.(botId);
    this.touch();
  }
  cancelRun(run: RunRecord) {
    if (run.groupOrigin) this.stop(run.groupOrigin.groupId);
  }
  retryRun(run: RunRecord) {
    const origin = run.groupOrigin;
    if (!origin) throw Error('群任务来源不存在');
    const room = this.room(origin.groupId);
    this.member(room, run.botId);
    const delivery = this.store.data.groupDeliveries.find(
      (item) => item.id === origin.deliveryId && item.recipientId === run.botId && item.runId === run.id,
    );
    if (
      !delivery ||
      !['failed', 'cancelled', 'interrupted'].includes(delivery.status) ||
      this.workers.has(run.botId) ||
      this.runner.isRunning(run.botId)
    )
      throw Error('群任务仍在处理或已有更新，请稍后重试');
    const batch = this.store.data.groupDeliveries.filter(
      (item) =>
        item.groupId === room.id &&
        item.recipientId === run.botId &&
        item.runId === run.id &&
        ['failed', 'cancelled', 'interrupted'].includes(item.status),
    );
    for (const item of batch) {
      const round = this.round(item.rootId);
      round.status = 'active';
      delete round.reason;
      item.status = 'queued';
      item.triage = 'wake';
      item.retryRunId = run.id;
      delete item.reason;
      delete item.resumable;
    }
    this.touch();
  }
  private requeue(worker: Worker) {
    for (const delivery of worker.deliveries)
      if (groupPending(delivery.status) && this.round(delivery.rootId).status === 'active') {
        delivery.status = 'queued';
        delivery.triage = 'wake';
        delivery.reason = undefined;
      }
  }
  /**
   * The message a reply answers when it names none: the last one that @ or replied to this Bot, else the
   * last one it must answer, else the last one that woke it.
   */
  private answered(room: GroupRoom, botId: string, deliveries: GroupDelivery[]) {
    const messages = deliveries.map((delivery) => room.messages.find((item) => item.id === delivery.messageId));
    const addressed = (message: GroupMessage | undefined) =>
      Boolean(
        message?.mentions?.some((mention) => mention.id === botId) ||
        room.messages.find((item) => item.id === (message && replyTarget(message)))?.sender.id === botId,
      );
    return (
      [...messages].reverse().find(addressed)?.id ||
      deliveries.filter((delivery) => delivery.must).at(-1)?.messageId ||
      deliveries.at(-1)?.messageId
    );
  }
  /** One generated line about what a Bot is doing, without a model call (design section 10.1). */
  private status(room: GroupRoom, botId: string) {
    const worker = this.workers.get(botId);
    if (!worker) return this.runner.isRunning(botId) ? '忙碌' : '空闲';
    if (worker.groupId !== room.id) return '忙碌';
    const request = worker.deliveries
        .map((delivery) => room.messages.find((message) => message.id === delivery.messageId))
        .find((message) => message?.sender.kind === 'user' && message.kind === 'message'),
      steps = this.store.data.runs.find((run) => run.id === worker.runId)?.plan?.steps || [],
      done = steps.filter((step) => step.status === 'done' || step.status === 'skipped').length;
    return (
      '在做：' +
      (groupReplyContent(request?.content || '').slice(0, 60) || '群里的讨论') +
      (steps.length ? `（计划 ${done}/${steps.length}）` : '')
    );
  }
  /** Apply the wake rules to one queued delivery. Returns true when its state changed. */
  private triageDelivery(
    room: GroupRoom,
    delivery: GroupDelivery,
    holds: number[],
    deliveries = this.store.data.groupDeliveries.filter((item) => item.groupId === room.id),
  ) {
    const message = room.messages.find((item) => item.id === delivery.messageId);
    const result = triage(delivery, {
      room,
      deliveries,
      now: Date.now(),
      holdMs: GROUP_LIMITS.holdSeconds * 1000,
      scheduledBy: message?.scheduled
        ? this.store.data.scheduledTasks.find(
            (task) => task.id === message.scheduled!.taskId && task.createdBy.kind === 'bot',
          )?.createdBy.id
        : undefined,
      designOwner: message?.designSessionId
        ? this.store.data.runs.find(
            (run) => run.designSessionId === message.designSessionId && run.groupOrigin?.groupId === room.id,
          )?.botId
        : undefined,
      idle: !this.workers.has(delivery.recipientId) && !this.runner.isRunning(delivery.recipientId),
    });
    if (result.kind === 'hold') {
      holds.push(result.until);
      return false;
    }
    if (result.kind === 'wake') {
      delivery.triage = 'wake';
      delivery.must = result.must || undefined;
      return true;
    }
    if (result.kind === 'skip' || result.kind === 'limited') {
      delivery.triage = 'skip';
      delivery.status = result.kind === 'limited' ? 'limited' : 'ignored';
      delivery.reason =
        result.kind === 'skip'
          ? result.reason
          : result.reason === 'pair'
            ? '两个 Bot 之间来回已达上限'
            : 'Bot 之间的发言已达上限，等待用户发言';
      if (result.kind === 'limited') this.noticeLimit(room, message!, delivery.recipientId, result.peerId);
      return true;
    }
    if (!this.laya?.isReady) {
      delivery.triage = 'wake';
      return true;
    }
    void this.decide(room, delivery, message!, result.answer);
    return true;
  }
  /** Laya's one question for messages nobody addressed to this Bot: does it relate to its role or work? */
  private async decide(room: GroupRoom, delivery: GroupDelivery, message: GroupMessage, answer?: GroupMessage) {
    const controller = new AbortController(),
      bot = this.store.bot(delivery.recipientId);
    this.deciding.set(delivery.id, controller);
    delivery.status = 'deciding';
    delivery.layaDecisionId = delivery.id;
    let observe = false;
    try {
      const decision = await this.laya!.decide(
        {
          sourceId: delivery.id,
          actorId: bot.id,
          input: buildGroupDecisionInput(room, bot, message, this.status(room, bot.id), answer),
        },
        controller.signal,
      );
      observe = decision?.appliedChoice === 'observe';
    } catch {
      // An unavailable Laya counts as "respond"; the main model can still decide not to speak.
    } finally {
      this.deciding.delete(delivery.id);
    }
    if (this.closing || controller.signal.aborted || delivery.status !== 'deciding') return;
    if (observe) {
      delivery.triage = 'skip';
      delivery.status = 'ignored';
      delivery.reason = '已看过，和自己无关';
    } else {
      delivery.triage = 'wake';
      delivery.status = 'queued';
    }
    this.touch();
  }
  private scheduleHold(holds: number[]) {
    clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    if (!holds.length || this.closing) return;
    this.holdTimer = setTimeout(
      () => {
        this.holdTimer = undefined;
        this.pump();
      },
      Math.max(100, Math.min(...holds) - Date.now()),
    );
    this.holdTimer.unref?.();
  }
  /** Pause the room at its text budget, keeping receipts for the last published answer. */
  private enforceBotLimit(room: GroupRoom, published?: GroupMessage) {
    if (botMessageCount(room) < GROUP_LIMITS.botStreak) return false;
    const reason = `Bot 发言已达 ${GROUP_LIMITS.botStreak} 条，本轮讨论已暂停，等待你发言或继续。`;
    const roots = new Set<string>();
    if (room.activeRootId) roots.add(room.activeRootId);
    if (published?.kind === 'message') {
      const run = this.store.data.runs.find((item) => published.runIds?.includes(item.id));
      if (run) {
        const answered = this.store.data.groupDeliveries.filter(
          (delivery) => delivery.groupId === room.id && delivery.runId === run.id && pendingOrResumable(delivery),
        );
        for (const delivery of answered) roots.add(delivery.rootId);
        this.acknowledgeReplies(room, run, answered, published);
      }
    }
    for (const delivery of this.store.data.groupDeliveries) {
      if (delivery.groupId !== room.id || delivery.recipientId === 'user' || !pendingOrResumable(delivery)) continue;
      roots.add(delivery.rootId);
      delivery.status = 'limited';
      delivery.triage = 'skip';
      delivery.reason = reason;
      delete delivery.resumable;
      this.deciding.get(delivery.id)?.abort();
    }
    for (const rootId of roots) {
      const round = this.round(rootId);
      round.status = 'limited';
      round.reason = reason;
    }
    if (!noticed(room, 'bot_limit'))
      this.append(room, system, reason, undefined, undefined, 'system', undefined, { notice: 'bot_limit' });
    // Commit the last allowed message before cancellation; late replies cannot publish.
    for (const worker of this.workers.values()) {
      if (worker.groupId !== room.id) continue;
      worker.controller.abort();
      if (worker.runId) this.runner.cancel(worker.botId);
    }
    this.store.save();
    return true;
  }

  private noticeLimit(room: GroupRoom, message: GroupMessage, recipientId: string, peerId?: string) {
    const round = message.rootId ? this.store.data.groupRounds.find((item) => item.id === message.rootId) : undefined;
    if (!round || round.status !== 'active') return;
    if (!peerId) {
      this.enforceBotLimit(room);
      return;
    }
    const pair = [peerId, recipientId].map((id) => this.store.bot(id)),
      key = pair
        .map((bot) => bot.name)
        .sort()
        .join('、');
    if (noticed(room, 'pair_limit', key)) return;
    // Whoever spoke first in this exchange sums it up.
    const first = sinceUser(room).find((item) => pair.some((bot) => bot.id === item.sender.id)),
      owner = pair.find((bot) => bot.id === first?.sender.id) || pair[0],
      content = `@${owner.name} ${key} 已来回 ${GROUP_LIMITS.pairStreak / 2} 轮，彼此的消息不再叫醒对方。请汇总双方理由，自己决定，或交给用户决定。`;
    this.append(
      room,
      system,
      content,
      round,
      [{ ...identity(owner), start: 0, end: owner.name.length + 1 }],
      'system',
      undefined,
      { notice: 'pair_limit' },
    );
  }
  private pump() {
    if (this.closing) return;
    let dirty = false;
    const holds: number[] = [];
    for (const room of this.store.data.groups)
      if (
        botMessageCount(room) >= GROUP_LIMITS.botStreak &&
        this.store.data.groupDeliveries.some(
          (d) => d.groupId === room.id && groupPending(d.status) && d.recipientId !== 'user',
        )
      ) {
        this.enforceBotLimit(room);
        dirty = true;
      }
    // Triage everything queued first, so a batch that starts now includes every message that wakes it.
    const byGroup = new Map<string, GroupDelivery[]>();
    for (const delivery of this.store.data.groupDeliveries) {
      const list = byGroup.get(delivery.groupId);
      if (list) list.push(delivery);
      else byGroup.set(delivery.groupId, [delivery]);
    }
    for (const delivery of this.store.data.groupDeliveries)
      if (delivery.status === 'queued' && !delivery.triage) {
        const room = this.store.data.groups.find((room) => room.id === delivery.groupId);
        if (
          room &&
          this.members(room).some((member) => member.id === delivery.recipientId) &&
          this.round(delivery.rootId).status === 'active' &&
          this.triageDelivery(room, delivery, holds, byGroup.get(room.id))
        )
          dirty = true;
      }
    // A worker owns one Bot, never an entire group. All idle recipients start together.
    for (const delivery of this.store.data.groupDeliveries.filter((d) => d.status === 'queued')) {
      if (delivery.status !== 'queued') continue;
      const room = this.store.data.groups.find((room) => room.id === delivery.groupId),
        round = this.round(delivery.rootId);
      if (!room || !this.members(room).some((member) => member.id === delivery.recipientId)) {
        delivery.status = 'cancelled';
        dirty = true;
        continue;
      }
      if (round.status !== 'active') {
        delivery.status = round.status === 'limited' ? 'limited' : 'cancelled';
        delivery.reason = round.reason;
        dirty = true;
        continue;
      }
      if (delivery.status !== 'queued' || delivery.triage !== 'wake') continue;
      if (this.workers.has(delivery.recipientId) || this.runner.isRunning(delivery.recipientId)) continue;
      const batch = this.store.data.groupDeliveries
        .filter(
          (d) =>
            d.groupId === room.id &&
            d.recipientId === delivery.recipientId &&
            d.status === 'queued' &&
            d.triage === 'wake' &&
            d.retryRunId === delivery.retryRunId &&
            this.round(d.rootId).status === 'active',
        )
        .slice(0, delivery.retryRunId ? undefined : 8);
      const firstMessage = room.messages.find((m) => m.id === delivery.messageId),
        designId = firstMessage?.designSessionId,
        lane = workLane(firstMessage);
      for (let i = batch.length - 1; i >= 0; i--) {
        const message = room.messages.find((m) => m.id === batch[i].messageId);
        if (message?.designSessionId !== designId || workLane(message) !== lane) batch.splice(i, 1);
      }
      const trigger = batch.at(-1)!;
      const worker: Worker = {
        groupId: room.id,
        botId: delivery.recipientId,
        rootId: trigger.rootId,
        deliveries: batch,
        controller: new AbortController(),
        seenSeq: room.messages.at(-1)?.seq || 0,
        noted: new Set(),
      };
      this.workers.set(worker.botId, worker);
      void this.process(room, worker)
        .catch((error) => {
          if (worker.preempted && this.round(worker.rootId).status === 'active') this.requeue(worker);
          else {
            const completed = this.store.data.runs.find((run) => run.id === worker.runId && run.status === 'completed');
            if (completed && !worker.controller.signal.aborted)
              this.deferReply(completed, worker.deliveries, publicationFailure(error));
            for (const item of worker.deliveries)
              if (groupPending(item.status)) {
                item.status = worker.controller.signal.aborted ? 'cancelled' : 'failed';
                item.reason = String((error as Error).message).slice(0, 300);
              }
          }
        })
        .finally(() => {
          if (worker.preempted) this.requeue(worker);
          if (this.workers.get(worker.botId) === worker) this.workers.delete(worker.botId);
          this.touch();
        });
    }
    this.scheduleHold(holds);
    if (dirty) this.touch();
  }
  private async process(room: GroupRoom, worker: Worker) {
    const round = this.round(worker.rootId),
      bot = this.store.bot(worker.botId),
      { deliveries, controller } = worker;
    this.member(room, bot.id);
    if (round.status !== 'active') return;
    for (const delivery of deliveries) delivery.status = 'running';
    this.touch();
    const retry = [...deliveries]
      .reverse()
      .map((delivery) => this.store.data.runs.find((run) => run.id === delivery.retryRunId && run.botId === bot.id))
      .find(Boolean);
    for (const delivery of deliveries) delete delivery.retryRunId;
    if (retry?.status === 'completed' && deliveries.every((delivery) => delivery.runId === retry.id)) {
      worker.runId = retry.id;
      this.finishReply(room, retry, round, deliveries);
      return;
    }
    // Deliveries requeued after a private chat took over keep the run they were part of; the next
    // run carries its plan and workspace forward.
    const previousRun =
      retry ||
      [...deliveries]
        .reverse()
        .map((delivery) =>
          this.store.data.runs.find(
            (run) => run.id === delivery.runId && run.botId === bot.id && run.groupOrigin?.groupId === room.id,
          ),
        )
        .find(Boolean);
    const recent = room.messages
      .filter((message) => !bot.contextResetAt || message.time >= bot.contextResetAt)
      .slice(-4)
      .map((message) => ({
        id: message.id,
        sender: message.sender,
        kind: message.kind,
        reply: message.reply,
        scheduled: message.scheduled,
        content: groupReplyContent(
          message.content,
          message.sender.kind === 'bot' ? message.sender.id : undefined,
        ).slice(0, 1200),
        event: message.event,
        mentions: message.mentions?.map((mention) => mention.id),
      }));
    // Only user requests handed to this Bot, never another member's request or this round's root.
    const requests = deliveries.flatMap((delivery) => {
      const message = room.messages.find((item) => item.id === delivery.messageId);
      if (!message) return [];
      const origin = this.store.data.groupRounds.find((item) => item.id === message.rootId);
      if (message.scheduled || message.kind === 'continue') return [origin?.request || message.content];
      // A group a Bot created for its user's task carries that task.
      if (message.sender.kind === 'bot' && origin?.originKey?.startsWith('task:')) return [origin.request];
      if (message.sender.kind !== 'user' || message.kind !== 'message') return [];
      if (message.mentions?.length && !message.mentions.some((mention) => mention.id === bot.id)) return [];
      return [message.content || round.request];
    });
    const context = groupEventPrompt(
      room.name,
      room.id,
      bot.name,
      this.identities(room).map((m) => ({ id: m.id, name: m.name })),
      requests,
    );
    const lastMessage = room.messages.find((m) => m.id === deliveries.at(-1)?.messageId),
      workItem = lastMessage?.workItemId
        ? this.store.data.workItems?.find(
            (item) => item.id === lastMessage.workItemId && item.botId === bot.id && item.scope.id === room.id,
          )
        : undefined;
    await this.runner.run(
      bot.id,
      JSON.stringify({
        events: deliveries.map((d) => {
          const message = room.messages.find((message) => message.id === d.messageId)!;
          return {
            eventId: d.id,
            messageId: message.id,
            sender: message.sender,
            kind: message.kind,
            reply: message.reply,
            event: message.event,
            scheduled: message.scheduled,
            content: groupReplyContent(
              message.content,
              message.sender.kind === 'bot' ? message.sender.id : undefined,
            ).slice(0, 1600),
            mentions: message.mentions,
            mentioned: message.mentions?.some((mention) => mention.id === bot.id) || false,
          };
        }),
        recent,
      }),
      {
        designSessionId: lastMessage?.designSessionId || previousRun?.designSessionId,
        resumeRunId: retry?.id,
        workItemId: retry?.workItemId || workItem?.id || previousRun?.workItemId,
        workspaceDir:
          retry?.workspaceDir ||
          workItem?.workspaceDir ||
          previousRun?.workspaceDir ||
          lastMessage?.workspaceDir ||
          effectiveWorkspace(this.store, this.host, { kind: 'group', id: room.id }),
        groupOrigin: { groupId: room.id, rootId: round.id, deliveryId: deliveries.at(-1)!.id },
        groupContext: context + GROUP_STATE_EVENT_PROMPT + this.personaContext(room, bot.id, lastMessage),
        groupTaskFrom: previousRun?.id,
        onStarted: (id) => {
          worker.runId = id;
          for (const delivery of deliveries) delivery.runId = id;
          this.touch();
        },
      },
    );
    if (controller.signal.aborted || !this.store.data.groups.includes(room)) return;
    this.member(room, bot.id);
    const run = this.store.data.runs.find((run) => run.id === worker.runId);
    if (run?.status !== 'completed') throw new Error(run?.error || '群聊任务未完成');
    if (round.status !== 'active') {
      if (this.publicationPaused(round)) this.deferReply(run, deliveries, round.reason || '同轮消息等待补发');
      else
        for (const delivery of deliveries)
          if (groupPending(delivery.status)) {
            delivery.status = round.status === 'limited' ? 'limited' : 'cancelled';
            delivery.reason = round.reason;
          }
      return;
    }
    this.finishReply(room, run, round, deliveries);
  }

  private finishReply(
    room: GroupRoom,
    run: RunRecord,
    round: GroupRound,
    deliveries: GroupDelivery[],
    recoveredReply?: GroupMessage,
  ) {
    const finalMessage = this.store
        .runMessages(run.id)
        .filter((message) => message.presentation === 'answer')
        .at(-1),
      answer = readableContent(finalMessage?.content || '').trim();
    const finalReply = this.beforeFinalReplyPublish(answer, finalMessage?.attachments),
      emitted = recoveredReply || this.publishedReplies(room, run).at(-1);
    if (emitted && finalReply.kind === 'silent') {
      this.acknowledgeReplies(room, run, deliveries, emitted);
      return;
    }
    const triggerMessage = room.messages.find((message) => message.id === this.answered(room, run.botId, deliveries));
    if (finalReply.kind === 'silent') {
      for (const delivery of deliveries) {
        delivery.status = 'ignored';
        delivery.reason = '已看过，没有发言';
        delete delivery.resumable;
      }
      return;
    }
    // Text replaced by an attachment summary no longer contains its original mentions.
    const mentions = finalReply.content === answer ? finalMessage?.mentions || [] : [];
    const message = this.publish(room, run, round, finalReply.content, mentions, {
      key:
        'final:' +
        createHash('sha256')
          .update(
            JSON.stringify([
              finalReply.content,
              mentions.map((m) => m.id),
              finalMessage?.attachments?.map((a) => a.id) || [],
            ]),
          )
          .digest('hex'),
      replyTo: triggerMessage?.id,
      answers: triggerMessage?.id,
      attachments: finalMessage?.attachments,
    });
    this.acknowledgeReplies(room, run, deliveries, message);
  }

  private rootFor(botId: string, runId: string) {
    const run = this.store.data.runs.find((run) => run.id === runId && run.botId === botId && run.status === 'running');
    if (!run) throw new Error('当前任务已结束');
    if (run.groupOrigin) return this.round(run.groupOrigin.rootId);
    const peer = run.peerOrigin
      ? this.store.data.peerExchanges.find((exchange) => exchange.id === run.peerOrigin!.exchangeId)
      : undefined;
    const rootRunId = peer?.rootRunId || runId,
      request = peer?.rootRequest || this.store.humanRunMessage(rootRunId)?.content;
    if (!request) throw new Error('缺少原始用户任务，不能自动发起群聊');
    let round = this.store.data.groupRounds.find((round) => round.originKey === `task:${rootRunId}`);
    if (!round) {
      round = {
        id: randomUUID(),
        groupId: '',
        originKey: `task:${rootRunId}`,
        request: request.slice(0, 8000),
        status: 'active',
        createdAt: now(),
        botMessages: 0,
        createdGroups: 0,
      };
      this.store.data.groupRounds.push(round);
    }
    return round;
  }
  invoke(
    botId: string,
    runId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    options: HarnessRunOptions,
  ) {
    this.store.bot(botId);
    if (this.closing || signal.aborted) throw new Error('任务已停止');
    if (name === 'groups_list') {
      const inGroup = Boolean(this.store.data.runs.find((run) => run.id === runId && run.botId === botId)?.groupOrigin);
      return this.store.data.groups
        .filter((room) => this.members(room).some((member) => member.id === botId))
        .map((room) =>
          inGroup
            ? {
                id: room.id,
                name: room.name,
                members: this.members(room).map((m) => ({ id: m.id, name: m.name })),
                preview: groupReplyContent(
                  room.messages.at(-1)?.content || '',
                  room.messages.at(-1)?.sender.kind === 'bot' ? room.messages.at(-1)?.sender.id : undefined,
                ).slice(0, 300),
              }
            : { id: room.id, name: room.name },
        );
    }
    if (name === 'group_read') {
      const room = this.room(required(args.groupId, '群聊 ID', 80));
      this.member(room, botId);
      if (args.messageId) {
        const message = room.messages.find((m) => m.id === args.messageId);
        if (!message) throw Error('群消息不存在');
        const offset = Number(args.offset) || 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > message.content.length) throw Error('消息偏移无效');
        return {
          ...message,
          content: message.content.slice(offset, offset + 6000),
          ...(offset + 6000 < message.content.length ? { nextOffset: offset + 6000 } : {}),
        };
      }
      const page = this.read({ id: room.id, before: typeof args.before === 'string' ? args.before : undefined }),
        messages = page.messages.slice(-10),
        before =
          messages[0] && room.messages.findIndex((m) => m.id === messages[0].id) > 0 ? messages[0].id : undefined;
      return {
        groupId: room.id,
        messages: messages.map((m) => ({
          ...m,
          content: m.content.slice(0, 2400),
          ...(m.content.length > 2400 ? { truncated: true, offset: 2400 } : {}),
        })),
        before,
      };
    }
    if (name === 'group_outbox') {
      const room = this.room(required(args.groupId, '群聊 ID', 80));
      this.member(room, botId);
      return this.store.data.groupOutbox
        ?.filter((m) => m.groupId === room.id && m.botId === botId)
        .slice(-20)
        .map((m) => ({
          id: m.id,
          key: m.key,
          status: m.status,
          messageId: m.messageId,
          content: m.content.slice(0, 500),
        }));
    }
    if (name === 'group_react') {
      const room = this.room(required(args.groupId, '群聊 ID', 80));
      this.member(room, botId);
      if (options.groupOrigin && options.groupOrigin.groupId !== room.id) throw new Error('只能回应当前群聊的消息');
      return this.pin(
        room,
        { kind: 'bot', ...identity(this.store.bot(botId)) },
        args as unknown as PinInput,
        this.rootFor(botId, runId),
        runId,
      );
    }
    const attachments = this.attachments.forBot(botId, args.attachmentIds),
      round = this.rootFor(botId, runId);
    if (round.status !== 'active') throw new Error('本轮自动讨论已暂停，等待用户继续');
    if (name === 'group_create') {
      const name = required(args.name, '群名称', 80),
        message = required(args.message, '开场消息', 8000);
      if (hasSilenceMarker(message)) throw new Error('静默标记是内部控制文本，不能作为群消息发布');
      if (!Array.isArray(args.botIds)) throw new Error('请选择群成员');
      const bots = this.botIds([...new Set([botId, ...args.botIds])], 2);
      if (round.createdGroups >= GROUP_LIMITS.groupsPerTask) throw new Error('本次任务建群次数已达上限');
      const formatted = botMentions(message, bots.map(identity), botId);
      const room = this.createRoom(name, bots, { kind: 'bot', ...identity(this.store.bot(botId)) }, round);
      round.createdGroups++;
      round.groupId ||= room.id;
      this.append(
        room,
        { kind: 'bot', ...identity(this.store.bot(botId)) },
        formatted.content,
        round,
        formatted.mentions,
        'message',
        undefined,
        { attachments },
      );
      const run = this.store.data.runs.find((run) => run.id === runId)!;
      if (!run.groupOrigin && !run.peerOrigin)
        this.store.message(botId, 'event', `创建了群聊「${room.name}」`, {
          groupLink: { groupId: room.id, action: 'created' },
        });
      this.touch();
      return { groupId: room.id, name: room.name, sent: true, message: '成员会按需处理消息，无需轮询或重复催问。' };
    }
    const room = this.room(required(args.groupId, '群聊 ID', 80));
    this.member(room, botId);
    if (name === 'group_invite') {
      if (!Array.isArray(args.botIds)) throw new Error('请选择群成员');
      const bots = this.botIds([...new Set([...this.members(room).map((m) => m.id), ...args.botIds])], 1);
      this.changeMembers(
        { id: room.id, name: room.name, botIds: bots.map((bot) => bot.id) },
        { kind: 'bot', ...identity(this.store.bot(botId)) },
        round,
      );
      return { invited: true, members: this.members(room) };
    }
    if (name === 'group_send_message') {
      const run = this.store.data.runs.find((run) => run.id === runId && run.botId === botId)!;
      if (run.groupOrigin && run.groupOrigin.groupId !== room.id)
        throw Error('群聊执行只能发布到当前群；跨群分享请由原会话明确发起');
      let body = required(args.message, '消息', 8000);
      if (isEmptyGroupReply(body)) {
        if (!attachments.length) return { sent: false, silent: true, message: '没有可发布的内容，不叫醒其他成员。' };
        body = attachmentSummary(attachments);
      }
      if (hasSilenceMarker(body))
        throw new AppError('group.silence_marker', '静默标记是内部控制文本，不能作为群消息发布');
      const formatted = botMentions(body, this.identities(room), botId);
      const kind = args.kind === 'progress' ? 'progress' : 'message';
      const replyTo = args.replyToMessageId ? required(args.replyToMessageId, '回复的消息 ID', 80) : undefined;
      if (replyTo && !room.messages.some((m) => m.id === replyTo && ['message', 'progress', 'system'].includes(m.kind)))
        throw new AppError('group.reply_target_invalid', '只能回复本群已发送的消息');
      const worker = this.workers.get(botId),
        own = worker?.runId === runId ? worker.deliveries : [],
        answers =
          kind === 'progress'
            ? undefined
            : own.find((delivery) => delivery.messageId === replyTo)?.messageId || this.answered(room, botId, own);
      if (!run.groupOrigin && !args.clientMessageId) {
        const duplicate = room.messages.find(
          (m) =>
            m.rootId === round.id &&
            m.sender.id === botId &&
            m.kind === kind &&
            (m.replyTo || m.answers) === (replyTo || answers) &&
            normalized(m.content) === normalized(formatted.content) &&
            JSON.stringify(m.mentions?.map((m) => m.id) || []) ===
              JSON.stringify(formatted.mentions.map((m) => m.id)) &&
            JSON.stringify(m.attachments?.map((a) => a.id) || []) === JSON.stringify(attachments.map((a) => a.id)),
        );
        if (duplicate) return { sent: true, alreadySent: true, messageId: duplicate.id };
      }
      const key = args.clientMessageId
        ? 'explicit:' + required(args.clientMessageId, '发件标识', 120)
        : 'content:' +
          createHash('sha256')
            .update(
              JSON.stringify([
                kind,
                replyTo || answers || null,
                formatted.content,
                formatted.mentions.map((m) => m.id),
                attachments.map((a) => a.id),
              ]),
            )
            .digest('hex');
      const message = this.publish(room, run, round, formatted.content, formatted.mentions, {
        key,
        kind,
        replyTo,
        ...(args.kind === 'progress' ? {} : { answers }),
        attachments,
      });
      return {
        sent: true,
        messageId: message.id,
        mentions: formatted.mentions.map((mention) => ({ id: mention.id, name: mention.name })),
      };
    }
    throw new Error('未知群聊工具');
  }
  dispose() {
    this.closing = true;
    clearTimeout(this.timer);
    clearTimeout(this.holdTimer);
    for (const controller of this.deciding.values()) controller.abort();
    // Quitting is not the user stopping the discussion: unfinished work stays resumable on the next start.
    interruptPending(this.store, '应用退出，等待用户继续');
    for (const worker of this.workers.values()) {
      worker.controller.abort();
      if (worker.runId) this.runner.cancel(worker.botId);
    }
    this.store.save();
  }
}
