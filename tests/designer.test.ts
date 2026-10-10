import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../electron/core/storage/store';
import { updateBotProfile } from '../electron/core/agent/bot-profile';
import { DesignSystems } from '../electron/core/designer/design-systems';
import { DesignStore } from '../electron/core/designer/design-store';
import type { RunRecord } from '../shared/types/core';
import { recordDelegationReceipt } from '../electron/core/peer/delegation';
import { groupMainContext } from '../electron/core/group/group-context';
import { ExecutionLedger } from '../electron/core/agent/execution-ledger';

function fixture(t: any) {
  const root = tempDir(t, 'aelion-design-');
  const store = new Store(join(root, 'data'));
  const bot = store.createBot('Designer', 'Design');
  store.data.model.model = 'fixture';
  return { root, store, bot };
}

function catalog(root: string, version = 'a'.repeat(40), color = 'red') {
  const dir = join(root, version);
  mkdirSync(join(dir, 'sample'), { recursive: true });
  const texts = {
    'DESIGN.md': '# Sample\nUse a restrained type scale.',
    'tokens.css': `:root {--accent:${color};}`,
    'components.html': '<main>Reference</main>',
  };
  const files = Object.entries(texts).map(([path, body]) => {
    writeFileSync(join(dir, 'sample', path), body);
    return { path, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') };
  });
  writeFileSync(
    join(dir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      sourceCommit: version,
      sourceUrl: 'https://example.test',
      systems: [
        {
          id: 'sample',
          name: 'Sample',
          category: 'Product',
          description: 'Test fixture',
          version,
          bytes: files.reduce((n, f) => n + f.bytes, 0),
          colors: ['#123456'],
          source: 'https://example.test',
          license: 'Apache-2.0',
          files,
        },
      ],
    }),
  );
  return dir;
}

test('a Bot type saved by an older version is kept as is; profile edits work while an old designer run exists', (t) => {
  const { store, bot } = fixture(t);
  (bot as any).type = 'designer';
  (bot as any).pendingType = 'general';
  store.save();
  const loaded = new Store(store.dir);
  assert.equal(loaded.bot(bot.id).type, 'designer');
  assert.equal(loaded.data.bots[0].type, undefined);
  assert.equal((loaded.bot(bot.id) as any).pendingType, undefined);
  store.data.runs.push({
    id: randomUUID(),
    botId: bot.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
    engine: 'designer',
  });
  updateBotProfile(store, {} as any, { id: bot.id, name: 'Renamed', soul: bot.soul });
  assert.equal(store.bot(bot.id).name, 'Renamed');
  assert.equal(store.bot(bot.id).type, 'designer');
});

test('design-system references validate bytes and pinned tasks retain old assets after an application update', (t) => {
  const { root, store, bot } = fixture(t),
    v1 = catalog(root),
    archive = join(root, 'cache'),
    systems = new DesignSystems(v1, archive),
    designs = new DesignStore(store, systems);
  const task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Build a landing page', systemId: 'sample' });
  assert.equal(task.systemVersion, 'a'.repeat(40));
  assert.throws(() => systems.read('sample', '../catalog.json'));
  const v2 = catalog(root, 'b'.repeat(40), 'blue'),
    updated = new DesignSystems(v2, archive);
  assert.match(updated.read('sample', 'tokens.css', task.systemVersion!).toString(), /red/);
  assert.match(updated.read('sample', 'tokens.css').toString(), /blue/);
  writeFileSync(join(v2, 'sample', 'tokens.css'), 'tampered');
  assert.throws(() => updated.read('sample', 'tokens.css'), { code: 'design.system_changed' });
});

