import type { PrefixHandler } from '../context';

export const SCHEDULED_HANDLER: PrefixHandler = {
  matches: (name) => name.startsWith('scheduled_'),
  // The scheduler owns the scheduled_* namespace and rejects unknown operations itself.
  unregistered: true,
  handler: ({ bot, args, name, signal, runId, options, deps }) => {
    if (!deps.scheduler) throw new Error('定时任务尚未启用');
    return deps.scheduler.invoke(bot.id, runId, name, args, signal, options);
  },
};
