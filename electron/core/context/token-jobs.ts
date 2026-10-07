import type { WireMessage } from '../../../shared/types/core';
import { serializeForSummary, sourceHash, textTokens } from './context-budget';

/** Token work that can run on another thread (see token-counter.ts). */
export type TokenJob =
  | { kind: 'count'; texts: string[] }
  | { kind: 'summary'; history: WireMessage[]; maxTokens: number }
  | { kind: 'hash'; history: WireMessage[] };

export function runTokenJob(job: TokenJob) {
  if (job.kind === 'count') return job.texts.map(textTokens);
  if (job.kind === 'hash') return sourceHash(job.history);
  return serializeForSummary(job.history, job.maxTokens);
}
