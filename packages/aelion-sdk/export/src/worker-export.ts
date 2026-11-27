import { AelionError, type Disposable } from '@aelionsdk/core';

import { createSinkCompletionBarrier } from './sink-completion.js';
import type { WebMExportOptions, WebMExportResult } from './webm-export.js';
import type {
  ExportWorkerAudioRequest,
  ExportWorkerFrameRequest,
  ExportWorkerRequest,
  ExportWorkerResponse,
} from './worker-protocol.js';

export interface WorkerMuxedExportOptions extends WebMExportOptions {
  readonly profile: 'webm' | 'mp4' | 'mp4-av1' | 'mp4-hevc';
  readonly workerUrl?: string | URL;
}

export interface WorkerMuxedExporterSnapshot {
  readonly disposed: boolean;
  readonly running: boolean;
  readonly pendingHostRequests: number;
}

export interface WorkerMuxedExporterOptions {
  readonly workerUrl?: string | URL;
  readonly workerFactory?: () => Worker;
}

function copiedPcm(pcm: Float32Array): Float32Array<ArrayBuffer> {
  const copy = new Float32Array(pcm.length);
  copy.set(pcm);
  return copy;
}

export class WorkerMuxedExporter implements Disposable {
  readonly #worker: Worker;
  readonly #pendingHostRequests = new Set<number>();
  #disposed = false;
  #running = false;

  public constructor(options: WorkerMuxedExporterOptions = {}) {
    this.#worker =
      options.workerFactory?.() ??
      new Worker(options.workerUrl ?? new URL('./mux-export-worker.js', import.meta.url), {
        type: 'module',
        name: 'aelion-export-mux',
      });
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public snapshot(): WorkerMuxedExporterSnapshot {
    return {
      disposed: this.#disposed,
      running: this.#running,
      pendingHostRequests: this.#pendingHostRequests.size,
    };
  }

  public run(options: WorkerMuxedExportOptions): Promise<WebMExportResult> {
    if (this.#disposed) return Promise.reject(new ReferenceError('Export Worker is disposed'));
    if (this.#running) return Promise.reject(new TypeError('EXPORT_WORKER_BUSY'));
    if (options.signal?.aborted === true) {
      return Promise.reject(new DOMException('Export cancelled', 'AbortError'));
    }
    const sinkBarrier = createSinkCompletionBarrier(options.sink);
    this.#running = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        this.#running = false;
        options.signal?.removeEventListener('abort', onAbort);
        this.#worker.removeEventListener('message', onMessage);
        this.#worker.removeEventListener('error', onError);
        operation();
      };
      const respondFrame = (request: ExportWorkerFrameRequest): void => {
        this.#pendingHostRequests.add(request.id);
        void options.renderFrame(request.request, options.signal).then(
          (frame) => {
            this.#pendingHostRequests.delete(request.id);
            if (!this.#running) {
              frame.close();
              return;
            }
            this.#post({ type: 'frame-response', id: request.id, frame }, [frame]);
          },
          (error: unknown) => {
            this.#pendingHostRequests.delete(request.id);
            this.#post({
              type: 'frame-response',
              id: request.id,
              error: error instanceof Error ? error.message : 'Frame rendering failed',
            });
          },
        );
      };
      const respondAudio = (request: ExportWorkerAudioRequest): void => {
        this.#pendingHostRequests.add(request.id);
        void options.renderAudio(request.request, options.signal).then(
          (value) => {
            this.#pendingHostRequests.delete(request.id);
            if (!this.#running) return;
            const pcm = copiedPcm(value);
            this.#post({ type: 'audio-response', id: request.id, pcm }, [pcm.buffer]);
          },
          (error: unknown) => {
            this.#pendingHostRequests.delete(request.id);
            this.#post({
              type: 'audio-response',
              id: request.id,
              error: error instanceof Error ? error.message : 'Audio rendering failed',
            });
          },
        );
      };
      const onMessage = (event: MessageEvent<ExportWorkerResponse>): void => {
        const response = event.data;
        if (response.type === 'render-frame') respondFrame(response);
        else if (response.type === 'render-audio') respondAudio(response);
        else if (response.type === 'progress') options.onProgress?.(response.value);
        else if (response.type === 'completed') {
          void sinkBarrier.completion.then(
            () => settle(() => resolve(response.result)),
            (cause: unknown) => {
              const error =
                cause instanceof AelionError
                  ? cause
                  : new AelionError([
                      {
                        code: 'EXPORT_STORAGE_WRITE_FAILED',
                        severity: 'error',
                        message: `Export sink did not finalize: ${cause instanceof Error ? cause.message : 'unknown storage failure'}`,
                        recoverable: true,
                        cause,
                      },
                    ]);
              settle(() => {
                void Promise.resolve(options.cleanupSink?.(error)).then(
                  () => reject(error),
                  () => reject(error),
                );
              });
            },
          );
        } else {
          const error = response.aborted
            ? new DOMException(response.message, 'AbortError')
            : new AelionError([
                {
                  code: response.code,
                  severity: 'error',
                  message: response.message,
                  recoverable: true,
                },
              ]);
          settle(() => {
            sinkBarrier.abort(error);
            void sinkBarrier.completion
              .catch(() => undefined)
              .then(() => options.cleanupSink?.(error))
              .then(
                () => reject(error),
                () => reject(error),
              );
          });
        }
      };
      const onError = (event: ErrorEvent): void => {
        const error = new Error(event.message || 'Export Worker crashed');
        settle(() => {
          sinkBarrier.abort(error);
          void sinkBarrier.completion
            .catch(() => undefined)
            .then(() => options.cleanupSink?.(error))
            .then(
              () => reject(error),
              () => reject(error),
            );
        });
      };
      const onAbort = (): void => {
        this.#post({
          type: 'cancel',
          reason: options.signal?.reason instanceof Error ? options.signal.reason.message : 'Export cancelled',
        });
      };
      this.#worker.addEventListener('message', onMessage);
      this.#worker.addEventListener('error', onError);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const start: ExportWorkerRequest = {
        type: 'start',
        profile: options.profile,
        config: {
          durationUs: options.durationUs,
          width: options.width,
          height: options.height,
          frameRate: options.frameRate,
          sampleRate: options.sampleRate,
          channelCount: options.channelCount,
          videoBitrate: options.videoBitrate,
          audioBitrate: options.audioBitrate,
          ...(options.videoCodecString === undefined ? {} : { videoCodecString: options.videoCodecString }),
          ...(options.audioCodecString === undefined ? {} : { audioCodecString: options.audioCodecString }),
        },
        sink: sinkBarrier.writable,
      };
      this.#post(start, [sinkBarrier.writable]);
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#running = false;
    this.#pendingHostRequests.clear();
    this.#worker.terminate();
  }

  #post(request: ExportWorkerRequest, transfer: Transferable[] = []): void {
    if (!this.#disposed) this.#worker.postMessage(request, transfer);
  }
}

export async function exportMuxedInWorker(options: WorkerMuxedExportOptions): Promise<WebMExportResult> {
  const exporter = new WorkerMuxedExporter({
    ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
  });
  try {
    return await exporter.run(options);
  } finally {
    exporter.dispose();
  }
}
