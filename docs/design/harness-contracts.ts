/**
 * Hermes 风格精简 Harness 的拟议契约；不是已实现 SDK。
 * 配合 contracts.ts；事务、权限与来源校验必须由运行时服务执行。
 */
import type { ArtifactRef, Capability, Digest, Epoch, Id, Revision, Timestamp } from "./contracts.ts";

export type KnowledgeScope =
  | { kind: "user"; userId: Id }
  | { kind: "bot-private"; botId: Id }
  | { kind: "project-shared"; projectId: Id };

export interface KnowledgeSource {
  kind: "user-message" | "tool-receipt" | "artifact" | "bot-message";
  eventId: Id;
  streamId: Id;
  seq: Epoch;
  artifact?: ArtifactRef;
  // bot-message 必须继续追溯原始证据，不能升级为用户授权。
}

export interface MemoryFact {
  id: Id;
  scope: KnowledgeScope;
  revision: Revision;
  text: string;
  category: "preference" | "project-convention" | "environment" | "verified-lesson";
  evidence: "user-explicit" | "tool-verified" | "inferred";
  sources: KnowledgeSource[];
  status: "candidate" | "active" | "retracted";
  supersedesFactId?: Id;
  validUntil?: Timestamp;
}

export interface MemoryMutation {
  id: Id;
  actorBotId: Id;
  scope: KnowledgeScope;
  operation: "add" | "replace" | "remove";
  factId?: Id;
  expectedScopeRevision: Revision;
  expectedFactRevision?: Revision;
  replacementText?: string;
  sources: KnowledgeSource[];
  learningJobId?: Id;
  grantIds: Id[];
}

export interface SkillVersion {
  skillId: Id;
  versionId: Id;
  name: string;
  description: string;
  scope: KnowledgeScope;
  digest: Digest;
  body: ArtifactRef;
  supportFiles: ArtifactRef[];
  sources: KnowledgeSource[];
  requiredCapabilities: Capability[];
  computerKinds: Array<"host" | "managed-vm">;
  platforms: Array<"windows" | "linux" | "macos">;
  status: "draft" | "active" | "deprecated";
  verification: "static-only" | "source-task-verified" | "replayed-on-new-input";
  verificationReceiptIds: Id[];
  replacesVersionId?: Id;
  // requiredCapabilities 是要求声明，不是权限授予。
}

export interface ExchangeGroup {
  id: Id;
  sourceEventIds: Id[];
  toolCallIds: Id[];
  unresolvedToolCallIds: Id[];
  payload: ArtifactRef;
  estimatedTokens: number;
  // 有未完成调用时不可从中间切分；provider adapter 校验原生协议约束。
}

export interface ContextEpoch {
  id: Id;
  revision: Revision;
  runId: Id;
  botId: Id;
  taskSpecRevision: Revision;
  runOwnerEpoch: Epoch;
  sourceCutoffs: Array<{ streamId: Id; throughSeq: Epoch }>;
  memorySnapshot: ArtifactRef;
  memoryScopeRevisions: Array<{ scope: KnowledgeScope; revision: Revision }>;
  skillCatalogRevision: Revision;
  loadedSkills: Array<{ skillId: Id; versionId: Id; digest: Digest }>;
  episodeSummaryIds: Id[];
  recentExchangeIds: Id[];
  createdAt: Timestamp;
}

export interface ContextBudget {
  contextLimitTokens: number;
  outputReserveTokens: number;
  toolAndControlReserveTokens: number;
  inputBudgetTokens: number;
  pruneAtTokens: number;
  compactAtTokens: number;
  hardLimitTokens: number;
  protectedTailTokens: number;
  summaryTargetTokens: number;
  countingMethod: "provider-tokenizer" | "provider-usage-calibrated" | "estimated";
}

export interface EpisodeSummary {
  id: Id;
  ownerBotId: Id;
  scope: KnowledgeScope;
  coveredRanges: Array<{ streamId: Id; fromSeq: Epoch; throughSeq: Epoch }>;
  sourceDigest: Digest;
  body: ArtifactRef;
  exactAnchorRefs: ArtifactRef[];
  sourceFactIds: Id[];
  sourceSkillVersionIds: Id[];
  status: "valid" | "invalidated";
  // 当前任务事实从 TaskState 读取，summary 不能决定权限或恢复已完成任务。
}

export interface CompactionCandidate {
  id: Id;
  expectedContextEpochId: Id;
  expectedContextRevision: Revision;
  expectedTaskSpecRevision: Revision;
  expectedRunOwnerEpoch: Epoch;
  sourceCutoffs: Array<{ streamId: Id; throughSeq: Epoch }>;
  summary: EpisodeSummary;
  retainedExchangeIds: Id[];
  beforeInputTokens: number;
  afterInputTokens: number;
  completeSummaryOutput: boolean;
  protocolValidation: "passed" | "failed";
  // 提交需要 CAS、token 缩减检查、来源可用性及授权撤销检查。
}

export interface LessonCandidate {
  id: Id;
  taskId: Id;
  episodeId: Id;
  ownerBotId: Id;
  trigger: "user-correction" | "verified-workflow" | "resolved-failure" | "explicit-save";
  sources: KnowledgeSource[];
  evidenceDigest: Digest;
  sourceIsLearningJob: false;
}

export interface LearningJob {
  id: Id;
  ownerBotId: Id;
  candidateIds: Id[];
  inputEvidenceDigest: Digest;
  knowledgeBaseRevisions: Array<{ scope: KnowledgeScope; revision: Revision }>;
  policyRevision: Revision;
  budgetReservationId: Id;
  maxModelCalls: 2;
  allowedOperations: Array<"read-authorized-evidence" | "propose-memory" | "propose-skill">;
  state: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  proposedMutationIds: Id[];
  proposedSkillVersionIds: Id[];
  // 执行验证由 ToolGateway 承接；学习进程没有直接系统执行能力。
}
