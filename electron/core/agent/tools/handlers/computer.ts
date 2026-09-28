import type { ComputerInput } from '../../../vm/computer';
import { vmPython } from '../../../vm/vm-python';
import type { ToolHandler } from '../context';
import { requiredText } from '../validation';

export const COMPUTER_HANDLERS: Record<string, ToolHandler> = {
  python_session: ({ bot, args, signal, runId, deps }) => {
    if (args.action === 'start') return deps.pythonSessions.start(bot.id, runId, signal);
    const id = requiredText(args, 'id', 100);
    if (args.action === 'execute') return deps.pythonSessions.execute(bot.id, runId, args, signal);
    if (args.action === 'poll')
      return deps.pythonSessions.poll(
        bot.id,
        id,
        requiredText(args, 'requestId', 100),
        signal,
        args.waitMs === undefined ? 10000 : Number(args.waitMs),
      );
    if (args.action === 'reset') return deps.pythonSessions.reset(bot.id, id, runId, signal);
    throw Error('无效 Python 会话操作');
  },
  request_user_control: async ({ bot, args, signal, runId, deps }) => {
    if (!deps.computer || !deps.interactions) throw new Error('人工接管尚不可用');
    const reason = requiredText(args, 'reason', 1000);
    deps.computer.reserveForHuman(bot.id);
    try {
      await deps.interactions.requestTakeover(
        bot.id,
        runId,
        reason,
        deps.computer.stateFor(bot.id).manualControl,
        signal,
      );
      deps.computer.clearHumanHold(bot.id);
      const result = await deps.computer.execute(bot.id, { action: 'screenshot' }, signal);
      return { ...result, message: '用户已交还控制，请根据新截图核对人工操作的实际结果。' };
    } finally {
      deps.computer.clearHumanHold(bot.id);
    }
  },
  computer: ({ bot, args, signal, deps }) => {
    if (!deps.computer) throw new Error('Computer Use 未配置');
    return deps.computer.execute(bot.id, args as unknown as ComputerInput, signal);
  },
  computer_execute: ({ bot, args, signal, deps }) =>
    deps.vm.execute(requiredText(args, 'command', 32000), bot.id, signal),
  python_execute: ({ bot, args, signal, deps }) =>
    vmPython(
      deps.vm,
      bot.id,
      { code: requiredText(args, 'code', 24000) },
      'exec(compile(a["code"],"<python_execute>","exec"))',
      signal,
    ),
};
