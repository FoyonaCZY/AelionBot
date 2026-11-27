// Hidden sandboxed Chromium BrowserWindow running the AelionSDK render, media analysis, and export engine.
import { randomUUID } from 'node:crypto';
import { mkdirSync, unlinkSync } from 'node:fs';
import { open, rename, type FileHandle } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { AppError } from '../../shared/errors';
import type { VideoExportFormat, VideoMediaProbe } from '../../shared/types/video-studio-types';
import { VIDEO_ENGINE_SCHEME } from '../core/video/video-projects';
import type {
  EngineAnalyzeMediaPayload,
  EngineCapabilitiesResult,
  EngineExportPayload,
  EngineExportResult,
  EngineRenderFramesPayload,
  EngineRenderFramesResult,
} from './video-engine-entry';
import type { VideoEngineExportChunk, VideoEngineProgressEvent, VideoEngineRpcResponse } from './video-engine-preload';

export const VIDEO_ENGINE_PARTITION = 'aelion-video-engine';

export interface VideoEngineExportToFileRequest extends EngineExportPayload {
  outputPath: string;
  onProgress?: (event: VideoEngineProgressEvent) => void;
}

export interface VideoEngineExportToFileResult extends EngineExportResult {
  outputPath: string;
}

export interface VideoEngineBackend {
  isReady(): boolean;
  capabilities(): Promise<EngineCapabilitiesResult>;
  analyzeMedia(payload: EngineAnalyzeMediaPayload): Promise<VideoMediaProbe>;
  renderFrames(payload: EngineRenderFramesPayload): Promise<EngineRenderFramesResult>;
  exportProjectToFile(request: VideoEngineExportToFileRequest): Promise<VideoEngineExportToFileResult>;
  cancelExport(jobId: string): void;
  dispose(): void;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveExportWriter {
  handle: FileHandle;
  tmpPath: string;
  writeChain: Promise<void>;
  onProgress?: (event: VideoEngineProgressEvent) => void;
}

export class VideoEngineWindow implements VideoEngineBackend {
  private win?: BrowserWindow;
  private ready = false;
  private starting?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private disposed = false;

  private readonly pending = new Map<string, PendingRpc>();
  private readonly exportWriters = new Map<string, ActiveExportWriter>();
  private readonly preloadPath: string;

  private readonly onReadyIpc = (event: IpcMainEvent) => {
    if (!this.win || event.sender.id !== this.win.webContents.id) return;
    this.ready = true;
    this.readyResolve?.();
    this.readyResolve = undefined;
    this.readyReject = undefined;
  };

  private readonly onResponseIpc = (event: IpcMainEvent, res: VideoEngineRpcResponse) => {
    if (!this.win || event.sender.id !== this.win.webContents.id) return;
    const entry = this.pending.get(res.id);
    if (!entry) return;
    this.pending.delete(res.id);
    clearTimeout(entry.timer);
    if (res.ok) entry.resolve(res.result);
    else entry.reject(new AppError('video.export_failed', res.error || '视频引擎执行失败'));
  };

  private readonly onProgressIpc = (event: IpcMainEvent, evt: VideoEngineProgressEvent) => {
    if (!this.win || event.sender.id !== this.win.webContents.id) return;
    this.exportWriters.get(evt.jobId)?.onProgress?.(evt);
  };

  private readonly onExportChunkIpc = async (
    event: IpcMainInvokeEvent,
    chunk: VideoEngineExportChunk,
  ): Promise<void> => {
    if (!this.win || event.sender.id !== this.win.webContents.id) {
      throw new Error('Unauthorized export chunk sender');
    }
    if (
      !chunk ||
      typeof chunk.jobId !== 'string' ||
      !Number.isSafeInteger(chunk.position) ||
      chunk.position < 0 ||
      !(chunk.data instanceof Uint8Array)
    ) {
      throw new Error('Invalid export chunk payload');
    }
    const writer = this.exportWriters.get(chunk.jobId);
    if (!writer) throw new Error(`No active export writer for job ${chunk.jobId}`);
    const buf = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    const writeOp = writer.writeChain.then(async () => {
      await writer.handle.write(buf, 0, buf.byteLength, chunk.position);
    });
    writer.writeChain = writeOp.catch(() => {});
    await writeOp;
  };

  constructor(preloadPath = join(__dirname, 'video-engine-preload.cjs')) {
    this.preloadPath = preloadPath;
    ipcMain.on('video-engine:ready', this.onReadyIpc);
    ipcMain.on('video-engine:response', this.onResponseIpc);
    ipcMain.on('video-engine:progress', this.onProgressIpc);
    ipcMain.handle('video-engine:export-chunk', this.onExportChunkIpc);
  }

  isReady(): boolean {
    return this.ready && Boolean(this.win && !this.win.isDestroyed());
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.disposed) throw new AppError('video.engine_unavailable', '视频引擎已关闭');
    if (this.ready && this.win && !this.win.isDestroyed()) return this.win;
    if (this.starting) {
      await this.starting;
      if (this.win && !this.win.isDestroyed()) return this.win;
    }

    this.starting = new Promise<void>((resolveReady, rejectReady) => {
      const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 720,
        paintWhenInitiallyHidden: true,
        webPreferences: {
          preload: this.preloadPath,
          partition: VIDEO_ENGINE_PARTITION,
          backgroundThrottling: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webgl: true,
        },
      });
      this.win = win;
      this.ready = false;

