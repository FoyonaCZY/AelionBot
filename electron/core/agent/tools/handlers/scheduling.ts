import type { PrefixHandler } from '../context';

export const SCHEDULED_HANDLER: PrefixHandler = {
  matches: (name) => name.startsWith('automation'),
  // The scheduler owns the automation* namespace and rejects unknown operations itself.
  unregistered: true,
  handler: ({ bot, args, name, signal, runId, options, deps }) => {
    if (!deps.scheduler) throw new Error('自动化尚未启用');
    return deps.scheduler.invoke(bot.id, runId, name, args, signal, options);
  },
};
