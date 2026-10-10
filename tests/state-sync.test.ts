import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, RunRecord, Snapshot } from '../shared/types/core';
import {
  applyEntityDelta,
  applyStateDelta,
  diffEntities,
  emptyBaseline,
  share,
  type StateDelta,
} from '../shared/state-sync';
import { StateSync } from '../electron/core/app/state-sync';
import { shallowEqual, sameItems } from '../src/ui/equality';
import { toolDiff } from '../shared/chat/tool-diff';

const message = (id: string, content = id, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id,
    botId: 'b',
    role: 'assistant',
    content,
    time: '2026-10-07T10:00:00Z',
    status: 'done',
    ...extra,
  }) as ChatMessage;
const run = (id: string, status: RunRecord['status'] = 'completed'): RunRecord => ({
  id,
  botId: 'b',
  status,
  startedAt: '2026-10-07T10:00:00Z',
  modelCalls: 0,
  toolCalls: 0,
});
const snapshot = (messages: ChatMessage[], runs: RunRecord[] = [], extra: Partial<Snapshot> = {}) =>
  ({ bots: [{ id: 'b', name: 'B' }], messages, runs, vm: { status: 'stopped' }, ...extra }) as unknown as Snapshot;

test('an unchanged collection produces no delta; replaced, new and removed entries do', () => {
  const list = [message('a'), message('b'), message('c')];
  const first = diffEntities(emptyBaseline(), list);
  assert.equal(first.delta?.upsert.length, 3);
  assert.equal(diffEntities(first.baseline, list).delta, undefined);
  const next = [list[0], { ...list[1], content: 'edited' }, message('d')];
  const { delta } = diffEntities(first.baseline, next);
  assert.deepEqual(
    delta?.upsert.map((entry) => entry.id),
    ['b', 'd'],
  );
  assert.deepEqual(delta?.remove, ['c']);
  assert.equal(delta?.order, undefined);
});

test('live entries are sent while they run and once after; edited ones when reported', () => {
  const running = message('a', 'partial', { status: 'running' });
  const settled = message('b');
  let state = diffEntities(emptyBaseline(), [running, settled]);
  state = diffEntities(state.baseline, [running, settled]);
  assert.deepEqual(
    state.delta?.upsert.map((entry) => entry.id),
    ['a'],
  );
  running.status = 'done';
  state = diffEntities(state.baseline, [running, settled]);
  assert.deepEqual(
    state.delta?.upsert.map((entry) => entry.id),
    ['a'],
    'sent once more after it finished',
  );
  assert.equal(diffEntities(state.baseline, [running, settled]).delta, undefined);
  settled.content = 'edited in place';
  const edited = diffEntities(state.baseline, [running, settled], new WeakSet([settled]));
  assert.deepEqual(
    edited.delta?.upsert.map((entry) => entry.id),
    ['b'],
  );
});

test('a reordering or a duplicated id is described in full', () => {
  const [a, b, c] = [message('a'), message('b'), message('c')];
  const base = diffEntities(emptyBaseline(), [a, b, c]).baseline;
  assert.deepEqual(diffEntities(base, [c, a, b]).delta?.order, ['c', 'a', 'b']);
  // A new entry inserted before kept ones cannot be appended.
  assert.deepEqual(diffEntities(base, [message('z'), a, b, c]).delta?.order, ['z', 'a', 'b', 'c']);
  assert.equal(diffEntities(base, [a, b, c, a]).delta?.replace?.length, 4);
});

test('applying a delta keeps every unchanged entry and the list itself when nothing changed', () => {
  const list = [message('a'), message('b'), message('c')];
  const kept = applyEntityDelta(list, { upsert: [structuredClone(list[1])], remove: [] });
  assert.equal(kept, list, 'an equal copy of an entry changes nothing');
  const next = applyEntityDelta(list, { upsert: [{ ...list[1], content: 'new' }, message('d')], remove: ['a'] });
  assert.deepEqual(
    next.map((entry) => entry.id),
    ['b', 'c', 'd'],
  );
  assert.equal(next[1], list[2]);
  assert.equal(next[0].content, 'new');
  const reordered = applyEntityDelta(list, { upsert: [], remove: [], order: ['c', 'b', 'a'] });
  assert.deepEqual(reordered, [list[2], list[1], list[0]]);
});

