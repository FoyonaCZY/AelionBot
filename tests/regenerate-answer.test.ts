import test from 'node:test';
import assert from 'node:assert/strict';
import { answer, tempDir, until } from './helpers';
import { Store } from '../electron/core/storage/store';
import { Harness } from '../electron/core/agent/harness';
import { ChatPinQueue } from '../electron/core/agent/chat-pins';
import { regenerateAnswer } from '../electron/core/agent/retract-input';
import type { ModelClient, Completion, ToolDefinition } from '../electron/core/model/model';
import type { VmController } from '../electron/core/vm/vm';
import type { WireMessage } from '../shared/types/core';
import { AppError } from '../shared/errors';

function fixture(
  t: test.TestContext,
  complete: (messages: WireMessage[], tools: ToolDefinition[], signal: AbortSignal) => Promise<Completion> | Completion,
) {
  const store = new Store(tempDir(t, 'aelion-regenerate-')),
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
  const regenerate = (runId: string, sessionId?: string) =>
    regenerateAnswer(
      {
        store,
        isRunning: (botId, lane) => harness.isRunning(botId, lane),
        hasPending: (botId, lane) => queue.hasPending(botId, lane),
        hold: (botId, id, work) => queue.hold(botId, id, work),
        forgetSuperseded: (botId, id, runId) => queue.forgetSuperseded(botId, id, runId),
        changed: () => {},
      },
      { botId: bot.id, runId, ...(sessionId ? { sessionId } : {}) },
    );
  return { store, bot, harness, queue, regenerate, idle: () => !harness.busy && !queue.hasPending(bot.id) };
}
const userText = (messages: WireMessage[]) => messages.filter((m) => m.role === 'user').map((m) => m.content || '');
const code = (error: unknown) => (error instanceof AppError ? error.code : String(error));

test('the last answer is made again from the same input, which stays where it was', async (t) => {
  const seen: string[][] = [];
  const fx = fixture(t, (messages) => {
    seen.push(userText(messages));
    return answer('第 ' + seen.length + ' 次回答');
  });
  fx.queue.send({ botId: fx.bot.id, message: '你好' });
  await until(fx.idle);
  fx.queue.send({ botId: fx.bot.id, message: '给周报起个标题' });
  await until(fx.idle);
  const sent = fx.store.data.messages.find((m) => m.content === '给周报起个标题')!;
  const first = fx.store.data.runs.find((r) => r.id === sent.runId)!;
  assert.ok(fx.store.data.messages.some((m) => m.content === '第 2 次回答'));

  await fx.regenerate(first.id);
  await until(() => fx.idle() && seen.length === 3);

  const chat = fx.store.data.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.content);
  assert.deepEqual(chat.slice(-2), ['给周报起个标题', '第 3 次回答'], 'the new answer replaces the old one');
  assert.ok(!chat.includes('第 2 次回答'));
  const again = fx.store.data.messages.find((m) => m.id === sent.id)!;
  assert.notEqual(again.runId, first.id, 'the input belongs to the new run');
  assert.equal(fx.store.data.runs.find((r) => r.id === first.id)?.retracted, true);
  // The model answers as if for the first time: the earlier answer is not in what it reads.
  assert.equal(seen[2].filter((text) => text.includes('给周报起个标题')).length, 1);
  const history = fx.store.data.conversations[fx.bot.id].map((m) => m.content || '');
  assert.ok(!history.some((text) => text.includes('第 2 次回答')));
});

test('only the last answer of a chat can be made again', async (t) => {
  const fx = fixture(t, (messages) => answer('收到：' + (userText(messages).at(-1) || '')));
  fx.queue.send({ botId: fx.bot.id, message: '第一件事' });
  await until(fx.idle);
  const earlier = fx.store.data.messages.find((m) => m.content === '第一件事')!.runId!;
  fx.queue.send({ botId: fx.bot.id, message: '第二件事' });
  await until(fx.idle);
  await assert.rejects(fx.regenerate(earlier), (error) => code(error) === 'chat.regenerate_unavailable');
  await assert.rejects(fx.regenerate('missing'), (error) => code(error) === 'chat.regenerate_unavailable');
});

test('an answer is not made again while the Bot works in that chat', async (t) => {
  let release: (() => void) | undefined;
  const fx = fixture(t, async (messages, _tools, signal) => {
    if ((userText(messages).at(-1) || '').includes('慢')) {
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return answer('好');
  });
  fx.queue.send({ botId: fx.bot.id, message: '快' });
  await until(fx.idle);
  const done = fx.store.data.messages.find((m) => m.content === '快')!.runId!;
  fx.queue.send({ botId: fx.bot.id, message: '慢慢来' });
  await until(() => Boolean(release));
  await assert.rejects(fx.regenerate(done), (error) =>
    ['chat.regenerate_unavailable', 'chat.regenerate_busy'].includes(code(error)),
  );
  release!();
  await until(fx.idle);
});

test('a work session regenerates in its own chat', async (t) => {
  const seen: string[] = [];
  const fx = fixture(t, (messages) => {
    seen.push(userText(messages).at(-1) || '');
    return answer('回答 ' + seen.length);
  });
  const session = { id: 'session-1', botId: fx.bot.id, name: '报表', createdAt: '', updatedAt: '' };
  fx.store.data.workSessions = [session];
  fx.queue.send({ botId: fx.bot.id, message: '主聊天' });
  fx.queue.send({ botId: fx.bot.id, sessionId: session.id, message: '会话里' });
  await until(fx.idle);
  const run = fx.store.data.messages.find((m) => m.content === '会话里')!.runId!;
  await assert.rejects(fx.regenerate(run), (error) => code(error) === 'chat.regenerate_unavailable');
  await fx.regenerate(run, session.id);
  await until(() => fx.idle() && seen.length === 3);
  assert.equal(seen[2].includes('会话里'), true);
  assert.ok(fx.store.data.messages.some((m) => m.content === '回答 1' || m.content === '回答 2'));
  assert.ok(fx.store.data.messages.some((m) => m.sessionId === session.id && m.content === '回答 3'));
});
