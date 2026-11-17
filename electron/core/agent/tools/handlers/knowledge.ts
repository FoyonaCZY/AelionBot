import { unregisteredTool, type ToolHandler } from '../context';
import { requiredText } from '../validation';

export const KNOWLEDGE_HANDLERS: Record<string, ToolHandler> = {
  knowledge_search: ({ bot, args, name, signal, deps }) => {
    if (!deps.knowledge?.offers(bot.id)) throw unregisteredTool(name);
    return deps.knowledge.search(
      bot.id,
      {
        query: requiredText(args, 'query', 1000),
        ...(typeof args.base === 'string' && args.base.trim() ? { base: args.base } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      },
      signal,
    );
  },
};
