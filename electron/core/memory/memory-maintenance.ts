import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

// Runs on its own thread, before the main process opens the database. Rebuilding is the only way to give back space
// left by rows deleted long ago, and to turn on incremental reclaiming afterwards; on a long profile it takes seconds.
const COMPACT = `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
const db = new DatabaseSync(workerData.path);
try {
  db.exec('PRAGMA busy_timeout=30000');
  db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const done = db.prepare("SELECT value FROM meta WHERE key='db-compacted'").get();
  if (done) parentPort.postMessage({ skipped: true });
  else {
    const size = (name) => Number(Object.values(db.prepare('PRAGMA ' + name).get())[0]);
    const before = size('page_count') * size('page_size');
    db.exec('PRAGMA journal_mode=DELETE');
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    db.exec('VACUUM');
    db.exec('PRAGMA journal_mode=WAL');
    db.prepare("INSERT INTO meta VALUES('db-compacted','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    parentPort.postMessage({ before, after: size('page_count') * size('page_size') });
  }
} finally {
  db.close();
}`;
/** Compacts the database once. A failure only leaves it as large as it was. */
export function compactOnce(path: string) {
  if (!existsSync(path)) return Promise.resolve(undefined);
  return new Promise<{ before?: number; after?: number; skipped?: boolean; error?: string }>((resolve) => {
    const worker = new Worker(COMPACT, { eval: true, workerData: { path } });
    worker.once('message', resolve);
    worker.once('error', (error: Error) => resolve({ error: error.message }));
    worker.once('exit', () => resolve({ skipped: true }));
  });
}
