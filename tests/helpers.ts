// Shared test utilities: waiting, temporary directories and model completions.
import type test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Completion } from '../electron/core/model/model';

/** Resolves after `ms` milliseconds. Use it to simulate latency inside fakes, not to wait for results. */
export const delay = (ms: number): Promise<void> => sleep(ms);

/**
 * Gives asynchronous work a chance to (not) happen before a negative assertion
 * ("nothing was called", "the state did not change"). Positive expectations use `until` instead.
 */
export const settle = (ms = 150): Promise<void> => sleep(ms);

/**
 * Polls `predicate` until it returns true. Rejects with `message` (a string or a function evaluated
 * at timeout, for diagnostics) once `timeoutMs` has passed.
 */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 10_000, intervalMs = 10, message = 'Timed out waiting for condition' as string | (() => string) } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(typeof message === 'function' ? message() : message);
    await sleep(intervalMs);
  }
}

/**
 * Creates a temporary directory under the real (symlink-resolved) system temp folder and removes it
 * after the test. Cleanup runs in registration order, so fixtures that must close handles inside the
 * directory before it is removed should keep their own cleanup.
 */
export function tempDir(t: test.TestContext, prefix = 'aelion-test-'): string {
  const parent = realpathSync.native(tmpdir()),
    dir = mkdtempSync(join(parent, prefix));
  t.after(() => {
    // Never remove anything outside the temp folder, whatever the test did with the path.
    if (dirname(dir) !== parent) throw new Error(`Refusing to remove ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** A final model answer with no tool calls. */
export const answer = (content: string): Completion => ({ content, calls: [], finishReason: 'stop' });
