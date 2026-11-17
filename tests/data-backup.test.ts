import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../electron/core/storage/store';
import { archived, planBackup, topLevelKind } from '../electron/core/backup/backup-rules';
import { openSecrets, sealSecrets, type SecretCodec } from '../electron/core/backup/backup-secrets';
import {
  applyPendingRestore,
  lastRestore,
  previousCopies,
  readManifest,
  removePreviousCopy,
  stageRestore,
  writeBackup,
} from '../electron/core/backup/data-backup';
import { snapshotSqlite } from '../electron/core/backup/sqlite-snapshot';
import { tar, untar, type TarFile } from '../electron/core/backup/tar';
import { errorCode } from '../shared/errors';
import { tempDir } from './helpers';

/** A stand-in for the system key store: each computer can only read what it encrypted itself. */
const codec = (computer: string): SecretCodec => ({
  encrypt: (value) => computer + ':' + Buffer.from(value).toString('base64'),
  decrypt: (value) => {
    if (!value.startsWith(computer + ':')) throw new Error('not this computer');
    return Buffer.from(value.slice(computer.length + 1), 'base64').toString();
  },
});
const put = (path: string, content: string | Buffer) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const rejectsWith = (code: string) => (error: unknown) => errorCode(error) === code;

async function collect(source: AsyncIterable<Buffer>) {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(chunk);
  return Buffer.concat(parts);
}
const file = (path: string, content: Buffer, chunk = 1000): TarFile => ({
  path,
  size: content.length,
  mtime: 1_700_000_000,
  mode: 0o644,
  body: async function* () {
    for (let at = 0; at < content.length; at += chunk) yield content.subarray(at, at + chunk);
  },
});

test('a tar archive keeps names ustar cannot hold and lets a reader skip bodies', async () => {
  const long = 'attachments/' + '很长的文件夹名称'.repeat(12) + '/报告 final (2).pdf',
    big = Buffer.alloc(70_000, 7),
    files = [
      file('manifest.json', Buffer.from('{}')),
      file(long, Buffer.from('中文内容')),
      file('empty.bin', Buffer.alloc(0)),
      file('data/big.bin', big),
      file('last.txt', Buffer.from('end')),
    ];
  const archive = await collect(tar(files));
  assert.equal(archive.length % 512, 0);
  const seen: Record<string, Buffer | null> = {};
  // Chunks that never line up with the 512-byte blocks.
  const source = (async function* () {
    for (let at = 0; at < archive.length; at += 777) yield archive.subarray(at, at + 777);
  })();
  for await (const entry of untar(source)) {
    assert.equal(entry.type, 'file');
    assert.equal(entry.mtime, 1_700_000_000);
    // The big file's body is left unread: the reader must still find the next entry.
    seen[entry.path] = entry.path === 'data/big.bin' ? null : await collect(entry.body());
    if (entry.path === 'data/big.bin') assert.equal(entry.size, big.length);
  }
  assert.deepEqual(
    Object.keys(seen),
    files.map((item) => item.path),
  );
  assert.equal(seen[long]?.toString(), '中文内容');
  assert.equal(seen['empty.bin']?.length, 0);
  assert.equal(seen['last.txt']?.toString(), 'end');
});

test('a damaged tar archive is reported as an invalid backup', async () => {
  const archive = await collect(tar([file('a.txt', Buffer.from('hello'))]));
  archive[0] ^= 0xff;
  await assert.rejects(async () => {
    const source = (async function* () {
      yield archive;
    })();
    for await (const entry of untar(source)) void entry;
  }, rejectsWith('backup.invalid'));
});

test('only the app’s own data counts as backup content', () => {
  for (const name of ['state.sqlite', 'bots', 'attachments', 'connectors.json', 'a-file-added-later.json'])
    assert.equal(topLevelKind(name), 'data', name);
  for (const name of ['state.json', 'state.sqlite-wal', 'cognition.sqlite-shm', 'peer-message-migration-backup.json'])
    assert.equal(topLevelKind(name), 'derived', name);
  for (const name of [
    'vm',
    'models',
    'downloads',
    'Cache',
    'Local Storage',
    'Preferences',
    'blob_storage',
    'DIPS',
    'lockfile',
    '.updaterId',
    'diagnostic-events.jsonl.1',
    'restore-previous',
    'mine.aelionbackup',
  ])
    assert.equal(topLevelKind(name), 'local', name);
  assert.equal(archived('bots/x/skills/a/SKILL.md'), true);
  assert.equal(archived('games/matches.sqlite-wal'), false);
  assert.equal(archived('vm/system.qcow2'), false);
});

