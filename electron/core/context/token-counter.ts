import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WireMessage } from '../../../shared/types/core';
import { rememberTokenCounts, uncountedTexts, type serializeForSummary } from './context-budget';
import { runTokenJob, type TokenJob } from './token-jobs';

// Counting tokens is slow (the tokenizer is plain JavaScript, ~10 µs a character) and a long conversation is
// megabytes of text: counted on the main process's thread, which also routes input to the window, it froze the app
// for tens of seconds. In the app the counting runs on a worker thread; elsewhere (tests, the CLI), and if the worker
// fails, it runs in place.
let file: string | undefined,
  worker: Worker | undefined,
  next = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

/** Uses the built token worker in `dir` (the app's dist-electron), when it is there. */
export function enableTokenWorker(dir: string) {
  const candidate = join(dir, 'token-worker.cjs');
  file = existsSync(candidate) ? candidate : undefined;
}

function start(path: string) {
  const created = new Worker(path, { execArgv: [] });
  created.unref();
  created.on('message', ({ id, ok, result, error }: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const job = pending.get(id);
    pending.delete(id);
    if (ok) job?.resolve(result);
    else job?.reject(new Error(error));
  });
  const fail = (error: Error) => {
    if (worker === created) worker = undefined;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };
  created.on('error', fail);
  created.on('exit', () => fail(new Error('token worker stopped')));
  return created;
}

async function run<T>(job: TokenJob): Promise<T> {
  if (!file) return runTokenJob(job) as T;
  worker ??= start(file);
  const id = next++,
    active = worker;
  try {
    return await new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      active.postMessage({ id, job });
    });
  } catch {
    return runTokenJob(job) as T;
  }
}

/**
 * Counts what estimating `messages` (and `texts`) would count off this thread, where it has no count yet, so the
 * estimate afterwards is a lookup.
 */
export async function primeTokenCounts(messages: WireMessage[], texts: string[] = []) {
  if (!file) return;
  const missing = uncountedTexts(messages, texts);
  if (missing.length)
    rememberTokenCounts(missing, await run<number[]>({ kind: 'count', texts: missing.map((entry) => entry.text) }));
}

/** sourceHash, off this thread: it serializes the whole span, screenshots included. */
export const historyHash = (history: WireMessage[]) => run<string>({ kind: 'hash', history });

/** serializeForSummary, off this thread. Images travel as their ids, the only part the summary input keeps. */
export function summaryInput(history: WireMessage[], maxTokens: number) {
  const slim = history.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.images?.length ? { images: message.images.map((image) => ({ id: image.id })) } : {}),
  })) as WireMessage[];
  return run<ReturnType<typeof serializeForSummary>>({ kind: 'summary', history: slim, maxTokens });
}
