import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../electron/core/storage/store';
import { StateDatabase } from '../electron/core/storage/state-database';

/** A temp directory removed after the test, once `closers` have released its SQLite files (Windows locks them). */
function temp(t: test.TestContext, closers: Array<() => void> = []) {
  const dir = mkdtempSync(join(tmpdir(), 'aelion-deferred-'));
  t.after(() => {
    for (const close of closers) close();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('deferred saves coalesce a burst into one write and still land shortly after', async (t) => {
  const closers: Array<() => void> = [],
    dir = temp(t, closers),
    store = new Store(dir, { incremental: true, deferWrites: true });
  closers.push(() => store.close());
  const database = (store as any).database as StateDatabase,
    write = database.write.bind(database);
  let writes = 0;
  database.write = (data) => {
    writes++;
    return write(data);
  };
  const bot = store.data.bots[0];
  for (let i = 0; i < 20; i++) store.message(bot.id, 'user', `burst ${i}`);
  assert.equal(writes, 0, 'a burst of saves writes nothing synchronously');
  await wait(400);
  assert.equal(writes, 1, 'the burst is written once');
  const reopened = new StateDatabase(dir);
  assert.equal(reopened.read()?.messages.at(-1).content, 'burst 19');
  reopened.close();
});

test('a steady stream of saves is still written within the maximum wait', async (t) => {
  const closers: Array<() => void> = [],
    dir = temp(t, closers),
    store = new Store(dir, { incremental: true, deferWrites: true });
  closers.push(() => store.close());
  const database = (store as any).database as StateDatabase,
    write = database.write.bind(database);
  let writes = 0;
  database.write = (data) => {
    writes++;
    return write(data);
  };
  const bot = store.data.bots[0],
    started = Date.now();
  // Saves every 100 ms never leave the 250 ms quiet gap, so only the maximum wait can trigger the write.
  while (Date.now() - started < 1900 && !writes) {
    store.message(bot.id, 'user', 'tick');
    await wait(100);
  }
  assert.ok(writes >= 1, 'written despite continuous changes');
  assert.ok(Date.now() - started < 1900);
});

test('close writes pending changes, and replaceData still writes before returning', (t) => {
  const dir = temp(t),
    store = new Store(dir, { incremental: true, deferWrites: true }),
    bot = store.data.bots[0];
  store.message(bot.id, 'user', 'pending at close');
  store.close();
  const restored = new Store(dir, { incremental: true, deferWrites: true });
  assert.equal(restored.data.messages.at(-1)?.content, 'pending at close');
  restored.replaceData({ ...restored.data, userProfile: { displayName: 'Wendy', role: '', background: '' } });
  const database = new StateDatabase(dir);
  assert.equal(database.read()?.userProfile.displayName, 'Wendy');
  database.close();
  restored.close();
});
