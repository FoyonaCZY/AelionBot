import {
  AudioDrivenVideoScheduler,
  AudioWorkletClock,
  StreamingPcmResampler,
  TransferableAudioWorkletClock,
  renderIrAudio,
  type ScheduledVideoFrame,
} from '@aelionsdk/audio';
import { sampleIndexAtTime } from '@aelionsdk/core';
import type { IrClip, RenderIr } from '@aelionsdk/render-ir';
import type { ChangeSet } from '@aelionsdk/transaction';

import type { AelionSession } from './session.js';
import { normalizePreviewQuality, type NormalizedPreviewQuality } from './preview-quality.js';
import type {
  AelionPlayerApi,
  AelionPlayerFrame,
  AelionPlayerStats,
  AelionPlayerTime,
  AelionPlayerResourceStats,
  AelionPlayerState,
  AelionRuntimeAssets,
} from './types.js';

type Clock = AudioWorkletClock | TransferableAudioWorkletClock;

type RuntimeErrorListener = (error: unknown) => void;

function runtimeErrorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const diagnostics: unknown = Reflect.get(error, 'diagnostics');
    if (Array.isArray(diagnostics)) {
      const first: unknown = diagnostics[0];
      const code: unknown = first !== null && typeof first === 'object' ? Reflect.get(first, 'code') : undefined;
      if (typeof code === 'string') return code;
    }
    const code: unknown = Reflect.get(error, 'code');
    if (typeof code === 'string') return code;
  }
  return 'PLAYER_RUNTIME_FAILED';
}

const RECOVERABLE_PREVIEW_CODES = new Set([
  'RENDERER_QUEUE_FULL',
  'RENDERER_FRAME_QUEUE_FULL',
  'MEDIA_RESOURCE_QUEUE_FULL',
  'MEDIA_PROVIDER_QUEUE_FULL',
  'OPERATION_ABORTED',
]);

function clipCoversTime(clip: IrClip, timeUs: number): boolean {
  return clip.enabled && timeUs >= clip.range.startUs && timeUs < clip.range.startUs + clip.range.durationUs;
}

function hasVisualPreview(ir: RenderIr, timeUs: number): boolean {
  for (const track of ir.tracks) {
    if (!track.enabled || track.kind === 'audio') continue;
    for (const clip of track.clips) {
      if (clip.kind === 'audio-clip') continue;
      if (clipCoversTime(clip, timeUs)) return true;
    }
  }
  return false;
}

function recoverablePreviewSkip(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof RangeError && error.message.includes('QUEUE_FULL')) return true;
  if (error === null || typeof error !== 'object') return false;
  const diagnostics: unknown = Reflect.get(error, 'diagnostics');
  if (Array.isArray(diagnostics)) {
    return diagnostics.some(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        RECOVERABLE_PREVIEW_CODES.has(Reflect.get(value, 'code') as string),
    );
  }
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' && RECOVERABLE_PREVIEW_CODES.has(code);
}

export class AelionPlayer implements AelionPlayerApi {
  readonly #session: AelionSession;
  readonly #onRuntimeError: RuntimeErrorListener | undefined;
  readonly #runtimeAssets: AelionRuntimeAssets | undefined;
  readonly #listeners = new Set<(frame: AelionPlayerFrame) => void>();
  readonly #timeListeners = new Set<(time: AelionPlayerTime) => void>();
  #state: AelionPlayerState = 'idle';
  #clock: Clock | undefined;
  #scheduler: AudioDrivenVideoScheduler | undefined;
  #fillHandle: ReturnType<typeof globalThis.setInterval> | undefined;
  #nextAudioFrame = 0;
  #audioResampler: StreamingPcmResampler | undefined;
  #audioResamplerInputRate = 0;
  #audioResamplerOutputRate = 0;
  #audioResamplerChannels = 0;
  #pendingResampledPcm: Float32Array | undefined;
  #fillTask: Promise<void> | undefined;
  #fillGeneration = -1;
  #runtimeInitTask: Promise<void> | undefined;
  #runtimeDisposeTask: Promise<void> | undefined;
  #disposeTask: Promise<void> | undefined;
  #fillController = new AbortController();
  #videoController = new AbortController();
  #generation = 0;
  #lastTimeUs = 0;
  #renderedFrames = 0;
  #droppedFrames = 0;
  #errors = 0;
  #lastErrorCode: string | undefined;
  #previewQuality: NormalizedPreviewQuality = normalizePreviewQuality();
  #lastDisposedRuntime: AelionPlayerResourceStats['lastDisposedRuntime'] = null;
  #presentedBlank = false;

