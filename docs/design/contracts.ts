/**
 * OpenGrokBot 本地版：拟议领域契约，用于实现评审。
 * 只有类型；不是已实现 SDK，也不包含权限执行器。
 * 所有输入仍需运行时 schema 校验和事务约束。
 */
export type Id = string;
export type Revision = number;
export type Timestamp = string; // ISO 8601 UTC
export type Epoch = string; // 十进制 uint64，避免 JavaScript 数值精度损失
export type Digest = string; // sha256:...

/** 首版安装级策略；由应用内核执行，不能只靠 UI 隐藏创建入口。 */
export interface LocalV1ProvisioningPolicy {
  hostSlot: "host-computer";
  managedVmSlot: "managed-work-computer";
  maxActiveManagedVms: 1;
  maxRegisteredManagedComputers: 1;
  provisioningOwner: "application";
  userCanCreateComputer: false;
  botCanCreateComputer: false;
  customImageImport: false;
  userHardwareConfiguration: false;
  imageProfileId: Id;
  imageProfileDigest: Digest;
  resourcePolicyId: Id;
}

export type Capability =
  | "files.read" | "files.write" | "process.exec"
  | "browser.observe" | "browser.act"
  | "desktop.observe" | "desktop.input"
  | "clipboard.read" | "clipboard.write"
  | "office.read" | "office.write"
  | "network.fetch" | "connector.invoke";

export interface Bot {
  id: Id;
  name: string;
  role: string;
  revision: Revision;
  skillVersions: Array<{ id: Id; digest: Digest }>;
  maximumCapabilities: Capability[];
  preferredBindingIds: Id[]; // 无 vmId；Computer 由多对多绑定解析
  collaborationPolicyId: Id;
  modelPolicyId: Id;
}

export type Computer = {
  id: Id;
  name: string;
  os: "windows" | "linux" | "macos";
  architecture: "x64" | "arm64";
  state: "stopped" | "starting" | "ready" | "asleep" | "unavailable";
  bootEpoch: Epoch;
  availableCapabilities: Capability[];
  enforcement: {
    filesystem: "os-enforced" | "gateway-only" | "unrestricted";
    network: "os-enforced" | "gateway-only" | "unrestricted";
    credentials: "outside-guest" | "same-user-trust";
  };
} & (
  | {
      kind: "host";
      slot: "host-computer";
      provider: "windows-host" | "macos-host" | "linux-host";
    }
  | {
      kind: "managed-vm";
      slot: "managed-work-computer";
      managedBy: "application";
      imageProfileId: Id;
      provider: "qemu-whpx" | "hyper-v" | "apple-vz" | "qemu-kvm";
      imageDigest: Digest;
      resourceLimit: { vcpus: number; memoryMiB: number; diskMiB: number }; // 内部策略，不是用户配置项
    }
);

export interface BotComputerBinding {
  id: Id;
  botId: Id;
  computerId: Id;
  revision: Revision;
  status: "active" | "revoked";
  userGrantIds: Id[];
  capabilities: Capability[];
  workspaceIds: Id[];
  allowedSessionIds: Id[];
  credentialBindingIds: Id[]; // 只有引用，不含 secret
  policyId: Id;
  expiresAt?: Timestamp;
}

export interface Workspace {
  id: Id;
  computerId: Id;
  projectId: Id;
  rootRef: string; // 由实际 Provider 安全解析
  trustDomainId: Id;
  revision: Revision;
}

export interface ComputerSession {
  id: Id;
  computerId: Id;
  kind: "desktop" | "browser" | "terminal" | "office";
  parentSessionId?: Id; // browser 需要系统交互时追溯到 desktop
  controlEpoch: Epoch;
  controller: { kind: "user" } | { kind: "run"; runId: Id } | null;
  credentialBindingIds: Id[];
}

