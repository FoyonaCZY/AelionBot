import type { Bot, ModelConfig, RunRecord, WireMessage } from '../../../../shared/types/core';
import type { Store } from '../../storage/store';
import type { VmController } from '../../vm/vm';
import type { ComputerController } from '../../vm/computer';
import type { HostDesktop } from '../../host/desktop/host-desktop';
import type { ModelClient, ToolDefinition } from '../../model/model';
import type { Integrations } from '../../extensions/integrations';
import type { HostComputer } from '../../host/host';
import type { Cognition } from '../../memory/cognition';
import type { Attachments } from '../../attachments/attachments';
import type { TerminalSessions } from '../../tools/terminal-sessions';
import type { BackgroundProcesses } from '../../tools/background-processes';
import type { FileCheckpoints } from '../../tools/file-checkpoints';
import type { PythonSessions } from '../../tools/python-sessions';
import type { CodeOrchestrator } from '../../tools/code-orchestrator';
import type { WebTools } from '../../tools/web-tools';
import type { TaskScheduler } from '../../scheduler/task-scheduler';
import type { VideoFrames } from '../../preview/video-frames';
import type { AgentPreviews } from '../../preview/agent-previews';
import type { PinnedWidgets } from '../../preview/pinned-widgets';
import type { GroupGateway } from '../../group/group-runtime-types';
import type { ExecutionLedger } from '../execution-ledger';
import type { Interactions } from '../interactions';
import type { HarnessRunOptions, PeerGateway } from '../peer-runtime-types';
import type { DesignWork } from '../../designer/design-work';
import { AppError } from '../../../../shared/errors';
import type { SpeechService } from '../../speech/speech-service';
import type { KnowledgeAccess } from '../../knowledge/knowledge-service';
import type { VaultService } from '../../vault/vault-service';
import type { VaultResolutionContext, VaultResolver } from '../../vault/vault-resolver';

/** The Harness collaborators tool handlers may use; optional ones depend on how the app was wired. */
export interface ToolDeps {
  store: Store;
  vm: VmController;
  model: ModelClient;
  ledger: ExecutionLedger;
  attachments: Attachments;
  terminals: TerminalSessions;
  processes: BackgroundProcesses;
  fileCheckpoints: FileCheckpoints;
  pythonSessions: PythonSessions;
  code: CodeOrchestrator;
  web: WebTools;
  computer?: ComputerController;
  /** Computer Use on the user's own desktop; absent where the system does not support it. */
  hostDesktop?: HostDesktop;
  integrations?: Integrations;
  host?: HostComputer;
  interactions?: Interactions;
  cognition?: Cognition;
  peers?: PeerGateway;
  groups?: GroupGateway;
  scheduler?: TaskScheduler;
  video?: VideoFrames;
  previews?: AgentPreviews;
  pinnedWidgets?: PinnedWidgets;
  /** Local design tasks; absent when the app was wired without them. */
  design?: DesignWork;
  imageModel?: (botId: string) => { config: ModelConfig; key: string } | undefined;
  /** Speech recognition and synthesis chosen in settings; absent where the app was wired without them. */
  speech?: SpeechService;
  /** The user's knowledge bases; absent where the app was wired without them (the command line). */
  knowledge?: KnowledgeAccess;
  /** User secret Vault and blind-injection resolver; absent in isolated unit setups. */
  vault?: VaultService;
  vaultResolver?: VaultResolver;
  /** Builds run-aware Vault resolution base metadata (headless, scheduled, group, peer, connector). */
  vaultContext?(
    botId: string,
    runId: string,
    options: HarnessRunOptions,
  ): Omit<VaultResolutionContext, 'sink' | 'targetSummary' | 'target' | 'signal'>;
  changed(): void;
  /** Tools callable in this run, as offered to the model. */
  callableTools(runId: string): ToolDefinition[] | undefined;
  /** Activates deferred tools for subsequent model turns of this run; returns the activated tool names. */
  activateTools?(runId: string, names: Iterable<string>): string[];
  /** Finite background tasks of this run (terminals and processes) that have not finished. */
  pendingTasks(botId: string, runId: string): unknown[];
  /** The last context sent to the model in this run. */
  preparedContext(runId: string): WireMessage[] | undefined;
  /** Whether new input or a group event has superseded this run. */
  runUpdated(runId: string): boolean;
  /** Takes the Bot's desktop for this run; throws while another of its chats is using it. */
  claimDesktop(botId: string, runId: string): void;
  /** Runs a tool with the shared preamble, without recording an execution. */
  executeTool(
    bot: Bot,
    args: Record<string, unknown>,
    name: string,
    signal: AbortSignal,
    runId: string,
    options: HarnessRunOptions,
  ): Promise<unknown>;
  /** Runs a tool on behalf of code_exec, recording it as its own execution. */
  invokeNested(
    bot: Bot,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    runId: string,
    options: HarnessRunOptions,
  ): Promise<unknown>;
}

export interface ToolContext {
  bot: Bot;
  args: Record<string, unknown>;
  name: string;
  signal: AbortSignal;
  runId: string;
  options: HarnessRunOptions;
  /** The Bot's run with this id; undefined for stale or foreign run ids. */
  run: RunRecord | undefined;
  workspace: string | undefined;
  deps: ToolDeps;
}

export type ToolHandler = (context: ToolContext) => unknown;

export interface PrefixHandler {
  matches(name: string): boolean;
  handler: ToolHandler;
  /** Dispatched even when the name is missing from TOOLS; the handler validates the name itself. */
  unregistered?: boolean;
}

export const unregisteredTool = (name: string) => new AppError('tool.unregistered', `未注册工具：${name}`);