test('a database in use is copied as one consistent file', async (t) => {
  // Closed before the folder is removed: hooks run in the order they were added.
  let db: DatabaseSync | undefined;
  t.after(() => db?.close());
  const dir = tempDir(t),
    source = join(dir, 'live.sqlite');
  db = new DatabaseSync(source);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(text TEXT); INSERT INTO notes VALUES ('kept in the WAL')");
  await snapshotSqlite(source, join(dir, 'copy.sqlite'));
  assert.equal(existsSync(join(dir, 'copy.sqlite-wal')), false);
  const copy = new DatabaseSync(join(dir, 'copy.sqlite'));
  try {
    assert.deepEqual(
      copy
        .prepare('SELECT text FROM notes')
        .all()
        .map((row) => row.text),
      ['kept in the WAL'],
    );
  } finally {
    copy.close();
  }
});

test('secrets sealed with a password open only with that password', async () => {
  const sealed = await sealSecrets({ 'A:abc': 'sk-secret' }, 'correct horse');
  assert.equal(JSON.stringify(sealed).includes('sk-secret'), false);
  assert.deepEqual(await openSecrets(sealed, 'correct horse'), { 'A:abc': 'sk-secret' });
  await assert.rejects(openSecrets(sealed, 'wrong'), rejectsWith('backup.password_wrong'));
  await assert.rejects(openSecrets({ ...sealed, n: 2 ** 30 }, 'correct horse'), rejectsWith('backup.invalid'));
});

