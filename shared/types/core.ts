import type { MessageReply } from '../chat/message-replies';
import type { ModelParameters, NativeAssistant } from './model-types';
import type { HostPermissionMode, HostApprovalView } from './permission-types';
import type { WorkItem, WorkAction } from './work-types';
import type { RuntimeSettings, TaskPlan, UsageRecord } from './runtime-types';
import type {
  Attachment,
  AttachmentScope,
  AttachmentUpload,
  DroppedAttachment,
  PreparedAttachmentDrop,
} from './attachment-types';
import type { BotMention, PeerChatPage, PeerNotice, PeerRunOrigin, PeerView } from './peer-types';
import type { GroupLink, GroupPage, GroupRunOrigin, GroupSummary, GroupsView } from './group-types';
import type { MessagePin, PinEvent, PinInput } from '../chat/reactions';
import type { UpdateState } from './update-types';
import type { GameAPI } from './game-types';
import type { MentionFileSearch } from '../chat/file-mentions';
import type { DiagnosticPreview } from './diagnostic-types';
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskUpdate, ScheduledTrigger } from './scheduled-types';
import type { ToolExecution } from './execution-types';
export type { BotMention } from './peer-types';
export interface ModelSelection {
  providerId: string;
  model: string;
  contextTokens: number;
  reasoningEffort?: string;
  supportsImages?: boolean;
}
export interface ProviderModel {
  id: string;
  contextTokens?: number;
  reasoningEffort?: string;
  thinkingBudget?: number;
  supportsImages?: boolean;
  imageOutput?: boolean;
  imageAspect?: import('./image-types').ImageAspect;
  imageQuality?: import('./image-types').ImageQuality;
}
export interface ModelProvider extends ModelParameters {
  id: string;
  name: string;
  baseUrl: string;
  hasKey: boolean;
  models: ProviderModel[];
  modelsUpdatedAt?: string;
  modelsCheckedAt?: string;
  modelsError?: string;
}
export interface ProviderInput extends ModelParameters {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey?: string | null;
}
export interface Bot {
  type?: import('./designer-types').BotType;
  contextResetAt?: string;
  defaultDesignSystemId?: string | null;
  id: string;
  name: string;
  /** SOUL.md: free-form Markdown defining the Bot's voice, values and boundaries. */
  soul: string;
  color: string;
  avatarStyle?: import('../chat/bot-colors').BotAvatarStyle;
  createdAt: string;
  memories: string[];
  model?: ModelSelection;
  imageModel?: ModelSelection;
  reasoningEffort?: string;
}
export interface BotUpdateInput {
  confirmContextReset?: boolean;
  expectedType?: import('./designer-types').BotType;
  type?: import('./designer-types').BotType;
  defaultDesignSystemId?: string | null;
  id: string;
  name: string;
  soul: string;
  model?: ModelSelection | null;
  imageModel?: ModelSelection | null;
  reasoningEffort?: string | null;
  color?: string;
  avatarStyle?: import('../chat/bot-colors').BotAvatarStyle | null;
}
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ScreenReference {
  id: string;
  width: number;
  height: number;
  attachmentId?: string;
}
export interface WireMessage {
  native?: NativeAssistant;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  images?: ScreenReference[];
  groupMessageId?: string;
}
export interface StreamingReply {
  id: string;
  botId: string;
  runId?: string;
  content: string;
  time: string;
  main: boolean;
  groupId?: string;
  peerThreadId?: string;
  purpose?: 'reply' | 'progress' | 'greeting';
  mentions?: BotMention[];
  reasoning?: MessageReasoning;
}
/** Readable model reasoning shown beside a reply; it never re-enters model context. */
export interface MessageReasoning {
  text: string;
  startedAt?: string;
  durationMs?: number;
}
export interface Artifact {
  id: string;
  botId: string;
  runId: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  kind?: 'file' | 'web';
  url?: string;
  urlLocation?: 'host' | 'vm';
}
export interface ArtifactPreview {
  kind: 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'web' | 'unsupported';
  web?: import('../preview/web-preview').WebPreviewSource;
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
}
export interface ChatMessage {
  designSessionId?: string;
  previewPrompt?: string;
  operationDenial?: import('../chat/operation-denial').OperationDenial;
  questionAnswer?: import('../chat/question-answers').QuestionAnswerData;
  reply?: MessageReply;
  workspaceDir?: string | null;
  executionId?: string;
  executionTarget?: string;
  executionResolved?: boolean;
  scheduled?: ScheduledTrigger;
  attachments?: Attachment[];
  inputState?: 'queued' | 'handled' | 'cancelled' | 'interrupted';
  pins?: MessagePin[];
  reaction?: PinEvent;
  id: string;
  botId: string;
  role: 'user' | 'assistant' | 'tool' | 'event';
  content: string;
  time: string;
  status?: 'running' | 'done' | 'failed' | 'cancelled';
  tool?: string;
  runId?: string;
  screenshotId?: string;
  activity?: { label: string; detail?: string };
  presentation?: 'progress' | 'answer' | 'error';
  mentions?: BotMention[];
  reasoning?: MessageReasoning;
  peer?: PeerNotice;
  groupLink?: GroupLink;
  groupTaskSource?: { groupId: string; name: string; messageId?: string; continuation?: boolean };
  audience?: 'user';
  peerSummaryFor?: string;
  peerContextPublished?: boolean;
  taskSource?: { botId: string; name: string; exchangeId: string; continuation?: boolean };
}
export interface RunRecord {
  engine?: import('./designer-types').BotType;
  engineVersion?: string;
  designSessionId?: string;
  contextOverview?: import('../chat/context-overview').ContextOverview;
  modelRequest?: import('./model-request-status').ModelRequestStatus;
  resumedFromRunId?: string;
  contextIssue?: import('../chat/context-issue').ContextIssue;
  lastProgressAt?: string;
  lastProgressDigest?: string;
  workItemId?: string;
  workspaceDir?: string;
  plan?: TaskPlan;
  executions?: ToolExecution[];
  attachments?: Attachment[];
  inputUpdated?: boolean;
  supersedesRunId?: string;
  progressSteps?: number;
  groupReplyMessageId?: string;
  id: string;
  botId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  endedAt?: string;
  error?: string;
  modelCalls: number;
  toolCalls: number;
  peerOrigin?: PeerRunOrigin;
  groupOrigin?: GroupRunOrigin;
  groupTask?: boolean;
  groupUpdated?: boolean;
}
export interface ModelConfig extends ModelParameters {
  supportsImages?: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  contextTokens: number;
  providerId?: string;
  providerName?: string;
  issue?: string;
  hostedImageSize?: string;
  hostedImageQuality?: string;
}
export interface SkillSource {
  label: string;
  path: string;
  scope: 'user' | 'project' | 'private' | 'builtin';
  readonly: boolean;
}
export interface Skill {
  enabled?: boolean;
  hash?: string;
  archived?: boolean;
  pinned?: boolean;
  readCount?: number;
  lastReadAt?: string;
  id: string;
  name: string;
  description: string;
  body: string;
  botId?: string;
  source?: SkillSource;
  compatibility?: string;
  availableFiles?: string[];
  vmPath?: string;
}
export interface IntegrationSource {
  id: string;
  label: string;
  path: string;
  kind: 'skills' | 'mcp';
  scope: 'user' | 'project' | 'private' | 'builtin';
  exists: boolean;
  count: number;
  issue?: string;
}
export interface McpServerView {
  id: string;
  name: string;
  source: SkillSource;
  transport: 'stdio' | 'http' | 'sse' | 'unsupported';
  endpoint: string;
  enabled: boolean;
  status: 'disabled' | 'available' | 'connecting' | 'connected' | 'error' | 'needs-config';
  issue?: string;
  toolCount?: number;
}
export interface IntegrationsView {
  sharedSkillDir: string;
  privateSkillDir: string;
  mcpFile: string;
  projectDir: string;
  sources: IntegrationSource[];
  servers: McpServerView[];
  scannedAt: string;
}
export const WORKSTATION_VERSION = '6';
export interface InstallationProgress {
  stage: string;
  phase: string;
  percent?: number;
  source?: string;
  package?: string;
  updatedAt: number;
  error?: string;
}
export interface VmState {
  operationPending?: boolean;
  storage?: import('../preview/vm-storage').VmStorageState;
  status: 'unprepared' | 'preparing' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'error';
  detail: string;
  progress?: number;
  installation?: InstallationProgress;
  pid?: number;
  sshPort?: number;
  imageVersion: string;
  desktopReady?: boolean;
  appsReady?: boolean;
  maintenance?: boolean;
  needsReboot?: boolean;
  lastError?: string;
  diskBytes?: number;
  vncUrl?: string;
}
export interface ComputerDesktopState {
  botId: string;
  status: 'idle' | 'starting' | 'ready' | 'error';
  ownerBotId?: string;
  manualControl: boolean;
  vncUrl?: string;
  error?: string;
}
export interface ComputerState {
  desktops: Record<string, ComputerDesktopState>;
}
export interface CommandPattern {
  kind: 'prefix' | 'exact';
  pattern: string;
}
export interface CommandPermissionRule extends CommandPattern {
  id: string;
  cwd: string;
  enabled: boolean;
  createdAt: string;
}
export interface HostWorkspaceSettings {
  workspaceDir: string;
  defaultWorkspaceDir: string;
}
export interface HostPermissionDetails {
  permissionScope?: 'host' | 'remote';
  operation: 'command' | 'read_file' | 'write_file' | 'delete_file' | 'mcp';
  reason: string;
  command?: string;
  cwd?: string;
  path?: string;
  content?: string;
  overwrite?: boolean;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  commandPattern?: CommandPattern;
  readOnly?: boolean;
  stdin?: string;
}
export interface UserQuestion {
  id: string;
  title: string;
  options?: string[];
}
export type InteractionRequest = { id: string; botId: string; runId: string; createdAt: string } & (
  | { kind: 'host_permission'; details: HostPermissionDetails; approval?: HostApprovalView }
  | { kind: 'vm_takeover'; reason: string; phase: 'waiting' | 'controlling' }
  | { kind: 'user_input'; questions: UserQuestion[]; phase: 'waiting' }
);
export type InteractionAction = 'allow' | 'allow-always' | 'deny' | 'takeover' | 'resume' | 'cancel' | 'answer';
interface CognitionView {
  learning: { enabled: boolean; runningBotId?: string; queued: number };
  bots: Array<{
    botId: string;
    memoryRevision: number;
    context?: {
      estimatedTokens: number;
      inputBudget: number;
      toolTokens: number;
      imageTokens: number;
      epoch: number;
      compactions: number;
      prunedOutputs: number;
      lastIssue?: string;
    };
    lastLearning?: { kind: string; action: string; time: string };
  }>;
}
export interface Snapshot {
  designer?: import('./designer-types').DesignerSnapshot;
  previewRequests?: import('../preview/agent-preview-types').AgentPreviewRequest[];
  previewHistory?: import('../preview/agent-preview-types').PreviewHistoryEntry[];
  appearance?: import('../preview/appearance').AppearanceSettings;
  userProfile?: import('../chat/user-profile').UserProfile;
  hostPermissionModes?: Record<string, HostPermissionMode>;
  platform?: string;
  workItems?: WorkItem[];
  conversationWorkspaces?: Record<string, string>;
  runtime?: RuntimeSettings;
  modelUsage?: UsageRecord[];
  updates?: UpdateState;
  scheduledTasks?: ScheduledTask[];
  bots: Bot[];
  messages: ChatMessage[];
  runs: RunRecord[];
  model: ModelConfig;
  providers?: ModelProvider[];
  defaultModel?: ModelSelection;
  approvalModel?: ModelSelection;
  botModels?: Record<string, ModelConfig>;
  streamingReplies?: StreamingReply[];
  vm: VmState;
  skills: Skill[];
  artifacts: Artifact[];
  computer: ComputerState;
  dataDir: string;
  integrations?: IntegrationsView;
  interactions?: InteractionRequest[];
  cognition?: CognitionView;
  peers?: PeerView;
  groups?: GroupsView;
  layaFeature?: import('./laya-types').LayaFeatureState;
  greetingBotIds?: string[];
  commandPermissions?: CommandPermissionRule[];
  hostWorkspace?: HostWorkspaceSettings;
  liveWork?: import('../chat/live-work').LiveWorkItem[];
}
type AppEvent = { type: 'state'; snapshot: Snapshot } | { type: 'streams'; streamingReplies: StreamingReply[] };
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}
export interface AelionAPI {
  games: GameAPI;
  designSystem(id: string): Promise<import('./designer-types').DesignSystemDetail>;
  createDesignSession(
    input: import('./designer-types').DesignSessionInput,
  ): Promise<import('./designer-types').DesignSession>;
  updateDesignSession(
    input: import('./designer-types').DesignSessionUpdate,
  ): Promise<import('./designer-types').DesignSession>;
  sendDesignMessage(input: { id: string; message: string; attachmentIds?: string[] }): Promise<void>;
  acceptDesignSession(input: { id: string; revision: number }): Promise<void>;
  listDesignWorkspace(id: string): Promise<Array<{ name: string; path: string; size: number; modifiedAt?: string }>>;
  importDesignSystem(): Promise<import('./designer-types').DesignSystemSummary | null>;
  listDesignFonts(input: { id: string }): Promise<import('./design-font-types').DesignFont[]>;
  searchDesignFonts(input: { query: string }): Promise<import('./design-font-types').DesignFontCatalogEntry[]>;
  acquireDesignFont(
    input: { id: string } & import('./design-font-types').DesignFontAcquire,
  ): Promise<import('./design-font-types').DesignFont[]>;
  importDesignFonts(input: { id: string }): Promise<import('./design-font-types').DesignFont[] | null>;
  applyDesignFont(input: {
    id: string;
    fontId: string;
    role: 'body' | 'display' | 'mono';
    path?: string;
  }): Promise<{ path: string; family: string; role: string; cssPath: string }>;
  checkDesignFonts(input: {
    id: string;
    text?: string;
    path?: string;
    family?: string;
  }): Promise<import('./design-font-types').DesignFontCheck>;
  exportDesignFile(
    input: import('../preview/canvas-export').CanvasExportInput,
  ): Promise<import('../preview/canvas-export').CanvasExportResult | null>;
  exportDesignProject(input: { id: string; path?: string }): Promise<string | null>;

