import { LayaDecisionLog } from './core/model/laya-decision-log';
import { LayaGroupDecisions } from './core/group/laya-decision';
import { gameProviders } from './core/games/providers';
import { GameRuntime } from './core/games/runtime';
import { gameInstructions, gamePrompt, parseGameAction } from './core/games/model-player';
import { BotRuntime } from './core/agent/bot-runtime';
import { DesignerLoop } from './core/designer/designer-loop';
import { DesignerFiles } from './core/designer/designer-files';
import { DesignStore } from './core/designer/design-store';
import { DesignSystems } from './core/designer/design-systems';
import { DesignCraft } from './core/designer/design-craft';
import { DesignFonts } from './core/designer/design-fonts';
import { renderCanvasExport } from './windows/canvas-export-renderer';
import { WebPreviewBrowser } from './windows/web-preview';
import { protocol } from 'electron';
import { VideoInspector } from './windows/video-inspector';
import { VideoFrames } from './core/preview/video-frames';
import { AgentPreviews } from './core/preview/agent-previews';
import { normalizeAppearance, type AppearanceSettings } from '../shared/preview/appearance';
import { createMacUpdater, macAutomaticUpdates } from './core/app/mac-updater';
import { hostEnvironment } from './core/host/host-platform';
import { RunPolicy } from './core/agent/runtime-policy';
import { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, Menu, nativeImage, nativeTheme, net } from 'electron';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from './core/storage/store';
import { VmController } from './core/vm/vm';
import { ModelClient } from './core/model/model';
import { ModelProviders } from './core/model/model-providers';
import { Harness } from './core/agent/harness';
import { ComputerController } from './core/vm/computer';
import { installComputerView } from './core/vm/computer-view';
import { Attachments } from './core/attachments/attachments';
import { ArtifactService } from './core/attachments/artifacts';
import { Integrations } from './core/extensions/integrations';
import { Interactions } from './core/agent/interactions';
import { HostComputer, redactHost } from './core/host/host';
import { HostApprovals, defaultPermissionReviewer, defaultApprovalModel } from './core/host/host-approvals';
import { CommandPermissions } from './core/host/command-permissions';
import { Cognition } from './core/memory/cognition';
import { PeerChats } from './core/peer/peer-chats';
import { GroupChats } from './core/group/group-chats';
import { LayaRuntime } from './core/model/laya-runtime';
import { LayaFeature } from './core/model/laya-feature';
import { ChatPinQueue } from './core/agent/chat-pins';
import { TaskScheduler } from './core/scheduler/task-scheduler';
import { groupPending } from '../shared/types/group-types';
import { peerPending } from '../shared/types/peer-types';
import { BotGreetings } from './core/agent/bot-greetings';
import { AppUpdates } from './core/app/app-updates';
import { Diagnostics } from './core/app/diagnostics';
import { slowOperations, watchEventLoop } from './core/app/slow-operations';
import { PowerShellParser } from './core/host/powershell-parser';
import { availableParallelism, release as osRelease, totalmem } from 'node:os';
import { createWindowsUpdater, UPDATE_REPOSITORY } from './core/app/windows-updater';
import {
  assertUpdateDataOutsideApp,
  loadUpdateLaunchContext,
  saveUpdateLaunchContext,
  type UpdateLaunchContext,
} from './core/app/update-launch-context';
import type { Snapshot } from '../shared/types/core';
import { Shutdown } from './core/app/shutdown';
import { IPC_CHANNELS, type IpcHandler, type IpcMethod } from '../shared/ipc';
import { registerIpc } from './ipc';

let window: BrowserWindow | undefined;
let previewDirty = false,
  previewWrites = 0;
