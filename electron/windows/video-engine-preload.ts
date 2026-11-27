// Preload bridge for the hidden sandboxed Aelion Video Engine window (aelion-video://engine/index.html).
import { contextBridge, ipcRenderer } from 'electron';

export interface VideoEngineRpcRequest {
  id: string;
  action: 'capabilities' | 'analyzeMedia' | 'renderFrames' | 'exportProject';
  payload: unknown;
}

export interface VideoEngineRpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface VideoEngineProgressEvent {
  jobId: string;
  progress: number;
  stage: string;
}

export interface VideoEngineExportChunk {
  jobId: string;
  position: number;
  data: Uint8Array;
}

export interface VideoEngineBridge {
  ready(): void;
  onRequest(listener: (req: VideoEngineRpcRequest) => void): () => void;
  sendResponse(res: VideoEngineRpcResponse): void;
  sendProgress(evt: VideoEngineProgressEvent): void;
  sendExportChunk(chunk: VideoEngineExportChunk): Promise<void>;
  onCancel(listener: (jobId: string) => void): () => void;
}

const bridge: VideoEngineBridge = {
  ready() {
    ipcRenderer.send('video-engine:ready');
  },
  onRequest(listener) {
    const handler = (_event: Electron.IpcRendererEvent, req: VideoEngineRpcRequest) => listener(req);
    ipcRenderer.on('video-engine:request', handler);
    return () => ipcRenderer.removeListener('video-engine:request', handler);
  },
  sendResponse(res) {
    ipcRenderer.send('video-engine:response', res);
  },
  sendProgress(evt) {
    ipcRenderer.send('video-engine:progress', evt);
  },
  sendExportChunk(chunk) {
    return ipcRenderer.invoke('video-engine:export-chunk', chunk) as Promise<void>;
  },
  onCancel(listener) {
    const handler = (_event: Electron.IpcRendererEvent, jobId: string) => listener(jobId);
    ipcRenderer.on('video-engine:cancel', handler);
    return () => ipcRenderer.removeListener('video-engine:cancel', handler);
  },
};

contextBridge.exposeInMainWorld('videoEngineBridge', bridge);
