// Counts tokens for the main process on a thread of its own (see token-counter.ts). It keeps its own count cache, so
// texts counted for one request are not counted again for the next.
import { parentPort } from 'node:worker_threads';
import { runTokenJob, type TokenJob } from './token-jobs';

parentPort?.on('message', ({ id, job }: { id: number; job: TokenJob }) => {
  try {
    parentPort!.postMessage({ id, ok: true, result: runTokenJob(job) });
  } catch (error) {
    parentPort!.postMessage({ id, ok: false, error: (error as Error)?.message || String(error) });
  }
});
