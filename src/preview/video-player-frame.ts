import {
  AelionSession,
  ProductionMediaProvider,
  RuntimeMaterialRegistry,
  attachPreviewCanvas,
  planTimelineMove,
  writeTimelinePlacements,
  type AelionMediaProvider,
  type AelionPlayerApi,
  type AelionRuntimeAssets,
  type PreviewCanvasController,
  type TimelinePlacement,
} from '@aelionsdk/sdk';
import { registerBuiltinVideoMaterials } from '../../electron/core/video/video-presets';
import { VIDEO_RUNTIME_ASSETS, VIDEO_RUNTIME_DIR, type VideoAssetInfo } from '../../shared/types/video-studio-types';

export interface VideoPlayerDragOverlay {
  readonly timeUs?: number;
  readonly clipId?: string;
  readonly trackId?: string;
  readonly startUs?: number;
  readonly durationUs?: number;
  readonly sourceStartUs?: number;
  readonly placements?: ReadonlyArray<{
    readonly itemId: string;
    readonly trackId: string;
    readonly startUs: number;
  }>;
}

export type VideoPlayerHostCommand =
  | {
      readonly source: 'aelion-video-host';
      readonly type: 'load';
      readonly projectId: string;
      readonly revision?: string;
    }
  | { readonly source: 'aelion-video-host'; readonly type: 'play' }
  | { readonly source: 'aelion-video-host'; readonly type: 'pause' }
  | { readonly source: 'aelion-video-host'; readonly type: 'seek'; readonly timeUs: number }
  | { readonly source: 'aelion-video-host'; readonly type: 'setRate'; readonly rate: number }
  | {
      readonly source: 'aelion-video-host';
      readonly type: 'setVolume';
      readonly volume: number;
      readonly muted?: boolean;
    }
  | { readonly source: 'aelion-video-host'; readonly type: 'captureFrame'; readonly requestId: string }
  | {
      readonly source: 'aelion-video-host';
      readonly type: 'previewDrag';
      readonly overlay: VideoPlayerDragOverlay | null;
    };

export type VideoPlayerFrameEvent =
  | {
      readonly source: 'aelion-video-player';
      readonly type: 'ready';
      readonly durationUs: number;
      readonly width: number;
      readonly height: number;
      readonly fps: number;
      readonly revision: string;
    }
  | {
      readonly source: 'aelion-video-player';
      readonly type: 'timeupdate';
      readonly timeUs: number;
      readonly playing: boolean;
    }
  | {
      readonly source: 'aelion-video-player';
      readonly type: 'statechange';
      readonly playing: boolean;
      readonly timeUs: number;
      readonly durationUs: number;
    }
  | {
      readonly source: 'aelion-video-player';
      readonly type: 'frameCaptured';
      readonly requestId: string;
      readonly dataUrl: string;
    }
  | {
      readonly source: 'aelion-video-player';
      readonly type: 'error';
      readonly message: string;
    };

interface ProjectPayloadAssetEntry extends Partial<VideoAssetInfo> {
  readonly url?: string;
  readonly mime?: string;
}

interface ProjectPayload {
  readonly project?: Record<string, unknown>;
  readonly projectJson?: Record<string, unknown>;
  readonly revision?: string | number;
  readonly assets?: readonly ProjectPayloadAssetEntry[] | Record<string, string | ProjectPayloadAssetEntry>;
  readonly assetUrls?: Record<string, string>;
}

const PROJECT_ORIGIN = 'aelion-video://project';
const ASSET_ORIGIN = 'aelion-video://asset';

function resolveRuntimeAssets(): AelionRuntimeAssets {
  const base =
    typeof window !== 'undefined' && window.location?.href ? window.location.href : 'aelion-video://player/index.html';
  const runtimeUrl = (file: string) => new URL(`/${VIDEO_RUNTIME_DIR}/${file}`, base).href;
  return {
    rendererWorker: runtimeUrl(VIDEO_RUNTIME_ASSETS.rendererWorker),
    exportWorker: runtimeUrl(VIDEO_RUNTIME_ASSETS.exportWorker),
    sharedAudioWorklet: runtimeUrl(VIDEO_RUNTIME_ASSETS.sharedAudioWorklet),
    transferableAudioWorklet: runtimeUrl(VIDEO_RUNTIME_ASSETS.transferableAudioWorklet),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error || 'Video player error');
}

