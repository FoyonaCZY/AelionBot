import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tempDir } from './helpers';
import { Store } from '../electron/core/storage/store';
import { forkConversation } from '../electron/core/agent/fork-session';
import type { RunRecord } from '../shared/types/core';

/** A task in a chat as the harness leaves it: the input, the answer, the run and their model history. */
function task(store: Store, botId: string, input: string, status: RunRecord['status'], sessionId?: string) {
  const run: RunRecord = {
    id: randomUUID(),
    botId,
    status,
    startedAt: new Date().toISOString(),
    modelCalls: 1,
    toolCalls: 0,
    ...(sessionId ? { sessionId } : {}),
  };
  store.data.runs.push(run);
  const scope = sessionId ? { sessionId } : {};
  store.message(botId, 'user', input, { runId: run.id, inputState: 'handled', ...scope });
  store.message(botId, 'assistant', '答：' + input, { runId: run.id, status: 'done', ...scope });
  const history = (store.data.conversations[sessionId ? Store.sessionHistoryKey(sessionId) : botId] ||= []);
  history.push({ role: 'user', content: input }, { role: 'assistant', content: '答：' + input });
  return run;
}

test('a fork takes the chat up to its last completed task, with its folder and permission mode', (t) => {
  const store = new Store(tempDir(t, 'aelion-fork-')),
    bot = store.data.bots[0];
  task(store, bot.id, '整理需求', 'completed');
  const done = task(store, bot.id, '写第一版', 'completed');
  task(store, bot.id, '改成英文', 'failed');
  task(store, bot.id, '再加一节', 'running');
  store.data.conversationWorkspaces = { [`bot:${bot.id}`]: 'C:\\work\\project' };
  const session = forkConversation(store, { botId: bot.id }, () => 'full');

  assert.equal(session.name, `${bot.name} (fork)`);
  const copied = store.data.messages.filter((m) => m.sessionId === session.id);
  assert.deepEqual(
    copied.map((m) => m.content),
    ['整理需求', '答：整理需求', '写第一版', '答：写第一版'],
  );
  const runs = store.data.runs.filter((r) => r.sessionId === session.id);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === 'completed' && r.id !== done.id));
  assert.ok(
    copied.every((m) => runs.some((r) => r.id === m.runId)),
    'messages point at the copied runs',
  );
  assert.deepEqual(
    store.data.conversations[Store.sessionHistoryKey(session.id)].map((m) => m.content),
    ['整理需求', '答：整理需求', '写第一版', '答：写第一版'],
    'the model history stops where the copied records stop',
  );
  assert.equal(store.data.conversationWorkspaces?.[`session:${session.id}`], 'C:\\work\\project');
  assert.equal(store.data.hostPermissionModes?.[`session:${session.id}`], 'full');
  // The source is left as it was.
  assert.equal(store.data.messages.filter((m) => m.botId === bot.id && !m.sessionId).length, 8);
});

test('a work session forks the same way, and a chat with no completed task has nothing to fork', (t) => {
  const store = new Store(tempDir(t, 'aelion-fork-')),
    bot = store.data.bots[0];
  const now = new Date().toISOString();
  const source = { id: randomUUID(), botId: bot.id, name: '周报', createdAt: now, updatedAt: now };
  store.data.workSessions = [source];
  assert.throws(() => forkConversation(store, { botId: bot.id, sessionId: source.id }, () => 'ask'), {
    code: 'session.fork_empty',
  });
  task(store, bot.id, '汇总数据', 'completed', source.id);
  const session = forkConversation(store, { botId: bot.id, sessionId: source.id }, () => 'ask');
  assert.equal(session.name, '周报 (fork)');
  assert.deepEqual(
    store.data.messages.filter((m) => m.sessionId === session.id).map((m) => m.content),
    ['汇总数据', '答：汇总数据'],
  );
  assert.equal(store.data.hostPermissionModes?.[`session:${session.id}`], 'ask');
  assert.throws(() => forkConversation(store, { botId: bot.id, sessionId: randomUUID() }, () => 'ask'), {
    code: 'session.not_found',
  });
});
