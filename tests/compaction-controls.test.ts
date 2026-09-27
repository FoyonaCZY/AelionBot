import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/store';
import { CognitiveStore } from '../electron/core/cognitive-store';
import {
  ContextEngine,
  localSummary,
  parseContextSummary,
  restoreCandidates,
  type FileRestorer,
} from '../electron/core/context-engine';
import { Interactions } from '../electron/core/interactions';
import type { ModelClient, ToolDefinition } from '../electron/core/model';
import type { WireMessage } from '../src/shared';

const summary = JSON.stringify({
  goal: '继续任务',
  constraints: [],
  done: ['读取了资料'],
  pending: [],
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
  const dir = mkdtempSync(join(tmpdir(), 'aelion-compaction-controls-')),
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
const entry = (i: number, size = 12): WireMessage => ({
  role: i % 2 ? 'assistant' : 'user',
  content: `记录 ${i} ` + '工作细节。'.repeat(size),
});
const call = (id: string, name: string, args: unknown): WireMessage[] => [
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  },
  { role: 'tool', tool_call_id: id, content: JSON.stringify({ result: { ok: true } }) },
];
const recorder = (content = summary) => {
  const requests: Array<{ messages: WireMessage[]; tools: ToolDefinition[] }> = [];
  return {
    requests,
    model: {
      complete: async (messages: WireMessage[], sent: ToolDefinition[]) => {
        requests.push({ messages, tools: sent });
        return { content, calls: [], finishReason: 'stop' };
      },
    } as unknown as ModelClient,
  };
};

test('over-long summaries keep the newest entries of every field', () => {
  const long = JSON.stringify({
    goal: '目标',
    constraints: [],
    done: Array.from({ length: 16 }, (_, i) => `完成 ${i} ` + '内容'.repeat(200)),
    files: Array.from({ length: 16 }, (_, i) => `文件 ${i} ` + '说明'.repeat(200)),
    pending: [],
    decisions: [],
    failures: [],
    next: [],
  });
  const fitted = JSON.parse(parseContextSummary(long, 500));
  assert.match(fitted.done.at(-1), /完成 15/);
  assert.match(fitted.files.at(-1), /文件 15/);
  assert.doesNotMatch(fitted.done[0], /完成 0 /);
});

test('restore candidates are the newest files of the dropped records, deduplicated and not already visible', () => {
  const history: WireMessage[] = [
    ...call('a', 'file_patch', { path: '/work/b/a.py' }),
    ...call('b', 'host_file_read', { path: 'src/b.ts' }),
    ...call('c', 'apply_patch', {
      patch: '*** Begin Patch\n*** Update File: src/c.ts\n@@\n-x\n+y\n*** Add File: src/d.ts\n+z\n*** End Patch',
    }),
    ...call('d', 'host_file_patch', { path: 'src/b.ts' }),
    ...call('e', 'host_file_read', { path: 'src/tail.ts' }),
    ...call('f', 'host_file_read', { path: 'src/tail.ts' }),
  ];
  const through = 8;
  assert.deepEqual(restoreCandidates(history, through), [
    { location: 'host', path: 'src/b.ts' },
    { location: 'host', path: 'src/d.ts' },
    { location: 'host', path: 'src/c.ts' },
    { location: 'vm', path: '/work/b/a.py' },
  ]);
  // A file the kept tail already shows is not duplicated.
  assert.ok(
    !restoreCandidates([...call('x', 'host_file_read', { path: 'src/tail.ts' }), ...history.slice(8)], 2).length,
  );
  assert.equal(restoreCandidates(history, through, 2).length, 2);
});

test('the rule-based summary carries user requests, files and failures and stays valid', () => {
  const covered: WireMessage[] = [
    { role: 'user', content: '请修复登录问题' },
    ...call('a', 'host_file_patch', { path: 'src/login.ts' }),
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'b',
          type: 'function',
          function: { name: 'host_execute', arguments: JSON.stringify({ command: 'npm test' }) },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'b', content: JSON.stringify({ result: { exitCode: 1, stderr: 'fail' } }) },
  ];
  const result = JSON.parse(
    localSummary(
      JSON.stringify({
        goal: '旧目标',
        constraints: ['只改 src'],
        done: [],
        pending: [],
        decisions: [],
        failures: [],
        next: [],
      }),
      covered,
      2000,
    ),
  );
  assert.equal(result.goal, '旧目标');
  assert.deepEqual(result.userMessages, ['请修复登录问题']);
  assert.deepEqual(result.constraints, ['只改 src']);
  assert.ok(result.files.some((file: string) => file.startsWith('src/login.ts')));
  assert.ok(result.done.some((item: string) => item.includes('host_file_patch')));
  assert.ok(result.failures.some((item: string) => item.includes('npm test')));
});

test('when the summary model keeps failing, an over-budget request still continues with a rule-based summary', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const engine = new ContextEngine(
    f.storage,
    {
      complete: async () => {
        calls++;
        throw Error('summary provider down');
      },
    } as unknown as ModelClient,
    () => {},
  );
  const input = {
    botId: f.bot.id,
    runId: 'run',
    system: { role: 'system' as const, content: '规则' },
    history: [] as WireMessage[],
    tools,
    signal: new AbortController().signal,
  };
  for (let i = 0; i < 400 && !f.storage.head(f.bot.id).revision; i++) {
    input.history.push(entry(i));
    await engine.prepare(input);
  }
  const head = f.storage.head(f.bot.id);
  assert.equal(head.revision, 1);
  assert.ok(calls > 0);
  assert.match(head.summary, /按规则整理/);
  assert.ok(f.store.data.messages.some((message) => message.content.includes('已按规则整理')));
  assert.match(engine.stats(f.bot.id)!.lastIssue || '', /规则摘要/);
});

