import type { ToolDefinition } from '../../../model/model';
import { READ_TOOLS } from '../../../tools/tool-pipeline';
import { string, tool } from './shared';
export const BATCH_TOOLS: ToolDefinition[] = [
  tool(
    'tools_batch',
    '并行读取或组织读取依赖链，可用工具见 tool 枚举，包含本机文件读取与检索。本机读取沿用当前会话权限，拒绝会停止本批。dependsOn 只能引用前面步骤；参数可写 {"$from":"步骤ID","path":"result.path"}。失败依赖的后续步骤会跳过，独立步骤继续；结果带 status。不执行写入、命令或界面操作。',
    {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[\\w-]{1,40}$' },
            tool: { type: 'string', enum: [...READ_TOOLS] },
            args: { type: 'object', additionalProperties: true },
            dependsOn: { type: 'array', items: string, uniqueItems: true },
          },
          required: ['id', 'tool', 'args'],
          additionalProperties: false,
        },
      },
    },
    ['steps'],
  ),
];
export const READ_RESULT_TOOLS: ToolDefinition[] = [
  tool(
    'read_result',
    '分页读取自己的工具输出记录，包括批处理中子步骤的 resultId。使用 nextOffset 继续，eof=true 时结束；maxChars 最大 32000。不会读取其他 Bot 的结果。',
    { id: string, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 1, maximum: 32000 } },
    ['id'],
  ),
];
