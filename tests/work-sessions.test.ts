import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../electron/core/storage/store';
import { Harness } from '../electron/core/agent/harness';
import { ChatPinQueue } from '../electron/core/agent/chat-pins';
import { TaskScheduler } from '../electron/core/scheduler/task-scheduler';
import type { ModelClient } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import type { Bot, ChatMessage, RunRecord, Snapshot, WireMessage, WorkSession } from '../shared/types/core';
import { botConversation } from '../src/app/bot-conversation';
import { botConversationRows } from '../src/app/conversation-list';
import { answer, tempDir, until } from './helpers';

const NOW = '2026-10-01T00:00:00.000Z';
const session = (botId: string, id = 's1', extra: Partial<WorkSession> = {}): WorkSession => ({
  id,
  botId,
  name: id,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});
const userText = (messages: WireMessage[]) =>
  messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message.content));

function fixture(t: test.TestContext, complete: (messages: WireMessage[]) => Promise<unknown>) {
  const store = new Store(tempDir(t, 'aelion-session-')),
    bot = store.data.bots[0];
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;
  store.data.workSessions!.push(session(bot.id));
  const refreshed: Array<[string, string | undefined]> = [];
  let queue: ChatPinQueue | undefined;
  const harness = new Harness(store, {} as VmController, { complete } as unknown as ModelClient, () => queue?.wake());
  queue = new ChatPinQueue(
    store,
    {
      isRunning: (id, sessionId) => harness.isRunning(id, sessionId),
      run: (...args) => harness.run(...args),
      refresh: (id, sessionId) => {
        refreshed.push([id, sessionId]);
        return undefined;
      },
    },
    () => {},
  );
  t.after(async () => {
    queue!.dispose();
    harness.cancel(bot.id);
    await until(() => !harness.busy);
  });
  return { store, bot, harness, queue, refreshed };
}

test('a work session is its own chat: its input, run, replies and context stay out of the main chat', async (t) => {
  const requests: string[][] = [];
  const { store, bot, harness, queue } = fixture(t, async (messages) => {
    requests.push(userText(messages));
    return answer('好的');
  });
  queue.send({ botId: bot.id, message: '主聊天里的问题' });
  await until(() => store.data.runs.length === 1 && !harness.busy && !queue.hasPending(bot.id));
  queue.send({ botId: bot.id, sessionId: 's1', message: '会话里的问题' });
  await until(() => store.data.runs.length === 2 && !harness.busy && !queue.hasPending(bot.id));
  const run = store.data.runs[1];
  assert.equal(run.sessionId, 's1');
  assert.equal(store.data.runs[0].sessionId, undefined);
  assert.ok(store.data.messages.filter((message) => message.runId === run.id).every((m) => m.sessionId === 's1'));
  assert.ok(JSON.stringify(store.data.conversations['session:s1']).includes('会话里的问题'));
  assert.ok(!JSON.stringify(store.data.conversations[bot.id]).includes('会话里的问题'));
  // The session's request carries its own history only.
  assert.ok(!requests.at(-1)!.some((text) => text.includes('主聊天里的问题')));
  assert.throws(() => queue.send({ botId: bot.id, sessionId: 'missing', message: '你好' }), /工作会话不存在/);
});

test('a Bot works in its chats at the same time; new input interrupts only the chat it is sent in', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { store, bot, harness, queue, refreshed } = fixture(t, async (messages) => {
    if (userText(messages).some((text) => text.includes('主聊天的长任务'))) await gate;
    return answer('完成');
  });
  queue.send({ botId: bot.id, message: '主聊天的长任务' });
  await until(() => harness.isRunning(bot.id, null));
  queue.send({ botId: bot.id, sessionId: 's1', message: '会话里的新问题' });
  assert.deepEqual(refreshed, [
    [bot.id, undefined],
    [bot.id, 's1'],
  ]);
  // The session's answer arrives while the main chat is still working.
  await until(() => store.data.runs.some((run) => run.sessionId === 's1' && run.status === 'completed'));
  assert.equal(harness.isRunning(bot.id, null), true);
  assert.equal(harness.isRunning(bot.id, 's1'), false);
  assert.equal(store.data.messages.find((m) => m.content === '会话里的新问题')?.runId, store.data.runs[1].id);
  // Stopping the session leaves the main chat working.
  harness.cancel(bot.id, 's1');
  assert.equal(harness.isRunning(bot.id, null), true);
  release();
  await until(() => !harness.busy && !queue.hasPending(bot.id));
  assert.equal(store.data.runs[0].status, 'completed');
  assert.equal(store.data.runs[0].sessionId, undefined);
});

