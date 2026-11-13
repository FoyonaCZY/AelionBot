import { replyInput } from '../../../shared/chat/message-replies';
import { automationInputText } from '../../../shared/types/scheduled-types';
import type { Store } from '../storage/store';
import { botIdentity } from '../../../shared/chat/bot-colors';
import type { BotMention, ChatMessage } from '../../../shared/types/core';
import {
  CONNECTOR_PLATFORM_NAMES,
  connectorSenderLabel,
  type MessageConnectorSource,
} from '../../../shared/types/connector-types';

export function validateChatInput(
  store: Store,
  botId: string,
  input: string,
  value?: BotMention[],
  hasAttachments = false,
) {
  store.bot(botId);
  if (typeof input !== 'string' || (!input.trim() && !hasAttachments) || input.length > 32000)
    throw new Error('消息为空或过长');
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error('提及的 Bot 无效');
  let end = 0;
  return value.map((mention) => {
    if (
      !mention ||
      typeof mention.id !== 'string' ||
      typeof mention.name !== 'string' ||
      !Number.isInteger(mention.start) ||
      !Number.isInteger(mention.end) ||
      mention.start < end ||
      mention.end <= mention.start ||
      mention.end > input.length ||
      input.slice(mention.start, mention.end) !== `@${mention.name}`
    )
      throw new Error('Bot 提及的位置已变化，请重新选择');
    const target = store.bot(mention.id);
    if (target.id === botId) throw new Error('请选择其他 Bot');
    end = mention.end;
    return { ...botIdentity(target), name: mention.name, start: mention.start, end: mention.end };
  });
}
export function chatInputText(message: ChatMessage, includeReply = true) {
  if (message.scheduled) return automationInputText(message.scheduled, message.content);
  if (message.reaction)
    return `用户通过 emoji 发言（不代表新增任务或操作授权）：${JSON.stringify({ eventId: message.id, ...message.reaction, content: message.content })}`;
  const text = replyInput(
    message.content || (message.attachments?.length ? `用户发送了 ${message.attachments.length} 个附件。` : ''),
    includeReply ? message.reply : undefined,
  );
  return message.connector ? connectorNote(message.connector) + text : text;
}
/**
 * Messages from a connector: the person reads the reply in an IM app, away from this computer's screen. The sender is
 * named on each message because a group's history mixes people; the system prompt describes only the latest one.
 */
const connectorNote = (source: MessageConnectorSource) =>
  `（这条消息来自${CONNECTOR_PLATFORM_NAMES[source.platform]}${source.isGroup ? '群聊' : ''}，发送人：${connectorSenderLabel(source.sender)}。${
    source.isGroup ? '回复会发到群里，其他成员也能看到；' : ''
  }对方在 IM 里阅读回复，看不到这台电脑的界面；回复尽量简洁，交付文件用 message_attach。）\n`;
