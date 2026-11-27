import { AelionError } from '@aelionsdk/core';
import type { AelionProject } from '@aelionsdk/project-schema';

import { TransactionEngine } from './transaction.js';
import type { AtomicOperation, EditOptions, ProjectChangeListener, TransactionCommit } from './types.js';

export interface TransactionHost {
  readonly revision: bigint;
  getSnapshot(): Readonly<AelionProject>;
  edit(options: EditOptions, callback: Parameters<TransactionEngine['edit']>[1]): TransactionCommit;
  subscribe(listener: ProjectChangeListener): () => void;
}

export interface TransactionHistoryOptions {
  /** Maximum number of semantic edits retained in each history direction. */
  readonly maxEntries?: number;
}

export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly undoLabel?: string;
  readonly redoLabel?: string;
}

interface HistoryEntry {
  readonly label?: string;
  readonly group?: string;
  readonly operations: readonly AtomicOperation[];
  readonly inverse: readonly AtomicOperation[];
}

function historyError(code: string, message: string): AelionError {
  return new AelionError([{ code, severity: 'error', message, recoverable: true }]);
}

function cloneOperations(operations: readonly AtomicOperation[]): readonly AtomicOperation[] {
  return operations.map((operation) => structuredClone(operation));
}

function sameField(left: AtomicOperation, right: AtomicOperation): boolean {
  return (
    left.op === 'setField' &&
    right.op === 'setField' &&
    left.collection === right.collection &&
    left.id === right.id &&
    left.path.length === right.path.length &&
    left.path.every((segment, index) => segment === right.path[index])
  );
}

function canReplaceGroupedFields(previous: HistoryEntry, next: HistoryEntry): boolean {
  return (
    previous.operations.length === next.operations.length &&
    previous.inverse.length === next.inverse.length &&
    previous.operations.every((operation, index) => {
      const nextOperation = next.operations[index];
      return nextOperation !== undefined && sameField(operation, nextOperation);
    })
  );
}

/**
 * Bounded undo/redo history for local semantic transactions.
 *
 * The manager intentionally detects edits made directly through the wrapped
 * engine. Applying an inverse across an unknown revision would be unsafe; a
 * collaboration adapter must instead create a fresh compensating command.
 */
export class TransactionHistory implements TransactionHost {
  readonly #engine: TransactionEngine;
  readonly #maxEntries: number;
  readonly #undo: HistoryEntry[] = [];
  readonly #redo: HistoryEntry[] = [];
  readonly #listeners = new Set<ProjectChangeListener>();
  #expectedRevision: bigint;
  #publishing = false;