  public constructor(
    session: AelionSession,
    onRuntimeError?: RuntimeErrorListener,
    runtimeAssets?: AelionRuntimeAssets,
  ) {
    this.#session = session;
    this.#onRuntimeError = onRuntimeError;
    this.#runtimeAssets = runtimeAssets;
  }

  public get state(): AelionPlayerState {
    return this.#state;
  }

  public get currentTimeUs(): number {
    if (this.#state === 'ended' || this.#state === 'error' || this.#state === 'disposed') {
      return this.#lastTimeUs;
    }
    return this.#clock?.nowUs() ?? this.#lastTimeUs;
  }

  public async play(): Promise<void> {
    try {
      if (this.#state === 'disposed') throw new ReferenceError('AelionPlayer is disposed');
      const ir = this.#session.requireIr();
      const generation = this.#generation;
      await this.#ensureRuntime();
      if (!this.#playContinuationCurrent(generation)) {
        throw new DOMException('Player play became stale', 'AbortError');
      }
      await this.#requestAudioFill(true);
      if (!this.#playContinuationCurrent(generation)) {
        throw new DOMException('Player play became stale', 'AbortError');
      }
      if (this.#state === 'paused') await this.#clock?.resume();
      else await this.#clock?.start();
      if (!this.#playContinuationCurrent(generation)) {
        throw new DOMException('Player play became stale', 'AbortError');
      }
      this.#state = 'playing';
      this.#publishTime();
      this.#session.notifyStatsChanged();
      this.#scheduler?.start();
      this.#fillHandle ??= globalThis.setInterval(() => {
        void this.#requestAudioFill(false);
      }, 20);
      if (this.currentTimeUs >= ir.durationUs) await this.seek(0);
    } catch (error) {
      this.#failRuntime(error);
      throw error;
    }
  }

