// The IPC contract between the preload bridge and the main process. Every channel string lives here so the
// renderer-facing API (AelionAPI) and the main-process handlers are checked against the same table.
import type { AelionAPI } from './types/core';
import type { AttachmentScope, DroppedAttachment } from './types/attachment-types';
import type { GameAPI } from './types/game-types';

export const INVOKE_CHANNELS = {
  // Design
  designSystem: 'design:system',
  createDesignSession: 'design:create',
  updateDesignSession: 'design:update',
  sendDesignMessage: 'design:send',
  acceptDesignSession: 'design:accept',
  listDesignWorkspace: 'design:workspace',
  importDesignSystem: 'design:import-system',
  listDesignFonts: 'design:fonts-list',
  searchDesignFonts: 'design:fonts-search',
  acquireDesignFont: 'design:fonts-acquire',
  importDesignFonts: 'design:fonts-import',
  applyDesignFont: 'design:fonts-apply',
  checkDesignFonts: 'design:fonts-check',
  exportDesignFile: 'design:export-file',
  exportDesignProject: 'design:export-project',
  // Preview
  focusPreviewFeedback: 'preview:focus-feedback',
  patchPreviewHtml: 'preview:html-edits',
  updatePreviewFeedbackOverlay: 'preview-feedback:overlay',
  sendPreviewFeedback: 'preview:feedback',
  acknowledgePreview: 'preview:acknowledge',
  // Web preview
  captureWebPreviewMenu: 'web-preview:menu-capture',
  freezeWebPreview: 'web-preview:freeze',
  previewEditorCommand: 'web-preview:editor',
  openWebPreview: 'web-preview:open',
  layoutWebPreview: 'web-preview:layout',
  webPreviewAction: 'web-preview:action',
  closeWebPreview: 'web-preview:close',
  webPreviewAppearance: 'web-preview:appearance',
  layoutWebPreviewMirror: 'web-preview:mirror',
  // Chat
  send: 'chat:send',
  resumeChat: 'chat:resume',
  pinChat: 'chat:pin',
  cancel: 'chat:cancel',
  readToolResult: 'chat:tool-result',
  compactContext: 'context:compact',
  setBackgroundLearning: 'cognition:learning',
  // Groups
  pinGroup: 'groups:pin',
  createGroup: 'groups:create',
  updateGroup: 'groups:update',
  deleteGroup: 'groups:delete',
  readGroup: 'groups:read',
  sendGroup: 'groups:send',
  markGroupRead: 'groups:read-mark',
  stopGroup: 'groups:stop',
  continueGroup: 'groups:continue',
  // Peers
  readPrivateChat: 'peers:read',
  cancelPeerExchange: 'peers:cancel',
  // Bots
  createBot: 'bot:create',
  deleteBot: 'bot:delete',
  updateBot: 'bot:update',
  // Models and providers
  saveModel: 'model:save',
  testModel: 'model:test',
  saveProvider: 'providers:save',
  refreshProviderModels: 'providers:models',
  updateProviderModel: 'providers:model',
  removeProvider: 'providers:remove',
  setApprovalModel: 'models:approval',
  setDefaultModel: 'models:default',
  setBotModel: 'models:bot',
  imageProtocols: 'image:protocols',
  testImageModel: 'image:test',
  queryUsage: 'usage:query',
  // Attachments
  pickAttachments: 'attachments:pick',
  prepareAttachmentPaste: 'attachments:paste-prepare',
  applyAttachmentDrop: 'attachments:drop-apply',
  pasteAttachments: 'attachments:paste',
  importAttachments: 'attachments:import',
  previewAttachment: 'attachments:preview',
  saveAttachment: 'attachments:save',
  readEditableAttachment: 'attachments:edit-read',
  // Files
  listFiles: 'files:list',
  previewFile: 'files:preview',
  setPreviewDirty: 'files:edit-dirty',
  readEditableFile: 'files:edit-read',
  saveEditableFile: 'files:edit-save',
  exportEditedText: 'files:edit-export',
  listWorkspaceDirectory: 'files:directory',
  openPreviewFile: 'files:open-with',
  openFile: 'files:open',
  exportFile: 'files:export',
  // Work computer
  vmAction: 'vm:action',
  saveVmStorageSettings: 'vm:storage-save',
  reclaimVmStorage: 'vm:storage-reclaim',
  vmTerminal: 'vm:terminal',
  screenshot: 'computer:screenshot',
  ensureComputerDesktop: 'computer:ensure',
  setComputerControl: 'computer:control',
  setComputerFullscreen: 'computer:fullscreen',
  openComputerApp: 'computer:open-app',
  // App, settings and updates
  snapshot: 'app:snapshot',
  openData: 'app:open-data',
  openExternalUrl: 'app:open-external-url',
  saveAppearanceSettings: 'appearance:save',
  saveUserProfile: 'profile:save',
  saveRuntimeSettings: 'runtime:save',
  setWindowDimmed: 'window:dimmed',
  prepareDiagnostics: 'diagnostics:prepare',
  exportDiagnostics: 'diagnostics:export',
  openDiagnosticIssue: 'diagnostics:issue',
  updateState: 'updates:state',
  checkForUpdates: 'updates:check',
  downloadUpdate: 'updates:download',
  cancelUpdateDownload: 'updates:cancel',
  installUpdate: 'updates:install',
  openUpdateRelease: 'updates:open-release',
  // Integrations, skills and MCP
  refreshIntegrations: 'integrations:refresh',
  addIntegrationSource: 'integrations:add-source',
  importMcpSnippet: 'integrations:import-mcp',
  openIntegrationPath: 'integrations:open-path',
  manageSkill: 'skills:manage',
  setSkillEnabled: 'skills:enabled',
  readSkill: 'skills:read',
  setMcpEnabled: 'mcp:enabled',
  testMcp: 'mcp:test',
  // Experimental local decision model
  installLaya: 'laya:install',
  selectLaya: 'laya:select',
  setLayaEnabled: 'laya:enabled',
  cancelLayaInstall: 'laya:cancel',
  // Scheduled tasks and work items
  createScheduledTask: 'tasks:create',
  updateScheduledTask: 'tasks:update',
  deleteScheduledTask: 'tasks:delete',
  runScheduledTask: 'tasks:run',
  workAction: 'work:action',
  stopLiveWork: 'work:stop-live',
  // Permissions and workspaces
  setHostPermissionMode: 'permissions:mode',
  setCommandPermissionEnabled: 'permissions:command-enabled',
  removeCommandPermission: 'permissions:command-remove',
  respondInteraction: 'interaction:respond',
  searchMentionFiles: 'workspace:mention-files',
  pickConversationWorkspace: 'workspace:pick',
  resetConversationWorkspace: 'workspace:reset',
  saveHostWorkspace: 'host:workspace-save',
  pickHostWorkspace: 'host:workspace-pick',
} as const satisfies Partial<Record<keyof AelionAPI, string>>;

