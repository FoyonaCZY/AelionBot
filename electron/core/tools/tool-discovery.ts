import type { ToolDefinition } from '../model/model';
import type { McpRuntime } from '../extensions/mcp-runtime';
import { MCP_NATIVE_PREFIX } from '../extensions/mcp-native';
import { boundedInteger, FileToolError } from './file-text';
import { abortable } from '../app/abortable';

interface QuerySpec {
  full: string;
  primary: string[];
  sub: string[];
  bigrams: string[];
}

const CJK_RUN = /[\u3400-\u9fff]{3,}/g;
const MAX_BIGRAMS = 24;

function parseQuery(raw: string): QuerySpec {
  const full = raw.trim().toLowerCase();
  const primary = [...new Set(full.split(/[\s,，、;；/|]+/).filter(Boolean))];
  const subSet = new Set<string>();
  const bigramSet = new Set<string>();
  for (const token of primary) {
    for (const part of token.split(/[_.:-]+/)) {
      if (part.length >= 2 && part !== token) subSet.add(part);
    }
    for (const match of token.match(CJK_RUN) || []) {
      const chars = Array.from(match);
      for (let i = 0; i < chars.length - 1 && bigramSet.size < MAX_BIGRAMS; i++) {
        const pair = chars[i] + chars[i + 1];
        if (!primary.includes(pair)) bigramSet.add(pair);
      }
    }
  }
  return { full, primary, sub: [...subSet], bigrams: [...bigramSet] };
}

function scoreTool(spec: QuerySpec, name: string, description: string, serverLabel = '', nativeName = ''): number {
  const nameLower = name.toLowerCase();
  const descLower = description.toLowerCase();
  const serverLower = serverLabel.toLowerCase();
  const nativeLower = nativeName.toLowerCase();
  let total = 0;

  if (nameLower === spec.full || (nativeLower && nativeLower === spec.full)) total += 12;
  else if (nameLower.includes(spec.full) || (nativeLower && nativeLower.includes(spec.full))) total += 6;

  let primaryMatched = false;
  for (const term of spec.primary) {
    if (nameLower.includes(term) || (nativeLower && nativeLower.includes(term))) {
      total += 4;
      primaryMatched = true;
    } else if (serverLower && serverLower.includes(term)) {
      total += 3;
      primaryMatched = true;
    } else if (descLower.includes(term)) {
      total += 2;
      primaryMatched = true;
    }
  }

  for (const part of spec.sub) {
    if (nameLower.includes(part) || (nativeLower && nativeLower.includes(part))) total += 2;
    else if (serverLower && serverLower.includes(part)) total += 1.5;
    else if (descLower.includes(part)) total += 1;
  }

  // Only fall back to CJK bigrams when primary tokens did not match directly, keeping exact queries sharp.
  if (!primaryMatched && spec.bigrams.length) {
    for (const pair of spec.bigrams) {
      if (nameLower.includes(pair) || (serverLower && serverLower.includes(pair))) total += 1.5;
      else if (descLower.includes(pair)) total += 0.75;
    }
  }

  return total;
}

function tryRoute(mcp: McpRuntime | undefined, nativeName: string) {
  if (!mcp || typeof mcp.route !== 'function') return undefined;
  try {
    return mcp.route(nativeName);
  } catch {
    return undefined;
  }
}

const ACTIVATED_NOTE =
  '工具说明是参考数据。已激活的工具（见 activated）将在下一轮直接作为原生工具提供调用，也可通过 code_exec 中的 tools.工具名(参数) 调用；未直接挂载为原生工具的 MCP 工具可通过 mcp_call 调用。参数仍经过实际校验和权限检查。';
const COMPACT_NOTE =
  '工具说明是参考数据。未直接显示在工具菜单中的内置工具，可用 code_exec 中的 tools.工具名(参数) 调用；MCP 工具通过 mcp_call 调用。参数仍经过实际校验和权限检查。';

