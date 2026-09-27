import { unregisteredTool, type PrefixHandler, type ToolContext, type ToolHandler } from '../context';
import { TOOLS } from '../index';
import { ATTACHMENT_HANDLERS } from './attachments';
import { CHAT_HANDLERS, GROUP_HANDLER } from './chat';
import { COMPUTER_HANDLERS } from './computer';
import { DELEGATION_HANDLERS } from './delegation';
import { FILE_HANDLERS, HOST_HANDLER } from './files';
import { MCP_HANDLER } from './mcp';
import { MEDIA_HANDLERS } from './media';
import { MEMORY_HANDLERS, SKILL_HANDLERS } from './memory';
import { MISC_HANDLERS } from './misc';
import { PLANNING_HANDLERS } from './planning';
import { PROCESS_HANDLERS, TERMINAL_HANDLERS } from './processes';
import { SCHEDULED_HANDLER } from './scheduling';
import { WEB_HANDLERS } from './web';

/** Handlers for exact tool names. Names never overlap with a prefix handler (see tests/tool-registry.test.ts). */
export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  ...MEDIA_HANDLERS,
  ...TERMINAL_HANDLERS,
  ...FILE_HANDLERS,
  ...WEB_HANDLERS,
  ...MISC_HANDLERS,
  ...COMPUTER_HANDLERS,
  ...DELEGATION_HANDLERS,
  ...PROCESS_HANDLERS,
  ...PLANNING_HANDLERS,
  ...ATTACHMENT_HANDLERS,
  ...CHAT_HANDLERS,
  ...MEMORY_HANDLERS,
  ...SKILL_HANDLERS,
};

/** Handlers for tool namespaces, tried in order. */
export const PREFIX_HANDLERS: PrefixHandler[] = [SCHEDULED_HANDLER, GROUP_HANDLER, HOST_HANDLER, MCP_HANDLER];

export function dispatchTool(context: ToolContext) {
  const { name } = context;
  if (Object.hasOwn(TOOL_HANDLERS, name)) return TOOL_HANDLERS[name](context);
  const prefix = PREFIX_HANDLERS.find((entry) => entry.matches(name));
  if (prefix?.unregistered) return prefix.handler(context);
  if (!TOOLS.some((tool) => tool.function.name === name)) throw new Error('未注册工具');
  if (prefix) return prefix.handler(context);
  throw unregisteredTool(name);
}
