import { AppError } from '../../../../../shared/errors';
import type { ComputerInput } from '../../../vm/computer';
import type { HostComputerInput } from '../../../host/desktop/host-desktop';
import { vmPython } from '../../../vm/vm-python';
import type { ToolContext, ToolHandler } from '../context';
import { requiredText } from '../validation';

async function resolvePythonVaultEnv(
  ctx: ToolContext,
  targetSummary: string,
): Promise<Record<string, string> | undefined> {
  const raw = ctx.args.vaultEnv;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('vault.ref_invalid', 'vaultEnv 必须是环境变量字符串映射对象');
  }
  const envMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new AppError('vault.ref_invalid', `vaultEnv.${k} 必须是字符串`);
    }
    envMap[k] = v;
  }
  if (!Object.keys(envMap).length) return undefined;
  if (!ctx.deps.vaultResolver) {
    throw new AppError('vault.encryption_unavailable', '保险库解析器未配置，无法在 Python 中注入凭据');
  }
  const baseCtx = ctx.deps.vaultContext?.(ctx.bot.id, ctx.runId, ctx.options) ?? {
    botId: ctx.bot.id,
    runId: ctx.runId,
  };
  return ctx.deps.vaultResolver.resolveEnv(envMap, {
    ...baseCtx,
    sink: 'python_env',
    targetSummary,
    signal: ctx.signal,
  });
}

export const COMPUTER_HANDLERS: Record<string, ToolHandler> = {
  python_session: async (ctx) => {
    const { bot, args, signal, runId, deps } = ctx;
    if (args.action === 'start') return deps.pythonSessions.start(bot.id, runId, signal);
    const id = requiredText(args, 'id', 100);
    if (args.action === 'execute') {
      const vaultEnv = await resolvePythonVaultEnv(ctx, '工作电脑 Python 会话环境变量');
      return deps.pythonSessions.execute(bot.id, runId, args, signal, vaultEnv);
    }
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
    deps.claimDesktop(bot.id, runId);
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
  computer: ({ bot, args, signal, runId, options, deps }) => {
    if (!deps.computer) throw new Error('Computer Use 未配置');
    // The Bot has one desktop: while one of its chats drives it, the others wait.
    deps.claimDesktop(bot.id, runId);
    return deps.computer.execute(
      bot.id,
      args as unknown as ComputerInput,
      signal,
      deps.vaultContext?.(bot.id, runId, options),
    );
  },
  host_computer: ({ bot, args, signal, runId, options, deps }) => {
    if (!deps.hostDesktop?.enabled) throw new Error('本机电脑控制未开启');
    return deps.hostDesktop.execute(
      bot.id,
      runId,
      args as unknown as HostComputerInput,
      signal,
      deps.vaultContext?.(bot.id, runId, options),
    );
  },
  python_execute: async (ctx) => {
    const { bot, args, signal, deps } = ctx;
    const code = requiredText(args, 'code', 24000);
    const vaultEnv = await resolvePythonVaultEnv(ctx, '工作电脑 Python 执行环境变量');
    return vmPython(
      deps.vm,
      bot.id,
      { code },
      'exec(compile(a["code"],"<python_execute>","exec"))',
      signal,
      undefined,
      vaultEnv,
    );
  },
};
