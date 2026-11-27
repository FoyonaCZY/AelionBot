import type { RenderIrFrameResult } from '@aelionsdk/renderer-worker';

import type { AelionPlayerFrame, AelionSessionApi } from './types.js';

export type PreviewCanvasQuality = 'adaptive' | 'draft' | 'full';

export interface PreviewCanvasControllerOptions {
  readonly quality?: PreviewCanvasQuality;
  readonly renderScale?: number;
  readonly fit?: 'contain' | 'cover' | 'fill';
  readonly background?: string;
  readonly pixelRatio?: number;
  /** Own Player frames and draw them to the Canvas. Defaults to true. */
  readonly subscribePlayer?: boolean;
  /** Pause playback while the page is hidden and resume it when visible. */
  readonly pauseWhenHidden?: boolean;
  readonly renderOnResize?: boolean;
  readonly targetFrameMs?: number;
  readonly adaptiveScales?: readonly number[];
  readonly onPointer?: (event: PreviewCanvasPointerEvent) => void;
  readonly onFrame?: (frame: PreviewCanvasFrame) => void;
  readonly onError?: (error: unknown) => void;
}

export interface PreviewCanvasPoint {
  readonly x: number;
  readonly y: number;
  readonly inside: boolean;
}

export interface PreviewCanvasPointerEvent {
  readonly type: 'down' | 'move' | 'up' | 'cancel';
  readonly point: PreviewCanvasPoint;
  readonly pointerId: number;
  readonly buttons: number;
  readonly originalEvent: PointerEvent;
}

export interface PreviewCanvasFrame {
  readonly timeUs: number;
  readonly width: number;
  readonly height: number;
  readonly renderScale: number;
  readonly backend: 'webgpu' | 'webgl2';
}

export interface PreviewCanvasControllerSnapshot {
  readonly disposed: boolean;
  readonly pending: boolean;
  readonly generation: number;
  readonly currentTimeUs: number | null;
  readonly quality: PreviewCanvasQuality;
  readonly renderScale: number;
  readonly renderedFrames: number;
  readonly cancelledFrames: number;
  readonly failedFrames: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface PreviewCanvasController {
  render(timeUs: number): Promise<void>;
  setQuality(quality: PreviewCanvasQuality, renderScale?: number): void;
  resize(): void;
  toProjectPoint(clientX: number, clientY: number): PreviewCanvasPoint;
  captureStream(frameRate?: number): MediaStream;
  snapshot(): PreviewCanvasControllerSnapshot;
  dispose(): void;
}

function assertScale(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new RangeError(`${name} must be greater than 0 and at most 1`);
  }
  return value;
}

function abortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error !== null && typeof error === 'object') {
    const diagnostics: unknown = Reflect.get(error, 'diagnostics');
    if (Array.isArray(diagnostics)) {
      const first = diagnostics[0] as unknown;
      return first !== null && typeof first === 'object' && Reflect.get(first, 'code') === 'OPERATION_ABORTED';
    }
  }
  return false;
}

class CanvasController implements PreviewCanvasController {
  readonly #session: AelionSessionApi;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #options: PreviewCanvasControllerOptions;
  readonly #fit: 'contain' | 'cover' | 'fill';
  readonly #background: string;
  readonly #targetFrameMs: number;
  readonly #adaptiveScales: readonly number[];
  readonly #resizeObserver?: ResizeObserver;
  #quality: PreviewCanvasQuality;
  #renderScale: number;
  #adaptiveIndex: number;
  #unsubscribePlayer: (() => void) | undefined;
  #controller: AbortController | undefined;
  #generation = 0;
  #currentTimeUs: number | null = null;
  #renderedFrames = 0;
  #cancelledFrames = 0;
  #failedFrames = 0;
  #slowFrames = 0;
  #fastFrames = 0;
  #lastPlayerPresentAt = 0;
  #resumeWhenVisible = false;
  #disposed = false;