  focusPreviewFeedback(): Promise<void>;
  captureWebPreviewMenu(input: { id: string }): Promise<import('../preview/web-preview').PreviewFreezeFrame | null>;
  freezeWebPreview(input: { id: string; frozen: boolean; revision?: number }): Promise<boolean>;
  previewEditorCommand(input: {
    id: string;
    command: import('./preview-editor-types').EditorCommand;
  }): Promise<import('./preview-editor-types').EditorResult>;
  onPreviewSave(callback: (id: string) => void): () => void;
  onPreviewEditor(
    callback: (event: { id: string; state: import('./preview-editor-types').PreviewEditorState }) => void,
  ): () => void;
  patchPreviewHtml(input: { content: string; edits: import('./preview-editor-types').DomEdit[] }): Promise<string>;
  updatePreviewFeedbackOverlay(
    input: import('../preview/preview-feedback-overlay').FeedbackOverlayLayout | null,
  ): Promise<boolean>;
  onPreviewFeedbackInput(
    callback: (input: import('../preview/preview-feedback-overlay').FeedbackOverlayInput) => void,
  ): () => void;
  openWebPreview(input: {
    id: string;
    source: import('../preview/web-preview').WebPreviewSource;
  }): Promise<import('../preview/web-preview').WebPreviewState>;
  layoutWebPreview(input: {
    id: string;
    rect: { x: number; y: number; width: number; height: number };
    visible: boolean;
  }): Promise<void>;
  webPreviewAction(input: {
    id: string;
    action: 'back' | 'forward' | 'reload' | 'navigate' | 'zoom';
    url?: string;
    factor?: number;
  }): Promise<import('../preview/web-preview').WebPreviewState>;
  closeWebPreview(id: string): Promise<void>;
  onWebPreview(callback: (state: import('../preview/web-preview').WebPreviewState) => void): () => void;
  onWebPreviewEscape(callback: (id: string) => void): () => void;
  sendPreviewFeedback(
    input: import('../preview/preview-feedback').PreviewFeedbackInput,
  ): Promise<{ sent: true; attachmentId: string }>;
  setSkillEnabled(input: { id: string; enabled: boolean }): Promise<void>;
  saveVmStorageSettings(value: import('../preview/vm-storage').VmStorageSettings): Promise<void>;
  reclaimVmStorage(): Promise<void>;
  acknowledgePreview(id: string): Promise<void>;
  readEditableFile(input: { botId: string; path: string }): Promise<import('../chat/editable-text').EditableText>;
  saveEditableFile(input: {
    botId: string;
    path: string;
    edit: import('../chat/editable-text').TextEdit;
  }): Promise<import('../chat/editable-text').EditableText>;
  readEditableAttachment(id: string): Promise<import('../chat/editable-text').EditableText>;
  exportEditedText(input: { name: string; content: string }): Promise<string | null>;
  setPreviewDirty(dirty: boolean): Promise<void>;
  saveAppearanceSettings(settings: import('../preview/appearance').AppearanceSettings): Promise<void>;
  saveUserProfile(profile: import('../chat/user-profile').UserProfile): Promise<void>;
  prepareDiagnostics(): Promise<DiagnosticPreview>;
  exportDiagnostics(id: string): Promise<string | null>;
  openDiagnosticIssue(id: string): Promise<void>;
  setHostPermissionMode(input: { scope: AttachmentScope; mode: HostPermissionMode }): Promise<void>;
  pickConversationWorkspace(scope: AttachmentScope): Promise<string | null>;
  resetConversationWorkspace(scope: AttachmentScope): Promise<void>;
  workAction(input: WorkAction): Promise<void>;
  updateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  cancelUpdateDownload(): Promise<void>;
  installUpdate(): Promise<void>;
  openUpdateRelease(): Promise<void>;
  resumeChat(input: { botId: string; runId: string }): Promise<void>;
  pickAttachments(scope: AttachmentScope): Promise<Attachment[]>;
  prepareAttachmentDrop(input: { scope: AttachmentScope; files: File[] }): Promise<PreparedAttachmentDrop>;
  prepareAttachmentPaste(scope: AttachmentScope): Promise<{ entries: DroppedAttachment[]; attachments: Attachment[] }>;
  applyAttachmentDrop(input: {
    scope: AttachmentScope;
    ids: string[];
    action: 'attach' | 'workspace';
  }): Promise<{ attachments: Attachment[]; workspaceDir?: string | null }>;
  pasteAttachments(scope: AttachmentScope): Promise<Attachment[]>;
  importAttachments(input: { scope: AttachmentScope; files: AttachmentUpload[] }): Promise<Attachment[]>;
  previewAttachment(id: string): Promise<ArtifactPreview>;
  saveAttachment(id: string): Promise<string | null>;
  snapshot(): Promise<Snapshot>;
  saveRuntimeSettings(settings: RuntimeSettings): Promise<void>;
  installLaya(): Promise<void>;
  selectLaya(variant: import('./laya-types').LayaVariant): Promise<void>;
  setLayaEnabled(enabled: boolean): Promise<void>;
  cancelLayaInstall(): Promise<void>;
  compactContext(input: {
    botId: string;
    focus?: string;
  }): Promise<{ compacted: boolean; freedTokens: number; queued?: boolean; issue?: string }>;
  createScheduledTask(input: ScheduledTaskInput): Promise<ScheduledTask>;
  updateScheduledTask(input: ScheduledTaskUpdate): Promise<ScheduledTask>;
  deleteScheduledTask(id: string): Promise<void>;
  runScheduledTask(id: string): Promise<void>;
  createBot(input: {
    type?: import('./designer-types').BotType;
    name: string;
    soul: string;
    color?: string;
    avatarStyle?: import('../chat/bot-colors').BotAvatarStyle | null;
    model?: ModelSelection | null;
    imageModel?: ModelSelection | null;
    reasoningEffort?: string | null;
  }): Promise<Bot>;
  deleteBot(id: string): Promise<void>;
  updateBot(input: BotUpdateInput): Promise<void>;
  send(input: {
    designSessionId?: string;
    botId: string;
    message: string;
    replyToMessageId?: string;
    mentions?: BotMention[];
    attachmentIds?: string[];
  }): Promise<void>;
  pinChat(input: PinInput & { botId: string }): Promise<void>;
  pinGroup(
    input: PinInput & { groupId: string },
  ): Promise<{ pinned: boolean; messageId: string; alreadyApplied?: boolean; eventId?: string }>;
  readPrivateChat(input: { threadId: string; before?: string }): Promise<PeerChatPage>;
  cancelPeerExchange(id: string): Promise<void>;
  createGroup(input: { name: string; botIds: string[] }): Promise<GroupSummary>;
  updateGroup(input: { id: string; name: string; botIds: string[] }): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  readGroup(input: { id: string; before?: string }): Promise<GroupPage>;
  sendGroup(input: {
    id: string;
    message: string;
    replyToMessageId?: string;
    mentions?: BotMention[];
    attachmentIds?: string[];
  }): Promise<void>;
  markGroupRead(input: { id: string; seq: number }): Promise<void>;
  stopGroup(id: string): Promise<void>;
  continueGroup(id: string): Promise<void>;
  cancel(botId: string): Promise<void>;
  stopLiveWork(input: { botId: string; kind: 'terminal' | 'process'; id: string }): Promise<void>;
  saveModel(input: { baseUrl: string; model: string; apiKey?: string; contextTokens: number }): Promise<void>;
  testModel(): Promise<string>;
  queryUsage(input: import('./usage-types').UsageQuery): Promise<import('./usage-types').UsageReport>;
  saveProvider(input: ProviderInput): Promise<ModelProvider>;
  imageProtocols(): Promise<import('./image-types').ImageProtocolInfo[]>;
  testImageModel(input: {
    selection: ModelSelection;
  }): Promise<{ protocol: import('./image-types').ImageProtocol; mediaType: string; bytes: number }>;
  refreshProviderModels(id: string): Promise<ModelProvider>;
  updateProviderModel(input: { providerId: string; model: ProviderModel }): Promise<ModelProvider>;
  removeProvider(id: string): Promise<void>;
  setDefaultModel(selection: ModelSelection | null): Promise<void>;
  setApprovalModel(selection: ModelSelection | null): Promise<void>;
  setBotModel(input: { botId: string; selection: ModelSelection | null }): Promise<void>;
  vmAction(action: 'prepare' | 'start' | 'stop' | 'restart' | 'repair-tools'): Promise<void>;
  vmTerminal(command: string): Promise<CommandResult>;
  listFiles(botId: string): Promise<Array<{ name: string; path: string; size: number; modifiedAt: string }>>;
  searchMentionFiles(input: {
    designSessionId?: string;
    scope: import('./attachment-types').AttachmentScope;
    query: string;
  }): Promise<MentionFileSearch>;
  listWorkspaceDirectory(input: {
    botId: string;
    path?: string;
  }): Promise<import('../preview/workspace-files').WorkspaceDirectory>;
  exportFile(input: { botId: string; path: string }): Promise<string | null>;
  previewFile(input: { botId: string; path: string }): Promise<ArtifactPreview>;
  readToolResult(input: { botId: string; messageId: string }): Promise<unknown>;
  setBackgroundLearning(enabled: boolean): Promise<void>;
  screenshot(id: string): Promise<string>;
  ensureComputerDesktop(botId: string): Promise<void>;
  setComputerControl(input: { botId: string; enabled: boolean }): Promise<void>;
  setComputerFullscreen(enabled: boolean): Promise<void>;
  setWindowDimmed(enabled: boolean, color?: string): Promise<void>;
  respondInteraction(input: { id: string; action: InteractionAction; answers?: Record<string, string> }): Promise<void>;
  setCommandPermissionEnabled(input: { id: string; enabled: boolean }): Promise<void>;
  removeCommandPermission(id: string): Promise<void>;
  saveHostWorkspace(path: string): Promise<void>;
  pickHostWorkspace(): Promise<string | null>;
  openComputerApp(input: {
    botId: string;
    app: 'browser' | 'files' | 'editor' | 'writer' | 'calc' | 'impress' | 'terminal';
  }): Promise<void>;
  openPreviewFile(input: import('../preview/preview-open').PreviewOpenInput): Promise<boolean>;
  openFile(input: { botId: string; path: string }): Promise<void>;
  // Resolves to shell.openPath's error message, or an empty string on success.
  openData(): Promise<string>;
  openExternalUrl(url: string): Promise<void>;
  refreshIntegrations(): Promise<void>;
  manageSkill(input: { botId: string; id: string; action: string; revision?: number }): Promise<unknown>;
  readSkill(input: { id: string; botId?: string }): Promise<Skill>;
  addIntegrationSource(kind: 'skills' | 'mcp'): Promise<void>;
  importMcpSnippet(text: string): Promise<string[]>;
  openIntegrationPath(input: {
    kind: 'shared-skills' | 'private-skills' | 'mcp-config' | 'source';
    id?: string;
  }): Promise<void>;
  setMcpEnabled(input: { id: string; enabled: boolean }): Promise<void>;
  testMcp(id: string): Promise<{ tools: string[] }>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global {
  interface Window {
    aelion: AelionAPI;
  }
}
