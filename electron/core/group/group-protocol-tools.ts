import type { ToolDefinition } from '../model/model';
const string = { type: 'string' };
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
export const GROUP_PROTOCOL_TOOLS = [
  tool(
    'group_outbox',
    '查看自己在该群最近的发件回执；pending 尚未公开，sent 才已送达。不要用它轮询其他成员。',
    { groupId: string },
    ['groupId'],
  ),
];
export const groupProtocolTool = (name: string) => GROUP_PROTOCOL_TOOLS.some((t) => t.function.name === name);
