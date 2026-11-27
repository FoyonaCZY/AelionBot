import { frameIndexAtTime, frameStartUs, type Disposable, type Rational } from '@aelionsdk/core';

export interface PlaybackClock {
  nowUs(): number;
}

export interface ScheduledVideoFrame {
  readonly generation: number;
  readonly frameIndex: number;
  readonly timestampUs: number;
  readonly droppedFrames: number;
}

export interface AudioDrivenVideoSchedulerSnapshot {
  readonly disposed: boolean;
  readonly scheduled: boolean;
  readonly rendering: boolean;
  readonly ended: boolean;
  readonly generation: number;
}

export interface AudioDrivenVideoSchedulerOptions {
  readonly clock: PlaybackClock;
  readonly frameRate: Rational;
  readonly durationUs: number;
  readonly onFrame: (frame: ScheduledVideoFrame) => void | Promise<void>;
  readonly onEnd?: () => void;
  readonly onError?: (error: unknown) => void;
  readonly schedule?: (callback: FrameRequestCallback) => number;
  readonly cancel?: (handle: number) => void;
}

export class AudioDrivenVideoScheduler implements Disposable {
  readonly #clock: PlaybackClock;
  readonly #frameRate: Rational;
  readonly #durationUs: number;
  readonly #onFrame: AudioDrivenVideoSchedulerOptions['onFrame'];
  readonly #onEnd: AudioDrivenVideoSchedulerOptions['onEnd'];
  readonly #onError: AudioDrivenVideoSchedulerOptions['onError'];
  readonly #schedule: (callback: FrameRequestCallback) => number;
  readonly #cancel: (handle: number) => void;
  #handle: number | undefined;
  #lastFrameIndex = -1;
  #generation = 0;
  #disposed = false;
  #rendering = false;
  #ended = false;

  public constructor(options: AudioDrivenVideoSchedulerOptions) {
    if (!Number.isSafeInteger(options.durationUs) || options.durationUs <= 0) {
      throw new RangeError('Video scheduler duration must be a positive safe integer');
    }
    this.#clock = options.clock;
    this.#frameRate = options.frameRate;
    this.#durationUs = options.durationUs;
    this.#onFrame = options.onFrame;
    this.#onEnd = options.onEnd;
    this.#onError = options.onError;
    this.#schedule = options.schedule ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.#cancel = options.cancel ?? ((handle) => globalThis.cancelAnimationFrame(handle));
  }

  public get generation(): number {
    return this.#generation;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public snapshot(): AudioDrivenVideoSchedulerSnapshot {
    return {
      disposed: this.#disposed,
      scheduled: this.#handle !== undefined,
      rendering: this.#rendering,
      ended: this.#ended,
      generation: this.#generation,
    };
  }

  public start(): void {
    if (this.#disposed) throw new ReferenceError('AudioDrivenVideoScheduler is disposed');
    if (this.#handle !== undefined) return;
    this.#ended = false;
    this.#handle = this.#schedule(this.#tick);
  }

  public pause(): void {
    if (this.#handle === undefined) return;
    this.#cancel(this.#handle);
    this.#handle = undefined;
  }

  public seek(): number {
    this.#generation += 1;
    this.#lastFrameIndex = -1;
    this.#ended = false;
    return this.#generation;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.pause();
    this.#disposed = true;
    this.#generation += 1;
  }

  readonly #tick = (): void => {
    this.#handle = undefined;
    if (this.#disposed) return;
    const clockTimeUs = Math.max(0, this.#clock.nowUs());
    if (clockTimeUs >= this.#durationUs) {
      this.pause();
      if (!this.#ended) {
        this.#ended = true;
        this.#onEnd?.();
      }
      return;
    }
    const timeUs = Math.min(this.#durationUs - 1, clockTimeUs);
    const frameIndex = frameIndexAtTime(timeUs, this.#frameRate);
    if (!this.#rendering && frameIndex !== this.#lastFrameIndex) {
      const generation = this.#generation;
      const droppedFrames = Math.max(0, frameIndex - this.#lastFrameIndex - 1);
      this.#lastFrameIndex = frameIndex;
      this.#rendering = true;
      void Promise.resolve(
        this.#onFrame({
          generation,
          frameIndex,
          timestampUs: frameStartUs(frameIndex, this.#frameRate),
          droppedFrames,
        }),
      ).then(
        () => {
          this.#rendering = false;
        },
        (error: unknown) => {
          this.#rendering = false;
          try {
            this.#onError?.(error);
          } catch {
            // Error observers cannot create an unhandled scheduler rejection.
          }
        },
      );
    }
    this.#handle = this.#schedule(this.#tick);
  };
}
