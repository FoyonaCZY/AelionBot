import type { Disposable } from '@aelionsdk/core';

import { TransferablePcmQueue, type TransferablePcmQueueSnapshot } from './transferable-pcm-queue.js';

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs.toString()} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
  }
}

export interface TransferableClockReport {
  readonly currentFrame: number;
  readonly currentTime: number;
  readonly generation: number;
  readonly playedFrames: number;
  readonly underrunFrames: number;
  readonly queuedBlocks: number;
}

export interface TransferableAudioClockOptions {
  readonly context?: AudioContext;
  /** Host-resolved module URL for non-Vite or CDN deployments. */
  readonly moduleUrl?: string | URL;
  /** Requested hardware context rate when the clock owns its AudioContext. */
  readonly sampleRate?: number;
  readonly capacityFrames?: number;
  readonly channelCount?: number;
  readonly reportEveryFrames?: number;
}

export class TransferableAudioWorkletClock implements Disposable {
  public readonly context: AudioContext;
  public readonly queue: TransferablePcmQueue;
  readonly #ownsContext: boolean;
  #node: AudioWorkletNode | undefined;
  #outputConnected = false;
  #initializeTask: Promise<void> | undefined;
  #disposeTask: Promise<void> | undefined;
  #disposed = false;
  #lifecycleGeneration = 0;
  #generation = 0;
  #timelineOriginUs = 0;
  #contextOriginTime?: number;
  #lastReport?: TransferableClockReport;
  readonly #moduleUrl: string | URL;

  public constructor(options: TransferableAudioClockOptions = {}) {
    this.#moduleUrl = options.moduleUrl ?? new URL('./pcm-message-player.worklet.js', import.meta.url);
    if (options.context !== undefined) {
      this.context = options.context;
    } else {
      try {
        this.context = new AudioContext({
          latencyHint: 'playback',
          sampleRate: options.sampleRate ?? 48_000,
        });
      } catch {
        // Fall back to hardware default rate if the OS rejects the requested project rate.
        this.context = new AudioContext({ latencyHint: 'playback' });
      }
    }
    this.#ownsContext = options.context === undefined;
    const actualSampleRate = Math.max(8_000, Math.round(this.context.sampleRate || options.sampleRate || 48_000));
    this.queue = new TransferablePcmQueue(options.capacityFrames ?? actualSampleRate * 4, options.channelCount ?? 2);
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public get ownsContext(): boolean {
    return this.#ownsContext;
  }

  public get generation(): number {
    return this.#generation;
  }

  public get lastReport(): TransferableClockReport | undefined {
    return this.#lastReport;
  }

  public async initialize(reportEveryFrames = Math.round(this.context.sampleRate / 20)): Promise<void> {
    if (this.#disposed) throw new ReferenceError('TransferableAudioWorkletClock is disposed');
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
    const node = new AudioWorkletNode(this.context, 'aelion-message-pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [this.queue.channelCount],
      processorOptions: {
        channelCount: this.queue.channelCount,
        generation: this.#generation,
        reportEveryFrames,
      },
    });
    let connected = false;
    try {
      node.port.addEventListener('message', (event) => {
        const value: unknown = event.data;
        if (value === null || typeof value !== 'object') return;
        const type: unknown = Reflect.get(value, 'type');
        if (type === 'ack') {
          const id: unknown = Reflect.get(value, 'id');
          if (typeof id === 'number') this.queue.acknowledge(id);
        } else if (type === 'clock') {
          this.#lastReport = value as TransferableClockReport;
        }
      });
      node.port.start();
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
    this.#node?.port.postMessage({ type: 'start', generation: this.#generation });
    await this.context.resume();
  }

  public enqueueInterleaved(input: Float32Array): boolean {
    if (this.#disposed) throw new ReferenceError('TransferableAudioWorkletClock is disposed');
    const block = this.queue.enqueue(input, this.#generation);
    if (block === undefined) return false;
    this.#node?.port.postMessage(
      {
        type: 'block',
        id: block.id,
        generation: block.generation,
        frameCount: block.frameCount,
        channelCount: block.channelCount,
        samples: block.samples,
      },
      [block.samples.buffer],
    );
    return true;
  }

  public async pause(): Promise<void> {
    this.#disconnectOutput();
    if (this.context.state === 'running') await this.context.suspend();
  }

  public async resume(): Promise<void> {
    this.#connectOutput();
    if (this.context.state !== 'running') await this.context.resume();
  }

  #connectOutput(): void {
    if (this.#node === undefined || this.#outputConnected) return;
    this.#node.connect(this.context.destination);
    this.#outputConnected = true;
  }

  #disconnectOutput(): void {
    if (this.#node === undefined || !this.#outputConnected) return;
    this.#node.disconnect();
    this.#outputConnected = false;
    this.queue.flush();
  }

  public seek(timeUs: number): number {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
      throw new RangeError('Seek target must be a non-negative safe integer microsecond value');
    }
    this.#generation += 1;
    this.#timelineOriginUs = timeUs;
    this.#contextOriginTime = this.context.currentTime;
    this.queue.flush();
    this.#node?.port.postMessage({ type: 'seek', generation: this.#generation });
    return this.#generation;
  }

  public nowUs(): number {
    const origin = this.#contextOriginTime ?? this.context.currentTime;
    return this.#timelineOriginUs + Math.max(0, Math.round((this.context.currentTime - origin) * 1_000_000));
  }

  public snapshot(): TransferablePcmQueueSnapshot {
    return this.queue.snapshot();
  }

  public dispose(): Promise<void> {
    this.#disposeTask ??= this.#dispose();
    return this.#disposeTask;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    this.#lifecycleGeneration += 1;
    this.queue.close();
    this.#node?.port.postMessage({ type: 'close' });
    this.#node?.disconnect();
    this.#outputConnected = false;
    this.#node?.port.close();
    this.#node = undefined;
    if (this.#ownsContext && this.context.state !== 'closed') await this.context.close();
    await this.#initializeTask?.catch(() => undefined);
  }

  #throwIfInitializationStale(generation: number): void {
    if (this.#disposed || generation !== this.#lifecycleGeneration) {
      throw new DOMException('TransferableAudioWorkletClock initialization became stale', 'AbortError');
    }
  }
}

export type BrowserAudioClockSelection =
  | { readonly mode: 'shared-ring'; readonly reason: 'cross-origin-isolated' }
  | { readonly mode: 'transferable-queue'; readonly reason: 'shared-array-buffer-unavailable' };

export function selectBrowserAudioTransport(environment: {
  readonly crossOriginIsolated: boolean;
  readonly sharedArrayBufferAvailable: boolean;
}): BrowserAudioClockSelection {
  return environment.crossOriginIsolated && environment.sharedArrayBufferAvailable
    ? { mode: 'shared-ring', reason: 'cross-origin-isolated' }
    : { mode: 'transferable-queue', reason: 'shared-array-buffer-unavailable' };
}
