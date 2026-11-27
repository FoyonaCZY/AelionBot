import type { Diagnostic, JsonObject, JsonValue } from '@aelionsdk/core';
import type { AelionProject, CollectionName, EntityId, TimeRange } from '@aelionsdk/project-schema';

export type AtomicOperation =
  | {
      readonly op: 'createEntity';
      readonly collection: CollectionName;
      readonly id: EntityId;
      readonly value: JsonObject;
    }
  | {
      readonly op: 'deleteEntity';
      readonly collection: CollectionName;
      readonly id: EntityId;
    }
  | {
      readonly op: 'setField';
      readonly collection: CollectionName;
      readonly id: EntityId;
      readonly path: readonly string[];
      readonly value: JsonValue;
    }
  | {
      readonly op: 'removeField';
      readonly collection: CollectionName;
      readonly id: EntityId;
      readonly path: readonly string[];
    }
  | {
      readonly op: 'listInsert';
      readonly collection: CollectionName;
      readonly id: EntityId;
      readonly path: readonly string[];
      readonly beforeId?: EntityId;
      readonly valueId: EntityId;
    }
  | {
      readonly op: 'listRemove';
      readonly collection: CollectionName;
      readonly id: EntityId;
      readonly path: readonly string[];
      readonly valueId: EntityId;
    }
  | {
      readonly op: 'listMove';
      readonly collection: CollectionName;
      readonly id: EntityId;
      readonly path: readonly string[];
      readonly beforeId?: EntityId;
      readonly valueId: EntityId;
    };

export interface AffectedRange extends TimeRange {
  readonly sequenceId: EntityId;
}

export interface ChangeSet {
  readonly id: string;
  readonly baseRevision: bigint;
  readonly committedRevision: bigint;
  readonly label?: string;
  readonly operations: readonly AtomicOperation[];
  readonly affectedEntityIds: readonly EntityId[];
  readonly affectedRanges: readonly AffectedRange[];
}

export interface TransactionCommit {
  readonly revision: bigint;
  readonly snapshot: Readonly<AelionProject>;
  readonly changeSet: ChangeSet;
  readonly inverse: readonly AtomicOperation[];
}

export interface EditOptions {
  readonly label?: string;
  readonly baseRevision?: bigint;
  /** Consecutive edits with the same key are stored as one undo/redo entry. */
  readonly historyGroup?: string;
}

export interface TransactionValidationResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export type ProjectValidation = (project: unknown) => TransactionValidationResult;

export type ProjectChangeListener = (commit: TransactionCommit) => void;

/**
 * A prepared, synchronous side effect that is published immediately before the
 * Project snapshot and revision become visible. Implementations must not call
 * consumer code; throwing prevents the TransactionEngine commit.
 */
export interface PreparedTransactionCommit {
  publish(): void;
}

/**
 * Prepares derived state for a candidate commit without mutating the active
 * Project. This is used by hosts such as AelionSession to compile Render IR as
 * part of the same atomic commit boundary.
 */
export type TransactionCommitPreparer = (commit: TransactionCommit) => PreparedTransactionCommit | undefined;

export interface TransactionEngineOptions {
  readonly prepareCommit?: TransactionCommitPreparer;
  /**
   * Adopts the Project as the first snapshot instead of copying and checking it.
   *
   * The constructor otherwise clones the document and runs `validate` over the
   * copy, because any object can be handed to it. A host that has just admitted
   * and validated the document pays for all of that a second time, and on a long
   * timeline that is most of the cost of opening a Project --
   * `ProjectValidator.validate` already returns an owned, checked snapshot that
   * nothing else holds a reference to.
   *
   * The adopted document is frozen in place. Passing one that is still reachable
   * and mutable somewhere else, or that has not been validated, breaks the
   * invariant every later commit is checked against.
   */
  readonly adoptValidatedProject?: boolean;
}
