import { delegationContract, delegationStatus, recordDelegationReceipt } from '../../../peer/delegation';
import type { ToolHandler } from '../context';
import { requiredText } from '../validation';
import { forwardAttachments } from './attachments';

const peerMessages: ToolHandler = async (context) => {
  const { bot, name, signal, runId, options, deps } = context;
  const args = name === 'bot_send_message' ? await forwardAttachments(context) : context.args;
  if (!deps.peers) throw new Error('私聊尚未启用');
  if (name === 'bots_list') return deps.peers.directory(bot.id);
  if (name === 'bot_read_messages') return deps.peers.readForBot(bot.id, args);
  return deps.peers.send(bot.id, runId, args, signal, options);
};

export const DELEGATION_HANDLERS: Record<string, ToolHandler> = {
  bot_delegate_task: ({ bot, args, signal, runId, options, deps }) => {
    if (!deps.peers) throw Error('私聊尚未启用');
    const task = delegationContract(args);
    return deps.peers.send(
      bot.id,
      runId,
      {
        botId: args.botId,
        task,
        message: `协作任务：${task.goal}\n验收条件：${task.acceptance.join('；')}\n预期成果：${task.expectedOutput}\n请自行决定是否接下；需要执行时先 start_main_task，完成或受阻后提交 delegation_receipt，再回复。`,
      },
      signal,
      options,
    );
  },
  delegation_status: ({ bot, args, deps }) => delegationStatus(deps.store, bot.id, requiredText(args, 'id', 100)),
  delegation_receipt: ({ bot, args, runId, deps }) => recordDelegationReceipt(deps.store, bot.id, runId, args),
  bots_list: peerMessages,
  bot_send_message: peerMessages,
  bot_read_messages: peerMessages,
};
