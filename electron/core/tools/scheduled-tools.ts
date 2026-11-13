import type { ToolDefinition } from '../model/model';
const string = { type: 'string' };
const schedule = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['once', 'daily', 'weekly', 'interval'] },
    timeZone: { ...string, description: 'IANA 时区，例如 Asia/Shanghai。未指定时使用当前系统时区。' },
    at: { ...string, description: 'once：包含时区的 ISO 8601 日期时间，例如 2026-09-08T09:00:00+08:00' },
    time: { ...string, description: 'daily/weekly：24 小时制 HH:mm' },
    weekdays: {
      type: 'array',
      items: { type: 'integer', minimum: 0, maximum: 6 },
      description: 'weekly：0=周日，1–6=周一至周六；工作日为 [1,2,3,4,5]',
    },
    minutes: { type: 'integer', minimum: 1, maximum: 525600, description: 'interval：间隔分钟数' },
  },
  required: ['kind', 'timeZone'],
};
const trigger = {
  type: 'object',
  additionalProperties: false,
  description:
    '触发条件，kind 决定其余字段：' +
    'schedule 按时间（schedule）；' +
    'webhook 本机 HTTP POST 调用时（创建后返回地址，请求体作为触发信息）；' +
    'file 本机文件夹（path，完整路径）里有文件变化时，需要用户同意；' +
    'message 连接器（飞书、企微、微信）收到消息时，可限定 connectorId 和包含的 keyword；' +
    'automation 另一个自动化（automationId）结束后，outcome 为 completed、failed 或 any；' +
    'script 每 minutes 分钟在沙箱里运行 code 检查条件，需要用户查看后启用。' +
    'script 的 code 是异步函数体：可用 state（上次保存的 JSON）和 await tools.fetch({url, method?, headers?, body?})（只能访问公网，返回 {status, body}），' +
    '最后 return {fire: 布尔, message: 触发说明, state: 要保存的 JSON}。',
  properties: {
    kind: { type: 'string', enum: ['schedule', 'webhook', 'file', 'message', 'automation', 'script'] },
    schedule,
    path: string,
    connectorId: string,
    keyword: { ...string, maxLength: 100 },
    automationId: string,
    outcome: { type: 'string', enum: ['completed', 'failed', 'any'] },
    code: { ...string, maxLength: 20000 },
    minutes: { type: 'integer', minimum: 1, maximum: 1440 },
  },
  required: ['kind'],
};
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
export const SCHEDULED_TOOLS: ToolDefinition[] = [
  tool('automations_list', '查看当前单聊或群聊已保存的自动化及状态。创建前按需检查已有自动化，避免重复。', {}, []),
  tool(
    'automation_create',
    '为当前会话创建自动化：触发条件满足时，把 prompt 交给当前会话执行，结果发回原会话。可按用户需求主动安排定时任务、提醒，或在事件发生时自动处理。prompt 写清届时要完成的事，不要写成再次创建自动化的指令。非定时触发每分钟最多运行一次，期间的多次触发会合并。只在成功返回后确认已安排。工具权限不会因自动执行而放宽。',
    { title: { ...string, maxLength: 80 }, prompt: { ...string, maxLength: 8000 }, trigger },
    ['title', 'prompt', 'trigger'],
  ),
  tool(
    'automation_update',
    '修改当前会话的自动化。id 来自列表或创建结果。status=paused 暂停，enabled 恢复，completed 结束；不取消已开始的本次执行。用户还没查看过的检查脚本不能由你启用。',
    {
      id: string,
      title: string,
      prompt: string,
      trigger,
      status: { type: 'string', enum: ['enabled', 'paused', 'completed'] },
    },
    ['id'],
  ),
  tool('automation_delete', '删除当前会话的自动化，停止之后的触发；已开始的本次执行不会撤销。', { id: string }, ['id']),
];
