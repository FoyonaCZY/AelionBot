// A consistent copy of a SQLite database that is in use. VACUUM INTO reads one snapshot of the database, WAL
// included, and writes a single file with no WAL. It runs in a worker: copying a few hundred megabytes on the main
// thread would freeze every window while it lasts.
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

const SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.source);
try {
  db.exec('PRAGMA busy_timeout=15000');
  db.prepare('VACUUM INTO ?').run(workerData.target);
} finally {
  db.close();
}
parentPort.postMessage('done');
`;

function inWorker(source: string, target: string) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(SCRIPT, { eval: true, workerData: { source, target } });
    let finished = false;
    worker.once('message', () => {
      finished = true;
      resolve();
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!finished) reject(new Error('数据库快照没有完成（' + code + '）'));
    });
  });
}

/** Writes a copy of the database at `source` to `target`, which must not exist. */
export async function snapshotSqlite(source: string, target: string) {
  try {
    await inWorker(source, target);
  } catch {
    // The worker could not do it. The same copy on this thread holds it up for a moment but is just as consistent;
    // a file SQLite cannot read fails here too, and the caller decides what to do with it.
    rmSync(target, { force: true });
    const db = new DatabaseSync(source);
    try {
      db.exec('PRAGMA busy_timeout=15000');
      db.prepare('VACUUM INTO ?').run(target);
    } finally {
      db.close();
    }
  }
}
