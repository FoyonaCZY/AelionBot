import type { Bot, ModelConfig, RunRecord, WireMessage } from '../../../../shared/types/core';
import type { Store } from '../../storage/store';
import type { VmController } from '../../vm/vm';
import type { ComputerController } from '../../vm/computer';
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
import type { GroupGateway } from '../../group/group-runtime-types';
import type { ExecutionLedger } from '../execution-ledger';
import type { Interactions } from '../interactions';
import type { HarnessRunOptions, PeerGateway } from '../peer-runtime-types';

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
  integrations?: Integrations;
  host?: HostComputer;
  interactions?: Interactions;
  cognition?: Cognition;
  peers?: PeerGateway;
  groups?: GroupGateway;
  scheduler?: TaskScheduler;
  video?: VideoFrames;
  previews?: AgentPreviews;
  imageModel?: (botId: string) => { config: ModelConfig; key: string } | undefined;
  changed(): void;
  /** Tools callable in this run, as offered to the model. */
  callableTools(runId: string): ToolDefinition[] | undefined;
  /** The last context sent to the model in this run. */
  preparedContext(runId: string): WireMessage[] | undefined;
  /** Whether new input or a group event has superseded the Bot's current run. */
  runUpdated(botId: string): boolean;
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

export const unregisteredTool = (name: string) => new Error(`未注册工具：${name}`);
