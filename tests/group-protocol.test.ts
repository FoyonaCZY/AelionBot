import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { until } from './helpers';
import { Store } from '../electron/core/storage/store';
import { GroupChats } from '../electron/core/group/group-chats';
import { groupHistory, groupContextKey } from '../electron/core/group/group-history';
import { CognitiveStore } from '../electron/core/memory/cognitive-store';
import type { RunRecord } from '../shared/types/core';
import { GROUP_LIMITS } from '../shared/types/group-types';
import { StateSync } from '../electron/core/app/state-sync';
import type { Snapshot } from '../shared/types/core';

function fixture(t: test.TestContext, incremental = false, deferWrites = false) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-group-protocol-')),
    store = new Store(dir, { incremental, deferWrites }),
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
    flush = f.store.flush.bind(f.store);
  let writes = 0;
  f.store.flush = () => {
    if (++writes === 2) throw Error('disk unavailable');
    flush();
  };
  assert.throws(() => f.invoke(f.ra, 'group_send_message', args), /disk unavailable/);
  f.store.flush = flush;
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

test('an unsent legacy automatic outbox entry is reused after a write failure', (t) => {
  const f = fixture(t);
  const args = { message: '核对完成。' };
  const flush = f.store.flush.bind(f.store);
  let writes = 0;
  f.store.flush = () => {
    if (++writes === 2) throw Error('disk unavailable');
    flush();
  };
  try {
    assert.throws(() => f.invoke(f.ra, 'group_send_message', args), /disk unavailable/);
  } finally {
    f.store.flush = flush;
  }
  const pending = f.store.data.groupOutbox![0];
  pending.key =
    'content:' +
    createHash('sha256')
      .update(JSON.stringify([args.message, [], []]))
      .digest('hex');
  f.store.save();
  const sent = f.invoke(f.ra, 'group_send_message', args);
  assert.equal(f.store.data.groupOutbox!.length, 1);
  assert.equal(pending.status, 'sent');
  assert.equal(pending.messageId, sent.messageId);
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

test('recovered completed-run receipts reach incremental UI state and a quick disk write', (t) => {
  const f = fixture(t, true, true);
  f.deliver(f.ra);
  const sent = f.invoke(f.ra, 'group_send_message', { message: '已完成核对。' });
  f.ra.status = 'completed';
  f.store.save();
  f.store.flush();
  const sync = new StateSync(
    () => ({ messages: [], runs: f.store.data.runs }) as unknown as Snapshot,
    () => [],
  );
  sync.base();
  f.store.onTouched = (entries) => sync.markEdited(entries);
  const recovered = new GroupChats(
    f.store,
    {
      isRunning: () => false,
      run: async () => {
        throw Error('must not replay');
      },
      cancel: () => {},
    },
    () => {},
  );
  try {
    assert.equal(sync.delta()?.runs?.upsert.find((run) => run.id === f.ra.id)?.groupReplyMessageId, sent.messageId);
    f.store.flush('quick');
    const reopened = new Store(f.dir, { incremental: true });
    try {
      assert.equal(reopened.data.runs.find((run) => run.id === f.ra.id)?.groupReplyMessageId, sent.messageId);
    } finally {
      reopened.close();
    }
  } finally {
    recovered.dispose();
  }
});

test('restart preserves each committed answer when a run answered multiple questions', (t) => {
  const f = fixture(t);
  f.deliver(f.ra);
  f.groups.send({ id: f.room.id, message: '还请核对第二份报告。' });
  const second = f.room.messages.at(-1)!;
  const secondDelivery = f.store.data.groupDeliveries.find(
    (d) => d.messageId === second.id && d.recipientId === f.a.id,
  )!;
  secondDelivery.status = 'running';
  secondDelivery.runId = f.ra.id;
  const firstReply = f.invoke(f.ra, 'group_send_message', {
    message: '第一份已核对。',
    replyToMessageId: f.source.id,
  });
  const secondReply = f.invoke(f.ra, 'group_send_message', {
    message: '第二份已核对。',
    replyToMessageId: second.id,
  });
  f.ra.status = 'completed';
  f.store.save();
  const restored = new Store(f.dir);
  const groups = new GroupChats(restored, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
  try {
    assert.equal(
      restored.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)?.replyMessageId,
      firstReply.messageId,
    );
    assert.equal(
      restored.data.groupDeliveries.find((d) => d.id === secondDelivery.id)?.replyMessageId,
      secondReply.messageId,
    );
  } finally {
    groups.dispose();
    restored.close();
  }
});

test('restart selects the latest published reply even when an older pending entry was retried last', (t) => {
  const f = fixture(t);
  f.deliver(f.ra);
  const flush = f.store.flush.bind(f.store);
  let writes = 0;
  f.store.flush = () => {
    if (++writes === 2) throw Error('disk unavailable');
    flush();
  };
  try {
    assert.throws(() => f.invoke(f.ra, 'group_send_message', { message: '稍后重试的消息。' }), /disk unavailable/);
  } finally {
    f.store.flush = flush;
  }
  f.invoke(f.ra, 'group_send_message', { message: '先送达的消息。' });
  const latest = f.invoke(f.ra, 'group_send_message', { message: '稍后重试的消息。' });
  f.ra.status = 'completed';
  f.store.save();
  const restored = new Store(f.dir);
  const groups = new GroupChats(restored, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
  try {
    assert.equal(restored.data.runs.find((run) => run.id === f.ra.id)?.groupReplyMessageId, latest.messageId);
    assert.equal(
      restored.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)?.replyMessageId,
      latest.messageId,
    );
  } finally {
    groups.dispose();
    restored.close();
  }
});

test('reusing an explicit publication key cannot silently change its kind or reply target', (t) => {
  const f = fixture(t);
  const args = { message: '已核对。', clientMessageId: 'stable', replyToMessageId: f.source.id };
  const first = f.invoke(f.ra, 'group_send_message', args);
  assert.equal(f.invoke(f.ra, 'group_send_message', args).messageId, first.messageId);
  assert.throws(() => f.invoke(f.ra, 'group_send_message', { ...args, kind: 'progress' }), {
    code: 'group.outbox_conflict',
  });
  const other = f.room.messages[0];
  assert.throws(() => f.invoke(f.ra, 'group_send_message', { ...args, replyToMessageId: other.id }), {
    code: 'group.outbox_conflict',
  });
});

test('reaching the message cap preserves receipts for earlier answers in the same run', (t) => {
  const f = fixture(t);
  f.deliver(f.ra);
  f.groups.send({ id: f.room.id, message: '核对第二份报告。' });
  const second = f.room.messages.at(-1)!;
  const delivery = f.store.data.groupDeliveries.find((d) => d.messageId === second.id && d.recipientId === f.a.id)!;
  delivery.status = 'running';
  delivery.runId = f.ra.id;
  for (let i = 0; i < GROUP_LIMITS.botStreak - 2; i++)
    f.invoke(f.ra, 'group_send_message', { message: `核对进度 ${i}`, kind: 'progress' });
  const firstReply = f.invoke(f.ra, 'group_send_message', { message: '第一份完成。', replyToMessageId: f.source.id });
  const secondReply = f.invoke(f.ra, 'group_send_message', { message: '第二份完成。', replyToMessageId: second.id });
  assert.equal(
    f.store.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)?.replyMessageId,
    firstReply.messageId,
  );
  assert.equal(delivery.replyMessageId, secondReply.messageId);
  assert.equal(f.room.messages.filter((m) => m.sender.kind === 'bot').length, GROUP_LIMITS.botStreak);
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

test('quitting after a round finished does not offer to continue it', (t) => {
  const f = fixture(t);
  for (const delivery of f.store.data.groupDeliveries) delivery.status = 'replied';
  f.groups.dispose();
  const restored = new Store(f.dir);
  const groups = new GroupChats(restored, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
  try {
    assert.equal(restored.data.groupRounds[0].status, 'active');
    assert.equal(restored.data.groupRounds[0].reason, undefined);
    assert.equal(groups.snapshot().rooms.find((g) => g.id === f.room.id)?.round?.status, 'active');
  } finally {
    groups.dispose();
    restored.close();
  }
});

test('startup clears a quit banner left on a round that had nothing to resume', (t) => {
  const f = fixture(t);
  for (const delivery of f.store.data.groupDeliveries) delivery.status = 'replied';
  f.store.data.groupRounds[0].status = 'stopped';
  f.store.data.groupRounds[0].reason = '应用退出，等待用户继续';
  f.groups.dispose();
  const restored = new Store(f.dir);
  const groups = new GroupChats(restored, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
  try {
    assert.equal(restored.data.groupRounds[0].status, 'active');
    assert.equal(restored.data.groupRounds[0].reason, undefined);
  } finally {
    groups.dispose();
    restored.close();
  }
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

for (const storage of ['json', 'sqlite', 'desktop'] as const) {
  const incremental = storage !== 'json';
  const deferWrites = storage === 'desktop';
  for (const shutdown of ['crash', 'exit'] as const) {
    for (const outcome of ['answer', 'reaction', 'silent', 'unfinished'] as const) {
      test(`recovery matrix: storage=${storage}, ${shutdown}, ${outcome}`, (t) => {
        const f = fixture(t, incremental, deferWrites);
        f.deliver(f.ra);
        let replyId: string | undefined;
        if (outcome === 'answer')
          replyId = f.invoke(f.ra, 'group_send_message', {
            message: '报告已核对。',
            replyToMessageId: f.source.id,
          }).messageId;
        if (outcome === 'reaction') f.invoke(f.ra, 'group_react', { messageId: f.source.id, emoji: '👍' });
        if (outcome === 'reaction') replyId = f.room.messages.at(-1)!.id;
        if (outcome === 'unfinished') f.invoke(f.ra, 'group_send_message', { message: '正在核对。', kind: 'progress' });
        f.ra.status = outcome === 'unfinished' ? 'running' : 'completed';
        if (shutdown === 'exit') f.groups.dispose();
        f.store.flush();
        const restored = new Store(f.dir, { incremental });
        const groups = new GroupChats(
          restored,
          { isRunning: () => false, run: async () => {}, cancel: () => {} },
          () => {},
        );
        try {
          const delivery = restored.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)!;
          const expected = outcome === 'unfinished' ? 'interrupted' : outcome === 'silent' ? 'ignored' : 'replied';
          assert.equal(delivery.status, expected);
          assert.equal(delivery.replyMessageId, replyId);
          assert.equal(Boolean(delivery.resumable), outcome === 'unfinished');
          if (replyId) assert.equal(restored.data.groups[0].messages.filter((m) => m.id === replyId).length, 1);
        } finally {
          groups.dispose();
          restored.close();
        }
      });
    }
  }
}

for (const storage of ['json', 'sqlite', 'desktop'] as const) {
  for (const failAt of [1, 2]) {
    test(`publication fault matrix: ${storage}, commit ${failAt}`, (t) => {
      const f = fixture(t, storage !== 'json', storage === 'desktop');
      f.deliver(f.ra);
      groupHistory(f.store, f.room.id, f.a.id);
      f.store.flush();
      const before = {
        messages: f.room.messages.length,
        deliveries: f.store.data.groupDeliveries.length,
        history: structuredClone(f.store.data.groupContexts),
      };
      const flush = f.store.flush.bind(f.store);
      let writes = 0;
      f.store.flush = () => {
        if (++writes === failAt) throw Error('disk unavailable');
        flush();
      };
      try {
        assert.throws(
          () => f.invoke(f.ra, 'group_send_message', { message: '需要原子发送的回答。', clientMessageId: 'fault' }),
          /disk unavailable/,
        );
      } finally {
        f.store.flush = flush;
      }
      assert.equal(f.room.messages.length, before.messages);
      assert.equal(f.store.data.groupDeliveries.length, before.deliveries);
      assert.deepEqual(f.store.data.groupContexts, before.history);
      const restored = new Store(f.dir, { incremental: storage !== 'json' });
      try {
        assert.equal(restored.data.groups[0].messages.length, before.messages);
        assert.equal(restored.data.groupOutbox?.length || 0, failAt === 1 ? 0 : 1);
        assert.ok(!restored.data.groupOutbox?.some((entry) => entry.status === 'sent'));
      } finally {
        restored.close();
      }
      const first = f.invoke(f.ra, 'group_send_message', { message: '需要原子发送的回答。', clientMessageId: 'fault' });
      const again = f.invoke(f.ra, 'group_send_message', { message: '需要原子发送的回答。', clientMessageId: 'fault' });
      assert.equal(first.messageId, again.messageId);
      assert.equal(f.room.messages.length, before.messages + 1);
    });
  }
}

test('retrying one failed batch requeues every unacknowledged input from that run', (t) => {
  const f = fixture(t);
  f.deliver(f.ra);
  const first = f.store.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)!;
  f.groups.send({ id: f.room.id, message: '第二份报告也要核对。' });
  const secondMessage = f.room.messages.at(-1)!;
  const second = f.store.data.groupDeliveries.find(
    (d) => d.messageId === secondMessage.id && d.recipientId === f.a.id,
  )!;
  for (const delivery of [first, second]) {
    delivery.status = 'failed';
    delivery.runId = f.ra.id;
    delivery.reason = 'model unavailable';
  }
  f.ra.status = 'failed';
  f.ra.groupOrigin = { groupId: f.room.id, rootId: second.rootId, deliveryId: second.id };
  f.groups.retryRun(f.ra);
  for (const delivery of [first, second]) {
    assert.equal(delivery.status, 'queued');
    assert.equal(delivery.retryRunId, f.ra.id);
    assert.equal(f.store.data.groupRounds.find((r) => r.id === delivery.rootId)?.status, 'active');
  }
});

for (const kind of ['message', 'reaction'] as const) {
  test(`desktop deferred storage commits ${kind} before acknowledging publication`, (t) => {
    const f = fixture(t, true, true);
    f.deliver(f.ra);
    f.store.flush();
    const result =
      kind === 'message'
        ? f.invoke(f.ra, 'group_send_message', { message: '不能丢失的公开回答。' })
        : f.invoke(f.ra, 'group_react', { messageId: f.source.id, emoji: '👍' });
    const id = kind === 'message' ? result.messageId : result.eventId;
    const restored = new Store(f.dir, { incremental: true });
    try {
      assert.ok(
        restored.data.groups[0].messages.some((m) => m.id === id),
        'acknowledged publication must already be on disk',
      );
      if (kind === 'reaction')
        assert.equal(restored.data.groups[0].messages.find((m) => m.id === f.source.id)?.pins?.length, 1);
    } finally {
      restored.close();
    }
  });
}

test('failed reaction persistence rolls back its badge and event before a retry', (t) => {
  const f = fixture(t, true);
  const before = { messages: f.room.messages.length, deliveries: f.store.data.groupDeliveries.length };
  const flush = f.store.flush.bind(f.store);
  f.store.flush = () => {
    throw Error('disk unavailable');
  };
  try {
    assert.throws(() => f.invoke(f.ra, 'group_react', { messageId: f.source.id, emoji: '👍' }), /disk unavailable/);
  } finally {
    f.store.flush = flush;
  }
  assert.equal(f.source.pins?.length || 0, 0);
  assert.equal(f.room.messages.length, before.messages);
  assert.equal(f.store.data.groupDeliveries.length, before.deliveries);
  const retried = f.invoke(f.ra, 'group_react', { messageId: f.source.id, emoji: '👍' });
  assert.ok(retried.eventId);
  assert.equal(f.source.pins?.length, 1);
  assert.equal(f.room.messages.length, before.messages + 1);
});

test('Bot reactions do not consume or inflate the displayed text allowance', (t) => {
  const f = fixture(t);
  f.invoke(f.ra, 'group_react', { messageId: f.source.id, emoji: '👍' });
  assert.equal(f.store.data.groupRounds.find((r) => r.id === f.source.rootId)?.botMessages, 0);
});

for (const status of ['replied', 'ignored', 'limited'] as const) {
  test(`a retry cannot reopen an already settled ${status} delivery`, (t) => {
    const f = fixture(t);
    f.deliver(f.ra);
    f.ra.status = 'cancelled';
    const delivery = f.store.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)!;
    delivery.status = status;
    assert.throws(() => f.groups.retryRun(f.ra));
    assert.equal(delivery.status, status);
  });
}

test('a failed batch larger than eight inputs resumes once as the original batch', async (t) => {
  const f = fixture(t);
  for (let i = 1; i < 14; i++) f.groups.send({ id: f.room.id, message: `待核对报告 ${i}` });
  const deliveries = f.store.data.groupDeliveries.filter(
    (d) => d.recipientId === f.a.id && f.room.messages.find((m) => m.id === d.messageId)?.sender.kind === 'user',
  );
  for (const delivery of deliveries) {
    delivery.status = 'failed';
    delivery.runId = f.ra.id;
  }
  f.ra.status = 'failed';
  const last = deliveries.at(-1)!;
  f.ra.groupOrigin = { groupId: f.room.id, rootId: last.rootId, deliveryId: last.id };
  f.groups.dispose();
  const resumed: Array<{ previous?: string; inputs: number }> = [];
  const groups = new GroupChats(
    f.store,
    {
      isRunning: () => false,
      cancel: () => {},
      run: async (botId, input, options) => {
        resumed.push({ previous: options.resumeRunId, inputs: JSON.parse(input).events.length });
        const run: RunRecord = {
          id: randomUUID(),
          botId,
          status: 'completed',
          modelCalls: 0,
          toolCalls: 0,
          startedAt: new Date().toISOString(),
          groupOrigin: options.groupOrigin,
        };
        f.store.data.runs.push(run);
        options.onStarted?.(run.id);
      },
    },
    () => {},
  );
  try {
    groups.start();
    groups.retryRun(f.ra);
    await until(() => !groups.busy && deliveries.every((d) => d.status === 'ignored'));
    assert.deepEqual(resumed, [{ previous: f.ra.id, inputs: 14 }]);
  } finally {
    groups.dispose();
  }
});

for (const storage of ['json', 'sqlite', 'desktop'] as const) {
  for (const shutdown of ['crash', 'exit'] as const) {
    test(`restart publishes the saved final answer exactly once: ${storage}, ${shutdown}`, (t) => {
      const incremental = storage !== 'json';
      const f = fixture(t, incremental, storage === 'desktop');
      f.deliver(f.ra);
      f.invoke(f.ra, 'group_send_message', { message: '正在核对。', kind: 'progress' });
      f.store.message(f.a.id, 'assistant', '核对完成，发现三处错误。', {
        runId: f.ra.id,
        presentation: 'answer',
        status: 'done',
      });
      f.ra.status = 'completed';
      if (shutdown === 'exit') f.groups.dispose();
      f.store.flush();
      let messageId: string | undefined;
      for (let restart = 0; restart < 2; restart++) {
        const restored = new Store(f.dir, { incremental });
        const groups = new GroupChats(
          restored,
          {
            isRunning: () => false,
            run: async () => {
              assert.fail('completed model work must not run again');
            },
            cancel: () => {},
          },
          () => {},
        );
        try {
          const room = restored.data.groups.find((g) => g.id === f.room.id)!;
          const replies = room.messages.filter((m) => m.content === '核对完成，发现三处错误。');
          assert.equal(replies.length, 1);
          assert.equal(replies[0].answers, f.source.id);
          assert.equal(replies[0].replyTo, f.source.id);
          if (messageId) assert.equal(replies[0].id, messageId);
          messageId = replies[0].id;
          const delivery = restored.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)!;
          assert.equal(delivery.status, 'replied');
          assert.equal(delivery.replyMessageId, messageId);
          assert.equal(delivery.resumable, undefined);
          restored.flush();
        } finally {
          groups.dispose();
          restored.close();
        }
      }
    });
  }
}

for (const [content, expected] of [
  ['最终结论。', '最终结论。'],
  ['', '[附件] report.txt'],
  ['  ', '[附件] report.txt'],
  ['<|eos|>', '[附件] report.txt'],
  ['（空消息，无需回应）', '[附件] report.txt'],
  ['没有新内容。[群聊静默]', '[附件] report.txt'],
  ['@B 没有新内容。[群聊静默]', '[附件] report.txt'],
  ['@B 最终结论。', '@B 最终结论。'],
  ['这个 <|eos|> 是模型结束标记。', '这个 <|eos|> 是模型结束标记。'],
]) {
  test(`restart recovers final attachments after a separately published answer (${JSON.stringify(content)})`, (t) => {
    const f = fixture(t, true, true);
    f.deliver(f.ra);
    f.invoke(f.ra, 'group_send_message', { message: '第一部分已完成。' });
    const attachments = [{ id: 'report-file', name: 'report.txt', size: 10, mime: 'text/plain' }];
    const mention = { id: f.b.id, name: f.b.name, color: f.b.color, start: 0, end: 2 };
    f.store.message(f.a.id, 'assistant', content, {
      runId: f.ra.id,
      presentation: 'answer',
      status: 'done',
      attachments,
      mentions: content.startsWith('@B ') ? [mention] : [],
    });
    f.ra.status = 'completed';
    f.store.flush();
    const restored = new Store(f.dir, { incremental: true });
    const groups = new GroupChats(
      restored,
      { isRunning: () => false, run: async () => {}, cancel: () => {} },
      () => {},
    );
    try {
      const reply = restored.data.groups[0].messages.find((m) => m.attachments?.[0]?.id === 'report-file');
      assert.ok(reply);
      assert.equal(reply.content, expected);
      assert.deepEqual(reply.attachments, attachments);
      assert.deepEqual(reply.mentions, expected.startsWith('@B ') ? [mention] : []);
      assert.equal(
        restored.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)?.replyMessageId,
        reply.id,
      );
    } finally {
      groups.dispose();
      restored.close();
    }
  });
}

test('recovery stops publishing other completed runs when the first recovered answer reaches the room limit', (t) => {
  const f = fixture(t);
  for (let i = 0; i < GROUP_LIMITS.botStreak - 1; i++)
    f.invoke(f.ra, 'group_send_message', { message: `公开消息 ${i}` });
  for (const run of [f.ra, f.rb]) {
    f.deliver(run);
    f.store.message(run.botId, 'assistant', `最后答案 ${run.id}`, {
      runId: run.id,
      presentation: 'answer',
      status: 'done',
    });
    run.status = 'completed';
  }
  f.store.flush();
  const restored = new Store(f.dir);
  let groups: GroupChats | undefined;
  try {
    groups = new GroupChats(restored, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
    assert.equal(
      restored.data.groups[0].messages.filter((m) => m.kind === 'message' && m.sender.kind === 'bot').length,
      GROUP_LIMITS.botStreak,
    );
    assert.equal(restored.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)?.status, 'replied');
    assert.equal(restored.data.groupDeliveries.find((d) => d.id === f.rb.groupOrigin!.deliveryId)?.status, 'limited');
  } finally {
    groups?.dispose();
    restored.close();
  }
});

for (const storage of ['json', 'sqlite', 'desktop'] as const) {
  for (const failAt of [1, 2]) {
    test(`failed startup publication retries the saved answer without a model call: ${storage}, write ${failAt}`, async (t) => {
      const incremental = storage !== 'json';
      const f = fixture(t, incremental, storage === 'desktop');
      f.deliver(f.ra);
      f.store.message(f.a.id, 'assistant', '已保存的最终结果', {
        runId: f.ra.id,
        presentation: 'answer',
        status: 'done',
      });
      f.ra.status = 'completed';
      f.store.flush();
      const restored = new Store(f.dir, { incremental });
      const flush = restored.flush.bind(restored);
      let writes = 0;
      restored.flush = (...args) => {
        if (++writes === failAt) throw Error('simulated publication write failure');
        return flush(...args);
      };
      let groups: GroupChats | undefined;
      try {
        groups = new GroupChats(
          restored,
          {
            isRunning: (id) => id !== f.a.id,
            run: async () => {
              assert.fail('must reuse the completed answer');
            },
            cancel: () => {},
          },
          () => {},
        );
        const delivery = () => restored.data.groupDeliveries.find((d) => d.id === f.ra.groupOrigin!.deliveryId)!;
        assert.equal(delivery().status, 'interrupted');
        assert.equal(delivery().resumable, true);
        assert.match(delivery().reason || '', /publication write failure/);
        restored.flush = flush;
        groups.continue(f.room.id);
        groups.start();
        await until(() => delivery().status === 'replied');
        assert.equal(restored.data.groups[0].messages.filter((m) => m.content === '已保存的最终结果').length, 1);
        assert.equal(restored.data.runs.filter((r) => r.botId === f.a.id).length, 1);
      } finally {
        restored.flush = flush;
        groups?.dispose();
        restored.close();
      }
    });
  }
}

test('clean-exit recovery respects the room limit across multiple saved answers', (t) => {
  const f = fixture(t);
  for (let i = 0; i < GROUP_LIMITS.botStreak - 1; i++)
    f.invoke(f.ra, 'group_send_message', { message: `边界消息 ${i}` });
  for (const run of [f.ra, f.rb]) {
    f.deliver(run);
    f.store.message(run.botId, 'assistant', `待补发 ${run.id}`, {
      runId: run.id,
      presentation: 'answer',
      status: 'done',
    });
    run.status = 'completed';
  }
  f.groups.dispose();
  f.store.flush();
  const restored = new Store(f.dir);
  let groups: GroupChats | undefined;
  try {
    groups = new GroupChats(restored, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
    assert.equal(
      restored.data.groups[0].messages.filter((m) => m.kind === 'message' && m.sender.kind === 'bot').length,
      GROUP_LIMITS.botStreak,
    );
    assert.equal(restored.data.groupDeliveries.find((d) => d.id === f.rb.groupOrigin!.deliveryId)?.status, 'limited');
  } finally {
    groups?.dispose();
    restored.close();
  }
});

test('game reports acknowledge one durable publication per match across restarts', (t) => {
  const f = fixture(t, true, true);
  f.store.flush();
  const deliveries = f.store.data.groupDeliveries.length;
  const post = (groups: GroupChats, matchId: string) =>
    groups.postGameResult(f.room.id, '对局结束：好人阵营获胜。', matchId);
  post(f.groups, 'match-one');
  const restored = new Store(f.dir, { incremental: true });
  let groups: GroupChats | undefined;
  try {
    assert.equal(restored.data.groups[0].messages.filter((m) => m.content.startsWith('对局结束')).length, 1);
    groups = new GroupChats(restored, { isRunning: () => false, run: async () => {}, cancel: () => {} }, () => {});
    post(groups, 'match-one');
    post(groups, 'match-two');
    const reports = restored.data.groups[0].messages.filter((m) => m.content.startsWith('对局结束'));
    assert.equal(reports.length, 2);
    assert.equal(new Set(reports.map((m) => m.id)).size, 2);
    assert.ok(reports.every((m) => m.kind === 'system' && !m.rootId));
    assert.equal(restored.data.groupDeliveries.length, deliveries);
  } finally {
    groups?.dispose();
    restored.close();
  }
});

test('failed game-report persistence retries once and closing cannot acknowledge publication', (t) => {
  const f = fixture(t, true, true);
  f.store.flush();
  const flush = f.store.flush.bind(f.store);
  f.store.flush = () => {
    throw Error('report disk unavailable');
  };
  try {
    assert.throws(() => f.groups.postGameResult(f.room.id, '战报需要落盘。', 'match-retry'), /report disk unavailable/);
  } finally {
    f.store.flush = flush;
  }
  f.groups.postGameResult(f.room.id, '战报需要落盘。', 'match-retry');
  const restored = new Store(f.dir, { incremental: true });
  try {
    assert.equal(restored.data.groups[0].messages.filter((m) => m.content === '战报需要落盘。').length, 1);
  } finally {
    restored.close();
  }
  f.groups.postGameResult('deleted-group', '已删除群聊不需要补发。', 'match-deleted');
  f.groups.dispose();
  assert.throws(() => f.groups.postGameResult(f.room.id, '尚未发布。', 'match-after-close'), /退出/);
  assert.ok(!f.room.messages.some((m) => m.content === '尚未发布。'));
});
