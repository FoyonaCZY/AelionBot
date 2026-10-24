import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, settle, tempDir, until } from './helpers';
import { Store } from '../electron/core/storage/store';
import { Harness } from '../electron/core/agent/harness';
import { ChatPinQueue } from '../electron/core/agent/chat-pins';
import { retractInput } from '../electron/core/agent/retract-input';
import { canRetract } from '../shared/chat/retract';
import type { ModelClient, Completion, ToolDefinition } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import type { ChatMessage, RunRecord, WireMessage } from '../shared/types/core';

function fixture(
  t: test.TestContext,
  complete: (messages: WireMessage[], tools: ToolDefinition[], signal: AbortSignal) => Promise<Completion> | Completion,
) {
  const store = new Store(tempDir(t, 'aelion-retract-')),
    bot = store.data.bots[0];
  store.data.model.model = 'fixture';
  store.data.model.contextTokens = 64000;
  let queue: ChatPinQueue;
  const harness = new Harness(store, {} as VmController, { complete } as ModelClient, () => queue?.wake());
  queue = new ChatPinQueue(
    store,
    {
      isRunning: (id, sessionId) => harness.isRunning(id, sessionId),
      run: (...args) => harness.run(...args),
      refresh: (id, sessionId) => harness.refreshInput(id, sessionId),
    },
    () => {},
  );
  t.after(async () => {
    queue.dispose();
    harness.cancel(bot.id);
    await until(() => !harness.busy);
  });
  const retract = (messageId: string) =>
    retractInput(
      {
        store,
        stop: (botId, lane) => harness.cancel(botId, lane),
        isRunning: (botId, lane) => harness.isRunning(botId, lane),
        hold: (botId, sessionId, work) => queue.hold(botId, sessionId, work),
        forgetSuperseded: (botId, sessionId, runId) => queue.forgetSuperseded(botId, sessionId, runId),
        changed: () => {},
      },
      { botId: bot.id, messageId },
    );
  return { store, bot, harness, queue, retract, idle: () => !harness.busy && !queue.hasPending(bot.id) };
}
const userText = (messages: WireMessage[]) => messages.filter((m) => m.role === 'user').map((m) => m.content || '');
/** Waits on the model until the run is stopped. */
const hang = (signal: AbortSignal) =>
  new Promise<Completion>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );

test('taking back a message being worked on stops the task and leaves no trace of it in the chat or the history', async (t) => {
  const seen: string[][] = [];
  const fx = fixture(t, (messages, _tools, signal) => {
    seen.push(userText(messages));
    const last = userText(messages).at(-1) || '';
    if (last.includes('销售')) return hang(signal);
    return answer('收到：' + last);
  });
  fx.queue.send({ botId: fx.bot.id, message: '你好' });
  await until(fx.idle);
  fx.queue.send({ botId: fx.bot.id, message: '写一份周报，重点放在销售' });
  await until(() => seen.length === 2);
  const sent = fx.store.data.messages.find((m) => m.content === '写一份周报，重点放在销售')!;
  const run = fx.store.data.runs.find((r) => r.id === sent.runId)!;
  assert.ok(canRetract(sent, run), 'a message whose task is running can be taken back');

  const draft = await fx.retract(sent.id);
  assert.equal(draft.text, '写一份周报，重点放在销售');
  assert.equal(run.status, 'cancelled');
  assert.equal(run.retracted, true);
  assert.ok(
    !fx.store.data.messages.some((m) => m.runId === run.id),
    'the input and what the Bot wrote for it are gone',
  );
  assert.ok(
    fx.store.data.messages.some((m) => m.content === '你好'),
    'earlier messages stay',
  );
  const history = fx.store.data.conversations[fx.bot.id];
  assert.ok(!history.some((m) => m.content?.includes('写一份周报')), 'the model history no longer holds it');
  assert.ok(history.some((m) => m.content === '你好'));

  fx.queue.send({ botId: fx.bot.id, message: '写一份周报，重点放在利润' });
  await until(fx.idle);
  const last = seen.at(-1)!;
  assert.ok(last.includes('你好'));
  assert.ok(
    !last.some((text) => text.includes('销售')),
    'the edited message is answered as if the first was never sent',
  );
  assert.ok(fx.store.data.messages.some((m) => m.content === '收到：写一份周报，重点放在利润'));
  assert.ok(!fx.store.data.runs.at(-1)!.supersedesRunId, 'the new task does not carry on with the one taken back');
});

test('taking back a waiting message removes it before it starts', async (t) => {
  let calls = 0;
  const fx = fixture(t, () => {
    calls++;
    return answer('不应调用');
  });
  fx.queue.send({ botId: fx.bot.id, message: '还在排队' });
  const waiting = fx.store.data.messages.at(-1)!;
  assert.ok(canRetract(waiting, undefined));
  const draft = await fx.retract(waiting.id);
  assert.equal(draft.text, '还在排队');
  await settle();
  assert.equal(calls, 0);
  assert.ok(!fx.store.data.messages.some((m) => m.id === waiting.id));
});

test('a message whose task has finished cannot be taken back', async (t) => {
  const fx = fixture(t, () => answer('好的'));
  fx.queue.send({ botId: fx.bot.id, message: '帮我看看' });
  await until(fx.idle);
  const done = fx.store.data.messages.find((m) => m.content === '帮我看看')!;
  await assert.rejects(fx.retract(done.id), { code: 'chat.retract_unavailable' });
  assert.ok(fx.store.data.messages.some((m) => m.id === done.id));
});

test('only typed input can be taken back', () => {
  const run = { id: 'r', botId: 'b', status: 'running' } as RunRecord;
  const typed = { id: 'm', botId: 'b', role: 'user', content: '改一下', time: '', runId: 'r' } as ChatMessage;
  assert.ok(canRetract(typed, run));
  assert.ok(!canRetract({ ...typed, role: 'assistant' }, run));
  assert.ok(!canRetract({ ...typed, previewPrompt: '' }, run), 'a preview comment');
  assert.ok(!canRetract({ ...typed, reaction: { messageId: 'x', emoji: '👍' } } as ChatMessage, run));
  assert.ok(!canRetract(typed, { ...run, status: 'completed' }));
  assert.ok(!canRetract(typed, { ...run, groupOrigin: { groupId: 'g' } } as RunRecord), 'a group task');
  assert.ok(!canRetract({ ...typed, runId: undefined, inputState: 'cancelled' }, undefined));
});