      const failAll = (reason: string) => {
        clearTimeout(timer);
        this.ready = false;
        this.starting = undefined;
        const err = new AppError('video.engine_unavailable', reason);
        this.readyReject?.(err);
        this.readyResolve = undefined;
        this.readyReject = undefined;
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(err);
          this.pending.delete(id);
        }
      };

      const timer = setTimeout(() => {
        failAll('视频引擎启动超时');
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = undefined;
      }, 20_000);

      this.readyResolve = () => {
        clearTimeout(timer);
        resolveReady();
      };
      this.readyReject = (error) => {
        clearTimeout(timer);
        rejectReady(error);
      };

      win.webContents.on('render-process-gone', (_e, details) => {
        failAll(`视频引擎进程异常退出（${details.reason}）`);
        if (!win.isDestroyed()) win.destroy();
        if (this.win === win) this.win = undefined;
      });
      win.on('closed', () => {
        failAll('视频引擎窗口已关闭');
        if (this.win === win) this.win = undefined;
      });

      win.loadURL(`${VIDEO_ENGINE_SCHEME}://engine/index.html`).catch((error: Error) => {
        failAll(`视频引擎加载失败：${error.message}`);
      });
    });

    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
    if (!this.win || this.win.isDestroyed()) {
      throw new AppError('video.engine_unavailable', '视频引擎未能就绪');
    }
    return this.win;
  }

  private async rpc<T>(
    action: 'capabilities' | 'analyzeMedia' | 'renderFrames' | 'exportProject',
    payload: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const win = await this.ensureWindow();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('video.engine_unavailable', `视频引擎操作超时（${action}）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      win.webContents.send('video-engine:request', { id, action, payload });
    });
  }

  capabilities(): Promise<EngineCapabilitiesResult> {
    return this.rpc<EngineCapabilitiesResult>('capabilities', {}, 15_000);
  }

  analyzeMedia(payload: EngineAnalyzeMediaPayload): Promise<VideoMediaProbe> {
    return this.rpc<VideoMediaProbe>('analyzeMedia', payload, 120_000);
  }

  renderFrames(payload: EngineRenderFramesPayload): Promise<EngineRenderFramesResult> {
    return this.rpc<EngineRenderFramesResult>('renderFrames', payload, 120_000);
  }

  async exportProjectToFile(request: VideoEngineExportToFileRequest): Promise<VideoEngineExportToFileResult> {
    mkdirSync(dirname(request.outputPath), { recursive: true });
    const tmpPath = `${request.outputPath}.${randomUUID().slice(0, 8)}.tmp`;
    const handle = await open(tmpPath, 'w');
    const writer: ActiveExportWriter = {
      handle,
      tmpPath,
      writeChain: Promise.resolve(),
      onProgress: request.onProgress,
    };
    this.exportWriters.set(request.jobId, writer);

    try {
      const rpcPayload: EngineExportPayload = {
        jobId: request.jobId,
        projectJson: request.projectJson,
        assets: request.assets,
        format: request.format,
        quality: request.quality,
        ...(request.timeUs !== undefined ? { timeUs: request.timeUs } : {}),
        ...(request.fps !== undefined ? { fps: request.fps } : {}),
        ...(request.width !== undefined ? { width: request.width } : {}),
        ...(request.height !== undefined ? { height: request.height } : {}),
      };
      const result = await this.rpc<EngineExportResult>('exportProject', rpcPayload, 30 * 60_000);
      await writer.writeChain;
      await handle.close();
      this.exportWriters.delete(request.jobId);

      // If MP4 fell back to WebM, align the final filename extension if needed
      let finalPath = request.outputPath;
      if (result.negotiatedFormat !== request.format) {
        const expectedExt = extForFormat(result.negotiatedFormat);
        const curExt = extname(finalPath).toLowerCase();
        if (curExt && curExt !== expectedExt) {
          finalPath = finalPath.slice(0, -curExt.length) + expectedExt;
        }
      }
      await rename(tmpPath, finalPath);
      return { ...result, outputPath: finalPath };
    } catch (error) {
      this.exportWriters.delete(request.jobId);
      try {
        await writer.writeChain;
      } catch {}
      try {
        await handle.close();
      } catch {}
      try {
        unlinkSync(tmpPath);
      } catch {}
      throw error;
    }
  }

  cancelExport(jobId: string): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('video-engine:cancel', jobId);
    }
  }

  dispose(): void {
    this.disposed = true;
    ipcMain.removeListener('video-engine:ready', this.onReadyIpc);
    ipcMain.removeListener('video-engine:response', this.onResponseIpc);
    ipcMain.removeListener('video-engine:progress', this.onProgressIpc);
    ipcMain.removeHandler('video-engine:export-chunk');
    const err = new AppError('video.engine_unavailable', '视频引擎已关闭');
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
    for (const [jobId, writer] of this.exportWriters) {
      void writer.handle.close().catch(() => {});
      try {
        unlinkSync(writer.tmpPath);
      } catch {}
      this.exportWriters.delete(jobId);
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = undefined;
    this.ready = false;
  }
}

function extForFormat(format: VideoExportFormat): string {
  switch (format) {
    case 'mp4':
      return '.mp4';
    case 'webm':
      return '.webm';
    case 'wav':
      return '.wav';
    case 'gif':
      return '.gif';
    case 'png':
      return '.png';
  }
}
