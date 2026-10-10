import { boundedInteger } from '../../../tools/file-text';
import { toolLocation } from '../../../tools/approval-reason';
import type { ToolHandler } from '../context';
import { requiredText } from '../validation';
import { execPatch } from './files';

const yieldOf = (value: unknown, fallback: number) =>
  boundedInteger(value === undefined ? fallback : value, fallback, 0, 30000, 'yieldTimeMs');

export const EXEC_HANDLERS: Record<string, ToolHandler> = {
  exec_command: async (ctx) => {
    const command = requiredText(ctx.args, 'command', 6000);
    toolLocation(ctx.args);
    const patched = await execPatch(ctx, command);
    if (patched) return { intercepted: 'apply_patch', ...patched };
    return ctx.deps.terminals.start(
      ctx.bot.id,
      ctx.runId,
      {
        ...ctx.args,
        command,
        tty: ctx.args.tty === true,
        yieldTimeMs: yieldOf(ctx.args.yieldTimeMs, 10000),
        tool: 'exec_command',
      },
      ctx.signal,
      ctx.workspace,
    );
  },
  write_stdin: ({ bot, args, signal, runId, deps }) =>
    deps.terminals.input(
      bot.id,
      runId,
      {
        ...args,
        chars: typeof args.chars === 'string' ? args.chars : '',
        yieldTimeMs: yieldOf(args.yieldTimeMs, 250),
        tool: 'write_stdin',
      },
      signal,
    ),
  exec_stop: ({ bot, args, signal, deps }) => deps.terminals.stop(bot.id, requiredText(args, 'id', 100), signal),
  exec_list: ({ bot, deps }) => ({ sessions: deps.terminals.list(bot.id) }),
};
