import type { GroupDelivery, GroupMessage } from '../types/group-types';

export const replyTarget = (message: GroupMessage) => message.reply?.messageId || message.replyTo;

/** A user message nobody addressed, that every Bot looked at and none answered. */
export function unanswered(messages: GroupMessage[], deliveries: GroupDelivery[], message: GroupMessage) {
  if (message.sender.kind !== 'user' || message.kind !== 'message' || message.mentions?.length) return false;
  const own = deliveries.filter((item) => item.messageId === message.id && item.recipientId !== 'user');
  return (
    own.length > 0 &&
    own.every((item) => item.status === 'ignored') &&
    !messages.some(
      (item) =>
        item.sender.kind !== 'user' &&
        (replyTarget(item) === message.id || item.answers === message.id || item.reaction?.messageId === message.id),
    )
  );
}
