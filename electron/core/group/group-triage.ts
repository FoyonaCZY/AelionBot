import { GROUP_LIMITS, type GroupDelivery, type GroupMessage, type GroupRoom } from '../../../shared/types/group-types';

// Who a published message wakes. Every member still receives it; triage only decides whether the
// recipient starts working on it (design section 4.1). Rules are tried in order and the first hit wins.

export type Triage =
  | { kind: 'skip'; reason: string }
  | { kind: 'wake'; must: boolean }
  | { kind: 'hold'; until: number }
  | { kind: 'limited'; peerId?: string; reason: 'pair' | 'bot' }
  | { kind: 'ask'; answer?: GroupMessage };
export interface TriageContext {
  room: GroupRoom;
  deliveries: GroupDelivery[];
  now: number;
  holdMs: number;
  /** The Bot that created the scheduled task behind a scheduled message. */
  scheduledBy?: string;
  /** The designer Bot that owns the design session a message belongs to. */
  designOwner?: string;
}

export const replyTarget = (message: GroupMessage) => message.reply?.messageId || message.replyTo;
const woken = (delivery: GroupDelivery) =>
  delivery.status === 'deciding' ||
  delivery.status === 'running' ||
  (delivery.status === 'queued' && delivery.triage !== 'skip');

/** Messages after the user's latest message (or all of them). Bot-to-bot limits reset when the user speaks. */
export function sinceUser(room: GroupRoom, before = room.messages.length) {
  let start = before;
  while (start > 0) {
    const message = room.messages[start - 1];
    if (message.sender.kind === 'user' && message.kind !== 'reaction') break;
    start--;
  }
  return room.messages.slice(start, before);
}
/** Other Bots a Bot message is aimed at: by @, by replying to them, or by answering a message they sent. */
export function botTargets(room: GroupRoom, message: GroupMessage) {
  const targets = new Set<string>();
  if (message.sender.kind !== 'bot') return targets;
  for (const mention of message.mentions || []) targets.add(mention.id);
  for (const id of [replyTarget(message), message.answers]) {
    const target = id ? room.messages.find((item) => item.id === id) : undefined;
    if (target?.sender.kind === 'bot') targets.add(target.sender.id);
  }
  targets.delete(message.sender.id);
  return targets;
}
/** The first answer an addressed member gave: a reply, a message it sent because of it, or a reaction. */
export function answerFrom(room: GroupRoom, message: GroupMessage, memberId: string) {
  const start = room.messages.indexOf(message);
  return room.messages
    .slice(start + 1)
    .find(
      (item) =>
        item.sender.id === memberId &&
        (replyTarget(item) === message.id ||
          item.answers === message.id ||
          (item.reaction?.messageId === message.id && !item.reaction.removed)),
    );
}
function limit(room: GroupRoom, message: GroupMessage, recipientId: string): Triage | undefined {
  if (message.sender.kind !== 'bot') return;
  const earlier = sinceUser(room, room.messages.indexOf(message)).filter(
    (item) => item.kind === 'message' && botTargets(room, item).size,
  );
  if (earlier.length >= GROUP_LIMITS.botStreak) return { kind: 'limited', reason: 'bot' };
  if (!botTargets(room, message).has(recipientId)) return;
  const sender = message.sender.id,
    pair = earlier.filter(
      (item) =>
        (item.sender.id === sender && botTargets(room, item).has(recipientId)) ||
        (item.sender.id === recipientId && botTargets(room, item).has(sender)),
    );
  if (pair.length >= GROUP_LIMITS.pairStreak) return { kind: 'limited', peerId: sender, reason: 'pair' };
}

export function triage(delivery: GroupDelivery, context: TriageContext): Triage {
  const { room, deliveries } = context,
    message = room.messages.find((item) => item.id === delivery.messageId),
    me = delivery.recipientId;
  if (!message) return { kind: 'skip', reason: '消息已不存在' };
  // 1. Reactions and notices wake nobody. A reaction still counts as an answer to its message.
  if (message.kind === 'reaction') return { kind: 'skip', reason: '表情回应，不叫醒' };
  if (message.event) return { kind: 'skip', reason: '成员变化通知，不叫醒' };
  if (message.scheduled) {
    if (!context.scheduledBy) return { kind: 'wake', must: false };
    return context.scheduledBy === me ? { kind: 'wake', must: true } : { kind: 'skip', reason: '其他成员的定时任务' };
  }
  const mentioned = Boolean(message.mentions?.some((mention) => mention.id === me));
  if (message.sender.kind === 'system')
    return mentioned ? { kind: 'wake', must: true } : { kind: 'skip', reason: '系统通知，不叫醒' };
  if (message.kind === 'continue') return { kind: 'wake', must: false };
  const limited = limit(room, message, me);
  if (limited) return limited;
  // 2. Addressed to me: @, a reply to my message, or feedback on my design.
  const target = replyTarget(message),
    replied = target ? room.messages.find((item) => item.id === target) : undefined,
    repliedToMe = replied?.sender.id === me;
  if (mentioned) return { kind: 'wake', must: true };
  if (context.designOwner) {
    if (context.designOwner === me) return { kind: 'wake', must: message.sender.kind === 'user' };
    return { kind: 'skip', reason: '其他成员的设计任务' };
  }
  if (repliedToMe) {
    // Let everyone answering the same message finish, so the asker reads all replies at once.
    const until = Date.parse(message.time) + context.holdMs;
    const writing = deliveries.some(
      (item) =>
        item.messageId === replied.id &&
        item.recipientId !== me &&
        item.recipientId !== message.sender.id &&
        woken(item) &&
        !answerFrom(room, replied, item.recipientId),
    );
    if (writing && context.now < until) return { kind: 'hold', until };
    return { kind: 'wake', must: message.sender.kind === 'user' };
  }
  // 3. Addressed to someone else: wait for them to answer first.
  const addressed = new Set<string>(
    (message.mentions || []).map((mention) => mention.id).filter((id) => id !== message.sender.id),
  );
  if (replied?.sender.kind === 'bot' && replied.sender.id !== message.sender.id) addressed.add(replied.sender.id);
  let answer: GroupMessage | undefined;
  if (addressed.size) {
    const until = Date.parse(message.time) + context.holdMs;
    for (const id of addressed) {
      const found = answerFrom(room, message, id);
      if (found) {
        answer ||= found;
        continue;
      }
      const theirs = deliveries.find((item) => item.messageId === message.id && item.recipientId === id);
      if (theirs && woken(theirs) && context.now < until) return { kind: 'hold', until };
    }
  }
  // 4. Everything else: ask Laya whether it relates to my role or current work.
  return { kind: 'ask', answer };
}
/** A notice of this kind already posted since the user last spoke. */
export function noticed(room: GroupRoom, notice: GroupMessage['notice'], key?: string) {
  return sinceUser(room).some((item) => item.notice === notice && (!key || item.content.includes(key)));
}
/** A user message nobody addressed, that every Bot looked at and none answered. */
export function unanswered(room: GroupRoom, deliveries: GroupDelivery[], message: GroupMessage) {
  if (message.sender.kind !== 'user' || message.kind !== 'message' || message.mentions?.length) return false;
  const own = deliveries.filter((item) => item.messageId === message.id && item.recipientId !== 'user');
  return (
    own.length > 0 &&
    own.every((item) => item.status === 'ignored') &&
    !room.messages.some(
      (item) =>
        item.sender.kind !== 'user' &&
        (replyTarget(item) === message.id || item.answers === message.id || item.reaction?.messageId === message.id),
    )
  );
}
