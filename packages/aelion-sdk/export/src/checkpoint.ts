import { throwIfAborted } from '@aelionsdk/core';

import type { ExportProfileId } from './profiles.js';

export interface ExportCheckpoint {
  readonly version: 1;
  readonly contentId: string;
  readonly profileId: ExportProfileId;
  readonly totalUnits: number;
  readonly completedUnits: number;
  readonly outputBytes: number;
  readonly state?: Readonly<Record<string, string | number | boolean | null>>;
  readonly updatedAtMs: number;
}

export interface ExportCheckpointStore {
  load(key: string, signal?: AbortSignal): Promise<ExportCheckpoint | undefined>;
  save(key: string, checkpoint: ExportCheckpoint, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export class MemoryExportCheckpointStore implements ExportCheckpointStore {
  readonly #entries = new Map<string, ExportCheckpoint>();

  public load(key: string, signal?: AbortSignal): Promise<ExportCheckpoint | undefined> {
    throwIfAborted(signal, 'Load export checkpoint');
    return Promise.resolve(this.#entries.get(key));
  }

  public save(key: string, checkpoint: ExportCheckpoint, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Save export checkpoint');
    this.#entries.set(key, structuredClone(checkpoint));
    return Promise.resolve();
  }

  public delete(key: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Delete export checkpoint');
    this.#entries.delete(key);
    return Promise.resolve();
  }
}

/**
 * Durable browser checkpoint store. A new instance with the same namespace
 * resumes committed units after a page reload; callers may inject sessionStorage
 * or a test double instead of localStorage.
 */
export class BrowserStorageExportCheckpointStore implements ExportCheckpointStore {
  readonly #storage: Storage;
  readonly #namespace: string;

  public constructor(options: { readonly storage?: Storage; readonly namespace?: string } = {}) {
    const storage = options.storage ?? globalThis.localStorage;
    this.#storage = storage;
    this.#namespace = options.namespace ?? 'aelion-export-checkpoint';
  }

  public load(key: string, signal?: AbortSignal): Promise<ExportCheckpoint | undefined> {
    throwIfAborted(signal, 'Load export checkpoint');
    const value = this.#storage.getItem(this.#key(key));
    if (value === null) return Promise.resolve(undefined);
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Reflect.get(parsed, 'version') !== 1 ||
        typeof Reflect.get(parsed, 'contentId') !== 'string' ||
        typeof Reflect.get(parsed, 'profileId') !== 'string'
      ) {
        this.#storage.removeItem(this.#key(key));
        return Promise.resolve(undefined);
      }
      return Promise.resolve(parsed as ExportCheckpoint);
    } catch {
      this.#storage.removeItem(this.#key(key));
      return Promise.resolve(undefined);
    }
  }

  public save(key: string, checkpoint: ExportCheckpoint, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Save export checkpoint');
    this.#storage.setItem(this.#key(key), JSON.stringify(checkpoint));
    return Promise.resolve();
  }

  public delete(key: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Delete export checkpoint');
    this.#storage.removeItem(this.#key(key));
    return Promise.resolve();
  }

  #key(key: string): string {
    if (key.length === 0) throw new TypeError('Checkpoint key must not be empty');
    return `${this.#namespace}:${encodeURIComponent(key)}`;
  }
}

export interface CheckpointedExportUnitResult {
  readonly outputBytes: number;
  readonly state?: ExportCheckpoint['state'];
}

export interface RunCheckpointedExportOptions {
  readonly key: string;
  readonly contentId: string;
  readonly profileId: ExportProfileId;
  readonly totalUnits: number;
  readonly store: ExportCheckpointStore;
  readonly processUnit: (
    unitIndex: number,
    checkpoint: ExportCheckpoint | undefined,
    signal?: AbortSignal,
  ) => Promise<CheckpointedExportUnitResult>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly onProgress?: (completedUnits: number, totalUnits: number) => void;
}

function compatibleCheckpoint(
  checkpoint: ExportCheckpoint | undefined,
  options: RunCheckpointedExportOptions,
): ExportCheckpoint | undefined {
  if (checkpoint === undefined) return undefined;
  if (
    checkpoint.contentId !== options.contentId ||
    checkpoint.profileId !== options.profileId ||
    checkpoint.totalUnits !== options.totalUnits ||
    checkpoint.completedUnits < 0 ||
    checkpoint.completedUnits > checkpoint.totalUnits
  ) {
    return undefined;
  }
  return checkpoint;
}

/**
 * Runs independently committable export units. A unit must be idempotent for
 * `(contentId, profileId, unitIndex)`; the checkpoint is advanced only after it commits.
 */
export async function runCheckpointedExport(options: RunCheckpointedExportOptions): Promise<ExportCheckpoint> {
  if (!Number.isSafeInteger(options.totalUnits) || options.totalUnits <= 0) {
    throw new RangeError('totalUnits must be a positive safe integer');
  }
  throwIfAborted(options.signal, 'Checkpointed export');
  let checkpoint = compatibleCheckpoint(await options.store.load(options.key, options.signal), options);
  if (checkpoint === undefined) {
    await options.store.delete(options.key, options.signal);
    checkpoint = {
      version: 1,
      contentId: options.contentId,
      profileId: options.profileId,
      totalUnits: options.totalUnits,
      completedUnits: 0,
      outputBytes: 0,
      updatedAtMs: (options.now ?? Date.now)(),
    };
  }
  options.onProgress?.(checkpoint.completedUnits, checkpoint.totalUnits);
  for (let unitIndex = checkpoint.completedUnits; unitIndex < options.totalUnits; unitIndex += 1) {
    throwIfAborted(options.signal, 'Checkpointed export');
    const result = await options.processUnit(unitIndex, checkpoint, options.signal);
    checkpoint = {
      ...checkpoint,
      completedUnits: unitIndex + 1,
      outputBytes: checkpoint.outputBytes + result.outputBytes,
      ...(result.state === undefined ? {} : { state: result.state }),
      updatedAtMs: (options.now ?? Date.now)(),
    };
    await options.store.save(options.key, checkpoint, options.signal);
    options.onProgress?.(checkpoint.completedUnits, checkpoint.totalUnits);
  }
  return checkpoint;
}