/**
 * A frame the renderer turned away because it was still busy with earlier ones, or one a newer request replaced.
 * The next frame draws over it, so it is a skipped frame, not a failure: reporting it would stop the studio's
 * playback for a click on the timeline while playing.
 */
const SKIPPED_FRAME_CODES = new Set([
  'RENDERER_QUEUE_FULL',
  'RENDERER_FRAME_QUEUE_FULL',
  'MEDIA_RESOURCE_QUEUE_FULL',
  'MEDIA_PROVIDER_QUEUE_FULL',
  'OPERATION_ABORTED',
]);

function skippedFrame(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!error || typeof error !== 'object') return false;
  const diagnostics: unknown = Reflect.get(error, 'diagnostics');
  if (Array.isArray(diagnostics)) {
    return diagnostics.some(
      (entry: unknown) =>
        entry !== null && typeof entry === 'object' && SKIPPED_FRAME_CODES.has(String(Reflect.get(entry, 'code'))),
    );
  }
  return SKIPPED_FRAME_CODES.has(String(Reflect.get(error, 'code')));
}

function ensureStageCanvas(): HTMLCanvasElement {
  const existing = document.getElementById('stage') ?? document.querySelector('canvas');
  if (existing instanceof HTMLCanvasElement) return existing;
  const host = document.getElementById('root') ?? document.body;
  const canvas = document.createElement('canvas');
  canvas.id = 'stage';
  canvas.style.cssText = 'display:block;width:100%;height:100%;background:#0b0c0e;';
  host.appendChild(canvas);
  return canvas;
}

class GainMediaProvider implements AelionMediaProvider {
  readonly #inner: ProductionMediaProvider;
  #volume = 1;
  #muted = false;

  public constructor(inner: ProductionMediaProvider) {
    this.#inner = inner;
  }

  public setGain(volume: number, muted: boolean): void {
    this.#volume = Math.max(0, Math.min(2, Number.isFinite(volume) ? volume : 1));
    this.#muted = muted;
  }

  public frameAt(...args: Parameters<AelionMediaProvider['frameAt']>) {
    return this.#inner.frameAt(...args);
  }

  public async pcmRange(...args: Parameters<AelionMediaProvider['pcmRange']>) {
    const block = await this.#inner.pcmRange(...args);
    const gain = this.#muted ? 0 : this.#volume;
    if (gain === 1) return block;
    const scaled = new Float32Array(block.interleaved.length);
    if (gain > 0) {
      for (let i = 0; i < block.interleaved.length; i++) {
        scaled[i] = block.interleaved[i]! * gain;
      }
    }
    return { ...block, interleaved: scaled };
  }

  public getDiagnosticSnapshot() {
    return this.#inner.getDiagnosticSnapshot();
  }
}

function isAllowedHostOrigin(origin: string): boolean {
  return origin === 'null' || origin === 'file://' || /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin);
}

function clearStageCanvas(canvas: HTMLCanvasElement, background = '#0b0c0e'): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width || 1, canvas.height || 1);
}

function drawBitmapContain(canvas: HTMLCanvasElement, bitmap: ImageBitmap | VideoFrame, background = '#0b0c0e'): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const cw = canvas.width || 1;
  const ch = canvas.height || 1;
  const bw = 'displayWidth' in bitmap ? bitmap.displayWidth || bitmap.codedWidth : bitmap.width;
  const bh = 'displayHeight' in bitmap ? bitmap.displayHeight || bitmap.codedHeight : bitmap.height;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, cw, ch);
  const scale = Math.min(cw / Math.max(1, bw), ch / Math.max(1, bh));
  const dw = bw * scale;
  const dh = bh * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;
  ctx.drawImage(bitmap, dx, dy, dw, dh);
}

