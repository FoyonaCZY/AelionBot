import { boundedInteger } from '../../../tools/file-text';
import type { PrefixHandler } from '../context';
import { requiredText } from '../validation';

export const MCP_HANDLER: PrefixHandler = {
  matches: (name) => name.startsWith('mcp_'),
  handler: async ({ bot, args, name, signal, runId, deps }) => {
    if (!deps.integrations) throw new Error('MCP 未配置');
    const mcp = deps.integrations.mcp;
    if (name === 'mcp_list_servers') return mcp.views();
    const server = requiredText(args, 'server', 160);
    if (name === 'mcp_list_tools')
      return mcp.listTools(
        server,
        String(args.query || ''),
        boundedInteger(args.offset, 0, 0, 100000, 'offset'),
        boundedInteger(args.limit, 100, 1, 100, 'limit'),
      );
    if (name === 'mcp_call') {
      const input = args.arguments;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MCP 参数必须是对象');
      const toolName = requiredText(args, 'name', 200),
        inspection = await mcp.inspectCall(
          server,
          toolName,
          input as Record<string, unknown>,
          Boolean(deps.interactions?.hasHostPolicy),
        );
      if (inspection.permission) {
        if (!deps.interactions) throw new Error('此 MCP 操作需要用户确认');
        await deps.interactions.permission(bot.id, runId, inspection.permission, signal);
      }
      signal.throwIfAborted();
      return mcp.call(server, toolName, input as Record<string, unknown>, signal, inspection.fingerprint);
    }
    if (name === 'mcp_list_resources')
      return mcp.listResources(server, typeof args.cursor === 'string' ? args.cursor : undefined);
    if (name === 'mcp_list_resource_templates')
      return mcp.listResourceTemplates(server, typeof args.cursor === 'string' ? args.cursor : undefined);
    if (name === 'mcp_read_resource') return mcp.readResource(server, requiredText(args, 'uri', 4000), signal);
    if (name === 'mcp_list_prompts') return mcp.listPrompts(server);
    if (name === 'mcp_get_prompt') {
      const values = args.arguments || {};
      if (
        typeof values !== 'object' ||
        Array.isArray(values) ||
        Object.values(values).some((value) => typeof value !== 'string')
      )
        throw new Error('模板参数必须为字符串对象');
      return mcp.getPrompt(server, requiredText(args, 'name', 200), values as Record<string, string>, signal);
    }
    throw new Error('未注册的 MCP 操作');
  },
};
