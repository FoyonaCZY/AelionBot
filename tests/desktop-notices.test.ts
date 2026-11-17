import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopNotices, type DesktopNotice } from '../electron/core/app/desktop-notices';
import type { Store } from '../electron/core/storage/store';
import type { InteractionRequest } from '../shared/types/core';

type Data = Store['data'];

function setup(data: Partial<Data> = {}) {
  const store = {
    data: {
      bots: [{ id: 'bot', name: '小蓝' }],
      workSessions: [{ id: 'session', botId: 'bot', name: '报表' }],
      groups: [],
      runs: [],
      messages: [],
      scheduledTasks: [],
      ...data,
    } as unknown as Data,
  };
  const state = { requests: [] as InteractionRequest[], attentive: false, shown: [] as DesktopNotice[], now: 0 };
  const notices = new DesktopNotices({
    store,
    interactions: () => state.requests,
    attentive: () => state.attentive,
    groupName: (id) => (id === 'group' ? '项目组' : undefined),
    show: (notice) => state.shown.push(notice),
    now: () => state.now,
  });
  // What is there at the first look is not news.
  notices.check();
  return { store, state, notices };
}

const permission = (id: string, phase?: 'reviewing' | 'waiting'): InteractionRequest =>
  ({
    id,
    botId: 'bot',
    runId: 'run',
    createdAt: '2026-11-17T10:00:00.000Z',
    kind: 'host_permission',
    details: { operation: 'command', reason: '', command: 'pnpm install' },
    ...(phase ? { approval: { phase } } : {}),
  }) as InteractionRequest;

const run = (id: string, patch: Record<string, unknown> = {}) =>
  ({
    id,
    botId: 'bot',
    status: 'running',
    startedAt: '2026-11-17T10:00:00.000Z',
    modelCalls: 0,
    toolCalls: 0,
    ...patch,
  }) as Data['runs'][number];

test('a request waiting for the person is announced once, with the chat it belongs to', () => {
  const { store, state, notices } = setup();
  store.data.runs.push(run('run', { sessionId: 'session' }));
  state.requests = [permission('ask')];
  notices.check();
  assert.equal(state.shown.length, 1);
  assert.equal(state.shown[0].title, '小蓝 · 报表');
  assert.match(state.shown[0].body, /pnpm install/);
  assert.deepEqual(state.shown[0].target, { botId: 'bot', sessionId: 'session', groupId: undefined, requestId: 'ask' });
  notices.check();
  assert.equal(state.shown.length, 1);
});

test('a request the approval model is still reviewing is announced when it reaches the person', () => {
  const { state, notices } = setup();
  state.requests = [permission('ask', 'reviewing')];
  notices.check();
  assert.equal(state.shown.length, 0);
  state.requests = [permission('ask', 'waiting')];
  notices.check();
  assert.equal(state.shown.length, 1);
});

test('what happened while the window was in front is not announced later', () => {
  const { store, state, notices } = setup();
  state.attentive = true;
  store.data.runs.push(run('seen'), run('away'));
  state.requests = [permission('ask')];
  notices.check();
  store.data.runs[0] = run('seen', { status: 'completed' });
  notices.check();
  state.attentive = false;
  notices.check();
  assert.equal(state.shown.length, 0);
  // A task that ends after the person left is news.
  store.data.runs[1] = run('away', { status: 'completed' });
  notices.check();
  assert.equal(state.shown.length, 1);
});

test('a finished task is announced with the answer, unless content is hidden', () => {
  const { store, state, notices } = setup();
  store.data.runs.push(run('run'));
  notices.check();
  store.data.runs[0] = run('run', { status: 'completed' });
  store.data.messages.push({
    id: 'm',
    botId: 'bot',
    role: 'assistant',
    runId: 'run',
    content: '**报表**做好了',
    time: '',
  } as Data['messages'][number]);
  notices.check();
  assert.equal(state.shown.length, 1);
  assert.equal(state.shown[0].body, '报表做好了');
  assert.deepEqual(state.shown[0].target, { botId: 'bot', sessionId: undefined });

  store.data.desktopNotify = { requests: true, finished: true, automations: true, content: false };
  state.now = 60_000;
  store.data.runs.push(run('next'));
  notices.check();
  store.data.runs[1] = run('next', { status: 'failed' });
  notices.check();
  assert.equal(state.shown.length, 2);
  assert.doesNotMatch(state.shown[1].body, /报表/);
});

test('cancelled, retracted, group and peer runs are not announced', () => {
  const { store, state, notices } = setup();
  const ends = [
    { status: 'cancelled' },
    { status: 'completed', retracted: true },
    { status: 'completed', groupOrigin: { groupId: 'group' } },
    { status: 'completed', peerOrigin: { exchangeId: 'x' } },
  ];
  ends.forEach((_, index) => store.data.runs.push(run('run' + index)));
  notices.check();
  ends.forEach((patch, index) => (store.data.runs[index] = run('run' + index, patch)));
  notices.check();
  assert.equal(state.shown.length, 0);
});

test('the switches decide which events are announced', () => {
  const { store, state, notices } = setup({
    desktopNotify: { requests: false, finished: false, automations: true, content: true },
    scheduledTasks: [
      { target: { kind: 'bot', id: 'bot', sessionId: 'session' }, lastRun: { startedAt: '2026-11-17T10:00:05.000Z' } },
    ] as unknown as Data['scheduledTasks'],
  });
  store.data.runs.push(run('plain'), run('automation', { sessionId: 'session' }));
  state.requests = [permission('ask')];
  notices.check();
  store.data.runs[0] = run('plain', { status: 'completed' });
  store.data.runs[1] = run('automation', { sessionId: 'session', status: 'completed' });
  notices.check();
  assert.deepEqual(
    state.shown.map((notice) => notice.tag),
    ['chat-bot/session'],
  );
});

test('a notice from another service is not repeated right away', () => {
  const { state, notices } = setup();
  notices.announce({ title: 'a', body: 'b', tag: 'budget' });
  notices.announce({ title: 'a', body: 'b', tag: 'budget' });
  state.now = 11_000;
  notices.announce({ title: 'a', body: 'b', tag: 'budget' });
  assert.equal(state.shown.length, 2);
});
