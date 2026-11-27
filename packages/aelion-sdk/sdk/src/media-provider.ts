import type { PcmSourceBlock } from '@aelionsdk/audio';
import { AelionError, type JsonObject } from '@aelionsdk/core';
import {
  createSampleIndex,
  createVideoFrameDecodeSessionFromReader,
  decodeAudioPcmRange,
  MemoryRangeReader,
  type SampleIndex,
  type VideoFrameDecodeSession,
} from '@aelionsdk/media';

import type { AelionMediaProvider } from './types.js';

export type AelionAssetBytesResolver = (assetId: string, signal?: AbortSignal) => Promise<Uint8Array>;

export interface ByteMediaProviderOptions {
  readonly resolveAssetBytes: AelionAssetBytesResolver;
  readonly maxCachedBytes?: number;
  /** Maximum byte-load, SampleIndex and decode operations allowed at once. Defaults to 4. */
  readonly maxConcurrentOperations?: number;
  /** Maximum bounded operations waiting for a slot. Defaults to 64. */
  readonly maxPendingOperations?: number;
  /** Compatibility alias for maxConcurrentOperations; covers load, index and decode work. */
  readonly maxConcurrentLoads?: number;
}

interface SharedOperation<T> {
  readonly controller: AbortController;
  settled: boolean;
  readonly subscribers: Map<symbol, SharedSubscriber<T>>;
}

interface SharedSubscriber<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort: () => void;
}

interface CachedAsset {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  index?: SampleIndex;
  indexOperation?: SharedOperation<SampleIndex> | undefined;
  videoSessions?: Map<number, VideoFrameDecodeSession> | undefined;
}

interface AssetLoad extends SharedOperation<CachedAsset> {
  readonly generation: number;
}

interface OperationWaiter {
  readonly grant: () => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function errorReason(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError');
}

function settleShared<T>(
  operation: SharedOperation<T>,
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error },
): void {
  if (operation.settled) return;
  operation.settled = true;
  const subscribers = [...operation.subscribers.values()];
  operation.subscribers.clear();
  for (const subscriber of subscribers) {
    subscriber.signal?.removeEventListener('abort', subscriber.onAbort);
    if (result.ok) subscriber.resolve(result.value);
    else subscriber.reject(result.error);
  }
}

function observeShared<T>(
  operation: SharedOperation<T>,
  promise: Promise<T>,
  failureMessage: string,
  onSettled: () => void,
): void {
  void promise.then(
    (value) => {
      try {
        settleShared(operation, { ok: true, value });
      } finally {
        onSettled();
      }
    },
    (error: unknown) => {
      try {
        settleShared(operation, {
          ok: false,
          error: errorReason(error, failureMessage),
        });
      } finally {
        onSettled();
      }
    },
  );
}

