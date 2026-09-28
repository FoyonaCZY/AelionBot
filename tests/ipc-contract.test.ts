import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { EVENT_CHANNELS, GAME_CHANNELS, INTERNAL_CHANNELS, INVOKE_CHANNELS, IPC_CHANNELS } from '../shared/ipc';
import type { IpcContext } from '../electron/ipc/context';
import type { AelionAPI } from '../shared/types/core';

// The IPC modules import Electron at load time, which only resolves inside an Electron process. Swap in a
// stub; its bindings are fixed on first import, so tests fill in the members of these shared objects.
const ELECTRON_EXPORTS = [
  'app',
  'BrowserWindow',
  'clipboard',
  'contextBridge',
  'dialog',
  'ipcMain',
  'ipcRenderer',
  'Menu',
  'nativeImage',
  'nativeTheme',
  'net',
  'protocol',
  'safeStorage',
  'session',
  'shell',
  'WebContentsView',
  'webUtils',
];
const STUB_URL = 'aelion-test:electron';
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'electron' ? { url: STUB_URL, shortCircuit: true } : next(specifier, context),
  load: (url, context, next) =>
    url === STUB_URL
      ? {
          format: 'module',
          shortCircuit: true,
          source: ELECTRON_EXPORTS.map((name) => `export const ${name} = globalThis.__electronStub.${name};`).join(
            '\n',
          ),
        }
      : next(url, context),
});
const stub: Record<string, Record<string, unknown>> = Object.fromEntries(ELECTRON_EXPORTS.map((name) => [name, {}]));
(globalThis as { __electronStub?: typeof stub }).__electronStub = stub;

const invokeChannels = [
  ...Object.values(INVOKE_CHANNELS),
  ...Object.values(GAME_CHANNELS),
  ...Object.values(INTERNAL_CHANNELS),
];

test('every IPC channel is unique across invoke, game, internal and event tables', () => {
  const all = [...invokeChannels, ...Object.values(EVENT_CHANNELS)];
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(new Set(Object.values(IPC_CHANNELS)), new Set(invokeChannels));
});

test('the main process registers exactly the invoke channels in the contract', async () => {
  const registered: string[] = [];
  stub.ipcMain.handle = (channel: string) => registered.push(channel);
  const { registerIpc } = await import('../electron/ipc');
  const { installComputerView } = await import('../electron/core/vm/computer-view');
  const methods: string[] = [];
  // Registration only reads a few services to build helpers; handlers are never called here.
  const known: Record<string, unknown> = {
    handle: (method: string) => methods.push(method),
    store: { dir: tmpdir() },
  };
  const ctx = new Proxy(known, { get: (target, key) => (key in target ? target[key as string] : {}) });
  registerIpc(ctx as unknown as IpcContext);
  // computer:fullscreen lives with the window's fullscreen state and registers itself on ipcMain.
  installComputerView({ webContents: { on() {} }, once() {} } as never);

  assert.equal(new Set(methods).size, methods.length, 'a method is registered twice');
  assert.deepEqual(new Set(methods), new Set(Object.keys(IPC_CHANNELS).filter((m) => m !== 'setComputerFullscreen')));
  const channels = [...methods.map((method) => IPC_CHANNELS[method as keyof typeof IPC_CHANNELS]), ...registered];
  assert.equal(channels.length, invokeChannels.length);
  assert.deepEqual(new Set(channels), new Set(invokeChannels));
});

test('the preload exposes an AelionAPI whose methods use the contract channels', async () => {
  const invoked: unknown[][] = [],
    listeners = new Map<string, unknown>();
  let exposed: { key: string; api: AelionAPI } | undefined;
  Object.assign(stub.ipcRenderer, {
    invoke: async (...args: unknown[]) => (invoked.push(args), 'result'),
    on: (channel: string, handler: unknown) => listeners.set(channel, handler),
    removeListener: (channel: string, handler: unknown) => {
      if (listeners.get(channel) === handler) listeners.delete(channel);
    },
  });
  stub.contextBridge.exposeInMainWorld = (key: string, api: AelionAPI) => (exposed = { key, api });
  stub.webUtils.getPathForFile = (file: { path?: string }) => file.path || '';
  await import('../electron/preload');
  assert.equal(exposed?.key, 'aelion');
  const api = exposed!.api as unknown as Record<string, unknown> & AelionAPI;

  for (const [method, channel] of Object.entries(INVOKE_CHANNELS)) {
    assert.equal(typeof api[method], 'function', method);
    invoked.length = 0;
    assert.equal(await (api[method] as (...args: unknown[]) => Promise<unknown>)('a', 'b'), 'result');
    assert.deepEqual(invoked, [[channel, 'a', 'b']], method);
  }
  for (const [method, channel] of Object.entries(GAME_CHANNELS)) {
    invoked.length = 0;
    await (api.games[method as keyof typeof GAME_CHANNELS] as (input: unknown) => Promise<unknown>)({ id: 'g' });
    assert.deepEqual(invoked, [[channel, { id: 'g' }]], method);
  }
  for (const [method, channel] of Object.entries(EVENT_CHANNELS)) {
    const received: unknown[] = [];
    const unsubscribe = (api[method] as (callback: (value: unknown) => void) => () => void)((value) =>
      received.push(value),
    );
    (listeners.get(channel) as (event: unknown, value: unknown) => void)({}, 'payload');
    assert.deepEqual(received, ['payload'], method);
    unsubscribe();
    assert.equal(listeners.has(channel), false, method);
  }

  invoked.length = 0;
  const scope = { kind: 'bot' as const, id: 'b' };
  const drop = await api.prepareAttachmentDrop({
    scope,
    files: [{ path: 'C:/a.txt' }, {}] as unknown as File[],
  });
  assert.deepEqual(drop, { entries: 'result', virtualIndexes: [1] });
  assert.deepEqual(invoked, [[INTERNAL_CHANNELS.prepareAttachmentDropPaths, { scope, paths: ['C:/a.txt'] }]]);
});
