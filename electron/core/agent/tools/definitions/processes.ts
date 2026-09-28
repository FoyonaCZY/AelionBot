import type { ToolDefinition } from '../../../model/model';
import { string, tool } from './shared';
export const PROCESS_TOOLS: ToolDefinition[] = [
  tool(
    'process_start',
    '启动后台命令并返回进程 ID。长任务用 purpose=task，持续服务用 service。启动不代表完成。host 沿用本机会话权限。后台日志有 2 MB 上限，需要完整日志时应在首次执行就重定向到文件，不要为补输出重复有副作用的命令。',
    {
      command: string,
      location: { type: 'string', enum: ['vm', 'host'] },
      purpose: { type: 'string', enum: ['task', 'service'] },
      cwd: string,
      reason: string,
    },
    ['command', 'location', 'purpose'],
  ),
  tool('process_list', '列出自己启动的后台进程，查看是否需要等待或停止。', {}, []),
  tool(
    'process_status',
    '读取自己的后台进程状态和日志。offset 使用上次 nextOffset（字节游标）；hasMoreLog 表示还有已保存日志未读，pendingBytes 表示 UTF-8 字符尚未收齐。truncated=true 表示达到日志保存上限。不要读取其他 Bot 进程。',
    { id: string, offset: { type: 'integer', minimum: 0 } },
    ['id'],
  ),
  tool(
    'process_wait',
    '等待自己的后台进程，最多 30 秒；返回状态和新增日志。任务进程完成后核对 exitCode 再报告成功。',
    {
      id: string,
      milliseconds: { type: 'integer', minimum: 0, maximum: 30000 },
      offset: { type: 'integer', minimum: 0 },
    },
    ['id'],
  ),
  tool(
    'process_stop',
    '停止自己启动的后台进程及子进程，并核对停止结果。不会按未经核验的旧 PID 杀进程。',
    { id: string },
    ['id'],
  ),
];
