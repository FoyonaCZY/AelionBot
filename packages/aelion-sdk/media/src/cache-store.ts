import { throwIfAborted } from '@aelionsdk/core';

export interface CacheAddress {
  readonly namespace: 'sample-index' | 'thumbnail' | 'waveform' | 'proxy' | 'derived';
  readonly contentHash: string;
  readonly version: string;
  readonly variant?: string;
}

export interface CacheStoreSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

export interface CacheStore {
  get(address: CacheAddress, signal?: AbortSignal): Promise<Uint8Array | undefined>;
  put(address: CacheAddress, value: Uint8Array, signal?: AbortSignal): Promise<void>;
  delete(address: CacheAddress, signal?: AbortSignal): Promise<void>;
  clear(signal?: AbortSignal): Promise<void>;
  snapshot(): CacheStoreSnapshot;
}

export function cacheAddressKey(address: CacheAddress): string {
  if (!/^[0-9a-f]{64}$/u.test(address.contentHash) || address.version.length === 0 || address.version.length > 128) {
    throw new TypeError('Cache address requires a SHA-256 content hash and bounded version');
  }
  return [address.namespace, address.contentHash, address.version, address.variant ?? ''].join(':');
}

interface MemoryEntry {
  readonly value: Uint8Array;
  lastAccess: number;
}

export class MemoryCacheStore implements CacheStore {
  readonly #entries = new Map<string, MemoryEntry>();
  readonly #maxBytes: number;
  #bytes = 0;
  #clock = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  public constructor(maxBytes = 64 * 1_024 * 1_024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    this.#maxBytes = maxBytes;
  }

  public get(address: CacheAddress, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    throwIfAborted(signal, 'Cache read');
    const entry = this.#entries.get(cacheAddressKey(address));
    if (entry === undefined) {
      this.#misses += 1;
      return Promise.resolve(undefined);
    }
    this.#hits += 1;
    entry.lastAccess = ++this.#clock;
    return Promise.resolve(entry.value.slice());
  }

  public put(address: CacheAddress, value: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Cache write');
    if (value.byteLength > this.#maxBytes) {
      throw new RangeError('Cache entry exceeds the store byte budget');
    }
    const key = cacheAddressKey(address);
    const previous = this.#entries.get(key);
    if (previous !== undefined) this.#bytes -= previous.value.byteLength;
    const copy = value.slice();
    this.#entries.set(key, { value: copy, lastAccess: ++this.#clock });
    this.#bytes += copy.byteLength;
    while (this.#bytes > this.#maxBytes) {
      let oldestKey: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [candidateKey, entry] of this.#entries) {
        if (entry.lastAccess < oldestAccess) {
          oldestKey = candidateKey;
          oldestAccess = entry.lastAccess;
        }
      }
      if (oldestKey === undefined) break;
      const oldest = this.#entries.get(oldestKey);
      if (oldest !== undefined) this.#bytes -= oldest.value.byteLength;
      this.#entries.delete(oldestKey);
      this.#evictions += 1;
    }
    return Promise.resolve();
  }

  public delete(address: CacheAddress, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Cache delete');
    const key = cacheAddressKey(address);
    const entry = this.#entries.get(key);
    if (entry !== undefined) this.#bytes -= entry.value.byteLength;
    this.#entries.delete(key);
    return Promise.resolve();
  }

  public clear(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Cache clear');
    this.#entries.clear();
    this.#bytes = 0;
    return Promise.resolve();
  }

  public snapshot(): CacheStoreSnapshot {
    return {
      entries: this.#entries.size,
      bytes: this.#bytes,
      maxBytes: this.#maxBytes,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
    };
  }
}

export class TieredCacheStore implements CacheStore {
  public constructor(
    readonly memory: CacheStore,
    readonly persistent: CacheStore,
  ) {}

  public async get(address: CacheAddress, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const hot = await this.memory.get(address, signal);
    if (hot !== undefined) return hot;
    const cold = await this.persistent.get(address, signal);
    if (cold !== undefined) await this.memory.put(address, cold, signal);
    return cold;
  }

  public async put(address: CacheAddress, value: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.persistent.put(address, value, signal);
    await this.memory.put(address, value, signal);
  }

