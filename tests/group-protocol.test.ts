import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { until } from './helpers';
import { Store } from '../electron/core/storage/store';
import { GroupChats } from '../electron/core/group/group-chats';
import { groupHistory, groupContextKey } from '../electron/core/group/group-history';
import { CognitiveStore } from '../electron/core/memory/cognitive-store';
import type { RunRecord } from '../shared/types/core';

function fixture(t: test.TestContext, incremental = false) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-group-protocol-')),
    store = new Store(dir, { incremental }),
    a = store.data.bots[0],
    b = store.createBot('B', ''),
    c = store.createBot('C', '');
  const groups = new GroupChats(store, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
  const id = groups.create({ name: '协作', botIds: [a.id, b.id] }).id;
  groups.send({ id, message: '核对报告，保存结果文档。' });
  const room = store.data.groups[0],
    source = room.messages.at(-1)!;
  function run(botId: string) {
    const delivery = store.data.groupDeliveries.find((d) => d.recipientId === botId && d.messageId === source.id)!;
    const run: RunRecord = {
      id: randomUUID(),
      botId,
      status: 'running',
      modelCalls: 0,
      toolCalls: 0,
      startedAt: new Date().toISOString(),
      groupOrigin: { groupId: id, rootId: source.rootId!, deliveryId: delivery.id },
    };
    store.data.runs.push(run);
    return run;
  }
  function deliver(run: RunRecord) {
    const delivery = store.data.groupDeliveries.find((d) => d.id === run.groupOrigin?.deliveryId)!;
    delivery.status = 'running';
    delivery.runId = run.id;
  }
  const ra = run(a.id),
    rb = run(b.id);
  const invoke = (run: RunRecord, name: string, args: Record<string, unknown> = {}) =>
    groups.invoke(run.botId, run.id, name, { groupId: id, ...args }, new AbortController().signal, {
      groupOrigin: run.groupOrigin,
    }) as any;
  t.after(() => {
    groups.dispose();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, groups, room, a, b, c, ra, rb, run, deliver, invoke, source };
}

test('outbox commit failure publishes nothing; retry and reopen preserve exactly one message and its deliveries', (t) => {
  const f = fixture(t, true),
    args = { message: '已核对第一部分。', clientMessageId: 'milestone-1', kind: 'progress' };
  const before = { messages: f.room.messages.length, deliveries: f.store.data.groupDeliveries.length },
    save = f.store.save.bind(f.store);
  let writes = 0;
  f.store.save = () => {
    if (++writes === 2) throw Error('disk unavailable');
    save();
  };
  assert.throws(() => f.invoke(f.ra, 'group_send_message', args), /disk unavailable/);
  f.store.save = save;
  assert.equal(f.room.messages.length, before.messages);
  assert.equal(f.store.data.groupDeliveries.length, before.deliveries);
  assert.equal(f.store.data.groupOutbox?.[0].status, 'pending');
  assert.equal(f.invoke(f.rb, 'group_outbox').length, 0);
  const first = f.invoke(f.ra, 'group_send_message', args),
    second = f.invoke(f.ra, 'group_send_message', args);
  assert.equal(first.messageId, second.messageId);
  assert.equal(f.room.messages.length, before.messages + 1);
  assert.equal(f.store.data.groupDeliveries.length, before.deliveries + 2);
  assert.equal(f.store.data.groupOutbox?.[0].status, 'sent');
  assert.throws(() => f.invoke(f.ra, 'group_send_message', { ...args, message: '同一个 ID 的不同内容' }), {
    code: 'group.outbox_conflict',
  });
  f.store.close();
  const restored = new Store(f.dir, { incremental: true });
  assert.equal(restored.data.groupOutbox?.[0].messageId, first.messageId);
  assert.equal(restored.data.groups[0].messages.filter((m) => m.id === first.messageId).length, 1);
  restored.close();
});

test('group outbox rejects internal silence markers', (t) => {
  const f = fixture(t);
  assert.throws(() => f.invoke(f.ra, 'group_send_message', { message: '没有新内容。[群聊静默]' }), {
    code: 'group.silence_marker',
  });
  assert.ok(!f.room.messages.some((message) => message.content.includes('[群聊静默]')));
});

test('removing a member prevents further reads or publication', (t) => {
  const f = fixture(t);
  f.deliver(f.ra);
  f.groups.update({ id: f.room.id, name: f.room.name, botIds: [f.b.id, f.c.id] });
  for (const name of ['group_read', 'group_outbox', 'group_send_message'])
    assert.throws(() => f.invoke(f.ra, name, { message: '旧进展' }), { code: 'group.not_member' });
});

test('legacy group task records stay stored untouched and the task tools are gone', (t) => {
  const f = fixture(t),
    legacy = { id: randomUUID(), title: '核对报告', ownerId: f.a.id, status: 'working', revision: 2 };
  f.room.tasks = [legacy];
  f.store.save();
  const restored = new Store(f.dir);
  assert.deepEqual(restored.data.groups[0].tasks, [legacy]);
  restored.close();
  assert.ok(!('tasks' in f.groups.read({ id: f.room.id })));
  for (const name of ['group_tasks', 'group_task_claim', 'group_task_update'])
    assert.throws(() => f.invoke(f.ra, name, { message: '旧任务' }), /未知群聊工具/);
});

test('context starts with a bounded public window, expands on demand, and private lookup stays bot scoped', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) f.groups.send({ id: f.room.id, message: `公共消息 ${i} ` + '长文'.repeat(3500) });
  const privateA = f.store.message(f.a.id, 'user', 'ALPHA_PRIVATE_CONTEXT'),
    privateB = f.store.message(f.b.id, 'user', 'BETA_PRIVATE_CONTEXT');
  f.store.data.conversations[f.a.id] = [{ role: 'user', content: privateA.content }];
  const main = JSON.stringify(f.store.data.conversations),
    context = groupHistory(f.store, f.room.id, f.a.id),
    text = JSON.stringify(context);
  assert.equal(context.filter((m) => m.groupMessageId).length, 4);
  assert.doesNotMatch(text, /公共消息 0 |ALPHA_PRIVATE_CONTEXT|BETA_PRIVATE_CONTEXT/);
  assert.ok(text.length < 10000);
  const target = f.room.messages.find((m) => m.content.startsWith('公共消息 0 '))!,
    first = f.invoke(f.ra, 'group_read', { messageId: target.id }),
    second = f.invoke(f.ra, 'group_read', { messageId: target.id, offset: first.nextOffset });
  assert.equal(first.content + second.content, target.content);
  const storage = new CognitiveStore(f.store);
  try {
    assert.equal(storage.search(f.a.id, 'ALPHA_PRIVATE_CONTEXT')[0].messageId, privateA.id);
    assert.equal(storage.search(f.a.id, 'BETA_PRIVATE_CONTEXT').length, 0);
    assert.throws(() => storage.readHistory(f.a.id, privateB.id), { code: 'memory.history_not_found' });
  } finally {
    storage.close();
  }
  assert.equal(JSON.stringify(f.store.data.conversations), main);
  assert.ok(!JSON.stringify(f.room.messages).includes('ALPHA_PRIVATE_CONTEXT'));
  assert.equal(f.store.data.groupContexts[groupContextKey(f.room.id, f.a.id)], context);
});

