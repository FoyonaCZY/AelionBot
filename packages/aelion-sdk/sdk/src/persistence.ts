import type { JsonValue } from '@aelionsdk/core';
import { canonicalHash, canonicalStringify, type AelionProject } from '@aelionsdk/project-schema';

import type { AelionSessionApi } from './types.js';

export const PROJECT_REVISION_RECORD_VERSION = 'aelion.project-revision/1' as const;

export interface ProjectRevisionRecord {
  readonly version: typeof PROJECT_REVISION_RECORD_VERSION;
  readonly projectId: string;
  /** Monotonic store generation; unlike Session revision, this survives reloads. */
  readonly generation: number;
  /** Transaction revision that triggered this snapshot inside its source Session. */
  readonly sourceRevision: string;
  readonly savedAtEpochMs: number;
  readonly canonicalProject: string;
  readonly contentHash: string;
}

export interface ProjectRevisionStore {
  loadLatest(projectId: string): Promise<ProjectRevisionRecord | null>;
  /**
   * Atomically keeps the record with the greatest generation.
   * Implementations must not replace a newer record with a stale write.
   */
  saveLatest(record: ProjectRevisionRecord): Promise<void>;
  remove(projectId: string): Promise<void>;
}

function cloneRecord(record: ProjectRevisionRecord): ProjectRevisionRecord {
  return structuredClone(record);
}

function assertRecord(value: unknown, projectId?: string): asserts value is ProjectRevisionRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid Aelion Project revision record');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.version !== PROJECT_REVISION_RECORD_VERSION ||
    typeof record.projectId !== 'string' ||
    (projectId !== undefined && record.projectId !== projectId) ||
    typeof record.generation !== 'number' ||
    !Number.isSafeInteger(record.generation) ||
    record.generation < 0 ||
    typeof record.sourceRevision !== 'string' ||
    !/^(0|[1-9]\d*)$/u.test(record.sourceRevision) ||
    typeof record.savedAtEpochMs !== 'number' ||
    !Number.isFinite(record.savedAtEpochMs) ||
    typeof record.canonicalProject !== 'string' ||
    record.canonicalProject.length === 0 ||
    typeof record.contentHash !== 'string' ||
    record.contentHash.length === 0
  ) {
    throw new TypeError('Invalid Aelion Project revision record');
  }
}

function persistenceError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Project persistence failed', { cause: value });
}

export class MemoryProjectRevisionStore implements ProjectRevisionStore {
  readonly #records = new Map<string, ProjectRevisionRecord>();

  public loadLatest(projectId: string): Promise<ProjectRevisionRecord | null> {
    const record = this.#records.get(projectId);
    return Promise.resolve(record === undefined ? null : cloneRecord(record));
  }

  public saveLatest(record: ProjectRevisionRecord): Promise<void> {
    assertRecord(record);
    const current = this.#records.get(record.projectId);
    if (current === undefined || record.generation > current.generation) {
      this.#records.set(record.projectId, cloneRecord(record));
    }
    return Promise.resolve();
  }

  public remove(projectId: string): Promise<void> {
    this.#records.delete(projectId);
    return Promise.resolve();
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

export interface IndexedDbProjectRevisionStoreOptions {
  readonly databaseName?: string;
}

/** Browser persistence with an atomic stale-generation guard. */
export class IndexedDbProjectRevisionStore implements ProjectRevisionStore {
  readonly #database: Promise<IDBDatabase>;

  public constructor(options: IndexedDbProjectRevisionStoreOptions = {}) {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is unavailable in this environment');
    }
    const request = indexedDB.open(options.databaseName ?? 'aelion-projects', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('project-revisions')) {
        request.result.createObjectStore('project-revisions', { keyPath: 'projectId' });
      }
    };
    this.#database = requestResult(request);
  }

  public async loadLatest(projectId: string): Promise<ProjectRevisionRecord | null> {
    const database = await this.#database;
    const transaction = database.transaction('project-revisions', 'readonly');
    const value: unknown = await requestResult<unknown>(transaction.objectStore('project-revisions').get(projectId));
    await transactionComplete(transaction);
    if (value === undefined) return null;
    assertRecord(value, projectId);
    return cloneRecord(value);
  }

  public async saveLatest(record: ProjectRevisionRecord): Promise<void> {
    assertRecord(record);
    const database = await this.#database;
    const transaction = database.transaction('project-revisions', 'readwrite');
    const store = transaction.objectStore('project-revisions');
    const current: unknown = await requestResult<unknown>(store.get(record.projectId));
    if (current !== undefined) assertRecord(current, record.projectId);
    if (current === undefined || record.generation > current.generation) {
      store.put(cloneRecord(record));
    }
    await transactionComplete(transaction);
  }

  public async remove(projectId: string): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction('project-revisions', 'readwrite');
    transaction.objectStore('project-revisions').delete(projectId);
    await transactionComplete(transaction);
  }
}

interface PendingProjectRevision {
  readonly project: Readonly<AelionProject>;
  readonly sourceRevision: bigint;
}