test('manual compaction runs outside a run with the focus, compacts short histories and leaves the live view alone', async (t) => {
  const f = fixture(t),
    { requests, model } = recorder(),
    engine = new ContextEngine(f.storage, model, () => {});
  const history = Array.from({ length: 12 }, (_, i) => entry(i, 60));
  const result = await engine.compactNow(f.bot.id, history, '保留接口设计', new AbortController().signal);
  assert.equal(result.compacted, true);
  assert.ok(result.freedTokens > 500);
  assert.equal(f.storage.head(f.bot.id).revision, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools.length, 0, 'the detached run uses the serialized, tool-free request');
  assert.equal(JSON.parse(requests[0].messages[1].content!).focus, '保留接口设计');
  assert.match(requests[0].messages[0].content!, /最新的放最后/);
  assert.equal(
    f.storage.contextState(f.bot.id, f.bot.id, 'view'),
    undefined,
    'the placeholder system prompt is never persisted',
  );
  assert.equal(engine.stats(f.bot.id), undefined);
  assert.ok(!f.store.data.messages.find((message) => message.content.includes('已整理较早'))?.runId);
  const other = fixture(t),
    short = await new ContextEngine(other.storage, model, () => {}).compactNow(
      other.bot.id,
      history.slice(0, 1),
      '',
      new AbortController().signal,
    );
  assert.deepEqual(short, { compacted: false, freedTokens: 0, issue: '没有可以压缩的较早记录' });
});

test('a compaction requested while busy runs before the next request and reuses the conversation prefix', async (t) => {
  const f = fixture(t),
    { requests, model } = recorder(),
    engine = new ContextEngine(f.storage, model, () => {});
  const input = {
    botId: f.bot.id,
    runId: 'run',
    system: { role: 'system' as const, content: '规则' },
    history: Array.from({ length: 12 }, (_, i) => entry(i, 60)),
    tools,
    signal: new AbortController().signal,
  };
  await engine.prepare(input);
  assert.equal(requests.length, 0);
  engine.requestCompaction(f.bot.id, '保留报错');
  assert.equal(engine.compactionPending(f.bot.id), true);
  const prepared = await engine.prepare(input);
  assert.equal(engine.compactionPending(f.bot.id), false);
  assert.equal(prepared.stats.compactions, 1);
  assert.deepEqual(requests[0].tools, tools);
  assert.match(requests[0].messages.at(-1)!.content!, /保留报错/);
  await engine.prepare(input);
  assert.equal(requests.length, 1, 'the request is consumed once');
});

test('compaction re-reads recently used files into the stable reference', async (t) => {
  const f = fixture(t),
    { model } = recorder(),
    engine = new ContextEngine(f.storage, model, () => {});
  let asked: unknown;
  const restoreFiles: FileRestorer = async (files, maxChars) => {
    asked = { files, maxChars };
    return files.map((file) => ({ ...file, content: 'export const a=1;', truncated: false, sha256: 'abc' }));
  };
  const input = {
    botId: f.bot.id,
    runId: 'run',
    system: { role: 'system' as const, content: '规则' },
    history: [
      ...call('a', 'host_file_patch', { path: 'src/a.ts' }),
      ...Array.from({ length: 12 }, (_, i) => entry(i, 60)),
    ],
    tools,
    signal: new AbortController().signal,
    restoreFiles,
  };
  engine.requestCompaction(f.bot.id);
  const first = await engine.prepare(input);
  assert.deepEqual((asked as any).files, [{ location: 'host', path: 'src/a.ts' }]);
  assert.ok((asked as any).maxChars >= 2000);
  const snapshot = first.messages.find((message) => message.content?.includes('压缩时重新读取的最近文件'));
  assert.ok(snapshot?.content?.includes('export const a=1;'));
  assert.ok(snapshot?.content?.includes('"sha256":"abc"'));
  // The snapshot is persisted with the epoch, so the next request keeps the same prefix.
  input.history.push(entry(99));
  const second = await engine.prepare(input);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
});

test('silent permission checks never enqueue a prompt', () => {
  const interactions = new Interactions(() => {}),
    details = { operation: 'read_file' as const, reason: 'r', path: '/tmp/a' };
  assert.equal(interactions.allowsSilently('bot', 'run', details), false);
  assert.equal(interactions.snapshot().length, 0);
  interactions.setHostPolicy({
    assess: () => ({ kind: 'allow', mode: 'full', source: 'full', reason: '' }),
    review: async () => ({ decision: 'ask', reason: '' }),
  } as any);
  assert.equal(interactions.allowsSilently('bot', 'run', details), true);
  interactions.setHostPolicy({
    assess: () => ({ kind: 'review', mode: 'auto', reason: '' }),
    review: async () => ({ decision: 'ask', reason: '' }),
  } as any);
  assert.equal(interactions.allowsSilently('bot', 'run', details), false);
  assert.equal(interactions.snapshot().length, 0);
});