test('task histories and lookups are isolated by Bot and channel; manual edits invalidate prior checks', (t) => {
  const { root, store, bot } = fixture(t),
    systems = new DesignSystems(catalog(root)),
    designs = new DesignStore(store, systems),
    other = store.createBot('Other', '');
  const a = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Project A' }),
    b = designs.create({ botId: bot.id, kind: 'ppt', brief: 'Project B' });
  designs.history(bot.id, a.origin, a.id).history.messages.push({ role: 'user', content: 'Private A' });
  assert.equal(designs.history(bot.id, b.origin, b.id).history.messages.length, 0);
  assert.throws(() => designs.get(a.id, other.id));
  assert.throws(() => designs.history(bot.id, { kind: 'group', id: 'missing' }, a.id));
  const active = designs.get(a.id);
  active.checks = [{ id: 'visual', label: 'Rendered', status: 'passed' }];
  designs.userEdit(bot.id, a.workspacePath + '/index.html', 'revision');
  assert.equal(active.checks[0].status, 'pending');
  assert.equal(active.userEdits.length, 1);
  assert.throws(() => designs.update({ id: a.id, revision: 1, title: 'stale' }), { code: 'design.session_stale' });
});

const call = (name: string, args: any) => ({
  id: randomUUID(),
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

test('the shipped design catalog contains all 152 packages and valid hashes', () => {
  const systems = new DesignSystems(resolve('assets/design-systems'));
  assert.equal(systems.list().length, 152);
  let total = 0;
  for (const system of systems.catalog.systems)
    for (const file of system.files) {
      total += systems.read(system.id, file.path).length;
    }
  assert.ok(total > 30_000_000 && total < 40_000_000);
  assert.ok(existsSync(resolve('assets/design-systems/LICENSE')));
  assert.ok(existsSync(resolve('assets/design-systems/NOTICE')));
});

test('only a structured delegation takes a receipt, and it needs successful execution evidence', (t) => {
  const { store, bot } = fixture(t),
    sender = store.createBot('Sender', ''),
    rootId = randomUUID(),
    id = randomUUID(),
    exchangeId = randomUUID(),
    time = new Date().toISOString();
  store.data.runs.push({
    id: rootId,
    botId: sender.id,
    status: 'completed',
    startedAt: time,
    modelCalls: 0,
    toolCalls: 0,
  });
  store.message(sender.id, 'user', 'Design a landing page', { runId: rootId });
  store.data.peerExchanges.push({
    id: exchangeId,
    threadId: 't',
    fromBotId: sender.id,
    toBotId: bot.id,
    rootRunId: rootId,
    rootBotId: sender.id,
    rootRequest: 'Design a landing page',
    status: 'working',
    createdAt: time,
    updatedAt: time,
    requestMessageId: 'r',
    task: { goal: 'Design', acceptance: ['HTML exists'], expectedOutput: 'index.html' },
  });
  const run: RunRecord = {
    id,
    botId: bot.id,
    engine: 'designer',
    status: 'running',
    startedAt: time,
    modelCalls: 1,
    toolCalls: 1,
    peerOrigin: { kind: 'peer_request', exchangeId },
    executions: [{ id: 'real-write', tool: 'file_write', status: 'succeeded' } as any],
  };
  store.data.runs.push(run);
  // The retired designer engine accepted receipts for plain requests; now only a structured delegation does.
  assert.throws(
    () =>
      recordDelegationReceipt(store, bot.id, id, { status: 'completed', summary: 'Done', evidenceIds: ['real-write'] }),
    { code: 'delegation.receiver_only' },
  );
  run.engine = 'general';
  run.peerOrigin = { kind: 'peer_task', exchangeId };
  assert.throws(() =>
    recordDelegationReceipt(store, bot.id, id, { status: 'completed', summary: 'Done', evidenceIds: [] }),
  );
  assert.equal(
    recordDelegationReceipt(store, bot.id, id, {
      status: 'completed',
      summary: 'Saved actual HTML',
      evidenceIds: ['real-write'],
    }).status,
    'completed',
  );
});

test('shared group references exclude private history, memories and unrelated group requests', (t) => {
  const { store, bot } = fixture(t),
    time = new Date().toISOString();
  bot.memories = ['PRIVATE_PREFERENCE'];
  store.data.conversations[bot.id] = [{ role: 'user', content: 'PRIVATE_TRANSCRIPT' }];
  store.data.summaries[bot.id] = 'PRIVATE_SUMMARY';
  for (const [id, request] of [
    ['current', 'SHARED_CURRENT'],
    ['other', 'OTHER_GROUP_SECRET'],
  ]) {
    store.data.groups.push({
      id,
      name: id,
      members: [{ ...bot, joinedAt: time }],
      createdBy: { kind: 'user', id: 'user', name: 'You' },
      createdAt: time,
      updatedAt: time,
      lastReadSeq: 0,
      messages: [],
    });
    store.data.groupRounds.push({
      id: id + '-round',
      groupId: id,
      request,
      status: 'active',
      createdAt: time,
      botMessages: 0,
      createdGroups: 0,
    });
  }
  const context = groupMainContext(store, bot.id, 6500, 'PRIVATE_SUMMARY', 'current');
  assert.match(context, /SHARED_CURRENT/);
  assert.doesNotMatch(context, /PRIVATE_|OTHER_GROUP_SECRET/);
});

test('invalid design updates do not partially change the stored task', (t) => {
  const { root, store, bot } = fixture(t),
    designs = new DesignStore(store, new DesignSystems(catalog(root))),
    task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Original' });
  assert.throws(() =>
    designs.update({ id: task.id, revision: task.revision, title: 'Should not stick', constraints: ['x'.repeat(801)] }),
  );
  assert.equal(designs.get(task.id).title, 'Original');
});

test('interrupted design tool calls are repaired as unknown and their evidence stays attached to the same task', (t) => {
  const { root, store, bot } = fixture(t),
    designs = new DesignStore(store, new DesignSystems(catalog(root))),
    task = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Resume safely' });
  designs.history(bot.id, task.origin, task.id).history.messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [call('file_write', { path: task.workspacePath + '/index.html', content: 'partial' })],
  });
  const restored = designs.history(bot.id, task.origin, task.id).history.messages;
  assert.equal(restored.at(-1)?.role, 'tool');
  assert.match(restored.at(-1)?.content || '', /unknown/);
  const prior: RunRecord = {
    id: randomUUID(),
    botId: bot.id,
    designSessionId: task.id,
    engine: 'designer',
    status: 'interrupted',
    startedAt: new Date().toISOString(),
    modelCalls: 0,
    toolCalls: 0,
  };
  store.data.runs.push(prior);
  const ledger = new ExecutionLedger(store),
    entry = ledger.begin(bot.id, prior.id, call('file_write', {}), { path: task.workspacePath + '/index.html' });
  ledger.finish(entry, 'unknown', { error: 'connection interrupted' }, 'result');
  const next: RunRecord = { ...prior, id: randomUUID(), status: 'running', executions: [] };
  store.data.runs.push(next);
  assert.ok(ledger.failureMap(bot.id, next.id).has(entry.id));
  const unrelated: RunRecord = { ...next, id: randomUUID(), designSessionId: randomUUID() };
  store.data.runs.push(unrelated);
  assert.equal(ledger.failureMap(bot.id, unrelated.id).size, 0);
});

test('design-system selection is task scoped while another task of the same Bot runs', (t) => {
  const { root, store, bot } = fixture(t),
    systems = new DesignSystems(catalog(root)),
    designs = new DesignStore(store, systems);
  const a = designs.create({ botId: bot.id, kind: 'prototype', brief: 'Running task', systemId: 'sample' }),
    b = designs.create({ botId: bot.id, kind: 'ppt', brief: 'New task' });
  designs.get(a.id).activeRunId = 'active-a';
  designs.get(a.id).status = 'running';
  designs.save();
  assert.throws(() => designs.update({ id: a.id, revision: a.revision, systemId: null }), {
    code: 'design.session_running',
  });
  assert.equal(designs.setSystem(designs.get(a.id), 'sample').systemId, 'sample');
  const updated = designs.update({ id: b.id, revision: b.revision, systemId: 'sample' });
  assert.equal(updated.systemId, 'sample');
  const cleared = designs.update({ id: b.id, revision: updated.revision, systemId: null });
  assert.equal(cleared.systemId, null);
  assert.equal(designs.get(a.id).systemId, 'sample');
  assert.equal(designs.get(a.id).activeRunId, 'active-a');
});