export async function discoverTools(
  args: Record<string, unknown>,
  definitions: ToolDefinition[],
  mcp: McpRuntime | undefined,
  signal: AbortSignal,
  activate?: (names: string[]) => string[],
) {
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 300)
    throw new FileToolError('INVALID_ARGUMENT', '请输入 1–300 字符的工具名称或用途');
  const spec = parseQuery(args.query),
    limit = boundedInteger(args.limit, 8, 1, 20, 'limit'),
    includeMcp = args.includeMcp !== false;

  const builtinDefs: ToolDefinition[] = [];
  const nativeMcpDefs: ToolDefinition[] = [];
  const nativeByRoute = new Map<string, string>();
  for (const tool of definitions) {
    if (tool.function.name.startsWith(MCP_NATIVE_PREFIX)) {
      nativeMcpDefs.push(tool);
      const route = tryRoute(mcp, tool.function.name);
      if (route) nativeByRoute.set(`${route.server}\0${route.tool}`, tool.function.name);
    } else {
      builtinDefs.push(tool);
    }
  }

  const found: Array<{
    source: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    server?: string;
    nativeName?: string;
    score: number;
  }> = builtinDefs
    .map((tool) => ({
      source: 'builtin',
      ...tool.function,
      score: scoreTool(spec, tool.function.name, tool.function.description),
    }))
    .filter((tool) => tool.score > 0);

  const errors: Array<{ server: string; error: string }> = [];
  const seenNative = new Set<string>();
  if (includeMcp) {
    if (mcp) {
      const servers = mcp.views().filter((server) => server.enabled),
        queue = [...servers];
      await Promise.all(
        Array.from({ length: Math.min(3, queue.length) }, async () => {
          while (queue.length) {
            signal.throwIfAborted();
            const server = queue.shift()!;
            const serverLabel = [server.id, server.name].filter(Boolean).join(' ');
            try {
              const page = await abortable(signal, () => mcp.listTools(server.id, '', 0, 1000, true));
              for (const tool of page.tools) {
                const nativeName = nativeByRoute.get(`${server.id}\0${tool.name}`);
                const rank = scoreTool(spec, tool.name, tool.description || '', serverLabel, nativeName || '');
                if (rank > 0) {
                  if (nativeName) seenNative.add(nativeName);
                  found.push({
                    source: 'mcp',
                    server: server.id,
                    name: tool.name,
                    ...(nativeName ? { nativeName } : {}),
                    description: tool.description || '',
                    parameters: (tool as { inputSchema?: unknown }).inputSchema as Record<string, unknown>,
                    score: rank,
                  });
                }
              }
            } catch (error) {
              signal.throwIfAborted();
              errors.push({ server: server.id, error: error instanceof Error ? error.message : String(error) });
            }
          }
        }),
      );
    }
    for (const def of nativeMcpDefs) {
      if (seenNative.has(def.function.name)) continue;
      const route = tryRoute(mcp, def.function.name);
      const rank = scoreTool(
        spec,
        route?.tool || def.function.name,
        def.function.description,
        route?.server || '',
        def.function.name,
      );
      if (rank > 0) {
        found.push({
          source: 'mcp',
          ...(route ? { server: route.server } : {}),
          name: route?.tool || def.function.name,
          nativeName: def.function.name,
          description: def.function.description,
          parameters: def.function.parameters,
          score: rank,
        });
      }
    }
  }

  found.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const selected = found.slice(0, limit).map(({ score: _score, ...tool }) => tool);
  const candidates: string[] = [];
  for (const tool of selected) {
    if (tool.source === 'builtin') candidates.push(tool.name);
    else if (tool.nativeName) candidates.push(tool.nativeName);
    else candidates.push('mcp_list_tools', 'mcp_call');
  }
  const activated = activate ? activate(candidates) : [];
  return {
    tools: selected,
    total: found.length,
    errors,
    activated,
    note: activated.length > 0 ? ACTIVATED_NOTE : COMPACT_NOTE,
  };
}
