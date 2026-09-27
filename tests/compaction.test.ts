import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { CognitiveStore } from '../electron/core/memory/cognitive-store';
import { ContextEngine, parseContextSummary } from '../electron/core/context/context-engine';
import { contextBudget, textTokens } from '../electron/core/context/context-budget';
import { protocolRequest } from '../electron/core/model/model-protocol';
import type { ModelClient, ToolDefinition } from '../electron/core/model/model';
import type { ModelConfig, WireMessage } from '../shared/types/core';

const summary = JSON.stringify({
  goal: '继续任务',
  userMessages: ['只改本地项目'],
  files: ['src/a.ts：已加入校验'],
  constraints: [],
  done: ['读取了资料'],
  pending: ['完成回复'],
  decisions: [],
  failures: [],
  next: ['核对结果'],
});
const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
];
function fixture(t: test.TestContext, contextTokens = 8000) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-compaction-')),
    store = new Store(dir),
    storage = new CognitiveStore(store),
    bot = store.data.bots[0];
  store.data.model.contextTokens = contextTokens;
  t.after(() => {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, storage, bot };
}
const entry = (i: number): WireMessage => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `记录 ${i} ` + '工作细节。'.repeat(12),
});
// Grow the conversation one small message at a time, as a real chat does, until the first compaction.
async function growUntilCompaction(
  engine: ContextEngine,
  input: { history: WireMessage[] } & Parameters<ContextEngine['prepare']>[0],
  compacted: () => boolean,
) {
  for (let i = 0; i < 400; i++) {
    input.history.push(entry(i));
    const result = await engine.prepare(input);
    if (compacted()) return result;
  }
  throw Error('No compaction happened');
}

test('compaction appends its instruction to the conversation request so the provider cache is reused', async (t) => {
  const f = fixture(t),
    requests: Array<{ messages: WireMessage[]; tools: ToolDefinition[]; options: any }> = [];
  const model = {
    complete: async (
      messages: WireMessage[],
      sent: ToolDefinition[],
      _signal: AbortSignal,
      _text: unknown,
      options: any,
    ) => {
      requests.push({ messages, tools: sent, options });
      return { content: summary, calls: [], finishReason: 'stop' };
    },
  } as unknown as ModelClient;
  const system: WireMessage = { role: 'system', content: '遵循用户最新要求。' },
    input = {
      botId: f.bot.id,
      runId: 'run',
      system,
      history: [] as WireMessage[],
      tools,
      signal: new AbortController().signal,
    };
  const engine = new ContextEngine(f.storage, model, () => {}),
    budget = contextBudget(8000);
  const result = await growUntilCompaction(engine, input, () => requests.length > 0);
  assert.ok(result.stats.compactions > 0);
  const first = requests[0];
  assert.equal(first.options.purpose, 'compaction');
  assert.equal(first.options.cachePurpose, 'foreground');
  assert.equal(first.options.cacheScope, f.bot.id);
  assert.deepEqual(first.tools, tools);
  assert.deepEqual(first.messages[0], system);
  assert.match(first.messages.at(-1)!.content!, /上下文压缩请求/);
  assert.match(first.messages.at(-1)!.content!, new RegExp(`targetTokens=${budget.summary}`));
  // The conversation messages precede the instruction unchanged, i.e. the same prefix as the main request.
  assert.ok(first.messages.slice(1, -1).some((message) => message.content === input.history[0].content));
});

test('if the model tries to call a tool during compaction the serialized tool-free request is used instead', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const seen: number[] = [];
  const model = {
    complete: async (_messages: WireMessage[], sent: ToolDefinition[]) => {
      calls++;
      seen.push(sent.length);
      return calls === 1
        ? {
            content: '',
            calls: [{ id: 'x', type: 'function', function: { name: 'file_read', arguments: '{"path":"a"}' } }],
            finishReason: 'tool_calls',
          }
        : { content: summary, calls: [], finishReason: 'stop' };
    },
  } as unknown as ModelClient;
  const result = await growUntilCompaction(
    new ContextEngine(f.storage, model, () => {}),
    {
      botId: f.bot.id,
      runId: 'run',
      system: { role: 'system', content: '规则' },
      history: [],
      tools,
      signal: new AbortController().signal,
    },
    () => calls > 0,
  );
  assert.equal(seen[0], 1);
  assert.equal(seen[1], 0);
  assert.ok(result.stats.compactions > 0);
  assert.ok(f.storage.head(f.bot.id).summary.includes('src/a.ts'));
});

