import { throwIfAborted } from '@aelionsdk/core';

import { cacheAddressKey, type CacheAddress, type CacheStore, type CacheStoreSnapshot } from './cache-store.js';

interface PersistedEntry {
  readonly file: string;
  readonly bytes: number;
  access: number;
}

interface PersistedIndex {
  readonly version: 1;
  readonly clock: number;
  readonly entries: Readonly<Record<string, PersistedEntry>>;
}

async function fileName(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return `${[...digest].map((value) => value.toString(16).padStart(2, '0')).join('')}.bin`;
}

export class OpfsCacheStore implements CacheStore {
  readonly #maxBytes: number;
  readonly #directory: Promise<FileSystemDirectoryHandle>;
  readonly #entries = new Map<string, PersistedEntry>();
  readonly #ready: Promise<void>;
  #mutation: Promise<void> = Promise.resolve();
  #bytes = 0;
  #clock = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  public constructor(directoryName = 'aelion-cache-v1', maxBytes = 512 * 1_024 * 1_024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    if (directoryName.length === 0 || directoryName.includes('/')) {
      throw new TypeError('OPFS cache directoryName must be a leaf name');
    }
    this.#maxBytes = maxBytes;
    this.#directory = navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(directoryName, { create: true }));
    this.#ready = this.#loadIndex();
  }

  public async get(address: CacheAddress, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    throwIfAborted(signal, 'OPFS cache read');
    await this.#ready;
    const key = cacheAddressKey(address);
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }
    try {
      const handle = await (await this.#directory).getFileHandle(entry.file);
      const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      throwIfAborted(signal, 'OPFS cache read');
      if (bytes.byteLength !== entry.bytes) throw new Error('OPFS cache entry size mismatch');
      entry.access = ++this.#clock;
      this.#hits += 1;
      return bytes;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        this.#entries.delete(key);
        this.#bytes -= entry.bytes;
        this.#misses += 1;
        return undefined;
      }
      throw error;
    }
  }

  public put(address: CacheAddress, value: Uint8Array, signal?: AbortSignal): Promise<void> {
    const task = this.#mutation.then(async () => {
      throwIfAborted(signal, 'OPFS cache write');
      await this.#ready;
      if (value.byteLength > this.#maxBytes) throw new RangeError('Cache entry exceeds OPFS budget');
      const estimate = await navigator.storage.estimate();
      const available = (estimate.quota ?? Number.MAX_SAFE_INTEGER) - (estimate.usage ?? 0);
      if (value.byteLength > available) {
        throw new DOMException('Insufficient OPFS quota', 'QuotaExceededError');
      }
      const key = cacheAddressKey(address);
      const name = await fileName(key);
      const directory = await this.#directory;
      const handle = await directory.getFileHandle(name, { create: true });
      const stream = await handle.createWritable();
      try {
        await stream.write(value as Uint8Array<ArrayBuffer>);
        await stream.close();
      } catch (error) {
        await stream.abort().catch(() => undefined);
        await directory.removeEntry(name).catch(() => undefined);
        throw error;
      }
      const previous = this.#entries.get(key);
      if (previous !== undefined) this.#bytes -= previous.bytes;
      this.#entries.set(key, { file: name, bytes: value.byteLength, access: ++this.#clock });
      this.#bytes += value.byteLength;
      await this.#evict();
      await this.#saveIndex();
    });
    this.#mutation = task.catch(() => undefined);
    return task;
  }

  public delete(address: CacheAddress, signal?: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      throwIfAborted(signal, 'OPFS cache delete');
      await this.#ready;
      const key = cacheAddressKey(address);
      const entry = this.#entries.get(key);
      if (entry === undefined) return;
      this.#entries.delete(key);
      this.#bytes -= entry.bytes;
      await (await this.#directory).removeEntry(entry.file).catch(() => undefined);
      await this.#saveIndex();
    });
  }

  public clear(signal?: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      throwIfAborted(signal, 'OPFS cache clear');
      await this.#ready;
      const directory = await this.#directory;
      await Promise.all(
        [...this.#entries.values()].map((entry) => directory.removeEntry(entry.file).catch(() => undefined)),
      );
      this.#entries.clear();
      this.#bytes = 0;
      await this.#saveIndex();
    });
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

  async #loadIndex(): Promise<void> {
    try {
      const handle = await (await this.#directory).getFileHandle('index.json');
      const parsed = JSON.parse(await (await handle.getFile()).text()) as PersistedIndex;
      this.#clock = parsed.clock;
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (
          typeof entry.file === 'string' &&
          Number.isSafeInteger(entry.bytes) &&
          entry.bytes >= 0 &&
          Number.isSafeInteger(entry.access)
        ) {
          this.#entries.set(key, { ...entry });
          this.#bytes += entry.bytes;
        }
      }
      await this.#evict();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
    }
  }

  async #saveIndex(): Promise<void> {
    const handle = await (await this.#directory).getFileHandle('index.json', { create: true });
    const stream = await handle.createWritable();
    await stream.write(
      JSON.stringify({
        version: 1,
        clock: this.#clock,
        entries: Object.fromEntries(this.#entries),
      } satisfies PersistedIndex),
    );
    await stream.close();
  }

  async #evict(): Promise<void> {
    const directory = await this.#directory;
    while (this.#bytes > this.#maxBytes) {
      const oldest = [...this.#entries.entries()].sort((left, right) => left[1].access - right[1].access)[0];
      if (oldest === undefined) return;
      this.#entries.delete(oldest[0]);
      this.#bytes -= oldest[1].bytes;
      await directory.removeEntry(oldest[1].file).catch(() => undefined);
      this.#evictions += 1;
    }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.#mutation.then(operation);
    this.#mutation = task.catch(() => undefined);
    return task;
  }
}
