import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store, type StoredProvider } from '../storage/store';
import { ModelProviders } from '../model/model-providers';
import { ModelClient } from '../model/model';
import { CommandPermissions } from '../host/command-permissions';
import { Interactions } from './interactions';
import { HostComputer, redactHost } from '../host/host';
import { HostApprovals, defaultPermissionReviewer } from '../host/host-approvals';
import { PowerShellParser } from '../host/powershell-parser';
import { Integrations } from '../extensions/integrations';
import { Cognition } from '../memory/cognition';
import { Harness } from './harness';
import { RunPolicy } from './runtime-policy';
import type { ApprovalAssessment, HostPermissionRequest } from '../host/host-approval-types';
import type { HostPermissionMode } from '../../../shared/types/permission-types';
import type { ModelProtocol } from '../../../shared/types/model-types';
import type { RunRecord } from '../../../shared/types/core';
import type { VmController } from '../vm/vm';
import { AppError } from '../../../shared/errors';

// workspace: ordinary project reads/edits and saved command rules only. auto: plus the approval model.
// full: everything. Whatever would wait for a person is denied, because nobody is there to answer.
export type HeadlessPermission = 'workspace' | 'auto' | 'full';
interface HeadlessModel {
  baseUrl: string;
  model: string;
  protocol?: ModelProtocol;
  contextTokens?: number;
  reasoningEffort?: string;
}
export interface HeadlessOptions {
  prompt: string;
  workspaceDir: string;
  dataDir: string;
  apiKey?: string;
  model?: HeadlessModel;
  botId?: string;
  permission?: HeadlessPermission;
  timeoutMs?: number;
  homeDir?: string;
  configDir?: string;
  runtimeDir?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onEvent?: (event: HeadlessEvent) => void;
  /** Tests only: replaces the model client. */
  modelClient?: ModelClient;
}
export type HeadlessEvent =
  | { type: 'started'; runId: string; botId: string; botName: string }
  | { type: 'tool'; tool: string; status: 'done' | 'failed'; detail?: string }
  | { type: 'denied'; tool?: string; operation: string; target?: string };
export interface HeadlessResult {
  status: RunRecord['status'];
  runId?: string;
  botId: string;
  reply: string;
  error?: string;
  modelCalls: number;
  toolCalls: number;
  denied: number;
  executions: Array<{ tool: string; status: string; target?: string }>;
}

const HEADLESS_PROVIDER = 'headless-env';
// A run from a pipe or scheduler must not share one state file with a second headless run.
export function acquireHeadlessLock(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'headless.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, 'utf8') === String(process.pid)) rmSync(file, { force: true });
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(file, 'utf8'));
      let alive = false;
      try {
        if (Number.isInteger(owner) && owner > 0) {
          process.kill(owner, 0);
          alive = true;
        }
      } catch (probe) {
        alive = (probe as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive)
        throw new AppError(
          'headless.data_dir_in_use',
          `另一个 headless 任务（PID ${owner}）正在使用数据目录 ${dataDir}`,
        );
      rmSync(file, { force: true });
    }
  }
  throw Error('无法锁定 headless 数据目录');
}
class HeadlessApprovals extends HostApprovals {
  constructor(
    store: Store,
    commands: CommandPermissions,
    reviewer: ConstructorParameters<typeof HostApprovals>[2],
    options: ConstructorParameters<typeof HostApprovals>[3],
    private permission: HeadlessPermission,
  ) {
    super(store, commands, reviewer, options);
  }
  // The CLI flag decides for this run; stored per-Bot modes belong to the desktop app.
  override modeFor(_request: HostPermissionRequest): HostPermissionMode {
    return this.permission === 'full' ? 'full' : 'auto';
  }
  override assess(request: HostPermissionRequest): ApprovalAssessment {
    const assessment = super.assess(request);
    return this.permission === 'workspace' && assessment.kind === 'review'
      ? { kind: 'ask', mode: assessment.mode, reason: assessment.reason }
      : assessment;
  }
}
function configureModel(store: Store, model: HeadlessModel, botId: string) {
  if (!model.model.trim() || !model.baseUrl.trim()) throw Error('headless 模型需要 baseUrl 和 model');
  const contextTokens = model.contextTokens || 128000;
  const provider: StoredProvider = {
    id: HEADLESS_PROVIDER,
    name: 'Headless (environment)',
    baseUrl: model.baseUrl.trim(),
    models: [{ id: model.model.trim(), contextTokens }],
    ...(model.protocol ? { protocol: model.protocol } : {}),
  };
  const selection = {
    providerId: HEADLESS_PROVIDER,
    model: model.model.trim(),
    contextTokens,
    ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
  };
  // The key stays in memory; only the endpoint and model name are saved in the headless data directory.
  store.data.providers = [...(store.data.providers || []).filter((item) => item.id !== HEADLESS_PROVIDER), provider];
  store.data.defaultModel = selection;
  const bot = store.bot(botId);
  bot.model = selection;
  if (model.reasoningEffort) bot.reasoningEffort = model.reasoningEffort;
  store.save();
}
// Any VM call fails with an explanation instead of starting a work computer.
const noVm = new Proxy(
  { state: { status: 'unprepared', detail: 'headless', imageVersion: '' } },
  {
    get(target, key) {
      if (key in target) return target[key as 'state'];
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return () => {
        throw Error('headless 模式没有 Linux 工作电脑，请使用本机工具');
      };
    },
  },
) as unknown as VmController;

