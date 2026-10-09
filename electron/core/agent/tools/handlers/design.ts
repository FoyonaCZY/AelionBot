import type { PrefixHandler } from '../context';

/** design_* tools: local design tasks, run by DesignWork for the general agent. */
export const DESIGN_HANDLER: PrefixHandler = {
  matches: (name) => name.startsWith('design_'),
  handler: ({ bot, args, name, signal, runId, run, options, deps }) => {
    if (!deps.design || !run) throw new Error('设计功能尚未就绪');
    return deps.design.invoke(run, name, args, signal, {
      invoke: (tool, input) => deps.invokeNested(bot, tool, input, signal, runId, options),
      callable: (tool) => Boolean(deps.callableTools(runId)?.some((item) => item.function.name === tool)),
      pending: () => deps.pendingTasks(bot.id, runId),
    });
  },
};