test("one of the Bot's chats at a time drives its desktop", (t) => {
  const { store, bot, harness } = fixture(t, async () => answer('完成'));
  const running = (id: string, sessionId?: string) =>
    store.data.runs.push({
      id,
      botId: bot.id,
      status: 'running',
      startedAt: NOW,
      modelCalls: 0,
      toolCalls: 0,
      ...(sessionId ? { sessionId } : {}),
    });
  running('main');
  running('work', 's1');
  const claim = (runId: string) => (harness as any).claimDesktop(bot.id, runId);
  claim('main');
  claim('main');
  assert.equal(harness.desktopSession(bot.id), null);
  assert.throws(() => claim('work'), { code: 'computer.in_use_elsewhere' });
  store.data.runs[0].status = 'completed';
  claim('work');
  assert.equal(harness.desktopSession(bot.id), 's1');
});

test("stopping one of the Bot's chats cancels only that chat's queued input", (t) => {
  const { store, bot, queue } = fixture(t, async () => answer('完成'));
  // Queued while the Bot is busy elsewhere (no model call is made here).
  const main = store.message(bot.id, 'user', '主聊天排队', { inputState: 'queued' }),
    work = store.message(bot.id, 'user', '会话排队', { inputState: 'queued', sessionId: 's1' });
  queue.cancel(bot.id, 's1');
  assert.equal(work.inputState, 'cancelled');
  assert.equal(main.inputState, 'queued');
  queue.cancel(bot.id, null);
  assert.equal(main.inputState, 'cancelled');
});

test('deleting a work session removes its messages, runs and context but keeps the main chat', (t) => {
  const dir = tempDir(t, 'aelion-session-delete-'),
    store = new Store(dir),
    bot = store.data.bots[0];
  store.data.workSessions!.push(session(bot.id));
  const main = store.message(bot.id, 'user', '主聊天');
  store.message(bot.id, 'user', '会话消息', { sessionId: 's1' });
  store.data.conversations['session:s1'] = [{ role: 'user', content: '会话消息' }];
  store.data.conversationWorkspaces = { 'session:s1': dir };
  store.save();
  store.deleteWorkSession('s1');
  const reopened = new Store(dir);
  assert.deepEqual(reopened.data.workSessions, []);
  assert.deepEqual(
    reopened.data.messages.map((m) => m.id),
    [main.id],
  );
  assert.equal(reopened.data.conversations['session:s1'], undefined);
  assert.equal(reopened.data.conversationWorkspaces?.['session:s1'], undefined);
  assert.throws(() => store.deleteWorkSession('s1'), /工作会话不存在/);
});

const bot = (id: string): Bot => ({ id, name: id, createdAt: NOW, color: '#888', soul: '', memories: [] });
const message = (botId: string, time: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `${botId}:${time}:${extra.sessionId || ''}`,
  botId,
  time,
  role: 'assistant',
  content: '消息',
  ...extra,
});

test('the list shows sessions under their Bot, and an active session keeps the Bot up the list', () => {
  const messages = [
    message('a', '2026-10-02T10:00:00Z'),
    message('b', '2026-10-02T11:00:00Z'),
    message('a', '2026-10-02T12:00:00Z', { sessionId: 'a1', content: '会话最新' }),
  ];
  const rows = botConversationRows([bot('a'), bot('b')], messages, [], [session('a', 'a1'), session('a', 'a2')]);
  assert.deepEqual(
    rows.map((row) => row.bot.id),
    ['a', 'b'],
  );
  // The Bot's own row keeps showing its main chat; the session row shows the session.
  assert.equal(rows[0].last?.time, '2026-10-02T10:00:00Z');
  assert.deepEqual(
    rows[0].sessions.map((row) => [row.session.id, row.last?.content]),
    [
      ['a1', '会话最新'],
      ['a2', undefined],
    ],
  );
  // An archived session no longer lifts its Bot.
  const archived = botConversationRows([bot('a'), bot('b')], messages, [], [session('a', 'a1', { archivedAt: NOW })]);
  assert.deepEqual(
    archived.map((row) => row.bot.id),
    ['b', 'a'],
  );
});