let vm: VmController;
let store: Store;
let harness: BotRuntime;
let designSystems: DesignSystems;
let designStore: DesignStore;
let model: ModelClient;
let providers: ModelProviders;
let computer: ComputerController;
let artifacts: ArtifactService;
let videoInspector: VideoInspector;
let attachments: Attachments;
let integrations: Integrations;
let interactions: Interactions;
let host: HostComputer;
let commandPermissions: CommandPermissions;
let hostApprovals: HostApprovals;
// Parses host commands for the permission policy only; never executes them.
const powershellParser = new PowerShellParser();
let cognition: Cognition;
let peerChats: PeerChats | undefined;
let groupChats: GroupChats | undefined;
let games: GameRuntime | undefined;
let laya: LayaRuntime | undefined;
let layaFeature: LayaFeature | undefined;
let chatPins: ChatPinQueue | undefined;
let scheduler: TaskScheduler | undefined;
let greetings: BotGreetings | undefined;
protocol.registerSchemesAsPrivileged([
  { scheme: 'aelion-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
let webPreview: WebPreviewBrowser | undefined;
let appUpdates: AppUpdates | undefined;
let diagnostics: Diagnostics | undefined;
let agentPreviews: AgentPreviews | undefined;
process.on('uncaughtExceptionMonitor', (error, origin) => diagnostics?.record('process.' + origin, error));
let updatePreparing = false;
let timer: NodeJS.Timeout | undefined;
let polling = false;
let exiting = false;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(initialize)
    .catch((error) => {
      diagnostics?.record('app.startup-error', error);
      console.error(error);
      dialog.showErrorBox('AelionBot 启动失败', String(error.message));
      app.exit(1);
    });
}
function snapshot(): Snapshot {
  return {
    designer: designStore?.snapshot(),
    previewRequests: agentPreviews?.snapshot(),
    previewHistory: agentPreviews?.history(),
    appearance: normalizeAppearance(store?.data.appearance),
    userProfile: store.data.userProfile,
    platform: process.platform,
    workItems: store.data.workItems,
    conversationWorkspaces: store.data.conversationWorkspaces,
    updates: appUpdates?.snapshot(),
    scheduledTasks: store.data.scheduledTasks,
    bots: store.data.bots,
    messages: store.data.messages,
    runs: store.data.runs,
    model: providers.config(),
    providers: providers.list(),
    defaultModel: store.data.defaultModel,
    approvalModel: store.data.approvalModel,
    botModels: Object.fromEntries(store.data.bots.map((bot) => [bot.id, providers.config(bot.id)])),
    vm: vm.state,
    skills: integrations ? integrations.skills.all() : store.data.skills,
    artifacts: store.data.artifacts,
    computer: computer.state,
    dataDir: store.dir,
    integrations: integrations?.snapshot(),
    interactions: interactions?.snapshot() || [],
    cognition: cognition?.view(),
    peers: peerChats?.snapshot(),
    groups: groupChats?.snapshot(),
    layaFeature: layaFeature?.snapshot(),
    greetingBotIds: greetings?.botIds || [],
    streamingReplies: [...(harness?.streams.snapshot() || []), ...(greetings?.streams.snapshot() || [])],
    runtime: store ? new RunPolicy(store).settings() : undefined,
    modelUsage: store?.data.modelUsage?.slice(-100),
    commandPermissions: commandPermissions?.list() || [],
    hostPermissionModes: hostApprovals?.modes(),
    hostWorkspace: host?.workspaceSettings(),
    liveWork: harness?.liveWork() || [],
  };
}
// Changes arrive in bursts (a message, its run, a journal entry…). Coalesce each burst into one snapshot, and send
// at most one every STATE_INTERVAL_MS: a snapshot of a long history is ~20 MB that the renderer must deserialize on
// the thread that also handles scrolling and typing.
const STATE_INTERVAL_MS = 150;
let stateTimer: ReturnType<typeof setTimeout> | undefined,
  lastStateAt = 0,
  slow: ReturnType<typeof slowOperations> | undefined;
function sendState() {
  stateTimer = undefined;
  if (exiting) return;
  lastStateAt = Date.now();
  const started = performance.now();
  if (window && !window.isDestroyed()) window.webContents.send('app:event', { type: 'state', snapshot: snapshot() });
  slow?.('state-push', performance.now() - started);
}
function changed() {
  if (exiting) return;
  stateTimer ??= setTimeout(sendState, Math.max(0, lastStateAt + STATE_INTERVAL_MS - Date.now()));
  chatPins?.wake();
  peerChats?.wake();
  groupChats?.wake();
}
// Streaming text changes only the live replies; a pending full snapshot already carries them.
function streamsChanged() {
  if (exiting || stateTimer) return;
  if (window && !window.isDestroyed())
    window.webContents.send('app:event', {
      type: 'streams',
      streamingReplies: [...(harness?.streams.snapshot() || []), ...(greetings?.streams.snapshot() || [])],
    });
}
// Renderer arguments are untrusted at runtime; the contract types only describe what the preload sends.
function handle<M extends IpcMethod>(method: M, callback: IpcHandler<M>) {
  const channel = IPC_CHANNELS[method];
  ipcMain.handle(channel, async (event, ...args: Parameters<IpcHandler<M>>) => {
    if (!window || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('不受信任的调用来源');
    if (
      updatePreparing &&
      !['app:snapshot', 'updates:state', 'updates:open-release', 'window:dimmed'].includes(channel)
    )
      throw new Error('正在准备安装更新，请稍候');
    try {
      return await callback(...args);
    } catch (error) {
      diagnostics?.record('ipc.' + channel, error);
      throw error;
    }
  });
}
function beforeModelChange(botIds: string[]) {
  const busy = botIds.find((id) => updatePreparing || harness.isRunning(id));
  if (busy) throw new Error(`请等待 ${store.bot(busy).name} 的当前任务结束后修改模型`);
  cognition.learning.preempt();
  for (const id of botIds) greetings?.cancel(id);
}
function afterModelChange() {
  changed();
  chatPins?.wake();
  cognition.learning.schedule();
  void greetings?.greetEmpty();
}
async function initialize() {
  app.setAppUserModelId('com.aelion.bot');
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ])
      : null,
  );
  if (process.platform === 'darwin') process.env.PATH = hostEnvironment().PATH;
  const profileDir = app.getPath('userData');
  let launchContext: UpdateLaunchContext | undefined;
  try {
    launchContext = loadUpdateLaunchContext(profileDir, process.execPath);
  } catch (error) {
    if (!process.env.AELION_DATA_DIR) throw error;
  }
  const savedLaunch = process.env.AELION_DATA_DIR ? undefined : launchContext;
  const dataDir = process.env.AELION_DATA_DIR
    ? resolve(process.env.AELION_DATA_DIR)
    : savedLaunch?.dataDir || (app.isPackaged ? profileDir : resolve('.local/app'));
  const projectDir = resolve(process.env.AELION_PROJECT_DIR || savedLaunch?.projectDir || process.cwd());
  mkdirSync(dataDir, { recursive: true });
  store = new Store(dataDir, { incremental: true, deferWrites: true });
  providers = new ModelProviders(
    store,
    {
      encrypt: (value) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用，尚未保存 API Key');
        return safeStorage.encryptString(value).toString('base64');
      },
      decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
    },
    changed,
  );
  commandPermissions = new CommandPermissions(
    join(dataDir, 'command-permissions.json'),
    (value) => host?.redact(value) ?? redactHost(value),
  );
  interactions = new Interactions(
    () => {
      changed();
      if (
        window &&
        !window.isDestroyed() &&
        !window.isFocused() &&
        interactions
          .snapshot()
          .some((request) =>
            request.kind === 'host_permission' ? request.approval?.phase !== 'reviewing' : request.phase === 'waiting',
          )
      )
        window.flashFrame(true);
    },
    (request, decision, ruleId) =>
      store.journal('interaction.decision', {
        id: request.id,
        botId: request.botId,
        runId: request.runId,
        kind: request.kind,
        decision,
        ...(request.kind === 'host_permission' && request.approval ? { approval: request.approval } : {}),
        ...(ruleId ? { ruleId } : {}),
        time: new Date().toISOString(),
      }),
    commandPermissions,
  );
  vm = new VmController({
    dataDir,
    appVersion: app.getVersion(),
    wallpaperPath: join(app.getAppPath(), 'assets', 'wallpaper-light.png'),
    runtimeDir: app.isPackaged ? join(process.resourcesPath, 'qemu') : resolve('runtime/qemu'),
    cacheDir: app.isPackaged ? join(dataDir, 'downloads') : resolve('runtime/downloads'),
    downloadFetch: (url, options) => net.fetch(url, options),
  });
  computer = new ComputerController(vm, dataDir, changed);
  artifacts = new ArtifactService(store, vm);
  const imagePreview = (bytes: Buffer, id: string) => {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) return;
    const { width, height } = image.getSize();
    if (width * height > 64 * 1024 * 1024) return;
    const scale = Math.min(1, 2048 / width, 2048 / height),
      preview =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: 'best',
            })
          : image;
    writeFileSync(join(computer.imageDir, id + '.png'), preview.toPNG());
    return { id, ...preview.getSize() };
  };
  attachments = new Attachments(store, vm, artifacts, imagePreview);
  const homeDir = app.getPath('home');
  const configDir = resolve(process.env.AELION_CONFIG_HOME || savedLaunch?.configDir || join(homeDir, '.aelion'));
  diagnostics = new Diagnostics({
    dataDir,
    snapshot,
    paths: () => [
      dataDir,
      profileDir,
      homeDir,
      projectDir,
      configDir,
      app.getAppPath(),
      ...Object.values(store.data.conversationWorkspaces || {}),
    ],
    secrets: () => {
      let keys: string[] = [];
      try {
        keys = providers.secrets();
      } catch {}
      return [
        ...keys,
        ...Object.entries(process.env)
          .filter(([name]) => /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH/i.test(name))
          .map(([, value]) => value || ''),
      ];
    },
    environment: {
      appVersion: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osRelease: osRelease(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      packaged: app.isPackaged,
      cpuCount: availableParallelism(),
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
    },
  });
  diagnostics.record('app.started', `AelionBot ${app.getVersion()} (${process.platform} ${process.arch})`);
  slow = slowOperations((source, message) => diagnostics?.record(source, message));
  store.onWrite = (mode, ms) => slow?.('state-write', ms, mode);
  watchEventLoop((source, ms) => slow?.(source, ms));
  host = new HostComputer(
    {
      imagePreview,
      dataDir,
      homeDir,
      projectDir,
      runtimeDir: __dirname,
      env: { ...process.env },
      secrets: () => providers.secrets(),
    },
    interactions,
  );
  const bundledSkillDir = join(
    app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(),
    'assets',
    'skills',
  );
  integrations = new Integrations(
    store,
    { homeDir, projectDir, dataDir, configDir, bundledSkillDir, env: { ...process.env } },
    changed,
    (data, mime) => {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(mime) ||
        typeof data !== 'string' ||
        data.length > 12 * 1024 * 1024
      )
        throw new Error('MCP 图像类型或大小不受支持');
      const img = nativeImage.createFromDataURL(`data:${mime};base64,${data}`);
      const size = img.getSize();
      if (img.isEmpty() || size.width * size.height > 16 * 1024 * 1024) throw new Error('MCP 图像不可读或过大');
      const id = randomUUID();
      writeFileSync(join(computer.imageDir, `${id}.png`), img.toPNG());
      return { id, width: size.width, height: size.height };
    },
  );
  await integrations.refresh();
  model = new ModelClient(
    (botId) => providers.config(botId),
    (botId) => providers.key(botId),
    (id) => computer.image(id),
    () => new RunPolicy(store).settings(),
    (record) => {
      record.runId ||= store.data.runs.find((run) => run.botId === record.botId && run.status === 'running')?.id;
      (store.data.modelUsage ||= []).push(record);
      store.journal('model.usage', record);
      store.save();
      changed();
    },
  );
  const approvalModel = defaultApprovalModel(
    { config: () => providers.approvalConfig(), key: () => providers.approvalKey() },
    () => new RunPolicy(store).settings(),
    (record) => {
      (store.data.modelUsage ||= []).push(record);
      store.journal('model.usage', record);
      store.save();
      changed();
    },
  );
  hostApprovals = new HostApprovals(
    store,
    commandPermissions,
    defaultPermissionReviewer(
      approvalModel,
      () => providers.approvalConfig(),
      (text) => host.redact(text),
    ),
    {
      homeDir,
      defaultModel: () => providers.approvalConfig(),
      parsePowerShell: (command) => powershellParser.parse(command),
    },
  );
  interactions.setHostPolicy(hostApprovals);
  laya = new LayaRuntime(
    join(
      app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(),
      'assets',
      'laya',
      'sidecar.py',
    ),
    () => groupChats?.layaChanged(),
    { runtime: undefined },
  );
  const layaLog = new LayaDecisionLog(store.dir, () => groupChats?.layaChanged());
  layaFeature = new LayaFeature(store.dir, laya, changed);
  games = new GameRuntime(
    join(store.dir, 'games'),
    async (player, context, request, signal, options) => {
      const config = providers.config(undefined, player.model);
      const key = providers.key(undefined, player.model);
      const maxOutputTokens = new RunPolicy(store).settings().maxOutputTokens;
      if (!config.protocol || ['chat', 'responses'].includes(config.protocol)) {
        const entry = {
          id: 'desktop-game',
          name: '游戏模型',
          model: config.model,
          baseUrl: config.baseUrl,
          apiKey: key,
          backend: config.protocol === 'responses' ? ('responses' as const) : ('chat-completions' as const),
          reasoningEffort: config.reasoningEffort,
          contextTokens: config.contextTokens,
          maxOutputTokens,
        };
        const registry = gameProviders({ ...entry, additionalProviders: [entry] });
        return registry.decide(
          { ...player, model: { providerId: entry.id, model: entry.model, contextTokens: entry.contextTokens } },
          context,
          request,
          signal,
          options,
        );
      }
      const result = await model.complete(
        [
          {
            role: 'system',
            content:
              gameInstructions(context, request) +
              (options?.retryFeedback ? '\n上次校验失败：' + options.retryFeedback : ''),
          },
          { role: 'user', content: gamePrompt(context, request) },
        ],
        [],
        signal,
        () => {},
        {
          config: { ...config, hostedWebSearch: false, hostedImageGeneration: false },
          key,
          maxOutputTokens,
          timeoutMs: 60000,
          retries: 0,
          cacheScope: context.id + ':' + player.id,
        },
      );
      return parseGameAction(result.content || '', request.kind, request);
    },
    (players) => {
      for (const p of players.filter((p) => !p.human)) {
        const config = providers.config(undefined, p.model);
        if (config.issue || !config.model) throw Error('请为所有 AI 配置有效模型');
        if (
          !providers.key(undefined, p.model) &&
          !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.baseUrl).hostname)
        )
          throw Error('模型缺少 API Key');
      }
    },
    { aiTimeoutMs: 90000 },
  );
  cognition = new Cognition(
    store,
    model,
    integrations.skills,
    changed,
    () => Boolean(updatePreparing || harness?.busy || groupChats?.busy),
    () => providers.secrets(),
  );
  agentPreviews = new AgentPreviews(store, artifacts, attachments, changed, host);
  const imageModelAccess = (botId: string) => providers.imageAccess(botId);
  const generalHarness = new Harness(
    store,
    vm,
    model,
    changed,
    computer,
    (botId, runId) => artifacts.collect(botId, runId),
    integrations,
    host,
    interactions,
    cognition,
    attachments,
  );
  generalHarness.setImageModel(imageModelAccess);
  designSystems = new DesignSystems(
    join(app.getAppPath(), 'assets', 'design-systems'),
    join(store.dir, 'design-system-cache'),
    join(store.dir, 'custom-design-systems'),
  );
  const designCraft = new DesignCraft(join(app.getAppPath(), 'assets', 'design-craft'));
  designStore = new DesignStore(store, designSystems, changed, () => host.workspaceSettings().workspaceDir);
  const designerFiles = new DesignerFiles(store, designStore);
  artifacts.designerFiles = designerFiles;
  artifacts.openLocal = (path) => shell.openPath(path);
  const designFonts = new DesignFonts({
    cacheDir: join(store.dir, 'font-cache'),
    files: designerFiles,
    fetch: (url, options) => net.fetch(url instanceof URL ? url.href : url, options),
  });
  const renderDesignPdf = async (html: string) => (await renderCanvasExport(html, 'pdf')).bytes;
  const designerLoop = new DesignerLoop(
    store,
    designStore,
    designSystems,
    designerFiles,
    model,
    cognition.context,
    generalHarness,
    artifacts,
    attachments,
    interactions,
    changed,
    {
      pdf: { render: renderDesignPdf },
      fonts: designFonts,
      craft: designCraft,
      imageModel: imageModelAccess,
    },
  );
  harness = new BotRuntime(store, generalHarness, designerLoop, changed, () => cognition.beforeRun());
  generalHarness.streams.onEmit = streamsChanged;
  designerLoop.streams.onEmit = streamsChanged;
  harness.setPreviewGateway(agentPreviews);
  videoInspector = new VideoInspector(join(app.getAppPath(), 'assets', 'video-inspector.html'));
  harness.setVideoFrames(
    new VideoFrames(
      host,
      attachments,
      join(computer.imageDir, 'video-frames'),
      (path, request, signal) => videoInspector.render(path, request, signal),
      () => {
        const ids = new Set<string>();
        for (const message of [...store.data.messages, ...store.data.peerMessages, ...store.data.groupRunMessages])
          if (message.screenshotId) ids.add(message.screenshotId);
        for (const history of [
          ...Object.values(store.data.conversations),
          ...Object.values(store.data.peerContexts),
          ...Object.values(store.data.groupContexts),
        ])
          for (const message of history) for (const image of message.images || []) ids.add(image.id);
        return ids;
      },
    ),
  );
  greetings = new BotGreetings(store, model, changed, (id) => updatePreparing || harness.isRunning(id));
  greetings.streams.onEmit = streamsChanged;
  peerChats = new PeerChats(
    store,
    {
      isRunning: (id) => updatePreparing || harness.isRunning(id) || Boolean(chatPins?.hasPending(id)),
      run: (id, input, options) => {
        groupChats?.preempt(id);
        greetings?.cancel(id);
        return harness.run(id, input, options);
      },
      cancel: (id) => harness.cancel(id),
    },
    changed,
    attachments,
  );
  harness.setPeerGateway(peerChats);
  peerChats.start();
  groupChats = new GroupChats(
    store,
    {
      isRunning: (id) => updatePreparing || harness.isRunning(id) || Boolean(chatPins?.hasPending(id)),
      run: (id, input, options) => {
        greetings?.cancel(id);
        return harness.run(id, input, options);
      },
      cancel: (id) => harness.cancel(id),
      refresh: (id) => harness.refreshGroup(id),
    },
    changed,
    attachments,
    host,
    new LayaGroupDecisions(laya, layaLog),
  );
  chatPins = new ChatPinQueue(
    store,
    {
      isRunning: (id) => updatePreparing || harness.isRunning(id),
      run: (id, input, options) => {
        greetings?.cancel(id);
        return harness.run(id, input, options);
      },
      refresh: (id) => {
        greetings?.cancel(id);
        const active = store.data.runs.find((run) => run.botId === id && run.status === 'running');
        groupChats?.yieldToUser(id);
        if (active) peerChats?.cancelRun(active);
        return harness.refreshInput(id);
      },
    },
    changed,
    attachments,
    host,
  );
  chatPins.wake();
  harness.setGroupGateway(groupChats);
  groupChats.start();
  scheduler = new TaskScheduler(
    store,
    {
      ready: (target) => {
        if (updatePreparing) return false;
        const ids =
          target.kind === 'bot'
            ? [target.id]
            : store.data.groups
                .find((room) => room.id === target.id)
                ?.members.filter((member) => !member.leftAt)
                .map((member) => member.id) || [];
        return (
          ids.length > 0 &&
          ids.every(
            (id) =>
              store.data.bots.some((bot) => bot.id === id) &&
              store.modelFor(id).model &&
              !store.modelFor(id).issue &&
              !harness.isRunning(id) &&
              !chatPins?.hasPending(id),
          ) &&
          !(
            target.kind === 'group' &&
            store.data.groupDeliveries.some(
              (delivery) => delivery.groupId === target.id && groupPending(delivery.status),
            )
          )
        );
      },
      send: (target, prompt, trigger) => {
        if (target.kind === 'bot') chatPins!.schedule(target.id, prompt, trigger);
        else groupChats!.schedule(target.id, prompt, trigger);
      },
    },
    changed,
  );
  harness.setTaskScheduler(scheduler);
  let pendingLaunch: UpdateLaunchContext | undefined;
  const updateBlocked = () => {
    if (previewDirty || previewWrites) return '请先保存预览中的修改，再更新应用。';
    if (updatePreparing) return '正在准备安装更新。';
    if (
      harness.busy ||
      groupChats?.busy ||
      store.data.peerExchanges.some((exchange) => peerPending(exchange.status)) ||
      greetings?.botIds.length ||
      store.data.bots.some((bot) => chatPins?.hasPending(bot.id)) ||
      store.data.groupDeliveries.some((delivery) => groupPending(delivery.status))
    )
      return '请先结束当前 Bot 任务，再重启更新。';
    if (
      interactions.snapshot().length ||
      Object.values(computer.state.desktops).some((desktop) => desktop.manualControl)
    )
      return '请先交还工作电脑并结束待处理操作。';
    if (vm.state.maintenance || ['preparing', 'starting', 'stopping'].includes(vm.state.status))
      return '工作电脑正在准备或维护，请稍后更新。';
  };
  appUpdates = new AppUpdates(
    process.platform === 'darwin'
      ? createMacUpdater(macAutomaticUpdates(process.resourcesPath))
      : createWindowsUpdater(process.execPath),
    app.getVersion(),
    UPDATE_REPOSITORY,
    ['win32', 'darwin'].includes(process.platform) && app.isPackaged,
    {
      blockedReason: updateBlocked,
      prepareInstall: async (version) => {
        const blocked = updateBlocked();
        if (blocked) throw new Error(blocked);
        assertUpdateDataOutsideApp(dataDir, dirname(process.execPath));
        assertUpdateDataOutsideApp(profileDir, dirname(process.execPath));
        updatePreparing = true;
        changed();
        cognition.learning.preempt();
        const resumeComputer = Boolean(vm.state.pid);
        try {
          if (vm.storage.snapshot().settings.reclaimAfterUpdate) {
            try {
              await vm.reclaimStorage(version);
            } catch (error) {
              await vm.stop();
              console.warn('更新空间回收已延后：', (error as Error).message);
            }
          } else await vm.stop();
          pendingLaunch = {
            version: 1,
            executable: process.execPath,
            dataDir,
            projectDir,
            configDir,
            resumeComputer,
            targetVersion: version,
          };
          saveUpdateLaunchContext(profileDir, pendingLaunch);
          store.save();
        } catch {
          updatePreparing = false;
          changed();
          cognition.learning.schedule();
          throw new Error('无法安全关闭工作电脑，请先在电脑设置中关闭后再更新。');
        }
      },
      recoverInstall: async () => {
        updatePreparing = false;
        if (pendingLaunch) {
          const resume = pendingLaunch.resumeComputer;
          saveUpdateLaunchContext(profileDir, { ...pendingLaunch, resumeComputer: false });
          pendingLaunch = undefined;
          if (resume) await vm.start().catch(() => {});
        }
        changed();
        cognition.learning.schedule();
      },
    },
    changed,
  );
  cognition.start();
  nativeTheme.themeSource = normalizeAppearance(store.data.appearance).theme;
  window = new BrowserWindow({
    width: 1420,
    height: 920,
    minWidth: 980,
    minHeight: 650,
    title: 'AelionBot',
    icon: join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#ffffff',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: { color: '#f7f7f7', symbolColor: '#555555', height: 38 } }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const canDiscardPreview = () => {
    if (previewWrites) {
      dialog.showMessageBoxSync(window!, {
        type: 'info',
        message: '文件正在保存，请稍后再关闭',
        buttons: ['继续等待'],
      });
      return false;
    }
    if (!previewDirty) return true;
    const choice = dialog.showMessageBoxSync(window!, {
      type: 'question',
      message: '预览中有未保存的修改',
      detail: '放弃后将丢失未保存的内容。',
      buttons: ['继续编辑', '放弃修改并关闭'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice !== 1) return false;
    previewDirty = false;
    return true;
  };
  window.on('close', (event) => {
    if (!canDiscardPreview()) event.preventDefault();
  });
  window.webContents.on('will-prevent-unload', (event) => {
    if (canDiscardPreview()) event.preventDefault();
  });
  installComputerView(window);
  webPreview = new WebPreviewBrowser(
    window,
    vm,
    artifacts,
    attachments,
    join(__dirname, 'preview-feedback-preload.cjs'),
    join(__dirname, 'web-preview-preload.cjs'),
  );
  window.on('unresponsive', () => diagnostics?.record('renderer.unresponsive', '页面未响应'));
  window.webContents.on('render-process-gone', (_event, details) =>
    diagnostics?.record('renderer.gone', `${details.reason}; exitCode=${details.exitCode}`),
  );
  window.webContents.on('did-fail-load', (_event, code, description) =>
    diagnostics?.record('renderer.load', `${code}: ${description}`),
  );
  window.webContents.on('console-message', (details) => {
    if (['warning', 'error'].includes(details.level) && details.frame === window?.webContents.mainFrame)
      diagnostics?.record('renderer.' + details.level, `${details.message}\nLine ${details.lineNumber}`);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault();
  });
  // Keep display zoom available even with the application menu disabled.
  const contents = window.webContents;
  let appearanceDimmed = false;
  const appearanceChrome = () => {
    if (!window || window.isDestroyed()) return;
    const dark = nativeTheme.shouldUseDarkColors;
    window.setBackgroundColor(dark ? '#202024' : '#ffffff');
    if (process.platform !== 'darwin' && !appearanceDimmed)
      window.setTitleBarOverlay({
        color: dark ? '#25232a' : '#f7f7f7',
        symbolColor: dark ? '#eeeaf2' : '#555555',
        height: 38,
      });
  };
  const applyNativeAppearance = (value: AppearanceSettings) => {
    nativeTheme.themeSource = value.theme;
    contents.setZoomFactor(value.zoom / 100);
    appearanceChrome();
  };
  const saveAppearance = (value: unknown) => {
    const previous = store.data.appearance,
      next = normalizeAppearance(value);
    store.data.appearance = next;
    try {
      store.save();
    } catch (error) {
      store.data.appearance = previous;
      throw error;
    }
    applyNativeAppearance(next);
    changed();
  };
  contents.on('did-finish-load', () => applyNativeAppearance(normalizeAppearance(store.data.appearance)));
  nativeTheme.on('updated', appearanceChrome);
  window.once('closed', () => nativeTheme.removeListener('updated', appearanceChrome));
  applyNativeAppearance(normalizeAppearance(store.data.appearance));
  contents.on('before-input-event', (event, input) => {
    if (
      input.type !== 'keyDown' ||
      !(process.platform === 'darwin' ? input.meta : input.control) ||
      input.alt ||
      input.isComposing
    )
      return;
    const zoomIn = input.key === '+' || input.key === '=' || input.code === 'NumpadAdd';
    const zoomOut = input.key === '-' || input.key === '_' || input.code === 'NumpadSubtract';
    const reset = !input.shift && (input.key === '0' || input.code === 'Numpad0');
    if (!zoomIn && !zoomOut && !reset) return;
    event.preventDefault();
    const percent = reset ? 100 : Math.round(contents.getZoomFactor() * 100) + (zoomIn ? 10 : -10);
    saveAppearance({ ...normalizeAppearance(store.data.appearance), zoom: Math.max(50, Math.min(200, percent)) });
  });
  registerIpc({
    get layaFeature() {
      return layaFeature;
    },
    handle,
    get window() {
      return window;
    },
    dataDir,
    get store() {
      return store;
    },
    get vm() {
      return vm;
    },
    get computer() {
      return computer;
    },
    get harness() {
      return harness;
    },
    generalHarness,
    get model() {
      return model;
    },
    get providers() {
      return providers;
    },
    get artifacts() {
      return artifacts;
    },
    get attachments() {
      return attachments;
    },
    get integrations() {
      return integrations;
    },
    get interactions() {
      return interactions;
    },
    get host() {
      return host;
    },
    get commandPermissions() {
      return commandPermissions;
    },
    get hostApprovals() {
      return hostApprovals;
    },
    get cognition() {
      return cognition;
    },
    get designSystems() {
      return designSystems;
    },
    get designStore() {
      return designStore;
    },
    designerFiles,
    designFonts,
    get peerChats() {
      return peerChats;
    },
    get groupChats() {
      return groupChats;
    },
    get games() {
      return games;
    },
    get chatPins() {
      return chatPins;
    },
    get scheduler() {
      return scheduler;
    },
    get greetings() {
      return greetings;
    },
    get webPreview() {
      return webPreview;
    },
    get appUpdates() {
      return appUpdates;
    },
    get diagnostics() {
      return diagnostics;
    },
    get agentPreviews() {
      return agentPreviews;
    },
    get updatePreparing() {
      return updatePreparing;
    },
    get previewDirty() {
      return previewDirty;
    },
    set previewDirty(value) {
      previewDirty = value;
    },
    get previewWrites() {
      return previewWrites;
    },
    set previewWrites(value) {
      previewWrites = value;
    },
    get appearanceDimmed() {
      return appearanceDimmed;
    },
    set appearanceDimmed(value) {
      appearanceDimmed = value;
    },
    snapshot,
    changed,
    beforeModelChange,
    afterModelChange,
    saveAppearance,
  });
  const shutdown = new Shutdown({
    stop: () => {
      vm.beginShutdown();
      if (timer) clearInterval(timer);
      for (const close of [
        () => appUpdates?.dispose(),
        () => scheduler?.dispose(),
        () => greetings?.dispose(),
        () => {
          for (const bot of store.data.bots) harness.cancel(bot.id);
        },
        () => providers.dispose(),
        () => games?.dispose(),
        () => layaFeature?.dispose(),
        () => laya?.dispose(),
        () => model?.dispose(),
        () => harness.disposeTools(),
        () => videoInspector?.dispose(),
        () => webPreview?.close(),
        () => chatPins?.dispose(),
        () => peerChats?.dispose(),
        () => groupChats?.dispose(),
        () => interactions.dispose(),
        () => host.dispose(),
      ])
        try {
          close();
        } catch (error) {
          diagnostics?.record('app.shutdown-error', error);
        }
    },
    closeWork: () => [harness.closeProcesses(), cognition.close(), integrations.close()],
    closeVm: () => vm.shutdownForExit(),
    closeState: () => {
      powershellParser.dispose();
      vm.dispose();
      store.close();
    },
    report: (error) => diagnostics?.record('app.shutdown-error', error),
    exit: () => {
      diagnostics?.dispose();
      app.exit(0);
    },
  });
  app.on('before-quit', (event) => {
    event.preventDefault();
    if (exiting || !canDiscardPreview()) return;
    exiting = true;
    void shutdown.run();
  });
  app.on('window-all-closed', () => app.quit());
  vm.on('state', changed);
  const dev = process.env.AELION_DEV_URL;
  if (dev) {
    if (new URL(dev).hostname !== '127.0.0.1') throw new Error('开发服务器必须在本机');
    await window.loadURL(dev);
  } else await window.loadFile(join(__dirname, '../dist/index.html'));
  window.show();
  appUpdates.startAutomaticChecks();
  void greetings.greetEmpty();
  for (const provider of providers.list()) void providers.prewarm(provider.id);
  await vm.refresh();
  if (exiting) return;
  if (launchContext?.resumeComputer && resolve(launchContext.dataDir).toLowerCase() === dataDir.toLowerCase()) {
    saveUpdateLaunchContext(profileDir, { ...launchContext, resumeComputer: false });
    await vm.start().catch(() => {});
  }
  if (exiting) return;
  scheduler.start();
  timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      await vm.refresh();
    } finally {
      polling = false;
    }
  }, 6000);
}
