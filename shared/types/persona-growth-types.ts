import type { Trait, Traits } from '../persona/persona-model';
import type { GameRole } from './game-types';

/** Accepted behavior with the information actually available then. Model self-explanations are excluded. */
export interface GrowthObservation {
  id: string;
  botId: string;
  matchId: string;
  createdAt: number;
  role: GameRole;
  kind: string;
  day: number;
  /** The accepted action alone: evidence must quote this, not somebody else's contextual speech. */
  behavior: string;
  text: string;
}
export interface GrowthEvidence {
  observationId: string;
  quote: string;
}
export interface GrowthTraitAssessment {
  attribution: 'trait' | 'skill' | 'relationship' | 'temporary' | 'uncertain' | 'stable';
  direction: -1 | 0 | 1;
  reason: string;
  evidence: GrowthEvidence[];
  counterEvidence: GrowthEvidence[];
}
export interface GrowthAssessment {
  version: 1;
  summary: string;
  traits: Record<Trait, GrowthTraitAssessment>;
}
export interface GrowthModelInfo {
  model: string;
  protocol?: string;
  reasoningEffort?: string;
}
export interface GrowthReviewRecord {
  id: string;
  botId: string;
  policyVersion: string;
  triggerMatchId: string;
  batchId: string;
  createdAt: number;
  completedAt?: number;
  status: 'running' | 'applied' | 'unchanged' | 'rejected' | 'failed' | 'stale' | 'reverted';
  summary: string;
  observations: GrowthObservation[];
  before: Traits;
  after: Traits;
  delta: Traits;
  anchor: Traits;
  nBefore: number;
  profileEpoch: number;
  assessment?: GrowthAssessment;
  model?: GrowthModelInfo;
  prompt?: { system: string; user: string };
  output?: string;
  /** Reversals are new immutable records, never mutations of an already exported assessment. */
  reverts?: string;
}
export interface GrowthReviewState {
  running: boolean;
  eligibleObservations: number;
  eligibleMatches: number;
  minObservations: number;
  minMatches: number;
  nextEligibleAt?: number;
  reason?: string;
  latest?: GrowthReviewRecord;
  recent: GrowthReviewRecord[];
  canUndoReviewId?: string;
}
