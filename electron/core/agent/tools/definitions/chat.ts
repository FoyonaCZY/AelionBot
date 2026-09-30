import type { ToolDefinition } from '../../../model/model';
import { attachmentList, string, tool } from './shared';
export const CHAT_TOOLS: ToolDefinition[] = [
  tool(
    'chat_pin',
    '用 emoji 回应用户的文字，或回应用户在当前原消息下新加的表态。messageId 使用可回应列表的真实 ID；回应用户给你的消息加的表情时，仍使用那条原消息 ID。仅在本次只需表态、没有待办工作时，用表情结束发言并省略重复文字。若用户交代了任务，表情只是确认收到，必须继续执行并给出最终结果；不能用表情代替任务。已有相同表态时选不同的 emoji 或用文字自然回应。',
    {
      messageId: string,
      emoji: {
        type: 'string',
        maxLength: 32,
        description: '单个标准 emoji，例如 👍、❤️、😂、🎉、🤔、👀、🙏、🚀、☕、🐱，也可使用其他常见表情。',
      },
    },
    ['messageId', 'emoji'],
  ),
  tool(
    'group_react',
    '用 emoji 回应自己所在群的一条已发布消息，代替重复接话，例如同意时用 👍。表态不叫醒任何人，但算作对那条消息的答复。不要回应别人的表态事件，也不要给自己表态。仅需要表态时用表情结束发言，不补发同义文字。承担任务或同时调用其他工具时继续执行，完成后仍需给出结果。',
    {
      groupId: string,
      messageId: string,
      emoji: {
        type: 'string',
        maxLength: 32,
        description: '单个标准 emoji，例如 👍、❤️、😂、🎉、🤔、👀、🙏、🚀、☕、🐱，也可使用其他常见表情。',
      },
    },
    ['groupId', 'messageId', 'emoji'],
  ),
  tool(
    'groups_list',
    '列出自己已加入的群聊。私聊中只返回群 ID 和名称，可用于确定 group_send_message 的目标；群内还会返回成员和消息预览。',
    {},
    [],
  ),
  tool(
    'group_create',
    '按当前用户任务需要主动创建群聊。用户自动加入，你自动成为成员；botIds 是其他成员的真实 ID（来自 bots_list）。message 说明具体问题或分工，不要只发问候。共 2–8 位 Bot；可在 message 中用 @{成员ID} 明确 @ 某位成员。',
    {
      name: string,
      botIds: { type: 'array', items: string, maxItems: 8 },
      message: string,
      attachments: attachmentList,
    },
    ['name', 'botIds', 'message'],
  ),
  tool(
    'group_invite',
    '向自己参加的群邀请 Bot。新成员可以查看历史，之后的新消息才通知它；不要为邀请自动发送欢迎或致谢。',
    { groupId: string, botIds: { type: 'array', items: string, maxItems: 8 } },
    ['groupId', 'botIds'],
  ),
  tool(
    'group_send_message',
    '向自己参加的群发送一条具体协作消息。其他成员都会收到，被 @ 或被回复的成员会被叫醒，无需轮询。message 可以包含 @{成员ID} 来 @ 群成员，唯一名字也可直接写 @名字；replyToMessageId 是接着回复的那条消息。可明确发布进展、提醒、问题或结果，其他执行草稿不会自动发送。clientMessageId 是本轮稳定的发件标识，重试复用；最终答复会自动发到群里，无需重复同一条。',
    {
      groupId: string,
      message: string,
      replyToMessageId: string,
      attachments: attachmentList,
      clientMessageId: string,
      kind: { type: 'string', enum: ['message', 'progress'] },
    },
    ['groupId', 'message'],
  ),
];
export const GROUP_READ_TOOLS: ToolDefinition[] = [
  tool(
    'group_read',
    '按需读取自己参加的群聊历史；before 翻页；messageId 精读一条消息，offset 续读长文。不能访问未加入的群，不要轮询。',
    { groupId: string, before: string, messageId: string, offset: { type: 'integer', minimum: 0 } },
    ['groupId'],
  ),
];
