import { AppError } from '../../../shared/errors';
import type { Store } from '../storage/store';

/**
 * Marks something the user or the Bot said in one of the Bot's chats, so the user finds it again on the conversation
 * rail, or takes the mark off. Marks are the user's own: the Bot is not told, and its context does not change.
 */
export function markMessage(store: Store, input: { botId: string; messageId: string; marked: boolean }) {
  if (typeof input?.botId !== 'string' || typeof input.messageId !== 'string' || typeof input.marked !== 'boolean')
    throw new AppError('chat.mark_invalid', '标记参数无效');
  store.bot(input.botId);
  const target = store.data.messages.find(
    (message) =>
      message.id === input.messageId &&
      message.botId === input.botId &&
      (message.role === 'user' || message.role === 'assistant') &&
      !message.reaction,
  );
  if (!target) throw new AppError('chat.mark_target_missing', '这条消息已经不在了');
  if (Boolean(target.marked) === input.marked) return false;
  if (input.marked) target.marked = true;
  else delete target.marked;
  store.touch(target);
  store.save();
  return true;
}