export interface ResourceLease {
  id: Id;
  resourceKey: string;
  mode: "shared-read" | "exclusive-write";
  owner: { kind: "run"; runId: Id } | { kind: "user"; userId: Id };
  fencingToken: Epoch;
  computerBootEpoch: Epoch;
  expiresAt: Timestamp;
  // 跨资源冲突通过资源层级表解决，不能只比较 resourceKey 是否相等。
}

export interface ArtifactRef {
  artifactId: Id;
  versionId: Id;
  digest: Digest;
  mediaType: string;
}

export interface Task {
  id: Id;
  rootTaskId: Id;
  parentTaskId?: Id;
  assignedBotId: Id;
  objective: string;
  specRevision: Revision;
  inputs: ArtifactRef[];
  acceptanceCriteria: Array<{ id: Id; description: string }>;
  allowedBindingIds: Id[];
  grantIds: Id[];
  delegationGrantId?: Id;
  budget: {
    reservationId: Id;
    maxCostMicros?: string;
    currency?: string;
    maxModelTokens?: number;
    maxWallTimeSeconds?: number;
    maxConcurrentChildren: number;
  };
}

export interface Run {
  id: Id;
  taskId: Id;
  engineId: Id;
  engineVersion: string;
  ownerEpoch: Epoch;
  lastCommittedSeq: Epoch;
  state:
    | "queued" | "running" | "verifying" | "succeeded"
    | "waiting-input" | "waiting-approval" | "waiting-resource"
    | "paused" | "budget-exhausted" | "recovering"
    | "needs-reconciliation" | "failed" | "cancelled";
  // Run 不固定 computerId；每条工具意图声明具体目标。
}

export interface ObservationRef {
  id: Id;
  computerId: Id;
  sessionId: Id;
  controlEpoch: Epoch;
  observedAt: Timestamp;
  targetIdentity: string;
  surfaceRevision: string;
}

export interface ToolIntent {
  invocationId: Id;
  runId: Id;
  runOwnerEpoch: Epoch;
  botId: Id;
  computerId: Id;
  bindingId: Id;
  bindingRevision: Revision;
  workspaceId?: Id;
  sessionId?: Id;
  toolName: string;
  toolVersion: string;
  arguments: unknown;
  argumentsDigest: Digest;
  inputArtifacts: ArtifactRef[];
  policyRevision: Revision;
  leaseIds: Id[];
  observation?: ObservationRef;
  preconditions: Array<{ resource: string; expectedVersion: string }>;
  approvalId?: Id;
  idempotencyKey: string;
  deadline: Timestamp;
  // Gateway 解析后绑定 fencing token；批准后不得修改意图内容。
}

export interface ToolReceipt {
  invocationId: Id;
  state: "succeeded" | "failed" | "cancelled" | "unknown";
  startedAt: Timestamp;
  finishedAt?: Timestamp;
  externalOperationId?: string;
  processJobId?: Id;
  outputs: ArtifactRef[];
  evidenceRefs: Id[];
  errorCode?: string;
}

export interface BotMessage {
  id: Id;
  channelId: Id;
  from: { kind: "user"; userId: Id } | { kind: "bot"; botId: Id };
  toBotIds: Id[];
  kind: "information" | "request" | "reply" | "task-result";
  correlationId: Id;
  causationId?: Id;
  taskId?: Id;
  content: string;
  artifacts: ArtifactRef[];
  expectsReply: boolean;
  remainingHops: number;
  expiresAt?: Timestamp;
  // Bot 消息从不自动转成用户 Grant；委派能力由独立 Grant 验证。
}

export interface Checkpoint {
  runId: Id;
  throughSeq: Epoch;
  taskSpecRevision: Revision;
  openActionIds: Id[];
  artifactManifest: ArtifactRef[];
  portableTaskState: {
    completedCriteriaIds: Id[];
    unresolved: string[];
    nextActions: string[];
    importantSourceRefs: Id[];
  };
  nativeContinuation?: {
    providerId: Id;
    modelFamily: string;
    engineVersion: string;
    opaqueBlobRef: Id;
  };
  // VM snapshot 独立管理；不能回滚外部副作用。
}
