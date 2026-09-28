import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AelionAPI } from '../shared/types/core';
import { EVENT_CHANNELS, GAME_CHANNELS, INTERNAL_CHANNELS, INVOKE_CHANNELS } from '../shared/ipc';

type InvokeAPI = Pick<AelionAPI, keyof typeof INVOKE_CHANNELS>;
const invoke = Object.fromEntries(
  Object.entries(INVOKE_CHANNELS).map(([method, channel]) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  ]),
) as InvokeAPI;
type EventMethod = keyof typeof EVENT_CHANNELS;
type EventValue<M extends EventMethod> = Parameters<Parameters<AelionAPI[M]>[0]>[0];
const subscribe =
  <M extends EventMethod>(method: M) =>
  (callback: (value: EventValue<M>) => void) => {
    const channel = EVENT_CHANNELS[method],
      handler = (_event: unknown, value: EventValue<M>) => callback(value);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
const api: AelionAPI = {
  ...invoke,
  games: {
    inspect: (input) => ipcRenderer.invoke(GAME_CHANNELS.inspect, input),
    create: (input) => ipcRenderer.invoke(GAME_CHANNELS.create, input),
    read: (input) => ipcRenderer.invoke(GAME_CHANNELS.read, input),
    act: (input) => ipcRenderer.invoke(GAME_CHANNELS.act, input),
    control: (input) => ipcRenderer.invoke(GAME_CHANNELS.control, input),
  },
  onEvent: subscribe('onEvent'),
  onPreviewSave: subscribe('onPreviewSave'),
  onPreviewEditor: subscribe('onPreviewEditor'),
  onPreviewFeedbackInput: subscribe('onPreviewFeedbackInput'),
  onWebPreview: subscribe('onWebPreview'),
  onWebPreviewEscape: subscribe('onWebPreviewEscape'),
  prepareAttachmentDrop: async (input) => {
    if (!Array.isArray(input.files) || input.files.length > 10) throw Error('一次最多拖入 10 个文件或文件夹');
    const paths: string[] = [],
      virtualIndexes: number[] = [];
    input.files.forEach((file, index) => {
      const path = webUtils.getPathForFile(file);
      if (path) paths.push(path);
      else virtualIndexes.push(index);
    });
    return {
      entries: await ipcRenderer.invoke(INTERNAL_CHANNELS.prepareAttachmentDropPaths, {
        scope: input.scope,
        paths,
      }),
      virtualIndexes,
    };
  },
};
contextBridge.exposeInMainWorld('aelion', api);