test('a chat shows only its own messages, runs and waiting requests, and counts as busy only for its own work', () => {
  const runs: RunRecord[] = [
    { id: 'main', botId: 'a', status: 'completed', startedAt: NOW, modelCalls: 0, toolCalls: 0 } as RunRecord,
    {
      id: 'work',
      botId: 'a',
      status: 'running',
      startedAt: NOW,
      sessionId: 's1',
      modelCalls: 0,
      toolCalls: 0,
    } as RunRecord,
  ];
  const state = {
    messages: [
      message('a', '2026-10-02T10:00:00Z', { runId: 'main' }),
      message('a', '2026-10-02T11:00:00Z', { runId: 'work', sessionId: 's1' }),
    ],
    runs,
    interactions: [{ id: 'r', botId: 'a', runId: 'work', kind: 'takeover' }],
  } as unknown as Snapshot;
  const main = botConversation(state, bot('a')),
    work = botConversation(state, bot('a'), 's1');
  assert.deepEqual(
    main.messages.map((m) => m.runId),
    ['main'],
  );
  assert.deepEqual(
    work.messages.map((m) => m.runId),
    ['work'],
  );
  assert.equal(main.running, false);
  assert.equal(work.running, true);
  assert.equal(main.waiting, undefined);
  assert.equal(work.waiting?.id, 'r');
});

test('a task the Bot schedules in a work session belongs to it, runs in it and goes with it', async (t) => {
  const { store, bot, harness, queue } = fixture(t, async () => answer('已核对'));
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const scheduler = new TaskScheduler(
    store,
    {
      ready: () => !harness.busy && !queue.hasPending(bot.id),
      send: (target, prompt, trigger) => queue.schedule(target.id, prompt, trigger, target.sessionId),
    },
    () => {},
    () => clock,
  );
  t.after(() => scheduler.dispose());
  const run = (sessionId?: string) => {
    const value = {
      id: 'run-' + (sessionId || 'main'),
      botId: bot.id,
      status: 'running',
      startedAt: NOW,
      modelCalls: 1,
      toolCalls: 0,
      ...(sessionId ? { sessionId } : {}),
    } as RunRecord;
    store.data.runs.push(value);
    return value;
  };
  const signal = new AbortController().signal,
    inSession = run('s1'),
    inMain = run();
  const task = scheduler.invoke(
    bot.id,
    inSession.id,
    'scheduled_task_create',
    {
      title: '发布检查',
      prompt: '检查发布进度',
      schedule: { kind: 'once', at: new Date(clock + 60_000).toISOString(), timeZone: 'Asia/Shanghai' },
    },
    signal,
    {},
  ) as any;
  assert.deepEqual(task.target, { kind: 'bot', id: bot.id, sessionId: 's1' });
  // Each chat sees and manages only its own tasks.
  assert.deepEqual(scheduler.invoke(bot.id, inMain.id, 'scheduled_tasks_list', {}, signal, {}), []);
  assert.equal((scheduler.invoke(bot.id, inSession.id, 'scheduled_tasks_list', {}, signal, {}) as any[]).length, 1);
  assert.throws(() => scheduler.invoke(bot.id, inMain.id, 'scheduled_task_delete', { id: task.id }, signal, {}), {
    code: 'schedule.target_mismatch',
  });
  store.data.runs = [];
  clock += 120_000;
  scheduler.tick();
  await until(() => store.data.runs.length === 1 && !harness.busy && !queue.hasPending(bot.id));
  assert.equal(store.data.runs[0].sessionId, 's1');
  assert.equal(store.data.messages.find((message) => message.scheduled)?.sessionId, 's1');
  // Removing the session's tasks leaves the main chat's; removing the Bot's removes both.
  const main = scheduler.create({
    target: { kind: 'bot', id: bot.id },
    title: '主聊天任务',
    prompt: '整理',
    schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
  });
  scheduler.removeTarget({ kind: 'bot', id: bot.id, sessionId: 's1' });
  assert.deepEqual(
    scheduler.list().map((item) => item.id),
    [main.id],
  );
  scheduler.removeTarget({ kind: 'bot', id: bot.id });
  assert.deepEqual(scheduler.list(), []);
  assert.throws(
    () =>
      scheduler.create({
        target: { kind: 'bot', id: bot.id, sessionId: 'missing' },
        title: '无效',
        prompt: '无效',
        schedule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
      }),
    /工作会话不存在/,
  );
});