  public constructor(engine: TransactionEngine, options: TransactionHistoryOptions = {}) {
    const maxEntries = options.maxEntries ?? 100;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive safe integer');
    }
    this.#engine = engine;
    this.#maxEntries = maxEntries;
    this.#expectedRevision = engine.revision;
  }

  public get revision(): bigint {
    return this.#engine.revision;
  }

  public get state(): HistoryState {
    const undoLabel = this.#undo.at(-1)?.label;
    const redoLabel = this.#redo.at(-1)?.label;
    return {
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      undoDepth: this.#undo.length,
      redoDepth: this.#redo.length,
      ...(undoLabel === undefined ? {} : { undoLabel }),
      ...(redoLabel === undefined ? {} : { redoLabel }),
    };
  }

  public getSnapshot(): Readonly<AelionProject> {
    return this.#engine.getSnapshot();
  }

  public subscribe(listener: ProjectChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public edit(options: EditOptions, callback: Parameters<TransactionEngine['edit']>[1]): TransactionCommit {
    this.#assertNotPublishing();
    this.#assertSynchronized();
    if (options.historyGroup !== undefined && options.historyGroup.length === 0) {
      throw new TypeError('historyGroup must be a non-empty string');
    }
    const commit = this.#engine.edit(options, callback);
    const entry: HistoryEntry = {
      ...(commit.changeSet.label === undefined ? {} : { label: commit.changeSet.label }),
      ...(options.historyGroup === undefined ? {} : { group: options.historyGroup }),
      operations: cloneOperations(commit.changeSet.operations),
      inverse: cloneOperations(commit.inverse),
    };
    const previous = this.#undo.at(-1);
    if (options.historyGroup !== undefined && previous?.group === options.historyGroup) {
      const replaceFields = canReplaceGroupedFields(previous, entry);
      this.#undo[this.#undo.length - 1] = {
        ...((entry.label ?? previous.label) === undefined ? {} : { label: entry.label ?? previous.label }),
        group: options.historyGroup,
        operations: replaceFields ? entry.operations : [...previous.operations, ...entry.operations],
        inverse: replaceFields ? previous.inverse : [...entry.inverse, ...previous.inverse],
      };
    } else {
      this.#undo.push(entry);
    }
    this.#trim(this.#undo);
    this.#redo.length = 0;
    this.#expectedRevision = commit.revision;
    this.#notify(commit);
    return commit;
  }

  /** Ends a coalescing group so a later edit with the same key starts a new undo entry. */
  public finishGroup(group: string): void {
    this.#assertNotPublishing();
    this.#assertSynchronized();
    const entry = this.#undo.at(-1);
    if (entry?.group !== group) return;
    this.#undo[this.#undo.length - 1] = {
      ...(entry.label === undefined ? {} : { label: entry.label }),
      operations: entry.operations,
      inverse: entry.inverse,
    };
  }

  /** Reverts the active group without creating redo history. */
  public cancelGroup(group: string): TransactionCommit | null {
    this.#assertNotPublishing();
    this.#assertSynchronized();
    const entry = this.#undo.at(-1);
    if (entry === undefined) return null;
    if (entry.group !== group) {
      throw historyError('HISTORY_GROUP_NOT_ACTIVE', `History group ${group} is not active`);
    }
    const commit = this.#engine.edit(
      {
        baseRevision: this.#engine.revision,
        label: entry.label === undefined ? 'Cancel interactive edit' : `Cancel: ${entry.label}`,
      },
      (transaction) => transaction.appendOperations(entry.inverse),
    );
    this.#undo.pop();
    this.#expectedRevision = commit.revision;
    this.#notify(commit);
    return commit;
  }

  public undo(): TransactionCommit {
    this.#assertNotPublishing();
    this.#assertSynchronized();
    const entry = this.#undo.at(-1);
    if (entry === undefined) throw historyError('HISTORY_UNDO_EMPTY', 'There is no edit to undo');
    const commit = this.#engine.edit(
      {
        baseRevision: this.#engine.revision,
        label: entry.label === undefined ? 'Undo' : `Undo: ${entry.label}`,
      },
      (transaction) => transaction.appendOperations(entry.inverse),
    );
    this.#undo.pop();
    this.#redo.push(entry);
    this.#trim(this.#redo);
    this.#expectedRevision = commit.revision;
    this.#notify(commit);
    return commit;
  }

  public redo(): TransactionCommit {
    this.#assertNotPublishing();
    this.#assertSynchronized();
    const entry = this.#redo.at(-1);
    if (entry === undefined) throw historyError('HISTORY_REDO_EMPTY', 'There is no edit to redo');
    const commit = this.#engine.edit(
      {
        baseRevision: this.#engine.revision,
        label: entry.label === undefined ? 'Redo' : `Redo: ${entry.label}`,
      },
      (transaction) => transaction.appendOperations(entry.operations),
    );
    this.#redo.pop();
    this.#undo.push(entry);
    this.#trim(this.#undo);
    this.#expectedRevision = commit.revision;
    this.#notify(commit);
    return commit;
  }

  public clear(): void {
    this.#assertNotPublishing();
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#expectedRevision = this.#engine.revision;
  }

  #assertSynchronized(): void {
    if (this.#engine.revision === this.#expectedRevision) return;
    throw historyError(
      'HISTORY_REVISION_DIVERGED',
      `History expected revision ${this.#expectedRevision}, current revision is ${this.#engine.revision}`,
    );
  }

  #trim(entries: HistoryEntry[]): void {
    const overflow = entries.length - this.#maxEntries;
    if (overflow > 0) entries.splice(0, overflow);
  }

  #assertNotPublishing(): void {
    if (!this.#publishing) return;
    throw historyError('HISTORY_REENTRANT', 'History cannot be mutated while a committed change is being published');
  }

  #notify(commit: TransactionCommit): void {
    this.#publishing = true;
    try {
      for (const listener of [...this.#listeners]) {
        try {
          listener(commit);
        } catch {
          // History is already synchronized; observers cannot make it diverge.
        }
      }
    } finally {
      this.#publishing = false;
    }
  }
}