function awaitShared<T>(operation: SharedOperation<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(abortReason(signal));
  if (operation.settled) return Promise.reject(new Error('Shared operation already settled'));

  return new Promise<T>((resolve, reject) => {
    const token = Symbol('media-subscriber');
    const onAbort = (): void => {
      if (!operation.subscribers.delete(token)) return;
      signal?.removeEventListener('abort', onAbort);
      if (signal !== undefined) reject(abortReason(signal));
      if (operation.subscribers.size === 0 && !operation.settled) {
        operation.controller.abort(new DOMException('Shared media operation has no active callers', 'AbortError'));
      }
    };
    operation.subscribers.set(token, {
      resolve,
      reject,
      ...(signal === undefined ? {} : { signal }),
      onAbort,
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    // Covers unusual AbortSignal implementations that become aborted while a
    // listener is being installed.
    if (signal?.aborted === true) onAbort();
  });
}

/**
 * Convenience provider for small Alpha projects. It keeps a bounded LRU of
 * immutable asset bytes and reuses SampleIndex across exact seeks. Large/CDN
 * integrations should provide their own Range-backed AelionMediaProvider.
 */
export class ByteMediaProvider implements AelionMediaProvider {
  readonly #resolve: AelionAssetBytesResolver;
  readonly #maxCachedBytes: number;
  readonly #maxConcurrentOperations: number;
  readonly #maxPendingOperations: number;
  readonly #maxInFlightRequests: number;
  readonly #cache = new Map<string, CachedAsset>();
  readonly #loads = new Map<string, AssetLoad>();
  readonly #assetLoadOperations = new Set<AssetLoad>();
  readonly #indexOperations = new Set<SharedOperation<SampleIndex>>();
  readonly #operationWaiters: OperationWaiter[] = [];
  #cachedBytes = 0;
  #activeOperations = 0;
  #inFlightRequests = 0;
  #generation = 0;

  public constructor(options: ByteMediaProviderOptions) {
    this.#resolve = options.resolveAssetBytes;
    this.#maxCachedBytes = positiveSafeInteger(options.maxCachedBytes ?? 64 * 1_024 * 1_024, 'maxCachedBytes');
    if (
      options.maxConcurrentOperations !== undefined &&
      options.maxConcurrentLoads !== undefined &&
      options.maxConcurrentOperations !== options.maxConcurrentLoads
    ) {
      throw new RangeError('maxConcurrentOperations and maxConcurrentLoads must match');
    }
    this.#maxConcurrentOperations = positiveSafeInteger(
      options.maxConcurrentOperations ?? options.maxConcurrentLoads ?? 4,
      'maxConcurrentOperations',
    );
    this.#maxPendingOperations = nonNegativeSafeInteger(options.maxPendingOperations ?? 64, 'maxPendingOperations');
    this.#maxInFlightRequests = this.#maxConcurrentOperations + this.#maxPendingOperations;
    if (!Number.isSafeInteger(this.#maxInFlightRequests)) {
      throw new RangeError('maxConcurrentOperations + maxPendingOperations must be a safe integer');
    }
  }

  public async frameAt(
    assetId: string,
    streamIndex: number,
    sourceTimeUs: number,
    signal?: AbortSignal,
  ): Promise<VideoFrame> {
    this.#admitRequest(signal);
    try {
      const cached = await this.#asset(assetId, signal);
      const index = await this.#sampleIndex(cached, signal);
      cached.videoSessions ??= new Map();
      let session = cached.videoSessions.get(streamIndex);
      if (session === undefined) {
        session = createVideoFrameDecodeSessionFromReader(
          new MemoryRangeReader(`${assetId}:video:${streamIndex.toString()}`, cached.bytes),
          index,
          {
            streamIndex,
            maxCachedFrames: 8,
            maxCachedBytes: 96 * 1_024 * 1_024,
          },
        );
        cached.videoSessions.set(streamIndex, session);
      }
      const decoded = await this.#runBounded(signal, () => session.frameAt(sourceTimeUs, signal));
      try {
        if (signal?.aborted === true) throw abortReason(signal);
        return decoded.frame.clone();
      } finally {
        decoded.close();
      }
    } finally {
      this.#releaseRequest();
    }
  }

  public async pcmRange(
    assetId: string,
    streamIndex: number,
    startUs: number,
    durationUs: number,
    signal?: AbortSignal,
  ): Promise<PcmSourceBlock> {
    this.#admitRequest(signal);
    try {
      const cached = await this.#asset(assetId, signal);
      const block = await this.#runBounded(signal, () =>
        decodeAudioPcmRange(cached.bytes, startUs, durationUs, {
          streamIndex,
          ...(signal === undefined ? {} : { signal }),
        }),
      );
      if (signal?.aborted === true) throw abortReason(signal);
      return block;
    } finally {
      this.#releaseRequest();
    }
  }

  public clear(): void {
    this.#generation += 1;
    for (const cached of this.#cache.values()) this.#disposeAsset(cached);
    this.#cache.clear();
    this.#cachedBytes = 0;
  }

  public snapshot(): {
    readonly assets: number;
    readonly cachedBytes: number;
    readonly maxCachedBytes: number;
    readonly inFlightAssetLoads: number;
    readonly inFlightSampleIndexes: number;
    /** Public frameAt/pcmRange calls currently admitted across their full lifecycle. */
    readonly inFlightRequests: number;
    /** Hard request cap, derived as maxConcurrentOperations + maxPendingOperations. */
    readonly maxInFlightRequests: number;
    /** Subscribers retained by active single-flight load and index operations. */
    readonly sharedOperationSubscribers: number;
    readonly activeOperations: number;
    readonly pendingOperations: number;
    readonly maxConcurrentOperations: number;
    readonly maxPendingOperations: number;
    /** Compatibility alias for activeOperations. */
    readonly activeLoads: number;
    /** Compatibility alias for pendingOperations. */
    readonly pendingLoads: number;
    /** Compatibility alias for maxConcurrentOperations. */
    readonly maxConcurrentLoads: number;
  } {
    return {
      assets: this.#cache.size,
      cachedBytes: this.#cachedBytes,
      maxCachedBytes: this.#maxCachedBytes,
      inFlightAssetLoads: this.#assetLoadOperations.size,
      inFlightSampleIndexes: this.#indexOperations.size,
      inFlightRequests: this.#inFlightRequests,
      maxInFlightRequests: this.#maxInFlightRequests,
      sharedOperationSubscribers: [...this.#assetLoadOperations, ...this.#indexOperations].reduce(
        (total, operation) => total + operation.subscribers.size,
        0,
      ),
      activeOperations: this.#activeOperations,
      pendingOperations: this.#operationWaiters.length,
      maxConcurrentOperations: this.#maxConcurrentOperations,
      maxPendingOperations: this.#maxPendingOperations,
      activeLoads: this.#activeOperations,
      pendingLoads: this.#operationWaiters.length,
      maxConcurrentLoads: this.#maxConcurrentOperations,
    };
  }

  public getDiagnosticSnapshot(): JsonObject {
    return this.snapshot() as unknown as JsonObject;
  }

  async #asset(assetId: string, signal?: AbortSignal): Promise<CachedAsset> {
    if (signal?.aborted === true) throw abortReason(signal);
    const existing = this.#cache.get(assetId);
    if (existing !== undefined) {
      this.#cache.delete(assetId);
      this.#cache.set(assetId, existing);
      return existing;
    }
    const generation = this.#generation;
    const inFlight = this.#loads.get(assetId);
    if (inFlight?.generation === generation && !inFlight.settled && !inFlight.controller.signal.aborted) {
      return awaitShared(inFlight, signal);
    }
    if (
      this.#activeOperations >= this.#maxConcurrentOperations &&
      this.#operationWaiters.length >= this.#maxPendingOperations
    ) {
      throw this.#queueFullError('operation');
    }
    const controller = new AbortController();
    const load: AssetLoad = {
      generation,
      controller,
      settled: false,
      subscribers: new Map(),
    };
    this.#loads.set(assetId, load);
    this.#assetLoadOperations.add(load);
    observeShared(load, this.#loadAsset(assetId, generation, controller.signal), 'Shared asset load failed', () => {
      this.#assetLoadOperations.delete(load);
      if (this.#loads.get(assetId) === load) this.#loads.delete(assetId);
    });
    return awaitShared(load, signal);
  }

  async #loadAsset(assetId: string, generation: number, signal: AbortSignal): Promise<CachedAsset> {
    return this.#runBounded(signal, async () => {
      const bytes = await this.#resolve(assetId, signal);
      if (signal.aborted) throw abortReason(signal);
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError(`Asset resolver returned no bytes for ${assetId}`);
      }
      // Only trust the genuine copy's intrinsic length. A Uint8Array subclass
      // can override `byteLength`; using the resolver object's property would
      // let it under-report cache ownership after a large copy was allocated.
      const copy = new Uint8Array(bytes);
      const byteLength = copy.byteLength;
      if (byteLength === 0) throw new TypeError(`Asset resolver returned no bytes for ${assetId}`);
      const cached = { bytes: copy, byteLength };
      if (generation !== this.#generation || byteLength > this.#maxCachedBytes) return cached;
      while (this.#cachedBytes + byteLength > this.#maxCachedBytes && this.#cache.size > 0) {
        const oldest = this.#cache.entries().next().value;
        if (oldest === undefined) break;
        this.#cache.delete(oldest[0]);
        this.#disposeAsset(oldest[1]);
        this.#cachedBytes -= oldest[1].byteLength;
      }
      this.#cache.set(assetId, cached);
      this.#cachedBytes += cached.byteLength;
      return cached;
    });
  }

  async #sampleIndex(cached: CachedAsset, signal?: AbortSignal): Promise<SampleIndex> {
    if (signal?.aborted === true) throw abortReason(signal);
    if (cached.index !== undefined) return cached.index;
    let operation = cached.indexOperation;
    if (operation === undefined || operation.settled || operation.controller.signal.aborted) {
      if (
        this.#activeOperations >= this.#maxConcurrentOperations &&
        this.#operationWaiters.length >= this.#maxPendingOperations
      ) {
        throw this.#queueFullError('operation');
      }
      const controller = new AbortController();
      operation = {
        controller,
        settled: false,
        subscribers: new Map(),
      };
      const current = operation;
      const promise = this.#runBounded(controller.signal, async () => {
        const index = await createSampleIndex(cached.bytes, { signal: controller.signal });
        if (controller.signal.aborted) throw abortReason(controller.signal);
        cached.index = index;
        return index;
      });
      cached.indexOperation = current;
      this.#indexOperations.add(current);
      observeShared(current, promise, 'Shared media index operation failed', () => {
        this.#indexOperations.delete(current);
        if (cached.indexOperation === current) cached.indexOperation = undefined;
      });
    }
    return awaitShared(operation, signal);
  }

  #disposeAsset(cached: CachedAsset): void {
    for (const session of cached.videoSessions?.values() ?? []) session.dispose();
    cached.videoSessions?.clear();
  }

  async #runBounded<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    await this.#acquireOperationSlot(signal);
    try {
      if (signal?.aborted === true) throw abortReason(signal);
      return await operation();
    } finally {
      this.#releaseOperationSlot();
    }
  }

  async #acquireOperationSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw abortReason(signal);
    if (this.#activeOperations < this.#maxConcurrentOperations) {
      this.#activeOperations += 1;
      return;
    }
    if (this.#operationWaiters.length >= this.#maxPendingOperations) {
      throw this.#queueFullError('operation');
    }
    await new Promise<void>((resolve, reject) => {
      let queued = true;
      const waiter: OperationWaiter = {
        ...(signal === undefined ? {} : { signal }),
        grant: () => {
          if (!queued) return;
          queued = false;
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (error) => {
          if (!queued) return;
          queued = false;
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        const index = this.#operationWaiters.indexOf(waiter);
        if (index >= 0) this.#operationWaiters.splice(index, 1);
        if (signal !== undefined) waiter.reject(abortReason(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#operationWaiters.push(waiter);
    });
  }

  #releaseOperationSlot(): void {
    let next = this.#operationWaiters.shift();
    while (next?.signal?.aborted === true) {
      next.reject(abortReason(next.signal));
      next = this.#operationWaiters.shift();
    }
    if (next === undefined) {
      this.#activeOperations -= 1;
      return;
    }
    next.grant();
  }

  #admitRequest(signal?: AbortSignal): void {
    if (signal?.aborted === true) throw abortReason(signal);
    if (this.#inFlightRequests >= this.#maxInFlightRequests) {
      throw this.#queueFullError('request');
    }
    this.#inFlightRequests += 1;
  }

  #releaseRequest(): void {
    this.#inFlightRequests -= 1;
  }

  #queueFullError(scope: 'operation' | 'request'): AelionError {
    const limit = scope === 'request' ? this.#maxInFlightRequests : this.#maxPendingOperations;
    return new AelionError([
      {
        code: 'MEDIA_PROVIDER_QUEUE_FULL',
        severity: 'error',
        message:
          scope === 'request'
            ? `ByteMediaProvider reached its ${limit.toString()} in-flight request limit`
            : `ByteMediaProvider operation queue reached its ${limit.toString()} pending operation limit`,
        recoverable: true,
        details: { scope, limit },
      },
    ]);
  }
}
