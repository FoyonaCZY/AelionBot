// Long-term memory as both processes see it. See docs/design/Memory-System-20261103.md.

/** `user` (about the person, shared by Bots), `bot:<id>`, `project:<key>` or `group:<id>`. */
type MemoryScope = string;
export const MEMORY_KINDS = [
  'preference',
  'profile',
  'environment',
  'project',
  'decision',
  'lesson',
  'event',
  'commitment',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
/** How the app knows it, decided from the evidence in code rather than by the model. */
export type MemoryOrigin = 'user_explicit' | 'user_stated' | 'tool_verified' | 'model_inferred';
export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'archived' | 'deleted';
export type MemorySensitivity = 'normal' | 'private';

export interface MemorySource {
  messageId?: string;
  episodeId?: string;
  role?: string;
  tool?: string;
  botId?: string;
  at?: string;
}
export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  text: string;
  /** Search hints written when it was saved: synonyms, translations. Only indexed, never shown to a model. */
  cues: string[];
  entities: string[];
  origin: MemoryOrigin;
  confidence: number;
  sensitivity: MemorySensitivity;
  status: MemoryStatus;
  pinned: boolean;
  /** When it holds in the world, as opposed to when it was recorded. */
  validFrom?: string;
  validUntil?: string;
  verifiedAt?: string;
  recordedAt: string;
  updatedAt: string;
  supersedes?: string;
  supersededBy?: string;
  /** Independent runs that stated it again. */
  confirmations: number;
  recallCount: number;
  lastRecalledAt?: string;
  /** The Bot whose conversation it came from. */
  authorBot?: string;
  /** Who said it when that was not the owner, e.g. another person in a connector chat. */
  speaker?: string;
  /** Why it waits for confirmation instead of being used. */
  note?: string;
  sources: MemorySource[];
}
export interface MemoryEpisode {
  id: string;
  botId: string;
  scope: MemoryScope;
  conversation: string;
  title: string;
  summary: string;
  outcome: 'done' | 'partial' | 'failed' | 'chat';
  pending: string[];
  entities: string[];
  origin: 'capture' | 'compaction' | 'schedule';
  startedAt: string;
  endedAt: string;
  firstMessage?: string;
  lastMessage?: string;
}
export interface MemoryEvent {
  id: string;
  itemId: string;
  action: string;
  before?: Partial<MemoryItem>;
  after?: Partial<MemoryItem>;
  actor: 'user' | 'bot' | 'capture' | 'consolidate' | 'system';
  runId?: string;
  jobId?: string;
  at: string;
}
export type MemoryJobKind = 'capture' | 'consolidate' | 'skill_review';
export interface MemoryJob {
  id: string;
  kind: MemoryJobKind;
  target: string;
  label?: string;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'undone';
  detail?: string;
  changes: number;
  inputTokens?: number;
  outputTokens?: number;
  startedAt: string;
  endedAt?: string;
}
/** A memory a reply used or saved, shown under the reply. */
export interface MemoryRef {
  id: string;
  text: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
}
export interface MemoryScopeView {
  scope: MemoryScope;
  kind: 'user' | 'bot' | 'project' | 'group';
  label: string;
  botId?: string;
  count: number;
}
export interface MemoryEmbeddingView {
  state: 'off' | 'downloading' | 'ready' | 'failed';
  progress?: number;
  bytes?: number;
  issue?: string;
  model: string;
  sizeMB: number;
  indexed: number;
  pending: number;
}
export interface MemoryOverview {
  scopes: MemoryScopeView[];
  pending: number;
  jobs: MemoryJob[];
  totals: { capture: [number, number]; consolidate: [number, number]; tokens: number };
  embedding: MemoryEmbeddingView;
  /** Bots that do not use the facts about the user (role-play characters, for example). */
  isolatedBots: string[];
  memoryModel?: import('./core').ModelSelection;
}
export interface MemoryListQuery {
  scope?: MemoryScope;
  /** `pending` lists candidates and suggested moves across scopes. */
  status?: MemoryStatus | 'pending' | 'all';
  query?: string;
  limit?: number;
}
export interface MemoryItemDetail {
  item: MemoryItem;
  history: MemoryEvent[];
  sources: Array<MemorySource & { excerpt?: string; sessionId?: string; groupId?: string; available: boolean }>;
}
export interface MemoryUpdateInput {
  id: string;
  text?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  pinned?: boolean;
  validUntil?: string | null;
}