  public constructor(session: AelionSessionApi, canvas: HTMLCanvasElement, options: PreviewCanvasControllerOptions) {
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (context === null) throw new Error('Canvas 2D context is unavailable');
    this.#session = session;
    this.#canvas = canvas;
    this.#context = context;
    this.#options = options;
    this.#fit = options.fit ?? 'contain';
    this.#background = options.background ?? '#000000';
    this.#targetFrameMs = options.targetFrameMs ?? 1_000 / 30;
    if (!Number.isFinite(this.#targetFrameMs) || this.#targetFrameMs <= 0) {
      throw new RangeError('targetFrameMs must be positive');
    }
    const scales = options.adaptiveScales ?? [1, 0.75, 0.5, 0.35];
    if (scales.length === 0) throw new RangeError('adaptiveScales must not be empty');
    this.#adaptiveScales = Object.freeze(
      [...new Set(scales.map((value) => assertScale(value, 'adaptive scale')))].sort((left, right) => right - left),
    );
    this.#quality = options.quality ?? 'adaptive';
    const defaultScale = this.#quality === 'draft' ? 0.5 : 1;
    this.#renderScale = assertScale(options.renderScale ?? defaultScale, 'renderScale');
    this.#adaptiveIndex = this.#nearestAdaptiveIndex(this.#renderScale);
    this.resize();

    if (options.subscribePlayer ?? true) {
      this.#unsubscribePlayer = session.player.subscribe((frame) => this.#acceptPlayerFrame(frame));
      this.#applyPlayerQuality();
    }
    if (typeof ResizeObserver === 'function') {
      this.#resizeObserver = new ResizeObserver(() => {
        if (this.#disposed) return;
        this.resize();
        if (
          (options.renderOnResize ?? true) &&
          this.#currentTimeUs !== null &&
          this.#session.player.state !== 'playing'
        ) {
          void this.render(this.#currentTimeUs).catch((error: unknown) => this.#reportError(error));
        }
      });
      this.#resizeObserver.observe(canvas);
    }
    if ((options.pauseWhenHidden ?? true) && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibilityChange);
    }
    if (options.onPointer !== undefined) {
      canvas.addEventListener('pointerdown', this.#onPointer);
      canvas.addEventListener('pointermove', this.#onPointer);
      canvas.addEventListener('pointerup', this.#onPointer);
      canvas.addEventListener('pointercancel', this.#onPointer);
    }
  }

  public async render(timeUs: number): Promise<void> {
    this.#assertActive();
    if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
      throw new RangeError('timeUs must be a non-negative safe integer');
    }
    const generation = ++this.#generation;
    this.#controller?.abort(new DOMException('Preview render superseded', 'AbortError'));
    const controller = new AbortController();
    this.#controller = controller;
    const startedAt = performance.now();
    try {
      const result = await this.#session.preview.renderFrame({
        timeUs,
        signal: controller.signal,
        quality: this.#quality === 'full' ? 'full' : 'draft',
        renderScale: this.#renderScale,
      });
      if (generation !== this.#generation || this.#disposed) {
        result.bitmap.close();
        this.#cancelledFrames += 1;
        return;
      }
      this.#currentTimeUs = timeUs;
      this.#draw(result, timeUs);
      this.#observePerformance(performance.now() - startedAt, false);
    } catch (error) {
      if (abortError(error) || controller.signal.aborted) {
        this.#cancelledFrames += 1;
        return;
      }
      this.#failedFrames += 1;
      this.#reportError(error);
      throw error;
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  public setQuality(quality: PreviewCanvasQuality, renderScale?: number): void {
    this.#assertActive();
    this.#quality = quality;
    this.#renderScale = assertScale(
      renderScale ?? (quality === 'draft' ? 0.5 : quality === 'full' ? 1 : this.#renderScale),
      'renderScale',
    );
    this.#adaptiveIndex = this.#nearestAdaptiveIndex(this.#renderScale);
    this.#slowFrames = 0;
    this.#fastFrames = 0;
    this.#applyPlayerQuality();
  }

  public resize(): void {
    this.#assertActive();
    const devicePixelRatio: unknown = Reflect.get(globalThis, 'devicePixelRatio');
    const pixelRatio = this.#options.pixelRatio ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 8) {
      throw new RangeError('pixelRatio must be greater than 0 and at most 8');
    }
    const snapshot = this.#session.getSnapshot();
    const fallbackWidth = snapshot.renderIr?.width ?? (this.#canvas.width || 1);
    const fallbackHeight = snapshot.renderIr?.height ?? (this.#canvas.height || 1);
    const cssWidth = this.#canvas.clientWidth || fallbackWidth;
    const cssHeight = this.#canvas.clientHeight || fallbackHeight;
    const width = Math.max(1, Math.round(cssWidth * pixelRatio));
    const height = Math.max(1, Math.round(cssHeight * pixelRatio));
    if (this.#canvas.width !== width) this.#canvas.width = width;
    if (this.#canvas.height !== height) this.#canvas.height = height;
  }

  public toProjectPoint(clientX: number, clientY: number): PreviewCanvasPoint {
    this.#assertActive();
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      throw new RangeError('Canvas coordinates must be finite');
    }
    const bounds = this.#canvas.getBoundingClientRect();
    const cssWidth = bounds.width || this.#canvas.width;
    const cssHeight = bounds.height || this.#canvas.height;
    const canvasX = (clientX - bounds.left) * (this.#canvas.width / cssWidth);
    const canvasY = (clientY - bounds.top) * (this.#canvas.height / cssHeight);
    const renderIr = this.#session.getSnapshot().renderIr;
    const projectWidth = renderIr?.width ?? this.#canvas.width;
    const projectHeight = renderIr?.height ?? this.#canvas.height;
    if (this.#fit === 'fill') {
      const x = (canvasX / this.#canvas.width) * projectWidth;
      const y = (canvasY / this.#canvas.height) * projectHeight;
      return {
        x,
        y,
        inside: x >= 0 && x <= projectWidth && y >= 0 && y <= projectHeight,
      };
    }
    const scale =
      this.#fit === 'cover'
        ? Math.max(this.#canvas.width / projectWidth, this.#canvas.height / projectHeight)
        : Math.min(this.#canvas.width / projectWidth, this.#canvas.height / projectHeight);
    const contentWidth = projectWidth * scale;
    const contentHeight = projectHeight * scale;
    const offsetX = (this.#canvas.width - contentWidth) / 2;
    const offsetY = (this.#canvas.height - contentHeight) / 2;
    const x = (canvasX - offsetX) / scale;
    const y = (canvasY - offsetY) / scale;
    return {
      x,
      y,
      inside: x >= 0 && x <= projectWidth && y >= 0 && y <= projectHeight,
    };
  }

  public captureStream(frameRate = 30): MediaStream {
    this.#assertActive();
    if (!Number.isFinite(frameRate) || frameRate <= 0 || frameRate > 240) {
      throw new RangeError('frameRate must be greater than 0 and at most 240');
    }
    if (typeof this.#canvas.captureStream !== 'function') {
      throw new Error('HTMLCanvasElement.captureStream is unavailable');
    }
    return this.#canvas.captureStream(frameRate);
  }

  public snapshot(): PreviewCanvasControllerSnapshot {
    return Object.freeze({
      disposed: this.#disposed,
      pending: this.#controller !== undefined,
      generation: this.#generation,
      currentTimeUs: this.#currentTimeUs,
      quality: this.#quality,
      renderScale: this.#renderScale,
      renderedFrames: this.#renderedFrames,
      cancelledFrames: this.#cancelledFrames,
      failedFrames: this.#failedFrames,
      canvasWidth: this.#canvas.width,
      canvasHeight: this.#canvas.height,
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#controller?.abort(new DOMException('Preview Canvas Controller disposed', 'AbortError'));
    this.#controller = undefined;
    this.#unsubscribePlayer?.();
    this.#unsubscribePlayer = undefined;
    this.#resizeObserver?.disconnect();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    }
    if (this.#options.onPointer !== undefined) {
      this.#canvas.removeEventListener('pointerdown', this.#onPointer);
      this.#canvas.removeEventListener('pointermove', this.#onPointer);
      this.#canvas.removeEventListener('pointerup', this.#onPointer);
      this.#canvas.removeEventListener('pointercancel', this.#onPointer);
    }
  }

  #acceptPlayerFrame(frame: AelionPlayerFrame): void {
    if (this.#disposed) {
      frame.result.bitmap.close();
      return;
    }
    this.#generation = Math.max(this.#generation, frame.generation);
    this.#currentTimeUs = frame.timestampUs;
    this.#draw(frame.result, frame.timestampUs);
    const now = performance.now();
    if (this.#lastPlayerPresentAt === 0) {
      this.#lastPlayerPresentAt = now;
      return;
    }
    const elapsedMs = now - this.#lastPlayerPresentAt;
    this.#lastPlayerPresentAt = now;
    // Scheduler drops are expected when decode cannot hold the timeline rate.
    // Adaptive quality should follow the present interval, not those skips, or
    // it oscillates scale and hitchs on every resolution change.
    this.#observePerformance(elapsedMs, false);
  }

  #draw(result: RenderIrFrameResult, timeUs: number): void {
    try {
      const canvasWidth = this.#canvas.width;
      const canvasHeight = this.#canvas.height;
      this.#context.save();
      try {
        this.#context.fillStyle = this.#background;
        this.#context.fillRect(0, 0, canvasWidth, canvasHeight);
        if (this.#fit === 'fill') {
          this.#context.drawImage(result.bitmap, 0, 0, canvasWidth, canvasHeight);
        } else {
          const scale =
            this.#fit === 'cover'
              ? Math.max(canvasWidth / result.width, canvasHeight / result.height)
              : Math.min(canvasWidth / result.width, canvasHeight / result.height);
          const width = result.width * scale;
          const height = result.height * scale;
          this.#context.drawImage(result.bitmap, (canvasWidth - width) / 2, (canvasHeight - height) / 2, width, height);
        }
      } finally {
        this.#context.restore();
      }
      this.#renderedFrames += 1;
      this.#options.onFrame?.({
        timeUs,
        width: result.width,
        height: result.height,
        renderScale: result.renderScale,
        backend: result.backend,
      });
    } finally {
      result.bitmap.close();
    }
  }

  #observePerformance(elapsedMs: number, dropped: boolean): void {
    if (this.#quality !== 'adaptive') return;
    const slow = dropped || elapsedMs > this.#targetFrameMs * 1.2;
    if (slow) {
      this.#slowFrames += 1;
      this.#fastFrames = 0;
      if (this.#slowFrames >= 3 && this.#adaptiveIndex < this.#adaptiveScales.length - 1) {
        this.#adaptiveIndex += 1;
        this.#renderScale = this.#adaptiveScales[this.#adaptiveIndex] ?? this.#renderScale;
        this.#slowFrames = 0;
        this.#applyPlayerQuality();
      }
      return;
    }
    this.#fastFrames += 1;
    this.#slowFrames = 0;
    if (this.#fastFrames >= 30 && this.#adaptiveIndex > 0) {
      this.#adaptiveIndex -= 1;
      this.#renderScale = this.#adaptiveScales[this.#adaptiveIndex] ?? this.#renderScale;
      this.#fastFrames = 0;
      this.#applyPlayerQuality();
    }
  }

  #applyPlayerQuality(): void {
    this.#session.player.setPreviewQuality({
      quality: this.#quality === 'full' ? 'full' : 'draft',
      renderScale: this.#renderScale,
    });
  }

  #nearestAdaptiveIndex(scale: number): number {
    let selected = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < this.#adaptiveScales.length; index += 1) {
      const candidate = this.#adaptiveScales[index];
      if (candidate === undefined) continue;
      const nextDistance = Math.abs(candidate - scale);
      if (nextDistance < distance) {
        selected = index;
        distance = nextDistance;
      }
    }
    return selected;
  }

  readonly #onVisibilityChange = (): void => {
    if (this.#disposed || typeof document === 'undefined') return;
    if (document.hidden) {
      this.#resumeWhenVisible = this.#session.player.state === 'playing';
      if (this.#resumeWhenVisible) {
        void this.#session.player.pause().catch((error: unknown) => this.#reportError(error));
      }
      return;
    }
    if (this.#resumeWhenVisible) {
      this.#resumeWhenVisible = false;
      void this.#session.player.play().catch((error: unknown) => this.#reportError(error));
    }
  };

  readonly #onPointer = (event: PointerEvent): void => {
    if (this.#disposed) return;
    const type =
      event.type === 'pointerdown'
        ? 'down'
        : event.type === 'pointerup'
          ? 'up'
          : event.type === 'pointercancel'
            ? 'cancel'
            : 'move';
    this.#options.onPointer?.({
      type,
      point: this.toProjectPoint(event.clientX, event.clientY),
      pointerId: event.pointerId,
      buttons: event.buttons,
      originalEvent: event,
    });
  };

  #reportError(error: unknown): void {
    this.#options.onError?.(error);
  }

  #assertActive(): void {
    if (this.#disposed) throw new ReferenceError('Preview Canvas Controller is disposed');
  }
}

export function attachPreviewCanvas(
  session: AelionSessionApi,
  canvas: HTMLCanvasElement,
  options: PreviewCanvasControllerOptions = {},
): PreviewCanvasController {
  return new CanvasController(session, canvas, options);
}
