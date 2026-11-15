import { randomUUID } from 'node:crypto';
import type { ToolCall } from '../../../shared/types/core';
import type { Completion, ToolDefinition } from './model';

/**
 * Some models served through compatible endpoints write a tool call into the reply text instead of the tool_calls
 * field, in their chat template's own markup:
 *
 *   <tool_call><function=group_read><parameter=groupId>…</parameter></function></tool_call>   (Qwen3-Coder, GLM)
 *   <tool_call>{"name": "group_read", "arguments": {"groupId": "…"}}</tool_call>               (Hermes, Qwen2.5)
 *   <｜DSML｜function_calls><｜DSML｜invoke name="group_read">
 *   <｜DSML｜parameter name="groupId" string="true">…</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>  (DeepSeek)
 *
 * Left as text, the markup was shown as the Bot's reply and the turn stopped. Calls to tools that were offered
 * become real calls, so the turn goes on as the model meant; any such markup left over is removed from the text.
 * Closing tags are often missing, so a call runs to the next one or to the end of the reply.
 */
const BLOCK = /<tool_call>([\s\S]*?)(?:<\/tool_call>|(?=<tool_call>)|$)/g;
const XML_FUNCTION = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/;
const XML_PARAMETER = /<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g;

/** A DeepSeek tag: the ｜DSML｜ marker (also seen with ASCII bars and spaces) and the tag's name. */
const dsml = (tag: string, closing = false) =>
  String.raw`<\s*${closing ? String.raw`\/\s*` : ''}(?:[｜|]\s*)+DSML\s*(?:[｜|]\s*)+${tag}`;
const DSML_INVOKE = new RegExp(
  `${dsml('invoke')}\\s+name\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)` +
    `(?:${dsml('invoke', true)}\\s*>|(?=${dsml('invoke')}|${dsml('\\w*calls', true)})|$)`,
  'g',
);
const DSML_PARAMETER = new RegExp(
  `${dsml('parameter')}\\s+name\\s*=\\s*"([^"]+)"(?:\\s+string\\s*=\\s*"(true|false)")?\\s*>([\\s\\S]*?)` +
    `(?:${dsml('parameter', true)}\\s*>|(?=${dsml('parameter')})|$)`,
  'g',
);
/** Whatever DeepSeek tags are left: the function_calls wrapper and stray closings. */
const DSML_TAG = new RegExp(`<\\s*\\/?\\s*(?:[｜|]\\s*)+DSML\\s*(?:[｜|]\\s*)+[^>\\n]*>?`, 'g');

type Parsed = { name: string; args: Record<string, unknown> } | undefined;

/** A value as the tool's schema expects it: text stays text, anything else is read as JSON when it is. */
function typed(raw: string, type: string | undefined, isString?: boolean) {
  if (isString ?? type === 'string') return raw;
  try {
    return JSON.parse(raw.trim());
  } catch {
    return raw.trim();
  }
}

function properties(tool: ToolDefinition) {
  return (tool.function.parameters.properties || {}) as Record<string, { type?: string }>;
}

function parseBlock(body: string, tools: Map<string, ToolDefinition>): Parsed {
  const xml = XML_FUNCTION.exec(body);
  if (xml) {
    const tool = tools.get(xml[1]);
    if (!tool) return undefined;
    const schema = properties(tool);
    const args: Record<string, unknown> = {};
    for (const [, key, raw] of xml[2].matchAll(XML_PARAMETER)) args[key] = typed(raw.trim(), schema[key]?.type);
    return { name: xml[1], args };
  }
  const text = body.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(text) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof parsed.name !== 'string' || !tools.has(parsed.name)) return undefined;
    const args = parsed.arguments ?? parsed.parameters ?? {};
    return { name: parsed.name, args: typeof args === 'string' ? JSON.parse(args) : args };
  } catch {
    return undefined;
  }
}

function parseDsml(name: string, body: string, tools: Map<string, ToolDefinition>): Parsed {
  const tool = tools.get(name);
  if (!tool) return undefined;
  const schema = properties(tool);
  const args: Record<string, unknown> = {};
  // string="true" carries the text as it is; string="false" carries JSON.
  for (const [, key, string, raw] of body.matchAll(DSML_PARAMETER))
    args[key] = typed(raw, schema[key]?.type, string ? string === 'true' : undefined);
  return { name, args };
}

export function recoverTextToolCalls(result: Completion, tools: ToolDefinition[]): Completion {
  const qwen = result.content.includes('<tool_call>');
  const deepseek = result.content.includes('DSML');
  if (!qwen && !deepseek) return result;
  const offered = new Map(tools.map((tool) => [tool.function.name, tool]));
  // Converted only when the provider returned no native calls, so nothing is doubled, and when the turn is replayed
  // from its text and calls (Chat Completions); a replay of the provider's own blocks would not carry these calls.
  const convert = !result.calls.length && (!result.native || result.native.protocol === 'chat');
  const calls: ToolCall[] = [];
  const add = (parsed: Parsed) => {
    if (parsed)
      calls.push({
        id: 'text_' + randomUUID(),
        type: 'function',
        function: { name: parsed.name, arguments: JSON.stringify(parsed.args) },
      });
  };
  let content = result.content;
  if (qwen)
    content = content.replace(BLOCK, (_, body: string) => {
      if (convert) add(parseBlock(body, offered));
      return '';
    });
  if (deepseek)
    content = content
      .replace(DSML_INVOKE, (_, name: string, body: string) => {
        if (convert) add(parseDsml(name, body, offered));
        return '';
      })
      .replace(DSML_TAG, '');
  return {
    ...result,
    content: content.trim(),
    ...(calls.length ? { calls, finishReason: 'tool_calls' } : {}),
  };
}