test('share keeps deep-equal parts of a fresh copy, matching id-keyed arrays by id', () => {
  const previous = { bots: [{ id: 'a', palette: { color: 'red' } }, { id: 'b' }], vm: { status: 'ready' } };
  const same = share(previous, structuredClone(previous));
  assert.equal(same, previous);
  const changed = share(previous, { ...structuredClone(previous), vm: { status: 'stopped' } });
  assert.notEqual(changed, previous);
  assert.equal(changed.bots, previous.bots);
  const inserted = share(previous.bots, [{ id: 'new' }, ...structuredClone(previous.bots)]);
  assert.equal(inserted[1], previous.bots[0]);
  assert.equal(inserted[2], previous.bots[1]);
});

test('the main process sends only what changed and the renderer arrives at the same state', () => {
  const messages = [message('a'), message('b', 'thinking', { status: 'running' })],
    runs = [run('r', 'running')];
  let extra: Partial<Snapshot> = { vm: { status: 'stopped' } as Snapshot['vm'] };
  const sync = new StateSync(
    () => snapshot(messages, runs, extra),
    () => [],
  );
  const base = sync.base();
  let renderer = structuredClone(base.snapshot);
  const apply = () => {
    const delta = sync.delta();
    if (!delta) return undefined;
    const received = structuredClone(delta) as StateDelta;
    assert.equal(received.from, base.seq + applied++);
    renderer = applyStateDelta(renderer, received);
    return received;
  };
  let applied = 0;
  const before = renderer;
  // Live entries are resent, but equal copies keep the renderer's objects.
  apply();
  assert.equal(renderer.messages, before.messages);
  assert.equal(renderer.bots, before.bots);
  messages[1].content = 'answer';
  messages[1].status = 'done';
  runs[0].status = 'completed';
  messages.push(message('c'));
  extra = { vm: { status: 'ready' } as Snapshot['vm'] };
  const delta = apply()!;
  assert.deepEqual(Object.keys(delta.fields), ['vm']);
  assert.deepEqual(
    delta.messages?.upsert.map((entry) => entry.id),
    ['b', 'c'],
  );
  assert.equal(renderer.messages[0], before.messages[0], 'an untouched message keeps its identity');
  assert.equal(renderer.bots, before.bots);
  assert.deepEqual(renderer, snapshot(messages, runs, extra));
  assert.equal(sync.delta(), undefined, 'nothing left to send');
});

test('an entry edited in place reaches the renderer once it is marked', () => {
  const messages = [message('a')];
  const sync = new StateSync(
    () => snapshot(messages),
    () => [],
  );
  sync.base();
  messages[0].content = 'edited in place';
  assert.equal(sync.delta(), undefined, 'the same object is taken as unchanged');
  assert.equal(sync.markEdited([messages[0]]), 1);
  assert.equal(sync.delta()?.messages?.upsert[0].content, 'edited in place');
});

test('live replies are sent when they change, also after being sent on their own', () => {
  let streams = [{ id: 's', botId: 'b', content: 'a', time: 't' }];
  const sync = new StateSync(
    () => snapshot([]),
    () => streams as never,
  );
  sync.base();
  assert.equal(sync.delta(), undefined);
  streams = [{ ...streams[0], content: 'ab' }];
  sync.sentStreams(streams as never);
  assert.equal(sync.delta(), undefined, 'already sent');
  streams = [];
  assert.deepEqual(sync.delta()?.streams, []);
});

test('shallow equality accepts display copies and notices any changed part', () => {
  const base = message('m', '{}', { role: 'tool' });
  const diff = toolDiff('file_patch', { path: 'a', oldText: 'a', newText: 'b' })!;
  assert.equal(shallowEqual(base, { ...base }), true);
  assert.equal(shallowEqual(base, { ...base, diff }), false);
  assert.equal(shallowEqual({ ...base, diff }, { ...base, diff }), true);
  assert.equal(shallowEqual(base, { ...base, content: '{"x":1}' }), false);
  assert.equal(sameItems([base], [base]), true);
  assert.equal(sameItems([base], [{ ...base }]), false);
});
