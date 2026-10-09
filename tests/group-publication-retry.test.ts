import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { GroupChats } from '../electron/core/group/group-chats';
import type { RunRecord } from '../shared/types/core';
import { until } from './helpers';

test('one failed startup publication does not block another completed answer in the same round', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'group-publication-siblings-'));
  const store = new Store(dir, { incremental: true, deferWrites: true });
  const runner = { isRunning: () => false, run: async () => {}, cancel: () => {} };
  const initial = new GroupChats(store, runner, () => {});
  const a = store.data.bots[0],
    b = store.createBot('B', '');
  const groupId = initial.create({ name: 'Sibling replies', botIds: [a.id, b.id] }).id;
  initial.send({ id: groupId, message: 'Both reports, please.' });
  const source = store.data.groups[0].messages.at(-1)!;
  for (const delivery of store.data.groupDeliveries) delivery.status = 'ignored';
  for (const bot of [a, b]) {
    const delivery = store.data.groupDeliveries.find((d) => d.messageId === source.id && d.recipientId === bot.id)!;
    const run: RunRecord = {
      id: bot.id,
      botId: bot.id,
      status: 'completed',
      modelCalls: 1,
      toolCalls: 0,
      startedAt: new Date().toISOString(),
      groupOrigin: { groupId, rootId: source.rootId!, deliveryId: delivery.id },
    };
    store.data.runs.push(run);
    delivery.status = 'running';
    delivery.runId = run.id;
    store.message(bot.id, 'assistant', `Report from ${bot.id}`, {
      runId: run.id,
      presentation: 'answer',
      status: 'done',
    });
  }
  initial.dispose();
  const flush = store.flush.bind(store);
  store.flush = (mode) => {
    if (store.data.groupOutbox?.some((entry) => entry.runId === a.id && entry.status === 'pending'))
      throw Error('A publication unavailable');
    return flush(mode);
  };
  const recovered = new GroupChats(store, runner, () => {});
  t.after(() => {
    store.flush = flush;
    recovered.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(store.data.groupDeliveries.find((d) => d.runId === a.id)?.status, 'interrupted');
  assert.equal(store.data.groupDeliveries.find((d) => d.runId === b.id)?.status, 'replied');
  assert.equal(store.data.groups[0].messages.filter((m) => m.content === `Report from ${b.id}`).length, 1);
});

for (const storage of ['json', 'sqlite', 'desktop'] as const) {
  for (const commit of ['pending', 'sent'] as const) {
    for (const restart of [false, true]) {
      test(`completed publication remains resumable after repeated ${commit} failures: ${storage}, restart=${restart}`, async (t) => {
        const dir = mkdtempSync(join(tmpdir(), 'group-publication-retry-'));
        const options = { incremental: storage !== 'json', deferWrites: storage === 'desktop' };
        let store = new Store(dir, options);
        const botId = store.data.bots[0].id;
        let modelCalls = 0;
        const runner = {
          isRunning: (id: string) => id !== botId,
          run: async () => {
            modelCalls++;
            assert.fail('saved model work must not run again');
          },
          cancel: () => {},
        };
        let groups = new GroupChats(store, runner, () => {});
        let restoreFlush = () => {};
        t.after(() => {
          restoreFlush();
          groups.dispose();
          store.close();
          rmSync(dir, { recursive: true, force: true });
        });
        const a = store.data.bots[0],
          b = store.createBot('B', '');
        const groupId = groups.create({ name: 'Publication recovery', botIds: [a.id, b.id] }).id;
        groups.send({ id: groupId, message: 'Complete the report.' });
        const source = store.data.groups[0].messages.at(-1)!;
        // Other recipients have already read this message. Only A's publication remains unfinished.
        for (const delivery of store.data.groupDeliveries) delivery.status = 'ignored';
        const delivery = store.data.groupDeliveries.find(
          (entry) => entry.messageId === source.id && entry.recipientId === a.id,
        )!;
        const run: RunRecord = {
          id: 'completed-report',
          botId: a.id,
          status: 'completed',
          modelCalls: 1,
          toolCalls: 0,
          startedAt: new Date().toISOString(),
          groupOrigin: { groupId, rootId: source.rootId!, deliveryId: delivery.id },
        };
        store.data.runs.push(run);
        delivery.status = 'running';
        delivery.runId = run.id;
        store.message(a.id, 'assistant', 'The saved report is ready.', {
          runId: run.id,
          presentation: 'answer',
          status: 'done',
        });
        groups.dispose();
        store.close();
        store = new Store(dir, options);
        const flush = store.flush.bind(store);
        let failures = 0;
        store.flush = (mode) => {
          if (
            store.data.groupOutbox?.some((entry) => entry.runId === run.id && entry.status === commit) &&
            failures < 3
          ) {
            failures++;
            throw Error('publication disk unavailable');
          }
          return flush(mode);
        };
        restoreFlush = () => {
          store.flush = flush;
        };
        groups = new GroupChats(store, runner, () => {});
        groups.start();
        const current = () => store.data.groupDeliveries.find((entry) => entry.id === delivery.id)!;
        for (let attempt = 1; attempt <= 3; attempt++) {
          assert.equal(failures, attempt);
          assert.equal(current().status, 'interrupted');
          assert.equal(current().resumable, true);
          assert.equal(current().retryRunId, run.id);
          const summary = groups.snapshot().rooms[0];
          assert.equal(summary.round?.status, 'stopped', 'the group UI must expose its Continue action');
          assert.equal(summary.pending, 0);
          assert.equal(
            store.data.groups[0].messages.filter((m) => m.content === 'The saved report is ready.').length,
            0,
          );
          if (attempt < 3) {
            groups.continue(groupId);
            await until(() => !groups.busy && failures > attempt);
          }
        }
        restoreFlush();
        if (restart) {
          groups.dispose();
          store.close();
          store = new Store(dir, options);
          groups = new GroupChats(store, runner, () => {});
          restoreFlush = () => {};
        } else {
          groups.continue(groupId);
          await until(() => !groups.busy && current().status === 'replied');
        }
        assert.equal(current().status, 'replied');
        assert.equal(store.data.runs.length, 1);
        store.flush();
        groups.dispose();
        store.close();
        store = new Store(dir, options);
        groups = new GroupChats(store, runner, () => {});
        restoreFlush = () => {};
        const published = store.data.groups[0].messages.filter((m) => m.content === 'The saved report is ready.');
        assert.equal(published.length, 1);
        assert.equal(current().replyMessageId, published[0].id);
        assert.equal(store.data.groupOutbox?.filter((entry) => entry.runId === run.id).length, 1);
        assert.equal(store.data.runs[0].status, 'completed');
        assert.equal(modelCalls, 0);
      });
    }
  }
}
