/// <reference lib="webworker" />

import { exportAv1Mp4, exportHevcMp4, exportMp4, exportWebM } from './webm-export.js';
import type { OfflineAudioRequest, OfflineFrameRequest } from './webm-export.js';
import type {
  ExportWorkerAudioResponse,
  ExportWorkerFrameResponse,
  ExportWorkerRequest,
  ExportWorkerResponse,
  ExportWorkerStartRequest,
} from './worker-protocol.js';

const scope = self as DedicatedWorkerGlobalScope;
let controller: AbortController | undefined;
let nextRequestId = 1;
const frames = new Map<
  number,
  { readonly resolve: (frame: VideoFrame) => void; readonly reject: (error: Error) => void }
>();
const audio = new Map<
  number,
  {
    readonly resolve: (pcm: Float32Array<ArrayBuffer>) => void;
    readonly reject: (error: Error) => void;
  }
>();

function post(response: ExportWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(response, transfer);
}

function errorIdentity(error: unknown): { code: string; message: string; aborted: boolean } {
  const aborted = error instanceof DOMException && error.name === 'AbortError';
  if (error !== null && typeof error === 'object') {
    const diagnostics: unknown = Reflect.get(error, 'diagnostics');
    if (Array.isArray(diagnostics)) {
      const first: unknown = (diagnostics as readonly unknown[])[0];
      if (first !== null && typeof first === 'object') {
        const code: unknown = Reflect.get(first, 'code');
        const message: unknown = Reflect.get(first, 'message');
        if (typeof code === 'string' && typeof message === 'string') return { code, message, aborted };
      }
    }
  }
  return {
    code: aborted ? 'OPERATION_ABORTED' : 'EXPORT_WORKER_FAILED',
    message: error instanceof Error ? error.message : 'Export Worker failed',
    aborted,
  };
}

function requestFrame(request: OfflineFrameRequest): Promise<VideoFrame> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    frames.set(id, { resolve, reject });
    post({ type: 'render-frame', id, request });
  });
}

function requestAudio(request: OfflineAudioRequest): Promise<Float32Array<ArrayBuffer>> {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    audio.set(id, { resolve, reject });
    post({ type: 'render-audio', id, request });
  });
}

function frameResponse(response: ExportWorkerFrameResponse): void {
  const pending = frames.get(response.id);
  if (pending === undefined) {
    response.frame?.close();
    return;
  }
  frames.delete(response.id);
  if (response.frame !== undefined) pending.resolve(response.frame);
  else pending.reject(new Error(response.error ?? 'Frame rendering failed'));
}

function audioResponse(response: ExportWorkerAudioResponse): void {
  const pending = audio.get(response.id);
  if (pending === undefined) return;
  audio.delete(response.id);
  if (response.pcm !== undefined) pending.resolve(response.pcm);
  else pending.reject(new Error(response.error ?? 'Audio rendering failed'));
}

async function start(request: ExportWorkerStartRequest): Promise<void> {
  if (controller !== undefined) {
    post({
      type: 'failed',
      code: 'EXPORT_WORKER_BUSY',
      message: 'Export Worker is busy',
      aborted: false,
    });
    return;
  }
  controller = new AbortController();
  try {
    const run =
      request.profile === 'mp4'
        ? exportMp4
        : request.profile === 'mp4-av1'
          ? exportAv1Mp4
          : request.profile === 'mp4-hevc'
            ? exportHevcMp4
            : exportWebM;
    const result = await run({
      ...request.config,
      sink: request.sink,
      signal: controller.signal,
      renderFrame: requestFrame,
      renderAudio: requestAudio,
      onProgress: (value) => post({ type: 'progress', value }),
    });
    post({ type: 'completed', result });
  } catch (error) {
    post({ type: 'failed', ...errorIdentity(error) });
  } finally {
    controller = undefined;
  }
}

scope.addEventListener('message', (event: MessageEvent<ExportWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'start') void start(request);
  else if (request.type === 'cancel') {
    controller?.abort(new DOMException(request.reason, 'AbortError'));
    for (const pending of frames.values()) pending.reject(new DOMException(request.reason, 'AbortError'));
    for (const pending of audio.values()) pending.reject(new DOMException(request.reason, 'AbortError'));
    frames.clear();
    audio.clear();
  } else if (request.type === 'frame-response') frameResponse(request);
  else audioResponse(request);
});
