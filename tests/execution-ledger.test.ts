import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { ExecutionLedger, executionTarget } from '../electron/core/agent/execution-ledger';
import { Harness } from '../electron/core/agent/harness';
import { HostComputer } from '../electron/core/host/host';
import { Interactions } from '../electron/core/agent/interactions';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
const call = (id: string, path: string) => ({
  id,
  type: 'function' as const,
  function: { name: 'file_write', arguments: JSON.stringify({ path, content: 'proof' }) },
});
function fixture(t: test.TestContext) {
  const dir = tempDir(t, 'aelion-ledger-');
  return new Store(dir);
}
test('another target succeeding cannot erase a failure or complete the run', async (t) => {
  const store = fixture(t);
  let turns = 0,
    writes = 0;
  const model = {
    complete: async () => ({
      content: '完成',
      finishReason: 'stop',
      calls: turns++ === 0 ? [call('a', 'a.txt'), call('b', 'b.txt')] : [],
    }),
  } as unknown as ModelClient;
  const vm = {
    execute: async () => ({ exitCode: writes++ === 0 ? 1 : 0, stdout: '', stderr: '' }),
  } as unknown as VmController;
  await new Harness(store, vm, model, () => {}).run(store.data.bots[0].id, '写入两个文件');
  assert.equal(store.data.runs[0].status, 'failed');
  assert.match(store.data.runs[0].error!, /不能确认完成/);
  assert.equal(store.data.runs[0].executions?.filter((e) => e.status === 'failed' && !e.resolution).length, 1);
  assert.ok(!store.data.messages.some((message) => message.content === '发现校验问题，正在检查并修正。'));
});

test('a user-visible briefing stays on screen while leftover failures are resolved', async (t) => {
  const store = fixture(t);
  let turns = 0,
    writes = 0;
  const model = {
    complete: async () => {
      turns++;
      if (turns === 1) return { content: '先保存一处。', finishReason: 'tool_calls', calls: [call('w1', 'a.txt')] };
      if (turns === 2) return { content: '项目是 Spark Island monorepo。', finishReason: 'stop', calls: [] };
      if (turns === 3) return { content: '再保存一次。', finishReason: 'tool_calls', calls: [call('w2', 'a.txt')] };
      return { content: '已经写好。', finishReason: 'stop', calls: [] };
    },
  } as unknown as ModelClient;
  const vm = {
    execute: async () => ({ exitCode: writes++ === 0 ? 1 : 0, stdout: 'ok', stderr: '' }),
  } as unknown as VmController;
  await new Harness(store, vm, model, () => {}).run(store.data.bots[0].id, '熟悉项目');
  assert.equal(store.data.runs[0].status, 'completed');
  assert.ok(
    store.data.messages.some(
      (message) => message.presentation === 'progress' && message.content.includes('Spark Island monorepo'),
    ),
  );
});
test('project inspection can finish after a failed read and a successful alternate read', async (t) => {
  const store = fixture(t),
    bot = store.data.bots[0];
  writeFileSync(join(store.dir, 'README.md'), 'A small Go project.');
  const interactions = new Interactions(() => {
    queueMicrotask(() => {
      for (const request of interactions.snapshot())
        if (request.kind === 'host_permission') interactions.approve(request.id, true);
    });
  });
  const host = new HostComputer({ dataDir: store.dir, homeDir: store.dir, projectDir: store.dir }, interactions);
  host.setWorkspaceDir(store.dir);
  let turns = 0;
  const model = {
    complete: async () => ({
      content: turns < 2 ? '' : '项目使用 Go。',
      finishReason: 'stop',
      calls:
        turns++ < 2
          ? [
              {
                id: 'read-' + turns,
                type: 'function',
                function: {
                  name: 'host_file_read',
                  arguments: JSON.stringify({
                    path: turns === 1 ? 'README.rst' : 'README.md',
                    reason: '阅读项目说明',
                    offset: 0,
                    startLine: 1,
                    lineCount: 200,
                  }),
                },
              },
            ]
          : [],
    }),
  } as unknown as ModelClient;
  try {
    await new Harness(
      store,
      {} as VmController,
      model,
      () => {},
      undefined,
      undefined,
      undefined,
      host,
      interactions,
    ).run(bot.id, '熟悉一下这个项目');
  } finally {
    host.dispose();
    interactions.dispose();
  }
  const run = store.data.runs[0];
  assert.equal(run.status, 'completed');
  assert.equal(turns, 3);
  assert.deepEqual(
    run.executions?.map((entry) => entry.status),
    ['failed', 'succeeded'],
  );
  assert.ok(
    store.data.messages.some((message) => message.presentation === 'answer' && message.content === '项目使用 Go。'),
  );
  assert.equal(new ExecutionLedger(store).pending(bot.id, run.id).length, 1);
  assert.equal(new ExecutionLedger(store).failureMap(bot.id, run.id).size, 0);
});