  public async pause(): Promise<void> {
    if (this.#state === 'disposed') throw new ReferenceError('AelionPlayer is disposed');
    const generation = this.#generation;
    if (this.#fillHandle !== undefined) {
      globalThis.clearInterval(this.#fillHandle);
      this.#fillHandle = undefined;
    }
    this.#scheduler?.pause();
    if (this.#clock !== undefined) await this.#clock.pause();
    if (this.#disposeTask !== undefined || generation !== this.#generation) return;
    if (this.#state !== 'idle') this.#state = 'paused';
    this.#lastTimeUs = this.currentTimeUs;
    this.#session.notifyStatsChanged();
    this.#publishTime();
  }

  public async seek(timeUs: number): Promise<void> {
    try {
      const ir = this.#session.requireIr();
      if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs >= ir.durationUs) {
        throw new RangeError('Player seek target is outside the sequence duration');
      }
      await this.#ensureRuntime();
      this.#advanceGeneration();
      const generation = this.#generation;
      const clock = this.#clock;
      if (clock instanceof AudioWorkletClock) clock.resetForSeek(timeUs);
      else clock?.seek(timeUs);
      this.#nextAudioFrame = sampleIndexAtTime(timeUs, ir.sampleRate);
      this.#lastTimeUs = timeUs;
      await this.#requestAudioFill(true);
      if (generation !== this.#generation) return;
      const signal = this.#videoController.signal;
      if (signal.aborted) return;
      const result = await this.#session.preview.renderFrame({
        timeUs,
        signal,
        ...this.#previewQuality,
      });
      if (generation !== this.#generation) {
        result.bitmap.close();
        return;
      }
      this.#presentedBlank = !hasVisualPreview(ir, timeUs);
      this.#publish({ generation, frameIndex: -1, timestampUs: timeUs, droppedFrames: 0 }, result);
    } catch (error) {
      // A superseded or disposed seek still rejects: the caller awaited a
      // specific position and did not reach it. Skipping recoverable errors is
      // for the playback frame loop, where dropping a frame is the right
      // outcome; #failRuntime already keeps them out of the error state.
      this.#failRuntime(error);
      throw error;
    }
  }

  public scrub(timeUs: number) {
    return this.#session.preview.renderFrame({ timeUs, ...this.#previewQuality });
  }

  public setPreviewQuality(options: Parameters<AelionPlayerApi['setPreviewQuality']>[0]): void {
    if (this.#state === 'disposed') throw new ReferenceError('AelionPlayer is disposed');
    this.#previewQuality = normalizePreviewQuality(options);
    // Apply on the next composed frame. Aborting the in-flight playback frame
    // leaves Worker cancel tombstones and can freeze the last presented bitmap
    // while the audio clock keeps moving.
    this.#session.notifyStatsChanged();
  }

  public getStats(): AelionPlayerStats {
    return Object.freeze({
      state: this.#state,
      currentTimeUs: this.currentTimeUs,
      generation: this.#generation,
      renderedFrames: this.#renderedFrames,
      droppedFrames: this.#droppedFrames,
      errors: this.#errors,
      lastErrorCode: this.#lastErrorCode ?? null,
      previewQuality: this.#previewQuality,
      resources: this.#resourceStats(),
    });
  }

  #resourceStats(): AelionPlayerResourceStats {
    const scheduler = this.#scheduler?.snapshot();
    const clock = this.#clock;
    const queue =
      clock instanceof AudioWorkletClock
        ? clock.ring.snapshot()
        : clock instanceof TransferableAudioWorkletClock
          ? clock.snapshot()
          : undefined;
    return Object.freeze({
      listeners: this.#listeners.size,
      runtimeInitializing: this.#runtimeInitTask !== undefined,
      audioFillScheduled: this.#fillHandle !== undefined,
      audioFillInFlight: this.#fillTask !== undefined,
      scheduler: Object.freeze({
        present: scheduler !== undefined,
        disposed: scheduler?.disposed ?? true,
        scheduled: scheduler?.scheduled ?? false,
        rendering: scheduler?.rendering ?? false,
      }),
      audio: Object.freeze({
        mode:
          clock instanceof AudioWorkletClock
            ? ('shared-ring' as const)
            : clock instanceof TransferableAudioWorkletClock
              ? ('transferable-queue' as const)
              : ('none' as const),
        disposed: clock?.disposed ?? true,
        contextState: clock?.context.state ?? null,
        bufferedFrames:
          queue === undefined ? 0 : 'availableReadFrames' in queue ? queue.availableReadFrames : queue.queuedFrames,
        closed: queue === undefined ? true : 'state' in queue ? queue.state === 'closed' : queue.closed,
      }),
      lastDisposedRuntime: this.#lastDisposedRuntime,
    });
  }

  public subscribe(listener: (frame: AelionPlayerFrame) => void): () => void {
    if (this.#state === 'disposed') throw new ReferenceError('AelionPlayer is disposed');
    if (this.#listeners.size > 0) {
      throw new Error('AelionPlayer supports one frame owner; unsubscribe before replacing it');
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Observes the playhead without taking ownership of a frame.
   *
   * `subscribe` is exclusive because a presented frame carries a `VideoFrame`
   * that exactly one consumer must close, and that consumer is normally the
   * Canvas controller. Everything else that follows playback -- a timecode
   * readout, a scrolling playhead, a transport button -- only wants the time,
   * so it gets a channel that carries no resource and takes as many listeners
   * as the host has places to show it. Without this, those callers are pushed
   * into polling the clock on an animation frame.
   */
  public subscribeTime(listener: (time: AelionPlayerTime) => void): () => void {
    if (this.#state === 'disposed') throw new ReferenceError('AelionPlayer is disposed');
    this.#timeListeners.add(listener);
    return () => this.#timeListeners.delete(listener);
  }

  public invalidate(changeSet: ChangeSet): void {
    void changeSet;
    if (this.#state !== 'playing' && this.#state !== 'paused') return;
    const ir = this.#session.requireIr();
    const timeUs = Math.min(Math.max(0, this.currentTimeUs), Math.max(0, ir.durationUs - 1));
    this.#advanceGeneration();
    this.#nextAudioFrame = sampleIndexAtTime(timeUs, ir.sampleRate);
    this.#lastTimeUs = timeUs;
    // A paused transport must not be woken by an edit. Advancing the generation
    // above already dropped the stale frames, which is the whole of what a
    // paused Player owes an edit; reseating its clock instead spins the audio
    // graph back up for a graph nobody is listening to, and an edit made while
    // paused starts leaking sound.
    if (this.#state !== 'playing') {
      this.#publishTime();
      return;
    }
    const clock = this.#clock;
    if (clock instanceof AudioWorkletClock) clock.resetForSeek(timeUs);
    else clock?.seek(timeUs);
    void this.#requestAudioFill(false);
    this.#publishTime();
  }

  public async reset(): Promise<void> {
    if (this.#state === 'disposed') return;
    this.#advanceGeneration();
    const generation = this.#generation;
    await this.#disposeRuntime();
    // The awaited runtime teardown permits a concurrent dispose() even though
    // TypeScript narrows the pre-await state check.
    if (this.#disposeTask !== undefined || generation !== this.#generation) return;
    this.#state = 'idle';
    this.#lastTimeUs = 0;
    this.#nextAudioFrame = 0;
    this.#publishTime();
  }

  public dispose(): Promise<void> {
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #dispose(): Promise<void> {
    if (this.#state === 'disposed') return;
    this.#advanceGeneration();
    // Publish the terminal state before the first await so concurrent reset or
    // runtime initialization cannot revive the Player while Session disposal runs.
    this.#state = 'disposed';
    this.#listeners.clear();
    this.#timeListeners.clear();
    await this.#disposeRuntime();
  }

  async #ensureRuntime(): Promise<void> {
    if (this.#scheduler !== undefined) return;
    const existing = this.#runtimeInitTask;
    if (existing !== undefined) return existing;
    const task = this.#initializeRuntime().finally(() => {
      if (this.#runtimeInitTask === task) this.#runtimeInitTask = undefined;
    });
    this.#runtimeInitTask = task;
    return task;
  }

  async #initializeRuntime(): Promise<void> {
    const ir = this.#session.requireIr();
    const generation = this.#generation;
    const clock =
      globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function'
        ? new AudioWorkletClock({
            channelCount: ir.channelLayout === 'mono' ? 1 : 2,
            sampleRate: ir.sampleRate,
            ...(this.#runtimeAssets?.sharedAudioWorklet === undefined
              ? {}
              : { moduleUrl: this.#runtimeAssets.sharedAudioWorklet }),
          })
        : new TransferableAudioWorkletClock({
            channelCount: ir.channelLayout === 'mono' ? 1 : 2,
            sampleRate: ir.sampleRate,
            ...(this.#runtimeAssets?.transferableAudioWorklet === undefined
              ? {}
              : { moduleUrl: this.#runtimeAssets.transferableAudioWorklet }),
          });
    this.#clock = clock;
    try {
      await clock.initialize(1_024);
    } catch (error) {
      await clock.dispose().catch(() => undefined);
      if (this.#clock === clock) this.#clock = undefined;
      throw error;
    }
    if (this.#clock !== clock || generation !== this.#generation || this.#state === 'disposed') {
      await clock.dispose();
      if (this.#clock === clock) this.#clock = undefined;
      throw new DOMException('Player runtime initialization became stale', 'AbortError');
    }
    this.#scheduler = new AudioDrivenVideoScheduler({
      clock,
      frameRate: ir.frameRate,
      durationUs: ir.durationUs,
      onFrame: (scheduled) => this.#renderScheduled(scheduled),
      onError: (error) => this.#failRuntime(error),
      onEnd: () => {
        this.#state = 'ended';
        this.#lastTimeUs = ir.durationUs;
        this.#resetAudioResampler();
        this.#publishTime();
        if (this.#fillHandle !== undefined) {
          globalThis.clearInterval(this.#fillHandle);
          this.#fillHandle = undefined;
        }
        void this.#clock?.pause().catch((error: unknown) => this.#failRuntime(error));
        this.#session.notifyStatsChanged();
      },
    });
  }

  #requestAudioFill(observeFailure: boolean): Promise<void> {
    const existing = this.#fillTask;
    if (existing !== undefined) {
      if (this.#fillGeneration === this.#generation) return existing;
      const next = existing.then(
        () => this.#requestAudioFill(observeFailure),
        () => this.#requestAudioFill(observeFailure),
      );
      if (!observeFailure) void next.catch((error: unknown) => this.#failRuntime(error));
      return next;
    }
    const clock = this.#clock;
    if (clock === undefined) return Promise.resolve();
    const generation = this.#generation;
    const signal = this.#fillController.signal;
    const task = this.#fillAudio(clock, generation, signal).finally(() => {
      if (this.#fillTask === task) this.#fillTask = undefined;
    });
    this.#fillTask = task;
    this.#fillGeneration = generation;
    if (!observeFailure) void task.catch((error: unknown) => this.#failRuntime(error));
    return task;
  }

  #writePcmToClock(clock: Clock, pcm: Float32Array, channelCount: number): Float32Array | undefined {
    const totalFrames = Math.floor(pcm.length / channelCount);
    if (totalFrames <= 0) return undefined;
    if (clock instanceof AudioWorkletClock) {
      const written = clock.ring.writeInterleaved(pcm);
      if (written >= totalFrames) return undefined;
      return pcm.slice(written * channelCount);
    }
    const available = clock.snapshot().availableWriteFrames;
    if (available <= 0) return pcm;
    if (totalFrames <= available) {
      return clock.enqueueInterleaved(pcm) ? undefined : pcm;
    }
    const head = pcm.slice(0, available * channelCount);
    if (!clock.enqueueInterleaved(head)) return pcm;
    return pcm.slice(available * channelCount);
  }

  #ensureAudioResampler(
    inputSampleRate: number,
    outputSampleRate: number,
    channelCount: number,
  ): StreamingPcmResampler {
    if (
      this.#audioResampler === undefined ||
      this.#audioResamplerInputRate !== inputSampleRate ||
      this.#audioResamplerOutputRate !== outputSampleRate ||
      this.#audioResamplerChannels !== channelCount
    ) {
      this.#audioResampler = new StreamingPcmResampler({
        inputSampleRate,
        outputSampleRate,
        channelCount,
      });
      this.#audioResamplerInputRate = inputSampleRate;
      this.#audioResamplerOutputRate = outputSampleRate;
      this.#audioResamplerChannels = channelCount;
    }
    return this.#audioResampler;
  }

  #resetAudioResampler(): void {
    this.#audioResampler = undefined;
    this.#audioResamplerInputRate = 0;
    this.#audioResamplerOutputRate = 0;
    this.#audioResamplerChannels = 0;
    this.#pendingResampledPcm = undefined;
  }

  async #fillAudio(clock: Clock, generation: number, signal: AbortSignal): Promise<void> {
    const ir = this.#session.requireIr();
    const channelCount = clock instanceof AudioWorkletClock ? clock.ring.channelCount : clock.queue.channelCount;
    const outputSampleRate = Math.max(8_000, Math.round(clock.context.sampleRate || ir.sampleRate));
    const needsResample = outputSampleRate !== ir.sampleRate;
    const totalFrames = Math.floor((ir.durationUs * ir.sampleRate) / 1_000_000);
    if (needsResample && this.#pendingResampledPcm !== undefined) {
      this.#pendingResampledPcm = this.#writePcmToClock(clock, this.#pendingResampledPcm, channelCount);
      if (this.#pendingResampledPcm !== undefined) return;
    }
    while (this.#nextAudioFrame < totalFrames) {
      if (!this.#runtimeCurrent(clock, generation, signal)) return;
      const snapshot = clock instanceof AudioWorkletClock ? clock.ring.snapshot() : clock.snapshot();
      if (snapshot.availableWriteFrames <= 0) break;
      const startFrame = this.#nextAudioFrame;
      const maxInputFrames = needsResample
        ? Math.max(256, Math.floor((snapshot.availableWriteFrames * ir.sampleRate) / outputSampleRate))
        : snapshot.availableWriteFrames;
      const frameCount = Math.min(4_096, maxInputFrames, totalFrames - startFrame);
      if (frameCount <= 0) break;
      const pcm = await renderIrAudio({
        ir,
        startFrame,
        frameCount,
        channelCount,
        source: this.#session.requireMedia(),
        signal,
      });
      if (!this.#runtimeCurrent(clock, generation, signal)) return;
      if (this.#nextAudioFrame !== startFrame) return;
      if (!needsResample) {
        const accepted =
          clock instanceof AudioWorkletClock
            ? clock.ring.writeInterleaved(pcm) === frameCount
            : clock.enqueueInterleaved(pcm);
        if (!accepted) break;
        this.#nextAudioFrame = startFrame + frameCount;
        continue;
      }
      const isFinal = startFrame + frameCount >= totalFrames;
      const resampler = this.#ensureAudioResampler(ir.sampleRate, outputSampleRate, channelCount);
      const resampled = resampler.push(pcm, isFinal);
      this.#nextAudioFrame = startFrame + frameCount;
      if (isFinal) this.#audioResampler = undefined;
      if (resampled.length > 0) {
        const remainder = this.#writePcmToClock(clock, resampled, channelCount);
        if (remainder !== undefined) {
          this.#pendingResampledPcm = remainder;
          break;
        }
      }
    }
  }

  async #renderScheduled(scheduled: ScheduledVideoFrame): Promise<void> {
    const signal = this.#videoController.signal;
    const ir = this.#session.requireIr();
    // Decode the clock's current time, not the (possibly stale) scheduled PTS.
    // A per-frame timeout abort restarts sequential decode from a keyframe and
    // hitches every few hundred milliseconds; the scheduler already skips
    // behind by dropping intervals while a frame is in flight.
    const timeUs = Math.min(Math.max(0, this.currentTimeUs), Math.max(0, ir.durationUs - 1));
    const visual = hasVisualPreview(ir, timeUs);
    if (!visual && this.#presentedBlank) return;
    try {
      const result = await this.#session.preview.renderFrame({
        timeUs,
        signal,
        ...this.#previewQuality,
      });
      if (signal.aborted || scheduled.generation !== this.#scheduler?.generation) {
        result.bitmap.close();
        return;
      }
      this.#presentedBlank = !visual;
      this.#publish({ ...scheduled, timestampUs: timeUs }, result);
    } catch (error) {
      if (recoverablePreviewSkip(error) || signal.aborted) return;
      throw error;
    }
  }

  #publish(
    scheduled: Pick<ScheduledVideoFrame, 'generation' | 'frameIndex' | 'timestampUs' | 'droppedFrames'>,
    result: Awaited<ReturnType<AelionSession['renderFrame']>>,
  ): void {
    this.#lastTimeUs = scheduled.timestampUs;
    this.#renderedFrames += 1;
    this.#droppedFrames += scheduled.droppedFrames;
    this.#session.notifyStatsChanged();
    this.#publishTime();
    if (this.#listeners.size === 0) {
      result.bitmap.close();
      return;
    }
    const event = { ...scheduled, result };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        result.bitmap.close();
        this.#failRuntime(error);
        return;
      }
    }
  }

  #publishTime(): void {
    if (this.#timeListeners.size === 0) return;
    const time: AelionPlayerTime = { timeUs: this.currentTimeUs, state: this.#state };
    for (const listener of [...this.#timeListeners]) {
      try {
        listener(time);
      } catch {
        // A readout that throws must not stall playback or the transport.
      }
    }
  }

  #disposeRuntime(): Promise<void> {
    const existing = this.#runtimeDisposeTask;
    if (existing !== undefined) return existing;
    const task = this.#disposeRuntimeOnce().finally(() => {
      if (this.#runtimeDisposeTask === task) this.#runtimeDisposeTask = undefined;
    });
    this.#runtimeDisposeTask = task;
    return task;
  }

  async #disposeRuntimeOnce(): Promise<void> {
    if (this.#fillHandle !== undefined) {
      globalThis.clearInterval(this.#fillHandle);
      this.#fillHandle = undefined;
    }
    const scheduler = this.#scheduler;
    const initializingClock = this.#clock;
    scheduler?.dispose();
    await this.#runtimeInitTask?.catch(() => undefined);
    const clock = this.#clock ?? initializingClock;
    this.#clock = undefined;
    await clock?.dispose();
    await this.#fillTask?.catch(() => undefined);
    this.#fillTask = undefined;
    this.#fillGeneration = -1;
    this.#resetAudioResampler();
    this.#scheduler = undefined;
    if (scheduler !== undefined || clock !== undefined) {
      const transport =
        clock instanceof AudioWorkletClock
          ? clock.ring.snapshot()
          : clock instanceof TransferableAudioWorkletClock
            ? clock.snapshot()
            : undefined;
      this.#lastDisposedRuntime = Object.freeze({
        schedulerDisposed: scheduler?.snapshot().disposed ?? true,
        audioDisposed: clock?.disposed ?? true,
        audioContextClosed: clock === undefined || !clock.ownsContext || clock.context.state === 'closed',
        transportClosed:
          transport === undefined ? true : 'state' in transport ? transport.state === 'closed' : transport.closed,
        bufferedFrames:
          transport === undefined
            ? 0
            : 'availableReadFrames' in transport
              ? transport.availableReadFrames
              : transport.queuedFrames,
      });
    }
  }

  #advanceGeneration(): void {
    this.#generation += 1;
    this.#presentedBlank = false;
    this.#resetAudioResampler();
    this.#scheduler?.seek();
    this.#fillController.abort(new DOMException('Player generation changed', 'AbortError'));
    this.#videoController.abort(new DOMException('Player generation changed', 'AbortError'));
    this.#fillController = new AbortController();
    this.#videoController = new AbortController();
  }

  #runtimeCurrent(clock: Clock, generation: number, signal: AbortSignal): boolean {
    return !signal.aborted && this.#state !== 'disposed' && this.#clock === clock && this.#generation === generation;
  }

  #playContinuationCurrent(generation: number): boolean {
    return this.#disposeTask === undefined && generation === this.#generation;
  }

  #failRuntime(error: unknown): void {
    if (this.#state === 'disposed') return;
    if (recoverablePreviewSkip(error)) return;
    const failureTimeUs = this.currentTimeUs;
    this.#errors += 1;
    this.#lastErrorCode = runtimeErrorCode(error);
    this.#state = 'error';
    this.#lastTimeUs = failureTimeUs;
    this.#publishTime();
    this.#scheduler?.pause();
    if (this.#fillHandle !== undefined) {
      globalThis.clearInterval(this.#fillHandle);
      this.#fillHandle = undefined;
    }
    this.#fillController.abort(error);
    void this.#clock?.pause().catch(() => undefined);
    try {
      this.#onRuntimeError?.(error);
    } catch {
      // Error reporting cannot create a second unhandled runtime failure.
    }
    this.#session.notifyStatsChanged();
  }
}
