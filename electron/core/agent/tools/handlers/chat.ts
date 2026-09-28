import type { PinInput } from '../../../../../shared/chat/reactions';
import { pinChat } from '../../chat-pins';
import type { PrefixHandler, ToolHandler } from '../context';
import { forwardAttachments } from './attachments';

export const CHAT_HANDLERS: Record<string, ToolHandler> = {
  chat_pin: ({ bot, args, runId, options, deps }) => {
    if (options.groupOrigin || options.peerOrigin) throw new Error('只能在自己的用户聊天中使用此回应');
    const result = pinChat(
      deps.store,
      bot.id,
      { kind: 'bot', id: bot.id, name: bot.name, color: bot.color },
      args as unknown as PinInput,
      runId,
    );
    deps.changed();
    return result;
  },
};

export const GROUP_HANDLER: PrefixHandler = {
  matches: (name) => /^groups?_/.test(name),
  handler: async (context) => {
    const { bot, name, signal, runId, options, deps } = context;
    const args = ['group_send_message', 'group_create'].includes(name)
      ? await forwardAttachments(context)
      : context.args;
    if (!deps.groups) throw new Error('群聊尚未启用');
    return deps.groups.invoke(bot.id, runId, name, args, signal, options);
  },
};
