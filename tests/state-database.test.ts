import test from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './helpers';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StateDatabase } from '../electron/core/storage/state-database';

test('state rows are keyed by entity id so a middle insert or delete touches only its own row', (t) => {
  const dir = tempDir(t, 'aelion-state-db-');
  const db = new StateDatabase(dir),
    data: any = {
      version: 1,
      messages: Array.from({ length: 50 }, (_, i) => ({ id: 'm' + i, content: 'text ' + i })),
      runs: [{ content: 'no id' }, { content: 'no id either' }],
    };
  db.write(data);
  data.messages.splice(3, 1);
  assert.equal(db.write(data), 2);
  data.messages.splice(5, 0, { id: 'inserted', content: 'new' });
  assert.equal(db.write(data), 2);
  // Duplicate ids fall back to index keys instead of overwriting each other.
  data.messages.push({ id: 'm0', content: 'duplicate id' });
  db.write(data);
  db.close();
  const reopened = new StateDatabase(dir);
  assert.deepEqual(reopened.read(), data);
  reopened.close();
});

test('databases saved with index-keyed rows still load and are migrated on the next write', (t) => {
  const dir = tempDir(t, 'aelion-state-db-legacy-');
  const raw = new DatabaseSync(join(dir, 'state.sqlite'));
  raw.exec('CREATE TABLE parts(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const put = raw.prepare('INSERT INTO parts VALUES(?,?)');
  put.run(
    'layout',
    JSON.stringify({ root: { version: 1 }, arrays: { messages: 2 }, histories: { conversations: { b: 1 } } }),
  );
  put.run(JSON.stringify(['messages', 0]), JSON.stringify({ id: 'a', content: 'first' }));
  put.run(JSON.stringify(['messages', 1]), JSON.stringify({ id: 'b', content: 'second' }));
  put.run(JSON.stringify(['conversations', 'b', 0]), JSON.stringify({ role: 'user', content: 'hi' }));
  raw.close();
  const db = new StateDatabase(dir),
    data = db.read()!;
  assert.deepEqual(
    data.messages.map((m: any) => m.id),
    ['a', 'b'],
  );
  assert.equal(data.conversations.b[0].content, 'hi');
  db.write(data);
  db.close();
  const again = new StateDatabase(dir);
  assert.deepEqual(again.read(), data);
  again.close();
});