export interface ProjectPersistenceOptions {
  readonly debounceMs?: number;
  readonly saveInitial?: boolean;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
}

export interface ProjectPersistenceSnapshot {
  readonly projectId: string;
  readonly pendingRevision: bigint | null;
  readonly lastSavedRevision: bigint | null;
  readonly generation: number;
  readonly disposed: boolean;
  readonly error: unknown;
}

/**
 * Serializes immutable Project snapshots in revision order. Call `flush` before
 * navigation when durability matters; `dispose` also flushes the trailing edit.
 */
export class ProjectPersistenceController {
  readonly #session: AelionSessionApi;
  readonly #store: ProjectRevisionStore;
  readonly #projectId: string;
  readonly #debounceMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #now: () => number;
  readonly #unsubscribe: () => void;
  #pending: PendingProjectRevision | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tail: Promise<void> = Promise.resolve();
  #generation: number;
  #lastSavedRevision: bigint | null = null;
  #error: unknown;
  #disposed = false;

  private constructor(
    session: AelionSessionApi,
    store: ProjectRevisionStore,
    projectId: string,
    generation: number,
    options: ProjectPersistenceOptions,
  ) {
    this.#session = session;
    this.#store = store;
    this.#projectId = projectId;
    this.#generation = generation;
    this.#debounceMs = options.debounceMs ?? 250;
    if (!Number.isFinite(this.#debounceMs) || this.#debounceMs < 0) {
      throw new RangeError('debounceMs must be a non-negative finite number');
    }
    this.#onError = options.onError;
    this.#now = options.now ?? Date.now;
    this.#unsubscribe = session.subscribe('project-changed', (event) => {
      this.#schedule(event.commit.revision);
    });
    if (options.saveInitial ?? true) {
      const revision = session.revision;
      if (revision !== null) this.#schedule(revision);
    }
  }

  public static async attach(
    session: AelionSessionApi,
    store: ProjectRevisionStore,
    options: ProjectPersistenceOptions = {},
  ): Promise<ProjectPersistenceController> {
    const project = session.getSnapshot().project;
    if (project === null) throw new Error('Load an Aelion Project before attaching persistence');
    const latest = await store.loadLatest(project.projectId);
    return new ProjectPersistenceController(session, store, project.projectId, latest?.generation ?? 0, options);
  }

  public getSnapshot(): ProjectPersistenceSnapshot {
    return {
      projectId: this.#projectId,
      pendingRevision: this.#pending?.sourceRevision ?? null,
      lastSavedRevision: this.#lastSavedRevision,
      generation: this.#generation,
      disposed: this.#disposed,
      error: this.#error,
    };
  }

  public async flush(): Promise<void> {
    this.#enqueuePending();
    await this.#tail;
    if (this.#error !== undefined) throw persistenceError(this.#error);
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    await this.flush();
  }

  #schedule(revision: bigint): void {
    if (this.#disposed) return;
    const project = this.#session.getSnapshot().project;
    if (project === null || project.projectId !== this.#projectId) {
      const error = new Error('Persistence controller cannot follow a different Project');
      this.#error = error;
      this.#onError?.(error);
      return;
    }
    this.#pending = {
      project: structuredClone(project),
      sourceRevision: revision,
    };
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#enqueuePending(), this.#debounceMs);
  }

  #enqueuePending(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    const generation = this.#generation + 1;
    this.#generation = generation;
    this.#tail = this.#tail.then(async () => {
      try {
        const canonicalProject = canonicalStringify(pending.project);
        const contentHash = await canonicalHash(pending.project);
        await this.#store.saveLatest({
          version: PROJECT_REVISION_RECORD_VERSION,
          projectId: this.#projectId,
          generation,
          sourceRevision: pending.sourceRevision.toString(),
          savedAtEpochMs: this.#now(),
          canonicalProject,
          contentHash,
        });
        this.#lastSavedRevision = pending.sourceRevision;
        this.#error = undefined;
      } catch (error) {
        this.#error = error;
        this.#onError?.(error);
      }
    });
  }
}

export interface RestoredProjectRevision {
  readonly record: ProjectRevisionRecord;
  readonly project: Readonly<AelionProject>;
}

/** Verifies the canonical content hash before loading a stored Project. */
export async function restoreLatestProject(
  session: AelionSessionApi,
  store: ProjectRevisionStore,
  projectId: string,
): Promise<RestoredProjectRevision | null> {
  const record = await store.loadLatest(projectId);
  if (record === null) return null;
  assertRecord(record, projectId);
  const parsed = JSON.parse(record.canonicalProject) as JsonValue;
  const contentHash = await canonicalHash(parsed);
  if (contentHash !== record.contentHash) {
    throw new Error(`Stored Aelion Project ${projectId} failed its content-hash check`);
  }
  await session.loadProject(parsed);
  const project = session.getSnapshot().project;
  if (project === null) throw new Error('Restored Project did not enter the Session');
  return { record, project };
}