class IsolatedVideoPlayerHost {
  readonly #canvas: HTMLCanvasElement;
  readonly #media = new ProductionMediaProvider();
  readonly #gainMedia: GainMediaProvider;
  readonly #materials = new RuntimeMaterialRegistry();
  readonly #session: AelionSession;
  readonly #controller: PreviewCanvasController;
  readonly #unsubTime: () => void;

  #parentOrigin = '*';
  #revision = '0';
  #durationUs = 0;
  #width = 1920;
  #height = 1080;
  #fps = 30;
  #rate = 1;
  #currentTimeUs = 0;
  #playing = false;
  #rateRaf = 0;
  #rateLastNow = 0;
  #rateRenderInFlight = false;
  #lastTimeEmitNow = 0;
  #dragAbort: AbortController | undefined;
  #stillUs: number | undefined;
  #stillDrawing = false;
  #loadSeq = 0;
  #disposed = false;

  public constructor() {
    this.#canvas = ensureStageCanvas();
    this.#gainMedia = new GainMediaProvider(this.#media);
    registerBuiltinVideoMaterials(this.#materials);
    this.#session = new AelionSession({
      media: this.#gainMedia,
      materials: this.#materials,
      runtimeAssets: resolveRuntimeAssets(),
      schemaValidationMode: 'structural',
      skipAjvCompile: true,
    });
    this.#controller = attachPreviewCanvas(this.#session, this.#canvas, {
      quality: 'adaptive',
      fit: 'contain',
      background: '#0b0c0e',
      pauseWhenHidden: false,
      onError: (err) => {
        if (!skippedFrame(err))
          this.#emit({ source: 'aelion-video-player', type: 'error', message: errorMessage(err) });
      },
    });
    const player: AelionPlayerApi = this.#session.player;
    this.#unsubTime = player.subscribeTime(({ timeUs, state }) => {
      if (this.#rate !== 1 && this.#playing) return;
      this.#currentTimeUs = timeUs;
      const nowPlaying = state === 'playing';
      if (nowPlaying !== this.#playing) {
        this.#playing = nowPlaying;
        this.#emitState();
      }
      const now = performance.now();
      if (!nowPlaying || now - this.#lastTimeEmitNow >= 32) {
        this.#lastTimeEmitNow = now;
        this.#emit({ source: 'aelion-video-player', type: 'timeupdate', timeUs, playing: nowPlaying });
      }
    });

    window.addEventListener('message', this.#onMessage);
    window.addEventListener('pagehide', this.#onUnload);
    window.addEventListener('beforeunload', this.#onUnload);

    const initialProjectId = new URLSearchParams(window.location.search).get('projectId');
    if (initialProjectId) {
      void this.#loadProject(initialProjectId);
    }
  }

  readonly #onUnload = (): void => {
    this.#dispose();
  };

  #emit(event: VideoPlayerFrameEvent): void {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(event, this.#parentOrigin);
    }
  }

  #emitState(): void {
    this.#emit({
      source: 'aelion-video-player',
      type: 'statechange',
      playing: this.#playing,
      timeUs: this.#currentTimeUs,
      durationUs: this.#durationUs,
    });
  }

  readonly #onMessage = (event: MessageEvent): void => {
    if (this.#disposed) return;
    if (window.parent && event.source !== window.parent) return;
    if (!isAllowedHostOrigin(event.origin)) return;
    const data = event.data as VideoPlayerHostCommand | null | undefined;
    if (!data || typeof data !== 'object' || data.source !== 'aelion-video-host') return;
    this.#parentOrigin = event.origin && event.origin !== 'null' && event.origin !== 'file://' ? event.origin : '*';
    void this.#handleCommand(data).catch((err) => {
      if (!skippedFrame(err)) this.#emit({ source: 'aelion-video-player', type: 'error', message: errorMessage(err) });
    });
  };

  async #handleCommand(command: VideoPlayerHostCommand): Promise<void> {
    switch (command.type) {
      case 'load':
        await this.#loadProject(command.projectId, command.revision);
        break;
      case 'play':
        await this.#play();
        break;
      case 'pause':
        await this.#pause();
        break;
      case 'seek':
        await this.#seek(command.timeUs);
        break;
      case 'setRate':
        await this.#setRate(command.rate);
        break;
      case 'setVolume':
        this.#gainMedia.setGain(command.volume, Boolean(command.muted));
        break;
      case 'captureFrame':
        await this.#captureFrame(command.requestId);
        break;
      case 'previewDrag':
        await this.#previewDrag(command.overlay);
        break;
    }
  }

  async #loadProject(projectId: string, revision?: string): Promise<void> {
    if (this.#disposed) return;
    const seq = ++this.#loadSeq;
    this.#dragAbort?.abort(new DOMException('Project reloaded', 'AbortError'));
    this.#dragAbort = undefined;
    const wasPlaying = this.#playing;
    await this.#pause();
    if (seq !== this.#loadSeq || this.#disposed) return;
    const query = revision ? `?rev=${encodeURIComponent(revision)}` : '';
    const url = `${PROJECT_ORIGIN}/${encodeURIComponent(projectId)}/project.json${query}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to fetch project (${response.status})`);
    }
    const payload = (await response.json()) as ProjectPayload;
    if (seq !== this.#loadSeq || this.#disposed) return;

    const projectDoc = payload.project ?? payload.projectJson ?? (payload as unknown as Record<string, unknown>);
    if (!projectDoc || typeof projectDoc !== 'object') {
      throw new Error('Invalid project payload');
    }

    this.#registerAssets(projectId, projectDoc, payload);
    await this.#session.loadProject(projectDoc);
    if (seq !== this.#loadSeq || this.#disposed) return;

    const snapshot = this.#session.getSnapshot();
    const ir = snapshot.renderIr;
    this.#revision = String(payload.revision ?? snapshot.revision ?? revision ?? '0');
    this.#durationUs = ir?.durationUs ?? 0;
    this.#width = ir?.width ?? 1920;
    this.#height = ir?.height ?? 1080;
    this.#fps = ir?.frameRate && ir.frameRate.denominator > 0 ? ir.frameRate.numerator / ir.frameRate.denominator : 30;

    const targetTimeUs = this.#clampTimeUs(this.#currentTimeUs);
    this.#currentTimeUs = targetTimeUs;
    this.#controller.resize();
    if (this.#durationUs > 0) {
      await this.#controller.render(targetTimeUs).catch(() => {});
      if (seq !== this.#loadSeq || this.#disposed) return;
    } else {
      clearStageCanvas(this.#canvas);
    }

    this.#emit({
      source: 'aelion-video-player',
      type: 'ready',
      durationUs: this.#durationUs,
      width: this.#width,
      height: this.#height,
      fps: this.#fps,
      revision: this.#revision,
    });
    this.#emit({
      source: 'aelion-video-player',
      type: 'timeupdate',
      timeUs: this.#currentTimeUs,
      playing: false,
    });

    if (wasPlaying && this.#durationUs > 0) {
      await this.#play();
    }
  }

  #registerAssets(projectId: string, projectDoc: Record<string, unknown>, payload: ProjectPayload): void {
    const registered = new Set<string>();
    const docAssets =
      projectDoc.assets && typeof projectDoc.assets === 'object' && !Array.isArray(projectDoc.assets)
        ? (projectDoc.assets as Record<string, Record<string, unknown>>)
        : {};
    const docMeta = (assetId: string) => {
      const entry = docAssets[assetId];
      if (!entry || typeof entry !== 'object') return {};
      return {
        kind: typeof entry.kind === 'string' ? entry.kind : undefined,
        mimeType: typeof entry.mimeType === 'string' ? entry.mimeType : undefined,
        durationUs: typeof entry.durationUs === 'number' ? entry.durationUs : undefined,
        width: typeof entry.width === 'number' ? entry.width : undefined,
        height: typeof entry.height === 'number' ? entry.height : undefined,
      };
    };
    const assetUrlFor = (assetId: string, explicitUrl?: string) => {
      if (explicitUrl && (explicitUrl.startsWith('aelion-video://') || explicitUrl.startsWith('aelion-media://'))) {
        return explicitUrl;
      }
      return `${ASSET_ORIGIN}/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}`;
    };

    const registerOne = (
      assetId: string,
      info: {
        kind?: string;
        url?: string;
        streamUrl?: string;
        mime?: string;
        mimeType?: string;
        durationUs?: number;
        width?: number;
        height?: number;
      },
    ) => {
      if (!assetId || registered.has(assetId)) return;
      registered.add(assetId);
      const fallback = docMeta(assetId);
      const kind = info.kind ?? fallback.kind;
      const mimeType = info.mimeType ?? info.mime ?? fallback.mimeType;
      const durationUs = info.durationUs ?? fallback.durationUs;
      const width = info.width ?? fallback.width;
      const height = info.height ?? fallback.height;
      const isImage = kind === 'image' || Boolean(mimeType?.startsWith('image/'));
      this.#media.registerUrl(assetId, assetUrlFor(assetId, info.url ?? info.streamUrl), {
        kind: isImage ? 'image' : 'media',
        ...(mimeType ? { mimeType } : {}),
        ...(typeof durationUs === 'number' && Number.isSafeInteger(durationUs) && durationUs > 0 ? { durationUs } : {}),
        ...(typeof width === 'number' && Number.isSafeInteger(width) && width > 0 ? { width } : {}),
        ...(typeof height === 'number' && Number.isSafeInteger(height) && height > 0 ? { height } : {}),
      });
    };

    if (Array.isArray(payload.assets)) {
      for (const asset of payload.assets) {
        if (asset && typeof asset.id === 'string') registerOne(asset.id, asset);
      }
    } else if (payload.assets && typeof payload.assets === 'object') {
      for (const [assetId, entry] of Object.entries(payload.assets)) {
        if (typeof entry === 'string') registerOne(assetId, { streamUrl: entry });
        else if (entry && typeof entry === 'object') registerOne(assetId, entry);
      }
    }

    if (payload.assetUrls && typeof payload.assetUrls === 'object') {
      for (const [assetId, streamUrl] of Object.entries(payload.assetUrls)) {
        if (typeof streamUrl === 'string') registerOne(assetId, { streamUrl });
      }
    }

    for (const assetId of Object.keys(docAssets)) {
      registerOne(assetId, {});
    }
  }

  #clampTimeUs(timeUs: number): number {
    const safe = Number.isFinite(timeUs) ? Math.round(timeUs) : 0;
    if (this.#durationUs <= 0) return 0;
    return Math.max(0, Math.min(safe, Math.max(0, this.#durationUs - 1)));
  }

  async #play(): Promise<void> {
    if (this.#session.state !== 'ready' || this.#durationUs <= 0) return;
    if (this.#currentTimeUs >= Math.max(0, this.#durationUs - 10_000)) {
      this.#currentTimeUs = 0;
      await this.#session.player.seek(0).catch(() => {});
    }
    if (this.#rate === 1) {
      this.#stopRateLoop();
      await this.#session.player.play();
      this.#playing = true;
      this.#emitState();
    } else {
      await this.#session.player.pause().catch(() => {});
      this.#playing = true;
      this.#emitState();
      this.#startRateLoop();
    }
  }

  async #pause(): Promise<void> {
    this.#stopRateLoop();
    if (this.#session.state === 'ready' && this.#session.player.state === 'playing') {
      await this.#session.player.pause().catch(() => {});
    }
    if (this.#playing) {
      this.#playing = false;
      this.#emitState();
    }
  }

  async #seek(timeUs: number): Promise<void> {
    if (this.#session.state !== 'ready') return;
    const clamped = this.#clampTimeUs(timeUs);
    this.#currentTimeUs = clamped;
    if (this.#durationUs <= 0) return;
    if (this.#session.player.state === 'playing') {
      // Playing, the player's own frame loop draws the new time next. Its seek also asks for a frame at once, which
      // the renderer turns away while the loop's frame is still in flight; that one is simply not needed.
      await this.#session.player.seek(clamped).catch((error: unknown) => {
        if (!skippedFrame(error)) throw error;
      });
    } else if (this.#session.player.state === 'paused') {
      // The seek draws the frame itself; when the renderer is busy, the still path asks again until it is drawn.
      await this.#session.player.seek(clamped).catch(async (error: unknown) => {
        if (!skippedFrame(error)) throw error;
        // Unless a later seek has taken over, which draws its own time.
        if (this.#currentTimeUs === clamped) await this.#drawStill(clamped);
      });
    } else {
      await this.#drawStill(clamped);
    }
    this.#emit({
      source: 'aelion-video-player',
      type: 'timeupdate',
      timeUs: clamped,
      playing: this.#playing,
    });
  }

  /**
   * Draws the picture at a time while nothing plays. Clicks and drags on the timeline ask faster than frames are
   * made: only the latest time asked for is kept, and a frame turned away because the renderer is busy is asked
   * for again once it has caught up, so the picture always ends on where the playhead stopped.
   */
  async #drawStill(timeUs: number): Promise<void> {
    this.#stillUs = timeUs;
    if (this.#stillDrawing) return;
    this.#stillDrawing = true;
    try {
      for (
        let busy = 0;
        this.#stillUs !== undefined && busy < 50 && !this.#disposed && this.#session.player.state !== 'playing';
      ) {
        const target: number = this.#stillUs;
        this.#stillUs = undefined;
        if (target !== this.#currentTimeUs) continue;
        try {
          await this.#controller.render(target);
          busy = 0;
        } catch (error) {
          if (!skippedFrame(error)) throw error;
          this.#stillUs ??= target;
          busy += 1;
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
      }
    } finally {
      this.#stillUs = undefined;
      this.#stillDrawing = false;
    }
  }

  async #setRate(rate: number): Promise<void> {
    const next = Math.max(0.25, Math.min(4, Number.isFinite(rate) ? rate : 1));
    if (next === this.#rate) return;
    const wasPlaying = this.#playing;
    this.#rate = next;
    if (!wasPlaying) return;
    if (next === 1) {
      this.#stopRateLoop();
      await this.#session.player.seek(this.#clampTimeUs(this.#currentTimeUs)).catch(() => {});
      await this.#session.player.play();
    } else {
      await this.#session.player.pause().catch(() => {});
      this.#startRateLoop();
    }
  }

  #startRateLoop(): void {
    this.#stopRateLoop();
    this.#rateLastNow = performance.now();
    const step = (now: number) => {
      if (!this.#playing || this.#rate === 1) return;
      const dtMs = Math.max(0, Math.min(100, now - this.#rateLastNow));
      this.#rateLastNow = now;
      const nextUs = Math.round(this.#currentTimeUs + dtMs * 1_000 * this.#rate);
      if (nextUs >= this.#durationUs) {
        this.#currentTimeUs = this.#clampTimeUs(this.#durationUs);
        this.#playing = false;
        this.#stopRateLoop();
        void this.#controller.render(this.#currentTimeUs).catch(() => {});
        this.#emitState();
        return;
      }
      this.#currentTimeUs = nextUs;
      if (now - this.#lastTimeEmitNow >= 32) {
        this.#lastTimeEmitNow = now;
        this.#emit({ source: 'aelion-video-player', type: 'timeupdate', timeUs: nextUs, playing: true });
      }
      if (!this.#rateRenderInFlight) {
        this.#rateRenderInFlight = true;
        void this.#controller
          .render(nextUs)
          .catch(() => {})
          .finally(() => {
            this.#rateRenderInFlight = false;
          });
      }
      this.#rateRaf = requestAnimationFrame(step);
    };
    this.#rateRaf = requestAnimationFrame(step);
  }

  #stopRateLoop(): void {
    if (this.#rateRaf) {
      cancelAnimationFrame(this.#rateRaf);
      this.#rateRaf = 0;
    }
  }

  async #captureFrame(requestId: string): Promise<void> {
    if (this.#session.state === 'ready' && this.#durationUs > 0 && !this.#playing) {
      await this.#controller.render(this.#clampTimeUs(this.#currentTimeUs)).catch(() => {});
    }
    const dataUrl = this.#canvas.toDataURL('image/png');
    this.#emit({
      source: 'aelion-video-player',
      type: 'frameCaptured',
      requestId,
      dataUrl,
    });
  }

  async #previewDrag(overlay: VideoPlayerDragOverlay | null): Promise<void> {
    if (this.#session.state !== 'ready' || this.#durationUs <= 0) return;
    this.#dragAbort?.abort(new DOMException('Drag preview superseded', 'AbortError'));
    if (!overlay) {
      await this.#controller.render(this.#clampTimeUs(this.#currentTimeUs)).catch(() => {});
      return;
    }
    const controller = new AbortController();
    this.#dragAbort = controller;
    const project = this.#session.getSnapshot().project;
    if (!project) return;
    const timeUs = this.#clampTimeUs(overlay.timeUs ?? this.#currentTimeUs);
    try {
      const result = await this.#session.preview.renderFrame({
        timeUs,
        quality: 'draft',
        signal: controller.signal,
        overlay: (tx) => {
          if (overlay.placements?.length) {
            const map = new Map<string, TimelinePlacement>();
            for (const entry of overlay.placements) {
              map.set(entry.itemId, { trackId: entry.trackId, startUs: Math.max(0, Math.round(entry.startUs)) });
            }
            writeTimelinePlacements(tx, project, map, { dropSeparatedTransitions: true });
            return;
          }
          if (!overlay.clipId) return;
          const item = project.items[overlay.clipId];
          if (!item) return;
          if (overlay.durationUs !== undefined) {
            const nextStart =
              overlay.startUs !== undefined ? Math.max(0, Math.round(overlay.startUs)) : item.range.startUs;
            const nextDuration = Math.max(100_000, Math.round(overlay.durationUs));
            tx.setField('items', item.id, ['range'], { startUs: nextStart, durationUs: nextDuration });
            if (
              overlay.sourceStartUs !== undefined &&
              'source' in item &&
              item.source &&
              typeof item.source === 'object'
            ) {
              tx.setField(
                'items',
                item.id,
                ['source', 'sourceRange', 'startUs'],
                Math.max(0, Math.round(overlay.sourceStartUs)),
              );
            }
          } else if (overlay.startUs !== undefined || overlay.trackId !== undefined) {
            const plan = planTimelineMove(project, {
              movedItemId: item.id,
              targetTrackId: overlay.trackId ?? item.trackId,
              targetStartUs: Math.max(0, Math.round(overlay.startUs ?? item.range.startUs)),
            });
            if (plan && plan.placements.size > 0) {
              writeTimelinePlacements(tx, project, plan.placements, { dropSeparatedTransitions: true });
            }
          }
        },
      });
      if (controller.signal.aborted) {
        result.bitmap.close();
        return;
      }
      drawBitmapContain(this.#canvas, result.bitmap);
      result.bitmap.close();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }

  #dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loadSeq += 1;
    this.#stopRateLoop();
    this.#dragAbort?.abort();
    this.#unsubTime();
    window.removeEventListener('message', this.#onMessage);
    window.removeEventListener('pagehide', this.#onUnload);
    window.removeEventListener('beforeunload', this.#onUnload);
    this.#controller.dispose();
    void this.#session.dispose();
    this.#media.dispose();
  }
}

function shouldAutoBoot(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (window.location.protocol === 'aelion-video:') return true;
  if (document.documentElement?.dataset.aelionVideoPlayer === 'true') return true;
  return new URLSearchParams(window.location.search).has('projectId');
}

if (shouldAutoBoot()) {
  const boot = () => {
    void new IsolatedVideoPlayerHost();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