test('failed memory saves do not block a completed briefing', (t) => {
  const store = fixture(t),
    bot = store.data.bots[0],
    ledger = new ExecutionLedger(store);
  store.data.runs.push({
    id: 'r',
    botId: bot.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  });
  const memory = ledger.begin(
    bot.id,
    'r',
    { id: 'mem', type: 'function', function: { name: 'memory', arguments: '{}' } },
    { action: 'add' },
  );
  ledger.finish(memory, 'failed', { error: '记忆操作或内容无效' }, 'mem');
  assert.equal(ledger.failureMap(bot.id, 'r').size, 0);
});
test('failed inspect commands do not block completion while failed writes still do', (t) => {
  const store = fixture(t),
    bot = store.data.bots[0],
    ledger = new ExecutionLedger(store);
  store.data.runs.push({
    id: 'r',
    botId: bot.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  });
  const command = ledger.begin(
    bot.id,
    'r',
    { id: 'cmd', type: 'function', function: { name: 'host_execute', arguments: '{}' } },
    { command: 'go vet ./...' },
  );
  ledger.finish(command, 'failed', { exitCode: 1, stderr: 'existing issue' }, 'cmd');
  const write = ledger.begin(
    bot.id,
    'r',
    { id: 'write', type: 'function', function: { name: 'host_file_write', arguments: '{}' } },
    { path: 'a.go' },
  );
  ledger.finish(write, 'failed', { error: 'denied' }, 'write');
  assert.equal(ledger.failureMap(bot.id, 'r').size, 1);
  assert.match([...ledger.failureMap(bot.id, 'r').values()][0], /host_file_write/);
});
test('read and bookkeeping failures do not mask unresolved command or write outcomes', (t) => {
  const store = fixture(t),
    bot = store.data.bots[0],
    ledger = new ExecutionLedger(store);
  store.data.runs.push({
    id: 'r',
    botId: bot.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  });
  for (const name of ['host_file_read', 'host_find_files', 'execution_resolve', 'host_execute', 'host_file_write']) {
    const entry = ledger.begin(bot.id, 'r', { id: name, type: 'function', function: { name, arguments: '{}' } }, {});
    ledger.finish(entry, 'failed', { error: 'failure' }, name);
  }
  const unknown = ledger.begin(
    bot.id,
    'r',
    { id: 'unknown', type: 'function', function: { name: 'host_execute', arguments: '{}' } },
    { command: 'unknown' },
  );
  ledger.finish(unknown, 'unknown', { error: 'connection lost' }, 'unknown');
  assert.deepEqual(
    [...ledger.failureMap(bot.id, 'r').values()].map((value) => JSON.parse(value).tool),
    ['host_file_write', 'host_execute'],
  );
  assert.equal(ledger.pending(bot.id, 'r').length, 6);
});
test('a successful retry of the same file resolves its failure', async (t) => {
  const store = fixture(t);
  let turns = 0,
    writes = 0;
  const model = {
    complete: async () => ({
      content: '完成',
      finishReason: 'stop',
      calls: turns++ === 0 ? [call('a', 'a.txt'), call('b', './a.txt')] : [],
    }),
  } as unknown as ModelClient;
  await new Harness(
    store,
    { execute: async () => ({ exitCode: writes++ === 0 ? 1 : 0, stdout: '' }) } as unknown as VmController,
    model,
    () => {},
  ).run(store.data.bots[0].id, '写入文件');
  assert.equal(store.data.runs[0].status, 'completed');
  assert.ok(store.data.runs[0].executions?.[0].resolution);
  assert.equal(store.runMessages(store.data.runs[0].id).find((m) => m.role === 'tool')?.executionResolved, true);
});
test('evidence is scoped to current bot/run and in-flight executions recover as unknown', (t) => {
  const store = fixture(t),
    bot = store.data.bots[0],
    ledger = new ExecutionLedger(store);
  store.data.runs.push({
    id: 'r',
    botId: bot.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  });
  const failed = ledger.begin(bot.id, 'r', call('a', 'a'), { path: 'a' });
  ledger.finish(failed, 'failed', { error: 'missing' }, 'out-a');
  const running = ledger.begin(bot.id, 'r', call('b', 'b'), { path: 'b' });
  assert.throws(
    () =>
      ledger.resolve(bot.id, 'r', {
        executionId: failed.id,
        kind: 'resolved',
        reason: '已检查替代文件的实际结果',
        evidenceIds: [running.id],
      }),
    { code: 'execution.resolution_evidence_invalid' },
  );
  const restored = new Store(store.dir);
  assert.equal(restored.data.runs[0].executions?.[1].status, 'unknown');
  assert.notEqual(
    executionTarget('host_execute', { command: 'echo "a b"' }, bot.id).targetKey,
    executionTarget('host_execute', { command: 'echo "ab"' }, bot.id).targetKey,
  );
  assert.equal(
    executionTarget('file_write', { path: '/work/' + bot.id + '/a' }, bot.id).targetKey,
    executionTarget('file_write', { path: 'a' }, bot.id).targetKey,
  );
});