test('summaries accept file and user-message fields, keep the old shape valid and are fitted locally when long', () => {
  const old = JSON.stringify({
    goal: 'g',
    constraints: [],
    done: [],
    pending: [],
    decisions: [],
    failures: [],
    next: [],
  });
  assert.equal(parseContextSummary(old, 1000), old);
  const parsed = JSON.parse(parseContextSummary(summary, 1000));
  assert.deepEqual(parsed.files, ['src/a.ts：已加入校验']);
  assert.deepEqual(parsed.userMessages, ['只改本地项目']);
  const long = JSON.stringify({
    goal: '目标',
    userMessages: Array.from({ length: 16 }, (_, i) => `要求 ${i} ` + '细节'.repeat(200)),
    constraints: [],
    done: Array.from({ length: 16 }, (_, i) => `完成 ${i} ` + '内容'.repeat(200)),
    pending: [],
    decisions: [],
    failures: [],
    next: [],
  });
  const fitted = parseContextSummary(long, 600);
  assert.ok(textTokens(fitted) <= 600);
  // The newest user requirements survive fitting.
  assert.match(JSON.parse(fitted).userMessages.at(-1), /要求 15/);
  assert.throws(
    () =>
      parseContextSummary(
        JSON.stringify({ goal: 'g', constraints: 'x', done: [], pending: [], decisions: [], failures: [], next: [] }),
        1000,
      ),
    /constraints/,
  );
});

test('budgets compact at a configurable share of the window and scale the tail and summary with very large windows', () => {
  for (const capacity of [128000, 200000, 1_000_000])
    assert.equal(contextBudget(capacity).trigger, Math.floor(capacity * 0.85));
  assert.equal(contextBudget(1_000_000, 60).trigger, 600000);
  assert.equal(contextBudget(1_000_000, 10).trigger, 500000, 'the ratio is clamped to 50–95%');
  // Small windows still keep the headroom below the input budget.
  assert.ok(contextBudget(32000).trigger < contextBudget(32000).input);
  // The summary call gets more output than a normal turn so reasoning cannot starve the summary.
  assert.ok(contextBudget(128000).compaction >= contextBudget(128000).summary * 2);
  assert.ok(contextBudget(128000).compaction > contextBudget(128000).output);
  assert.equal(contextBudget(1_000_000).summary, 8000);
  assert.ok(contextBudget(1_000_000).tail > 100000);
  assert.equal(contextBudget(160000).output, 8192);
  assert.equal(contextBudget(200000).output, 8192);
  for (const capacity of [8000, 32000, 128000, 160000, 200000, 1_000_000]) {
    const budget = contextBudget(capacity);
    assert.equal(budget.input + budget.output + budget.safety, capacity);
    assert.ok(budget.tail < budget.input && budget.summary < budget.tail);
  }
});

test('Anthropic thinking never takes more than half of the output and drops a custom temperature', () => {
  const config = {
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-x',
    contextTokens: 200000,
    protocol: 'anthropic',
    thinkingBudget: 32000,
    temperature: 0.2,
  } as ModelConfig;
  const body = protocolRequest(config, [{ role: 'user', content: 'hi' }], [], 4096, 'key', () => '').body as any;
  assert.equal(body.thinking.budget_tokens, 2048);
  assert.equal(body.temperature, undefined);
  const small = protocolRequest(config, [{ role: 'user', content: 'hi' }], [], 1500, 'key', () => '').body as any;
  assert.equal(small.thinking, undefined);
  assert.equal(small.temperature, 0.2);
});