  public async delete(address: CacheAddress, signal?: AbortSignal): Promise<void> {
    await Promise.all([this.memory.delete(address, signal), this.persistent.delete(address, signal)]);
  }

  public async clear(signal?: AbortSignal): Promise<void> {
    await Promise.all([this.memory.clear(signal), this.persistent.clear(signal)]);
  }

  public snapshot(): CacheStoreSnapshot {
    const memory = this.memory.snapshot();
    const persistent = this.persistent.snapshot();
    return {
      entries: persistent.entries,
      bytes: persistent.bytes,
      maxBytes: persistent.maxBytes,
      hits: memory.hits + persistent.hits,
      misses: memory.misses + persistent.misses,
      evictions: memory.evictions + persistent.evictions,
    };
  }
}

export interface SegmentedIndexChunk<T> {
  readonly segment: number;
  readonly startUs: number;
  readonly durationUs: number;
  readonly value: T;
}

export interface SegmentedIndexOptions<T> {
  readonly durationUs: number;
  readonly segmentDurationUs?: number;
  readonly maxResidentSegments?: number;
  readonly load: (startUs: number, durationUs: number, signal?: AbortSignal) => Promise<T>;
}

/** Lazy, bounded time segmentation for long-media indexes and derived data. */
export class SegmentedIndex<T> {
  readonly #options: SegmentedIndexOptions<T>;
  readonly #segmentDurationUs: number;
  readonly #maxResidentSegments: number;
  readonly #segments = new Map<number, { chunk: SegmentedIndexChunk<T>; access: number }>();
  readonly #inFlight = new Map<number, Promise<SegmentedIndexChunk<T>>>();
  #clock = 0;

  public constructor(options: SegmentedIndexOptions<T>) {
    const segmentDurationUs = options.segmentDurationUs ?? 60_000_000;
    const maxResidentSegments = options.maxResidentSegments ?? 8;
    if (
      !Number.isSafeInteger(options.durationUs) ||
      !Number.isSafeInteger(segmentDurationUs) ||
      !Number.isSafeInteger(maxResidentSegments) ||
      options.durationUs <= 0 ||
      segmentDurationUs <= 0 ||
      maxResidentSegments <= 0
    ) {
      throw new RangeError('Invalid segmented index limits');
    }
    this.#options = { ...options, segmentDurationUs, maxResidentSegments };
    this.#segmentDurationUs = segmentDurationUs;
    this.#maxResidentSegments = maxResidentSegments;
  }

  public async segmentAt(timeUs: number, signal?: AbortSignal): Promise<SegmentedIndexChunk<T>> {
    if (!Number.isSafeInteger(timeUs) || timeUs < 0 || timeUs >= this.#options.durationUs) {
      throw new RangeError('Segment time is outside the media duration');
    }
    throwIfAborted(signal, 'Segmented index');
    const segmentDurationUs = this.#segmentDurationUs;
    const segment = Math.floor(timeUs / segmentDurationUs);
    const resident = this.#segments.get(segment);
    if (resident !== undefined) {
      resident.access = ++this.#clock;
      return resident.chunk;
    }
    const pending = this.#inFlight.get(segment);
    if (pending !== undefined) return pending;
    const startUs = segment * segmentDurationUs;
    const durationUs = Math.min(segmentDurationUs, this.#options.durationUs - startUs);
    const task = this.#options
      .load(startUs, durationUs, signal)
      .then((value) => {
        throwIfAborted(signal, 'Segmented index');
        const chunk = { segment, startUs, durationUs, value };
        this.#segments.set(segment, { chunk, access: ++this.#clock });
        this.#evict();
        return chunk;
      })
      .finally(() => this.#inFlight.delete(segment));
    this.#inFlight.set(segment, task);
    return task;
  }

  public clear(): void {
    this.#segments.clear();
  }

  public snapshot(): { readonly residentSegments: number; readonly inFlightSegments: number } {
    return { residentSegments: this.#segments.size, inFlightSegments: this.#inFlight.size };
  }

  #evict(): void {
    const limit = this.#maxResidentSegments;
    while (this.#segments.size > limit) {
      const oldest = [...this.#segments.entries()].sort((left, right) => left[1].access - right[1].access)[0];
      if (oldest === undefined) return;
      this.#segments.delete(oldest[0]);
    }
  }
}
