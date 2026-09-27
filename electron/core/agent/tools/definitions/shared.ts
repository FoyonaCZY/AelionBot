import type { ToolDefinition } from '../../../model/model';
export const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});
export const string = { type: 'string' };
export const attachmentList = {
  type: 'array',
  maxItems: 10,
  items: {
    type: 'object',
    properties: {
      attachmentId: { type: 'string', description: '已有附件 ID' },
      path: {
        type: 'string',
        description: '文件路径。默认是 Bot 工作目录相对路径；本机绝对路径或 location=host 读取用户电脑上的文件',
      },
      location: {
        type: 'string',
        enum: ['vm', 'host'],
        description: 'vm 为当前 Bot 工作目录，host 为用户本机。本机绝对路径可省略此项',
      },
    },
    additionalProperties: false,
  },
};