export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  if (!options.prompt.trim() || options.prompt.length > 32000) throw Error('任务为空或超过 32000 字符');
  const workspaceDir = realpathSync.native(resolve(options.workspaceDir));
  if (!statSync(workspaceDir).isDirectory()) throw Error('工作目录不存在');
  const dataDir = resolve(options.dataDir),
    homeDir = options.homeDir || homedir(),
    env = { ...(options.env || process.env) },
    permission = options.permission || 'workspace';
  const release = acquireHeadlessLock(dataDir);
  const store = new Store(dataDir, { incremental: true });
  let disposed = false;
  const cleanup: Array<() => unknown> = [];
  try {
    // Desktop keys are encrypted with the OS keychain via Electron; headless uses AELION_API_KEY instead.
    new ModelProviders(store, {
      encrypt: () => {
        throw Error('headless 模式不保存 API Key');
      },
      decrypt: () => {
        throw Error('headless 模式无法读取桌面端加密的 API Key');
      },
    });
    const bot = options.botId
      ? store.data.bots.find((item) => item.id === options.botId || item.name === options.botId)
      : store.data.bots[0];
    if (!bot) throw Error(`找不到 Bot：${options.botId}`);
    if (options.model) configureModel(store, options.model, bot.id);
    const key = options.apiKey || '',
      emit = options.onEvent || (() => {});
    let host!: HostComputer, interactions!: Interactions;
    const reported = new Set<string>();
    let runId: string | undefined,
      denied = 0;
    const changed = () => {
      if (disposed) return;
      for (const request of interactions?.snapshot() || [])
        if (request.kind === 'host_permission' && request.approval?.phase !== 'reviewing')
          queueMicrotask(() => {
            try {
              interactions.deny(
                request.id,
                `headless 运行无人确认，当前权限（${permission}）未放行此操作。需要时用 --permission auto 或 full 重新运行。`,
              );
              denied++;
              emit({
                type: 'denied',
                tool: request.details.tool,
                operation: request.details.operation,
                target: request.details.command || request.details.path || request.details.server,
              });
            } catch {
              /* already settled */
            }
          });
      if (runId)
        for (const message of store.runMessages(runId))
          if (
            message.role === 'tool' &&
            message.tool &&
            (message.status === 'done' || message.status === 'failed') &&
            !reported.has(message.id)
          ) {
            reported.add(message.id);
            emit({ type: 'tool', tool: message.tool, status: message.status, detail: message.activity?.label });
          }
    };
    const commands = new CommandPermissions(
      join(dataDir, 'command-permissions.json'),
      (value) => host?.redact(value) ?? redactHost(value),
    );
    interactions = new Interactions(
      changed,
      (request, decision, ruleId) => {
        try {
          store.journal('interaction.decision', {
            id: request.id,
            botId: request.botId,
            runId: request.runId,
            kind: request.kind,
            decision,
            ...(request.kind === 'host_permission' && request.approval ? { approval: request.approval } : {}),
            ...(ruleId ? { ruleId } : {}),
            headless: true,
            time: new Date().toISOString(),
          });
        } catch {}
      },
      commands,
    );
    cleanup.push(() => interactions.dispose());
    host = new HostComputer(
      {
        dataDir,
        homeDir,
        projectDir: workspaceDir,
        runtimeDir: options.runtimeDir,
        env,
        secrets: () => (key ? [key] : []),
      },
      interactions,
    );
    cleanup.push(() => host.dispose());
    const usage = (record: import('../../../shared/types/runtime-types').UsageRecord) => {
      record.runId ||= runId;
      (store.data.modelUsage ||= []).push(record);
      try {
        store.journal('model.usage', record);
      } catch {}
      store.save();
    };
    const model =
      options.modelClient ||
      new ModelClient(
        (id) => store.modelFor(id),
        () => key,
        undefined,
        () => new RunPolicy(store).settings(),
        usage,
      );
    cleanup.push(() => model.dispose?.());
    const powershell = new PowerShellParser();
    cleanup.push(() => powershell.dispose());
    const approvals = new HeadlessApprovals(
      store,
      commands,
      defaultPermissionReviewer(
        model,
        () => store.modelFor(bot.id),
        (text) => host.redact(text),
      ),
      {
        homeDir,
        defaultModel: () => ({ ...store.modelFor(bot.id), hasKey: Boolean(key) }),
        parsePowerShell: (command) => powershell.parse(command),
      },
      permission,
    );
    interactions.setHostPolicy(approvals);
    const integrations = new Integrations(
      store,
      {
        homeDir,
        projectDir: workspaceDir,
        dataDir,
        configDir: resolve(options.configDir || env.AELION_CONFIG_HOME || join(homeDir, '.aelion')),
        env,
        ...(options.runtimeDir && existsSync(join(options.runtimeDir, '..', 'assets', 'skills'))
          ? { bundledSkillDir: join(options.runtimeDir, '..', 'assets', 'skills') }
          : {}),
      },
      changed,
    );
    await integrations.refresh();
    cleanup.push(() => integrations.close());
    // Memory and context compaction run in the foreground; background learning stays queued for the desktop app.
    const cognition = new Cognition(
      store,
      model,
      integrations.skills,
      changed,
      () => true,
      () => (key ? [key] : []),
    );
    cleanup.push(() => cognition.close());
    const harness = new Harness(
      store,
      noVm,
      model,
      changed,
      undefined,
      undefined,
      integrations,
      host,
      interactions,
      cognition,
    );
    harness.setHeadless(true);
    cleanup.push(
      () => harness.disposeTools(),
      () => harness.closeProcesses(),
    );
    const controller = new AbortController(),
      stop = () => harness.cancel(bot.id);
    options.signal?.addEventListener('abort', stop, { once: true });
    cleanup.push(() => options.signal?.removeEventListener('abort', stop));
    const timer = options.timeoutMs
      ? setTimeout(() => {
          controller.abort();
          stop();
        }, options.timeoutMs)
      : undefined;
    cleanup.push(() => clearTimeout(timer));
    let failure: string | undefined;
    try {
      await harness.run(bot.id, options.prompt, {
        workspaceDir,
        onStarted: (id) => {
          runId = id;
          emit({ type: 'started', runId: id, botId: bot.id, botName: bot.name });
        },
      });
    } catch (error) {
      failure = (error as Error).message;
    }
    const run = runId ? store.data.runs.find((item) => item.id === runId) : undefined;
    const replies = runId
      ? store
          .runMessages(runId)
          .filter(
            (message) => message.role === 'assistant' && message.presentation !== 'progress' && message.content.trim(),
          )
      : [];
    const status = controller.signal.aborted && run?.status !== 'completed' ? 'cancelled' : run?.status || 'failed';
    return {
      status,
      runId,
      botId: bot.id,
      reply: replies.at(-1)?.content || '',
      ...(failure || run?.error
        ? { error: controller.signal.aborted ? '超过 --timeout 设置的时间' : run?.error || failure }
        : {}),
      modelCalls: run?.modelCalls || 0,
      toolCalls: run?.toolCalls || 0,
      denied,
      executions: (run?.executions || []).map((item) => ({
        tool: item.tool,
        status: item.status,
        ...(item.target ? { target: item.target } : {}),
      })),
    };
  } finally {
    disposed = true;
    for (const close of cleanup.reverse())
      try {
        await close();
      } catch {}
    store.close();
    release();
  }
}
