import { boundedInteger } from '../../../tools/file-text';
import type { ToolHandler } from '../context';
import { requiredText } from '../validation';

export const TERMINAL_HANDLERS: Record<string, ToolHandler> = {
  terminal_start: ({ bot, args, signal, runId, workspace, deps }) =>
    deps.terminals.start(bot.id, runId, args, signal, workspace),
  terminal_input: ({ bot, args, signal, runId, deps }) => deps.terminals.input(bot.id, runId, args, signal),
  terminal_read: ({ bot, args, signal, deps }) =>
    deps.terminals.read(
      bot.id,
      requiredText(args, 'id', 100),
      signal,
      boundedInteger(args.waitMs, 1000, 0, 30000, 'waitMs'),
      boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
    ),
  terminal_stop: ({ bot, args, signal, deps }) => deps.terminals.stop(bot.id, requiredText(args, 'id', 100), signal),
};

export const PROCESS_HANDLERS: Record<string, ToolHandler> = {
  process_start: ({ bot, args, signal, runId, deps }) =>
    deps.processes.start(bot.id, runId, args, signal, deps.store.data.runs.find((r) => r.id === runId)?.workspaceDir),
  process_list: ({ bot, deps }) => deps.processes.list(bot.id),
  process_status: ({ bot, args, signal, deps }) =>
    deps.processes.status(bot.id, requiredText(args, 'id', 100), signal, Number(args.offset) || 0),
  process_wait: ({ bot, args, signal, deps }) =>
    deps.processes.wait(
      bot.id,
      requiredText(args, 'id', 100),
      signal,
      args.milliseconds === undefined ? 10000 : Number(args.milliseconds),
      Number(args.offset) || 0,
    ),
  process_stop: ({ bot, args, signal, deps }) => deps.processes.stop(bot.id, requiredText(args, 'id', 100), signal),
};