export const GAME_CHANNELS = {
  inspect: 'games:inspect',
  create: 'games:create',
  read: 'games:read',
  act: 'games:act',
  control: 'games:control',
} as const satisfies Record<keyof GameAPI, string>;

export const EVENT_CHANNELS = {
  onEvent: 'app:event',
  onPreviewSave: 'web-preview:save',
  onPreviewEditor: 'web-preview:editor-event',
  onPreviewFeedbackInput: 'preview-feedback:input',
  onWebPreview: 'web-preview:event',
  onWebPreviewEscape: 'web-preview:escape',
} as const satisfies Partial<Record<keyof AelionAPI, string>>;

// Calls the preload makes on the renderer's behalf; they are not part of AelionAPI.
interface InternalAPI {
  // prepareAttachmentDrop resolves File objects to host paths in the preload, then sends only the paths.
  prepareAttachmentDropPaths(input: { scope: AttachmentScope; paths: string[] }): Promise<DroppedAttachment[]>;
}

export const INTERNAL_CHANNELS = {
  prepareAttachmentDropPaths: 'attachments:drop-prepare',
} as const satisfies Record<keyof InternalAPI, string>;

type InvokeMethod = keyof typeof INVOKE_CHANNELS;
type GameMethod = keyof typeof GAME_CHANNELS;

// Everything the main process answers with ipcMain.handle, keyed by API method name. Game methods are
// namespaced as `games.<method>` because they live on AelionAPI['games'].
type IpcContract = { [M in InvokeMethod]: AelionAPI[M] } & { [M in GameMethod as `games.${M}`]: GameAPI[M] } & {
  [M in keyof InternalAPI]: InternalAPI[M];
};
export type IpcMethod = keyof IpcContract;
export type IpcHandler<M extends IpcMethod> = (
  ...args: Parameters<IpcContract[M]>
) => ReturnType<IpcContract[M]> | Awaited<ReturnType<IpcContract[M]>>;

export const IPC_CHANNELS: Readonly<Record<IpcMethod, string>> = {
  ...INVOKE_CHANNELS,
  ...(Object.fromEntries(Object.entries(GAME_CHANNELS).map(([method, channel]) => ['games.' + method, channel])) as {
    [M in GameMethod as `games.${M}`]: (typeof GAME_CHANNELS)[M];
  }),
  ...INTERNAL_CHANNELS,
};
