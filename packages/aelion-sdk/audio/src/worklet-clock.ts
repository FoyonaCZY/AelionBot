import type { Disposable } from '@aelionsdk/core';

import { SharedPcmRingBuffer, type PcmRingSnapshot } from './pcm-ring.js';

export interface AudioClockReport {
  readonly currentFrame: number;
  readonly currentTime: number;
  readonly snapshot: PcmRingSnapshot;
}

export type AudioClockEvent =
  | { readonly type: 'started'; readonly timeUs: number }
  | { readonly type: 'paused'; readonly timeUs: number }
  | { readonly type: 'interrupted'; readonly timeUs: number }
  | { readonly type: 'resumed'; readonly timeUs: number }
  | { readonly type: 'seeked'; readonly timeUs: number; readonly generation: number };

export interface AudioClockOptions {
  readonly context?: AudioContext;
  /** Host-resolved module URL for non-Vite or CDN deployments. */
  readonly moduleUrl?: string | URL;
  /** Requested hardware context rate when the clock owns its AudioContext. */
  readonly sampleRate?: number;
  readonly capacityFrames?: number;
  readonly channelCount?: number;
  readonly reportEveryFrames?: number;
}

export type AudioContextRuntimeState = AudioContextState | 'interrupted';

export function audioContextStateTransition(
  previous: AudioContextRuntimeState,
  current: AudioContextRuntimeState,
): 'interrupted' | 'resumed' | undefined {
  if (current === 'interrupted' && previous !== 'interrupted') return 'interrupted';
  if (previous === 'interrupted' && current === 'running') return 'resumed';
  return undefined;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

export class AudioWorkletClock implements Disposable {
  public readonly context: AudioContext;
  public readonly ring: SharedPcmRingBuffer;

  #node: AudioWorkletNode | undefined;
  #initializeTask: Promise<void> | undefined;
  #disposeTask: Promise<void> | undefined;
  #ownsContext: boolean;
  #outputConnected = false;
  #disposed = false;
  #lifecycleGeneration = 0;
  #lastReport?: AudioClockReport;
  #contextOriginTime?: number;
  #timelineOriginUs = 0;
  #generation = 0;
  #lastContextState: AudioContextRuntimeState;
  readonly #listeners = new Set<(event: AudioClockEvent) => void>();
  readonly #moduleUrl: string | URL;
  readonly #onStateChange = (): void => {
    if (this.#disposed) return;
    const current = this.context.state as AudioContextRuntimeState;
    const transition = audioContextStateTransition(this.#lastContextState, current);
    this.#lastContextState = current;
    if (transition !== undefined) this.#emit(transition);
  };

  public constructor(options: AudioClockOptions = {}) {
    this.#moduleUrl = options.moduleUrl ?? new URL('./pcm-player.worklet.js', import.meta.url);
    if (options.context !== undefined) {
      this.context = options.context;
    } else {
      try {
        this.context = new AudioContext({
          latencyHint: 'interactive',
          sampleRate: options.sampleRate ?? 48_000,
        });
      } catch {
        // Some OS audio devices (e.g. Bluetooth headsets) reject explicit sample rates; fall back to device rate.
        this.context = new AudioContext({ latencyHint: 'interactive' });
      }
    }
    this.#ownsContext = options.context === undefined;
    this.#lastContextState = this.context.state;
    const actualSampleRate = Math.max(8_000, Math.round(this.context.sampleRate || options.sampleRate || 48_000));
    this.ring = SharedPcmRingBuffer.allocate(
      options.capacityFrames ?? actualSampleRate * 2,
      options.channelCount ?? 2,
      actualSampleRate,
    );
    this.context.addEventListener('statechange', this.#onStateChange);
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public get ownsContext(): boolean {
    return this.#ownsContext;
  }

  public get lastReport(): AudioClockReport | undefined {
    return this.#lastReport;
  }

  public get generation(): number {
    return this.#generation;
  }

  public async initialize(reportEveryFrames = this.context.sampleRate): Promise<void> {
    if (this.#disposed) throw new ReferenceError('AudioWorkletClock is disposed');
    if (this.#node !== undefined) return;
    const existing = this.#initializeTask;
    if (existing !== undefined) return existing;
    const generation = this.#lifecycleGeneration;
    const task = this.#initialize(reportEveryFrames, generation).finally(() => {
      if (this.#initializeTask === task) this.#initializeTask = undefined;
    });
    this.#initializeTask = task;
    return task;
  }

  async #initialize(reportEveryFrames: number, generation: number): Promise<void> {
    await withTimeout(
      this.context.audioWorklet.addModule(this.#moduleUrl),
      5_000,
      'AudioWorklet module initialization',
    );
    this.#throwIfInitializationStale(generation);
    const node = new AudioWorkletNode(this.context, 'aelion-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.ring.channelCount],
      processorOptions: {
        ring: this.ring.descriptor(),
        reportEveryFrames,
      },
    });
    let connected = false;
    try {
      node.port.addEventListener('message', (event) => {
        const value: unknown = event.data;
        if (value !== null && typeof value === 'object' && Reflect.get(value, 'type') === 'clock') {
          this.#lastReport = value as AudioClockReport;
        }
      });
      node.port.start();
      // AudioContext.currentTime starts when the context starts running, which can
      // be well before the worklet module has loaded.  The transport clock must
      // instead start when this playback node joins the audio graph; otherwise
      // module-loading latency appears as permanent A/V drift.
      node.connect(this.context.destination);
      connected = true;
      this.#outputConnected = true;
      this.#throwIfInitializationStale(generation);
      this.#contextOriginTime = this.context.currentTime;
      this.#node = node;
    } catch (error) {
      if (connected) node.disconnect();
      node.port.close();
      throw error;
    }
  }

  public async start(): Promise<void> {
    await this.initialize();
    this.#connectOutput();
    await withTimeout(this.context.resume(), 5_000, 'AudioContext resume');
    this.#emit('started');
  }

  public async pause(): Promise<void> {
    this.#disconnectOutput();
    if (this.context.state === 'running') await this.context.suspend();
    this.#emit('paused');
  }

  public async resume(): Promise<void> {
    this.#connectOutput();
    if (this.context.state !== 'running') {
      await withTimeout(this.context.resume(), 5_000, 'AudioContext resume');
    }
    this.#emit('resumed');
  }

  #connectOutput(): void {
    if (this.#node === undefined || this.#outputConnected) return;
    this.#node.connect(this.context.destination);
    this.#outputConnected = true;
  }

  #disconnectOutput(): void {
    if (this.#node === undefined || !this.#outputConnected) return;
    // Disconnect only. A pause does not move the playback position, so the
    // buffered frames are still the ones that come next and resuming should
    // continue from them. Dropping them here would also reset the ring's play
    // and underrun counters, which are reported as session telemetry, and cost
    // a full refill on every resume. An edit while paused is what makes those
    // frames stale, and `AelionPlayer.invalidate` handles that case.
    this.#node.disconnect();
    this.#outputConnected = false;
  }

  public subscribe(listener: (event: AudioClockEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public resetForSeek(timeUs = 0): number {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
      throw new RangeError('Seek target must be a non-negative safe integer microsecond value');
    }
    this.ring.flush();
    this.#timelineOriginUs = timeUs;
    this.#contextOriginTime = this.context.currentTime;
    this.#generation += 1;
    this.#emit('seeked');
    return this.#generation;
  }

  public nowUs(): number {
    const origin = this.#contextOriginTime ?? this.context.currentTime;
    return this.#timelineOriginUs + Math.max(0, Math.round((this.context.currentTime - origin) * 1_000_000));
  }

  public dispose(): Promise<void> {
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    this.#lifecycleGeneration += 1;
    this.context.removeEventListener('statechange', this.#onStateChange);
    this.ring.close();
    this.#node?.disconnect();
    this.#outputConnected = false;
    this.#node?.port.close();
    this.#node = undefined;
    if (this.#ownsContext && this.context.state !== 'closed') await this.context.close();
    await this.#initializeTask?.catch(() => undefined);
    this.#listeners.clear();
  }

  #throwIfInitializationStale(generation: number): void {
    if (this.#disposed || generation !== this.#lifecycleGeneration) {
      throw new DOMException('AudioWorkletClock initialization became stale', 'AbortError');
    }
  }

  #emit(type: AudioClockEvent['type']): void {
    const event =
      type === 'seeked'
        ? ({ type, timeUs: this.nowUs(), generation: this.#generation } as const)
        : ({ type, timeUs: this.nowUs() } as AudioClockEvent);
    for (const listener of this.#listeners) listener(event);
  }
}