test('a failed multi-file patch is settled once each of its files is written successfully, not by unrelated writes', (t) => {
  const store = fixture(t),
    bot = store.data.bots[0],
    ledger = new ExecutionLedger(store);
  store.data.runs.push({
    id: 'run',
    botId: bot.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  });
  const invoke = (id: string, name: string, args: Record<string, unknown>, status: 'failed' | 'succeeded') => {
    const entry = ledger.begin(
      bot.id,
      'run',
      { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      args,
    );
    ledger.finish(entry, status, {}, '00000000-0000-0000-0000-00000000000' + id.length);
    return entry;
  };
  const patch =
    '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** End Patch';
  const failed = invoke('p1', 'apply_patch', { location: 'vm', patch }, 'failed');
  assert.deepEqual(failed.paths, [`vm:/work/${bot.id}/src/a.ts`, `vm:/work/${bot.id}/src/b.ts`]);
  invoke('w1', 'file_write', { path: 'other.ts', content: 'x' }, 'succeeded');
  assert.equal(failed.resolution, undefined);
  invoke('w2', 'file_patch', { path: 'src/a.ts' }, 'succeeded');
  assert.equal(failed.resolution, undefined);
  invoke(
    'w3',
    'apply_patch',
    {
      location: 'vm',
      patch: '*** Begin Patch\n*** Update File: /work/' + bot.id + '/src/b.ts\n@@\n-x\n+z\n*** End Patch',
    },
    'succeeded',
  );
  assert.equal(ledger.list(bot.id, 'run').find((entry) => entry.id === failed.id)?.resolution?.kind, 'resolved');
  assert.equal(ledger.blocking(bot.id, 'run').length, 0);
  // Host and VM paths never settle each other.
  const host = invoke('h1', 'host_file_patch', { path: 'C:\repoa.ts' }, 'failed');
  invoke('h2', 'file_patch', { path: 'a.ts' }, 'succeeded');
  assert.equal(host.resolution, undefined);
});
