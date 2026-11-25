import { AppError } from '../../../../../shared/errors';
import { containsVaultMarker } from '../../../../../shared/vault-refs';
import { FILE_INPUTS_META, type BridgedFile } from '../../../extensions/mcp-files';
import { namedFile } from './attachments';
import { boundedInteger } from '../../../tools/file-text';
import type { PrefixHandler } from '../context';
import { requiredText } from '../validation';
import { MCP_NATIVE_PREFIX } from '../../../extensions/mcp-native';
import type { McpRuntime } from '../../../extensions/mcp-runtime';
import type { ToolContext } from '../context';

function treeHasVaultMarker(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return containsVaultMarker(value);
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => treeHasVaultMarker(item, seen));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, item]) => containsVaultMarker(key) || treeHasVaultMarker(item, seen),
  );
}

/** The files a tool inside this app reads, as stored copies of attachments the run may use. */
async function bridgedInputs(context: ToolContext, inputs: string[], args: Record<string, unknown>) {
  const files: Record<string, BridgedFile> = {};
  for (const key of inputs) {
    if (args[key] === undefined) continue;
    const file = await namedFile(context, args[key], '让插件读取本机文件');
    files[key] = { ...context.deps.attachments.storedFile(context.bot.id, file.id), mime: file.mime, size: file.size };
  }
  return files;
}

/** Checks one tool call, asks for approval where the server or permission mode needs it, then runs it. */
async function callTool(
  mcp: McpRuntime,
  context: ToolContext,
  server: string,
  toolName: string,
  input: Record<string, unknown>,
) {
  const { bot, signal, runId, options, deps } = context;
  const inspection = await mcp.inspectCall(server, toolName, input, Boolean(deps.interactions?.hasHostPolicy));
  if (inspection.permission) {
    if (!deps.interactions) throw new Error('此 MCP 操作需要用户确认');
    await deps.interactions.permission(bot.id, runId, inspection.permission, signal);
  }
  signal.throwIfAborted();
  const bridge = mcp.fileBridge(server, toolName);
  const meta = bridge && { [FILE_INPUTS_META]: await bridgedInputs(context, bridge.inputs, input) };
  let resolvedInput = input;
  if (deps.vaultResolver) {
    const baseCtx = deps.vaultContext?.(bot.id, runId, options) ?? { botId: bot.id, runId };
    resolvedInput = await deps.vaultResolver.resolveObject(input, {
      ...baseCtx,
      sink: 'mcp',
      targetSummary: `MCP：${server} / ${toolName}`,
      target: { kind: 'mcp', value: server },
      signal,
    });
  } else if (treeHasVaultMarker(input)) {
    throw new AppError('vault.encryption_unavailable', '保险库解析器未配置，无法在 MCP 工具中注入凭据');
  }
  try {
    const output = await mcp.call(server, toolName, resolvedInput, signal, inspection.fingerprint, meta);
    return deps.vault ? deps.vault.redactor.redactValue(output, { runId }) : output;
  } catch (error) {
    throw deps.vault ? deps.vault.redactor.redactError(error, { runId }) : error;
  }
}

export const MCP_HANDLER: PrefixHandler = {
  matches: (name) => name.startsWith('mcp_'),
  handler: async (context) => {
    const { args, name, signal, deps } = context;
    if (!deps.integrations) throw new Error('MCP 未配置');
    const mcp = deps.integrations.mcp;
    if (name.startsWith(MCP_NATIVE_PREFIX)) {
      const route = mcp.route(name);
      return callTool(mcp, context, route.server, route.tool, args);
    }
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
      return callTool(mcp, context, server, requiredText(args, 'name', 200), input as Record<string, unknown>);
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