test('restart reconciles a committed reply before marking the remaining inbox interrupted', (t) => {
  const f = fixture(t),
    delivery = f.store.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)!;
  delivery.status = 'running';
  delivery.runId = f.ra.id;
  const sent = f.invoke(f.ra, 'group_send_message', { message: '已经完成', clientMessageId: 'completed' });
  f.ra.status = 'completed';
  f.store.save();
  const restored = new Store(f.dir),
    groups = new GroupChats(
      restored,
      {
        isRunning: () => false,
        run: async () => {
          throw Error('must not replay');
        },
        cancel: () => {},
      },
      () => {},
    );
  assert.equal(restored.data.groupDeliveries.find((d) => d.id === delivery.id)?.status, 'replied');
  assert.equal(restored.data.groupDeliveries.find((d) => d.id === delivery.id)?.replyMessageId, sent.messageId);
  assert.equal(restored.data.runs.find((r) => r.id === f.ra.id)?.groupReplyMessageId, sent.messageId);
  groups.dispose();
  restored.close();
});

test('continuing after a restart resumes the interrupted work with its run, not a fresh round', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-group-restart-'));
  const first = new Store(dir),
    a = first.data.bots[0],
    b = first.createBot('B', '');
  const hanging = new GroupChats(
    first,
    {
      isRunning: () => false,
      run: (_id, _input, options) => {
        const run: RunRecord = {
          id: randomUUID(),
          botId: _id,
          status: 'running',
          modelCalls: 1,
          toolCalls: 1,
          startedAt: new Date().toISOString(),
          groupOrigin: options.groupOrigin,
        };
        first.data.runs.push(run);
        options.onStarted?.(run.id);
        return new Promise(() => {});
      },
      cancel: () => {},
    },
    () => {},
  );
  const id = hanging.create({ name: '重启', botIds: [a.id, b.id] }).id;
  hanging.send({
    id,
    message: `@${a.name} 生成报告`,
    mentions: [{ id: a.id, name: a.name, color: a.color, start: 0, end: a.name.length + 1 }],
  });
  hanging.start();
  const question = first.data.groups[0].messages.at(-1)!;
  const delivery = () => first.data.groupDeliveries.find((d) => d.messageId === question.id && d.recipientId === a.id)!;
  await until(() => Boolean(delivery().runId));
  const firstRun = delivery().runId;
  hanging.dispose();
  first.close();
  // Simulate the app quitting mid-run: the hanging service is dropped without stopping the round.
  const restored = new Store(dir),
    resumed: Array<{ botId: string; from?: string; input: string }> = [];
  const groups = new GroupChats(
    restored,
    {
      isRunning: () => false,
      run: async (botId, input, options) => {
        resumed.push({ botId, from: options.groupTaskFrom, input });
      },
      cancel: () => {},
    },
    () => {},
  );
  t.after(() => {
    groups.dispose();
    restored.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const interrupted = restored.data.groupDeliveries.find((d) => d.messageId === question.id && d.recipientId === a.id)!;
  assert.equal(interrupted.status, 'interrupted');
  const messages = restored.data.groups[0].messages.length;
  groups.start();
  groups.continue(id);
  await until(() => resumed.some((item) => item.botId === a.id));
  assert.equal(resumed.find((item) => item.botId === a.id)!.from, firstRun);
  assert.equal(restored.data.groups[0].messages.length, messages, 'no new "continue" message or round');
  // Once resumed, the same deliveries are not revived again.
  assert.throws(() => groups.continue(id), /仍可继续/);
});

test('sending a new message after quitting leaves the interrupted work alone', (t) => {
  const f = fixture(t);
  f.deliver(f.ra);
  f.groups.dispose();
  const restored = new Store(f.dir);
  const interrupted = () => restored.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)!;
  assert.equal(interrupted().status, 'interrupted');
  assert.equal(interrupted().reason, '应用退出，等待用户继续');
  assert.equal(interrupted().resumable, true);
  assert.notEqual(restored.data.groupRounds[0].reason, '你停止了本轮讨论');
  const groups = new GroupChats(restored, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
  try {
    groups.send({ id: f.room.id, message: '换个话题' });
    assert.equal(interrupted().resumable, undefined);
    assert.equal(interrupted().status, 'interrupted');
  } finally {
    groups.dispose();
    restored.close();
  }
});