/** The old computer: an open store with a provider key, connector and sign-in secrets, attachments and local files. */
function oldComputer(t: test.TestContext) {
  // Closed before the folder is removed: hooks run in the order they were added.
  const open: Store[] = [];
  t.after(() => open.forEach((item) => item.close()));
  const root = tempDir(t),
    dataDir = join(root, 'data'),
    configDir = join(root, 'config'),
    a = codec('A');
  const store = new Store(dataDir, { incremental: true });
  open.push(store);
  store.data.providers = [
    {
      id: 'p1',
      name: 'Example',
      baseUrl: 'https://api.example.com/v1',
      models: [],
      encryptedKey: a.encrypt('sk-model'),
    },
  ];
  store.message(store.data.bots[0].id, 'user', '备份里应该有这条消息');
  store.flush();
  put(
    join(dataDir, 'connectors.json'),
    JSON.stringify({ version: 1, keepRunning: true, connectors: [{ id: 'c1', secret: a.encrypt('{"token":"im"}') }] }),
  );
  put(
    join(dataDir, 'mcp-auth.json'),
    JSON.stringify({ version: 1, servers: { 'https://mcp.example.com': a.encrypt('{"token":"mcp"}') }, clients: {} }),
  );
  put(
    join(dataDir, 'remote.json'),
    JSON.stringify({ version: 1, keys: { secret: a.encrypt('{"k":1}') }, devices: [{ id: 'd', key: 'k' }] }),
  );
  put(join(dataDir, 'attachments', 'a1', '季度 报告.pdf'), Buffer.alloc(300_000, 3));
  put(join(dataDir, 'bots', store.data.bots[0].id, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\n');
  put(join(dataDir, 'a-file-added-later.json'), '{"new":true}');
  // Stays with the computer.
  put(join(dataDir, 'vm', 'system.qcow2'), 'old vm');
  put(join(dataDir, 'models', 'bge', 'model.onnx'), 'model');
  put(join(dataDir, 'Cache', 'index'), 'chromium');
  put(join(dataDir, 'diagnostic-events.jsonl'), 'log');
  put(join(configDir, 'mcp.json'), '{"mcpServers":{"old":{}}}');
  return { root, dataDir, configDir, store, codec: a };
}
/** Another computer with data of its own. */
function newComputer(t: test.TestContext) {
  const root = tempDir(t),
    dataDir = join(root, 'data'),
    configDir = join(root, 'config');
  const store = new Store(dataDir, { incremental: true });
  store.message(store.data.bots[0].id, 'user', '这台电脑原来的消息');
  store.close();
  put(join(dataDir, 'vm', 'system.qcow2'), 'new vm');
  put(join(dataDir, 'Preferences'), 'chromium');
  put(join(dataDir, 'attachments', 'mine.txt'), 'mine');
  put(join(configDir, 'mcp.json'), '{"mcpServers":{"mine":{}}}');
  put(join(configDir, 'only-here.json'), '{}');
  return { root, dataDir, configDir, codec: codec('B') };
}
async function backup(t: test.TestContext, password?: string) {
  const old = oldComputer(t),
    target = join(old.root, 'backup.aelionbackup');
  let progress = 0;
  const written = await writeBackup({
    dataDir: old.dataDir,
    configDir: old.configDir,
    target,
    appVersion: '0.54.2',
    device: 'old-computer',
    password,
    codec: old.codec,
    onProgress: (done, total) => {
      assert.ok(done >= progress && done <= total);
      progress = done;
    },
  });
  assert.equal(progress, written.manifest.bytes);
  return { old, target, written };
}

test('a backup restores the data on another computer and keeps what it replaced', async (t) => {
  const { old, target, written } = await backup(t, 'pass-word');
  assert.equal(written.skipped, 0);
  assert.equal(existsSync(target + '.partial'), false);
  assert.equal(existsSync(join(old.dataDir, 'backup-temp')), false);
  // Nothing readable in the file gives a secret away.
  assert.equal(readFileSync(target).includes('sk-model'), false);
  const manifest = await readManifest(target);
  assert.equal(manifest.device, 'old-computer');
  assert.equal(manifest.secrets, true);

  const next = newComputer(t);
  const staged = await stageRestore({
    file: target,
    dataDir: next.dataDir,
    configDir: next.configDir,
    appVersion: '0.54.2',
    codec: next.codec,
    password: 'pass-word',
  });
  assert.equal(staged.unreadableSecrets, 0);
  // Staging changes nothing yet.
  assert.equal(readFileSync(join(next.dataDir, 'attachments', 'mine.txt'), 'utf8'), 'mine');

  const outcome = applyPendingRestore(next.dataDir, new Date('2026-11-17T10:00:00.000Z'));
  assert.equal(outcome?.ok, true);
  assert.equal(applyPendingRestore(next.dataDir), undefined);
  assert.equal(existsSync(join(next.dataDir, 'restore-staging')), false);

  const restored = new Store(next.dataDir, { incremental: true });
  try {
    assert.deepEqual(
      restored.data.bots.map((bot) => bot.id),
      old.store.data.bots.map((bot) => bot.id),
    );
    assert.ok(restored.data.messages.some((message) => message.content === '备份里应该有这条消息'));
    assert.equal(next.codec.decrypt(restored.data.providers![0].encryptedKey!), 'sk-model');
  } finally {
    restored.close();
  }
  const read = (name: string) => JSON.parse(readFileSync(join(next.dataDir, name), 'utf8'));
  assert.equal(next.codec.decrypt(read('connectors.json').connectors[0].secret), '{"token":"im"}');
  assert.equal(next.codec.decrypt(read('mcp-auth.json').servers['https://mcp.example.com']), '{"token":"mcp"}');
  assert.equal(next.codec.decrypt(read('remote.json').keys.secret), '{"k":1}');
  assert.equal(statSync(join(next.dataDir, 'attachments', 'a1', '季度 报告.pdf')).size, 300_000);
  assert.equal(readFileSync(join(next.dataDir, 'a-file-added-later.json'), 'utf8'), '{"new":true}');
  assert.equal(existsSync(join(next.dataDir, 'attachments', 'mine.txt')), false);
  // What stays with a computer is neither in the backup nor replaced.
  assert.equal(readFileSync(join(next.dataDir, 'vm', 'system.qcow2'), 'utf8'), 'new vm');
  assert.equal(readFileSync(join(next.dataDir, 'Preferences'), 'utf8'), 'chromium');
  assert.equal(existsSync(join(next.dataDir, 'models')), false);
  assert.equal(existsSync(join(next.dataDir, 'Cache')), false);
  // The configuration folder is replaced as a whole.
  assert.deepEqual(readdirSync(next.configDir), ['mcp.json']);
  assert.equal(readFileSync(join(next.configDir, 'mcp.json'), 'utf8'), '{"mcpServers":{"old":{}}}');

  const [copy] = previousCopies(next.dataDir);
  assert.equal(copy.createdAt, '2026-11-17T10:00:00.000Z');
  assert.equal(readFileSync(join(copy.path, 'data', 'attachments', 'mine.txt'), 'utf8'), 'mine');
  assert.equal(readFileSync(join(copy.path, 'config', 'only-here.json'), 'utf8'), '{}');
  assert.ok(existsSync(join(copy.path, 'data', 'state.sqlite')));
  assert.equal(lastRestore(next.dataDir)?.ok, true);
  await removePreviousCopy(next.dataDir, copy.id);
  assert.deepEqual(previousCopies(next.dataDir), []);
});

test('a backup with a password needs it, and can be restored without its secrets', async (t) => {
  const { target } = await backup(t, 'pass-word'),
    next = newComputer(t),
    base = { file: target, dataDir: next.dataDir, configDir: next.configDir, appVersion: '0.54.2', codec: next.codec };
  await assert.rejects(stageRestore(base), rejectsWith('backup.password_required'));
  await assert.rejects(stageRestore({ ...base, password: 'nope' }), rejectsWith('backup.password_wrong'));
  // A refused restore leaves nothing waiting for the next start.
  assert.equal(applyPendingRestore(next.dataDir), undefined);
  assert.equal(existsSync(join(next.dataDir, 'restore-staging')), false);
  const staged = await stageRestore({ ...base, skipSecrets: true });
  assert.equal(staged.unreadableSecrets, 4);
});

test('a backup without a password keeps its secrets usable on the computer that made it', async (t) => {
  const { old, target, written } = await backup(t);
  assert.equal(written.manifest.secrets, false);
  old.store.close();
  const staged = await stageRestore({
    file: target,
    dataDir: old.dataDir,
    configDir: old.configDir,
    appVersion: '0.54.2',
    codec: old.codec,
  });
  assert.equal(staged.unreadableSecrets, 0);
  assert.equal(applyPendingRestore(old.dataDir)?.ok, true);
  const restored = new Store(old.dataDir, { incremental: true });
  try {
    assert.equal(old.codec.decrypt(restored.data.providers![0].encryptedKey!), 'sk-model');
  } finally {
    restored.close();
  }
});

test('files that are not complete backups are refused', async (t) => {
  const { target } = await backup(t),
    next = newComputer(t),
    base = { dataDir: next.dataDir, appVersion: '0.54.2', codec: next.codec };
  await assert.rejects(stageRestore({ ...base, file: target, appVersion: '0.53.0' }), rejectsWith('backup.newer'));
  const other = join(next.root, 'not-a-backup.aelionbackup');
  writeFileSync(other, 'plain text');
  await assert.rejects(readManifest(other), rejectsWith('backup.invalid'));
  await assert.rejects(stageRestore({ ...base, file: other }), rejectsWith('backup.invalid'));
  truncateSync(target, Math.floor(statSync(target).size / 2));
  await assert.rejects(stageRestore({ ...base, file: target }), rejectsWith('backup.invalid'));
  assert.equal(applyPendingRestore(next.dataDir), undefined);
});

test('a restore that fails puts the data back', async (t) => {
  const { target } = await backup(t),
    next = newComputer(t);
  await stageRestore({
    file: target,
    dataDir: next.dataDir,
    configDir: next.configDir,
    appVersion: '0.54.2',
    codec: next.codec,
  });
  // The configuration folder cannot be created: its parent is a file.
  const marker = join(next.dataDir, 'restore-pending.json'),
    pending = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(join(next.root, 'blocked'), '');
  writeFileSync(marker, JSON.stringify({ ...pending, configDir: join(next.root, 'blocked', 'config') }));
  const outcome = applyPendingRestore(next.dataDir);
  assert.equal(outcome?.ok, false);
  assert.ok(outcome?.error);
  assert.equal(readFileSync(join(next.dataDir, 'attachments', 'mine.txt'), 'utf8'), 'mine');
  assert.equal(existsSync(join(next.dataDir, 'a-file-added-later.json')), false);
  assert.equal(existsSync(join(next.dataDir, 'restore-previous')), false);
  assert.equal(existsSync(marker), false);
  const kept = new Store(next.dataDir, { incremental: true });
  try {
    assert.ok(kept.data.messages.some((message) => message.content === '这台电脑原来的消息'));
  } finally {
    kept.close();
  }
  assert.equal(lastRestore(next.dataDir)?.ok, false);
});

test('a restore cut off halfway continues at the next start', async (t) => {
  const { target } = await backup(t),
    next = newComputer(t);
  await stageRestore({ file: target, dataDir: next.dataDir, appVersion: '0.54.2', codec: next.codec });
  // As if the app had stopped after moving part of the old data aside.
  const marker = join(next.dataDir, 'restore-pending.json'),
    pending = JSON.parse(readFileSync(marker, 'utf8')),
    previous = join(next.dataDir, 'restore-previous', 'earlier');
  mkdirSync(join(previous, 'data'), { recursive: true });
  renameSync(join(next.dataDir, 'attachments'), join(previous, 'data', 'attachments'));
  writeFileSync(marker, JSON.stringify({ ...pending, phase: 'out', previous: 'earlier', attempts: 1 }));
  assert.equal(applyPendingRestore(next.dataDir)?.ok, true);
  assert.ok(existsSync(join(next.dataDir, 'a-file-added-later.json')));
  assert.ok(existsSync(join(previous, 'data', 'state.sqlite')));
  assert.equal(readFileSync(join(previous, 'data', 'attachments', 'mine.txt'), 'utf8'), 'mine');
});

test('a backup lists what it will hold before it is written', async (t) => {
  const old = oldComputer(t),
    plan = await planBackup(old.dataDir, old.configDir),
    paths = plan.files.map((item) => item.path);
  assert.ok(paths.includes('data/state.sqlite'));
  assert.ok(paths.includes('config/mcp.json'));
  assert.ok(paths.includes('data/attachments/a1/季度 报告.pdf'));
  assert.equal(
    paths.some(
      (path) => /^data\/(vm|models|Cache|state\.json|diagnostic-events)/.test(path) || /-(wal|shm)$/.test(path),
    ),
    false,
  );
  assert.ok(plan.bytes > 300_000);
});
