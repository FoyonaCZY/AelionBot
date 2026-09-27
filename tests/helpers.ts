// Shared test utilities: waiting and model completions.
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

/** A final model answer with no tool calls. */
export const answer = (content: string): Completion => ({ content, calls: [], finishReason: 'stop' });
