import type { ToolHandler } from '../context';

export const WEB_HANDLERS: Record<string, ToolHandler> = {
  web_search: ({ bot, args, signal, deps }) => deps.web.search(bot.id, args, signal),
  web_read: ({ bot, args, signal, deps }) => deps.web.read(bot.id, args, signal),
};
