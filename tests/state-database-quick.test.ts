import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { Store } from '../electron/core/storage/store';
import { StateDatabase } from '../electron/core/storage/state-database';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = (db: StateDatabase) => new Map((db as any).cached as Map<string, string>);
function initial(): any {
  return {
    version: 1,
    language: 'zh',
    messages: Array.from({ length: 120 }, (_, i) => ({ id: 'm' + i, content: 'text ' + i, status: 'done' })),
    runs: [{ content: 'no id' }, { content: 'no id either' }],
    modelUsage: Array.from({ length: 90 }, (_, i) => ({ at: i, tokens: i * 10 })),
    bots: [{ id: 'b1', name: 'one' }],
    conversations: {
      a: Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: 'a' + i })),
      b: [{ role: 'user', content: 'b0' }],
    },
  };
}

test('quick writes store exactly the rows a full write stores, whatever the change', (t) => {
  const db = new StateDatabase(tempDir(t, 'aelion-quick-')),
    reference = new StateDatabase(tempDir(t, 'aelion-quick-ref-')),
    data = initial();
  try {
    db.write(data, 'quick');
    runChanges(db, reference, data);
  } finally {
    db.close();
    reference.close();
  }
});

function runChanges(db: StateDatabase, reference: StateDatabase, data: any) {
  let n = 0;
  const changes: Array<[string, () => void]> = [
    ['append', () => data.messages.push({ id: 'new' + n, content: 'appended', status: 'running' })],
    ['edit the newest row in place', () => (data.messages.at(-1).content += ' streamed')],
    [
      'edit a running row far from the end',
      () => ((data.messages[5].status = 'running'), (data.messages[5].content = 'live')),
    ],
    ['finish it', () => (data.messages[5].status = 'done')],
    ['remove from the middle', () => data.messages.splice(40, 3)],
    ['insert in the middle', () => data.messages.splice(20, 0, { id: 'inserted' + n, content: 'x' })],
    ['replace the array', () => (data.messages = data.messages.filter((m: any) => m.id !== 'm7'))],
    ['prepend', () => data.messages.unshift({ id: 'first' + n, content: 'first' })],
    ['reverse', () => data.messages.reverse()],
    ['duplicate id', () => data.messages.push({ id: 'm1', content: 'duplicate' })],
    ['replace an old row with a new object', () => (data.messages[10] = { ...data.messages[10], content: 'copy' })],
    ['drop the oldest usage rows', () => data.modelUsage.splice(0, 5)],
    ['usage append', () => data.modelUsage.push({ at: 1000 + n, tokens: 1 })],
    ['small collection edited in place', () => (data.bots[0].name = 'renamed ' + n)],
    ['index-keyed rows', () => data.runs.unshift({ content: 'no id ' + n })],
    ['history append', () => data.conversations.a.push({ role: 'assistant', content: 'reply ' + n })],
    ['history tail edit', () => (data.conversations.a.at(-1).content += '!')],
    ['history truncate', () => data.conversations.a.splice(10)],
    ['history replace', () => (data.conversations.a = [{ role: 'user', content: 'fresh ' + n }])],
    [
      'history scope removed and added',
      () => (delete data.conversations.b, (data.conversations['c' + n] = [{ role: 'user', content: 'c' }])),
    ],
    ['root field', () => (data.language = n % 2 ? 'en' : 'zh')],
    ['collection removed', () => delete data.runs],
    ['collection back', () => (data.runs = [{ content: 'back' }])],
  ];
  for (let round = 0; round < 3; round++)
    for (const [name, change] of changes) {
      n++;
      change();
      db.write(data, 'quick');
      reference.write(structuredClone(data), 'full');
      assert.deepEqual(rows(db), rows(reference), `rows differ after: ${name} (round ${round})`);
    }
}

test('a sweep finds an old row edited in place, and the next quick write stores it', async (t) => {
  const dir = tempDir(t, 'aelion-quick-sweep-'),
    db = new StateDatabase(dir),
    data = initial();
  let stale = 0;
  try {
    await sweepFindsEdit(
      db,
      data,
      () => stale,
      (s) => (db.onStale = s),
    );
  } finally {
    db.close();
  }
  const reopened = new StateDatabase(dir);
  assert.equal(reopened.read()!.messages[3].content, 'edited in place');
  reopened.close();
});

async function sweepFindsEdit(db: StateDatabase, data: any, stale: () => number, listen: (f: () => void) => void) {
  let count = 0;
  listen(() => count++);
  db.write(data, 'quick');
  db.write(data, 'quick');
  data.messages[3].content = 'edited in place';
  db.write(data, 'quick');
  assert.notEqual(rows(db).get('["messages","id","m3"]'), JSON.stringify(data.messages[3]), 'quick write skips it');
  await wait(2600);
  assert.equal(count, 1, 'the sweep reports it');
  db.write(data, 'quick');
  assert.equal(rows(db).get('["messages","id","m3"]'), JSON.stringify(data.messages[3]));
  void stale;
}

test('a deferred store writes an old message edited in place after the sweep finds it', async (t) => {
  const dir = tempDir(t, 'aelion-quick-store-'),
    // The edit below deliberately skips store.touch(): the sweep is the safety net for one that does.
    store = new Store(dir, { incremental: true, deferWrites: true, checkEdits: false });
  let old: any;
  try {
    const bot = store.data.bots[0];
    for (let i = 0; i < 80; i++) store.message(bot.id, 'user', 'message ' + i);
    await wait(400);
    old = store.data.messages[2];
    old.content = 'edited without its own save';
    store.message(bot.id, 'user', 'another change');
    await wait(3200);
    const database = new StateDatabase(dir);
    assert.equal(database.read()!.messages.find((m: any) => m.id === old.id).content, 'edited without its own save');
    database.close();
  } finally {
    store.close();
  }
});
