import type {Attachment,AttachmentScope,AttachmentUpload} from './attachment-types';
import type {BotMention,PeerChatPage,PeerNotice,PeerRunOrigin,PeerView} from './peer-types';
import type {GroupLink,GroupPage,GroupRunOrigin,GroupSummary,GroupsView} from './group-types';
import type {MessagePin,PinEvent,PinInput} from './reactions';
import type {UpdateState} from './update-types';
import type {ScheduledTask,ScheduledTaskInput,ScheduledTaskUpdate,ScheduledTrigger} from './scheduled-types';
export type {BotMention,PeerChatPage,PeerNotice,PeerRunOrigin,PeerView} from './peer-types';
export interface ModelSelection {providerId:string;model:string;contextTokens:number;}
export interface ProviderModel {id:string;}
export interface ModelProvider {id:string;name:string;baseUrl:string;hasKey:boolean;models:ProviderModel[];modelsUpdatedAt?:string;modelsCheckedAt?:string;modelsError?:string;}
export interface ProviderInput {id?:string;name:string;baseUrl:string;apiKey?:string|null;}
export interface Bot { id: string; name: string; role: string; color: string; createdAt: string; memories: string[]; model?:ModelSelection; }
export interface BotUpdateInput {id:string;name:string;role:string;model?:ModelSelection|null;}
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }
export interface ScreenReference { id: string; width: number; height: number; attachmentId?:string; }
export interface WireMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; images?: ScreenReference[]; groupMessageId?:string; }
export interface StreamingReply {id:string;botId:string;runId?:string;content:string;time:string;main:boolean;groupId?:string;peerThreadId?:string;purpose?:'reply'|'progress'|'greeting';mentions?:BotMention[];}
export interface Artifact { id: string; botId: string; runId: string; path: string; name: string; size: number; modifiedAt: string; }
export interface ArtifactPreview { kind: 'text' | 'markdown' | 'html' | 'image' | 'pdf' | 'unsupported'; content?: string; dataUrl?: string; truncated?: boolean; }
export interface ChatMessage { scheduled?:ScheduledTrigger; attachments?:Attachment[]; inputState?:'queued'|'handled'|'cancelled'|'interrupted'; pins?:MessagePin[];reaction?:PinEvent; id: string; botId: string; role: 'user' | 'assistant' | 'tool' | 'event'; content: string; time: string; status?: 'running' | 'done' | 'failed' | 'cancelled'; tool?: string; runId?: string; screenshotId?: string; activity?: {label:string;detail?:string}; presentation?: 'progress'|'answer'|'error'; mentions?:BotMention[];peer?:PeerNotice;groupLink?:GroupLink;groupTaskSource?:{groupId:string;name:string;messageId?:string;continuation?:boolean};audience?:'user';peerSummaryFor?:string;peerContextPublished?:boolean;taskSource?:{botId:string;name:string;exchangeId:string;continuation?:boolean}; }
export interface RunRecord { attachments?:Attachment[]; inputUpdated?:boolean;supersedesRunId?:string;progressSteps?:number; groupReplyMessageId?:string; id: string; botId: string; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; startedAt: string; endedAt?: string; error?: string; modelCalls: number; toolCalls: number; peerOrigin?:PeerRunOrigin;groupOrigin?:GroupRunOrigin;groupTask?:boolean;groupUpdated?:boolean; }
export interface ModelConfig { baseUrl: string; model: string; hasKey: boolean; contextTokens: number; providerId?:string;providerName?:string;issue?:string; }
export interface SkillSource { label: string; path: string; scope: 'user'|'project'|'private'|'builtin'; readonly: boolean; }
export interface Skill { id: string; name: string; description: string; body: string; botId?: string; source?: SkillSource; compatibility?: string; availableFiles?: string[]; vmPath?: string; }
export interface IntegrationSource { id: string; label: string; path: string; kind: 'skills'|'mcp'; scope: 'user'|'project'|'private'|'builtin'; exists: boolean; count: number; issue?: string; }
export interface McpServerView { id: string; name: string; source: SkillSource; transport: 'stdio'|'http'|'sse'|'unsupported'; endpoint: string; enabled: boolean; status: 'disabled'|'available'|'connecting'|'connected'|'error'|'needs-config'; issue?: string; toolCount?: number; }
export interface IntegrationsView { sharedSkillDir: string; privateSkillDir: string; mcpFile: string; projectDir: string; sources: IntegrationSource[]; servers: McpServerView[]; scannedAt: string; }
export interface VmState { status: 'unprepared' | 'preparing' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'error'; detail: string; progress?: number; pid?: number; sshPort?: number; imageVersion: string; desktopReady?: boolean; appsReady?: boolean; maintenance?: boolean; needsReboot?: boolean; lastError?: string; diskBytes?: number; vncUrl?: string; }
export interface ComputerDesktopState {botId:string;status:'idle'|'starting'|'ready'|'error';ownerBotId?:string;manualControl:boolean;vncUrl?:string;error?:string;}
export interface ComputerState { desktops:Record<string,ComputerDesktopState>; }
export interface CommandPattern {kind:'prefix'|'exact';pattern:string;}
export interface CommandPermissionRule extends CommandPattern {id:string;cwd:string;enabled:boolean;createdAt:string;}
export interface HostWorkspaceSettings {workspaceDir:string;defaultWorkspaceDir:string;}
export interface HostPermissionDetails { operation:'command'|'read_file'|'write_file'|'mcp'; reason:string; command?:string; cwd?:string; path?:string; content?:string; overwrite?:boolean; server?:string; tool?:string; arguments?:Record<string,unknown>; commandPattern?:CommandPattern; }
export type InteractionRequest = {id:string;botId:string;runId:string;createdAt:string} & ({kind:'host_permission';details:HostPermissionDetails}|{kind:'vm_takeover';reason:string;phase:'waiting'|'controlling'});
export type InteractionAction='allow'|'allow-always'|'deny'|'takeover'|'resume'|'cancel';
export interface CognitionView {learning:{enabled:boolean;runningBotId?:string;queued:number};bots:Array<{botId:string;memoryRevision:number;context?:{estimatedTokens:number;inputBudget:number;toolTokens:number;imageTokens:number;epoch:number;compactions:number;prunedOutputs:number;lastIssue?:string};lastLearning?:{kind:string;action:string;time:string}}>}
export interface Snapshot {updates?:UpdateState; scheduledTasks?:ScheduledTask[]; bots: Bot[]; messages: ChatMessage[]; runs: RunRecord[]; model: ModelConfig; providers?:ModelProvider[];defaultModel?:ModelSelection;botModels?:Record<string,ModelConfig>; streamingReplies?:StreamingReply[]; vm: VmState; skills: Skill[]; artifacts: Artifact[]; computer: ComputerState; dataDir: string; integrations?:IntegrationsView; interactions?:InteractionRequest[]; cognition?:CognitionView; peers?:PeerView;groups?:GroupsView; greetingBotIds?:string[]; commandPermissions?:CommandPermissionRule[]; hostWorkspace?:HostWorkspaceSettings; }
export interface AppEvent { type: 'state'; snapshot: Snapshot; }
export interface CommandResult { stdout: string; stderr: string; exitCode: number; durationMs: number; }
export interface AelionAPI {
  updateState():Promise<UpdateState>;
  checkForUpdates():Promise<void>;
  downloadUpdate():Promise<void>;
  cancelUpdateDownload():Promise<void>;
  installUpdate():Promise<void>;
  openUpdateRelease():Promise<void>;
  pickAttachments(scope:AttachmentScope):Promise<Attachment[]>;
  pasteAttachments(scope:AttachmentScope):Promise<Attachment[]>;
  importAttachments(input:{scope:AttachmentScope;files:AttachmentUpload[]}):Promise<Attachment[]>;
  previewAttachment(id:string):Promise<ArtifactPreview>;
  saveAttachment(id:string):Promise<string|null>;
  snapshot(): Promise<Snapshot>;
  createScheduledTask(input:ScheduledTaskInput):Promise<ScheduledTask>;
  updateScheduledTask(input:ScheduledTaskUpdate):Promise<ScheduledTask>;
  deleteScheduledTask(id:string):Promise<void>;
  runScheduledTask(id:string):Promise<void>;
  createBot(input: { name: string; role: string; color?: string }): Promise<Bot>;
  deleteBot(id: string): Promise<void>;
  updateBot(input: BotUpdateInput): Promise<void>;
  send(input: { botId: string; message: string; mentions?:BotMention[];attachmentIds?:string[] }): Promise<void>;
  pinChat(input:PinInput&{botId:string}):Promise<void>;
  pinGroup(input:PinInput&{groupId:string}):Promise<void>;
  readPrivateChat(input:{threadId:string;before?:string}):Promise<PeerChatPage>;
  cancelPeerExchange(id:string):Promise<void>;
  createGroup(input:{name:string;botIds:string[]}):Promise<GroupSummary>;
  updateGroup(input:{id:string;name:string;botIds:string[]}):Promise<void>;
  deleteGroup(id:string):Promise<void>;
  readGroup(input:{id:string;before?:string}):Promise<GroupPage>;
  sendGroup(input:{id:string;message:string;mentions?:BotMention[];attachmentIds?:string[]}):Promise<void>;
  markGroupRead(input:{id:string;seq:number}):Promise<void>;
  stopGroup(id:string):Promise<void>;
  continueGroup(id:string):Promise<void>;
  cancel(botId: string): Promise<void>;
  saveModel(input: { baseUrl: string; model: string; apiKey?: string; contextTokens: number }): Promise<void>;
  testModel(): Promise<string>;
  saveProvider(input:ProviderInput):Promise<ModelProvider>;
  refreshProviderModels(id:string):Promise<ModelProvider>;
  removeProvider(id:string):Promise<void>;
  setDefaultModel(selection:ModelSelection|null):Promise<void>;
  setBotModel(input:{botId:string;selection:ModelSelection|null}):Promise<void>;
  vmAction(action: 'prepare' | 'start' | 'stop' | 'restart' | 'repair-tools'): Promise<void>;
  vmTerminal(command: string): Promise<CommandResult>;
  listFiles(botId: string): Promise<Array<{ name: string; path: string; size: number; modifiedAt: string }>>;
  exportFile(input: { botId: string; path: string }): Promise<string | null>;
  previewFile(input: { botId: string; path: string }): Promise<ArtifactPreview>;
  readToolResult(input: { botId:string; messageId:string }): Promise<unknown>;
  setBackgroundLearning(enabled:boolean):Promise<void>;
  screenshot(id: string): Promise<string>;
  ensureComputerDesktop(botId:string):Promise<void>;
  setComputerControl(input:{botId:string;enabled:boolean}): Promise<void>;
  setComputerFullscreen(enabled: boolean): Promise<void>;
  setWindowDimmed(enabled:boolean):Promise<void>;
  respondInteraction(input:{id:string;action:InteractionAction}):Promise<void>;
  setCommandPermissionEnabled(input:{id:string;enabled:boolean}):Promise<void>;
  removeCommandPermission(id:string):Promise<void>;
  saveHostWorkspace(path:string):Promise<void>;
  pickHostWorkspace():Promise<string|null>;
  openComputerApp(input: { botId: string; app: 'browser' | 'files' | 'editor' | 'writer' | 'calc' | 'terminal' }): Promise<void>;
  openFile(input: { botId: string; path: string }): Promise<void>;
  openData(): Promise<void>;
  refreshIntegrations(): Promise<void>;
  readSkill(input: {id:string;botId:string}): Promise<Skill>;
  addIntegrationSource(kind:'skills'|'mcp'): Promise<void>;
  openIntegrationPath(input:{kind:'shared-skills'|'private-skills'|'mcp-config'|'source';id?:string}): Promise<void>;
  setMcpEnabled(input:{id:string;enabled:boolean}): Promise<void>;
  testMcp(id:string): Promise<{tools:string[]}>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global { interface Window { aelion: AelionAPI; } }
