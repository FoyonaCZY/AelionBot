import type { ToolDefinition } from '../../../model/model';
import { attachmentList, string, tool } from './shared';
export const DELEGATION_TOOLS: ToolDefinition[] = [
  tool(
    'bot_delegate_task',
    '给其他 Bot 委托有明确验收条件的任务。只在当前用户目标范围内共享必要资料。对方可以决定接下或说明阻碍，最终回执包含执行证据。已排队不代表已完成，不轮询。',
    {
      botId: string,
      goal: string,
      acceptance: { type: 'array', items: string, minItems: 1, maxItems: 10 },
      expectedOutput: string,
    },
    ['botId', 'goal', 'acceptance', 'expectedOutput'],
  ),
  tool(
    'delegation_status',
    '按需查看自己发出或接到的委托及回执，包含产物和模型用量；不是等待工具，不要轮询。',
    { id: string },
    ['id'],
  ),
  tool(
    'delegation_receipt',
    '接收方在自己的主任务里提交委托回执。completed 需要当前实际成功执行的 executionId，blocked 说明具体阻碍；按验收条件说明结果，文件仍用 message_attach 附上。',
    {
      status: { type: 'string', enum: ['completed', 'blocked'] },
      summary: string,
      evidenceIds: { type: 'array', items: string, maxItems: 10 },
    },
    ['status', 'summary', 'evidenceIds'],
  ),
];
export const PEER_TOOLS: ToolDefinition[] = [
  tool(
    'start_main_task',
    '把当前收到的私聊请求转入自己的主会话任务。应用将载入你自己的主会话历史、记忆和完整工具，再由你执行。仅聊天或查询协作状态时直接回复；需要保存记忆、操作文件或电脑等任务时先调用此工具。调用本身不代表任务已完成。',
    {},
    [],
  ),
  tool(
    'bots_list',
    '查看可私聊的其他 Bot 的准确 ID、SOUL.md 摘要和当前忙闲状态。先确定身份再发送，不要凭空编造 Bot 或回复。',
    {},
    [],
  ),
  tool(
    'bot_send_message',
    '给另一个 Bot 发送私聊请求或协作任务。botId 必须来自 bots_list 或当前用户明确 @ 的身份。消息最长 8000 字符，只共享本次任务所需的内容。调用只确认已排队，不代表对方已经回复；回复会保存在私聊中，并在主会话显示可点击的收到消息事件，不要轮询或重复催问。接到私聊时最终答复会自动回给发起方，不要给它新建回复请求。',
    { botId: string, message: string, attachments: attachmentList },
    ['botId', 'message'],
  ),
  tool(
    'bot_read_messages',
    '按需回看自己与指定 Bot 的真实私聊记录，不可读取不属于自己的私聊。before 为上一页返回的消息 ID。',
    { botId: string, before: string },
    ['botId'],
  ),
];
