// Checking scripts of automations, run in the same QuickJS sandbox as code_exec: no file system, no Node, only
// `tools.fetch` to public addresses and the state the script kept from its last check.
import { AppError } from '../../../shared/errors';
import type { CodeOrchestrator } from '../tools/code-orchestrator';
import { requestPublic } from '../tools/web-tools';
import type { ScriptOutcome } from '../scheduler/task-scheduler';

/** A check that takes longer than this is stopped and counts as failed. */
const CHECK_MS = 30_000;
const FETCHES = 10;
/** Response text a script sees per request; enough for an API's JSON or a page's text. */
const BODY_CHARS = 200_000;

function fetchInput(args: Record<string, unknown>) {
  const url = typeof args.url === 'string' ? args.url : '',
    method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method))
    throw new AppError('automation.fetch_method', '不支持的请求方法');
  const headers: Record<string, string> = {};
  if (args.headers !== undefined) {
    if (!args.headers || typeof args.headers !== 'object' || Array.isArray(args.headers))
      throw new AppError('automation.fetch_headers', 'headers 应为字符串键值对');
    for (const [key, value] of Object.entries(args.headers)) {
      if (typeof value !== 'string' || /[\r\n]/.test(key + value))
        throw new AppError('automation.fetch_headers', 'headers 应为字符串键值对');
      headers[key] = value;
    }
  }
  const body =
    args.body === undefined ? undefined : typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  if (body && body.length > 64_000) throw new AppError('automation.fetch_body', '请求体不能超过 64000 字符');
  if (body && args.body !== undefined && typeof args.body !== 'string' && !headers['content-type'])
    headers['content-type'] = 'application/json';
  return { url, init: { method, headers, ...(body !== undefined ? { body } : {}) } };
}

/** Runs one check of a script; its value decides whether the automation fires. */
export async function checkAutomationScript(
  code: CodeOrchestrator,
  source: string,
  state: unknown,
  signal: AbortSignal,
): Promise<ScriptOutcome> {
  let fetches = 0;
  const program =
    `let state = ${JSON.stringify(state ?? null)};\n` +
    `const __out = await (async () => {\n${source}\n})();\n` +
    'return { out: __out === undefined ? null : __out, state };';
  const result = (await code.run({ code: program, timeoutMs: CHECK_MS }, ['fetch'], signal, async (_name, args) => {
    if (++fetches > FETCHES) throw new AppError('automation.fetch_limit', `一次检查最多请求 ${FETCHES} 次`);
    const { url, init } = fetchInput(args);
    const response = await requestPublic(url, init, signal);
    return {
      status: response.status,
      contentType: response.contentType,
      body: response.body.slice(0, BODY_CHARS),
      ...(response.body.length > BODY_CHARS ? { truncated: true } : {}),
    };
  })) as { value?: { out?: unknown; state?: unknown } };
  const out = result.value?.out as { fire?: unknown; message?: unknown; state?: unknown } | boolean | null;
  const object = out && typeof out === 'object' ? out : undefined;
  return {
    fire: out === true || object?.fire === true,
    message: typeof object?.message === 'string' ? object.message.slice(0, 4000) : '',
    state: object && 'state' in object ? object.state : result.value?.state,
  };
}
