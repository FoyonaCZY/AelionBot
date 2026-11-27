import type { JsonObject, JsonValue } from '@aelionsdk/core';
import { AelionError } from '@aelionsdk/core';
import type { AelionProject, ProjectEntity } from '@aelionsdk/project-schema';

import type { AtomicOperation } from './types.js';

function operationError(code: string, message: string, operation: AtomicOperation): AelionError {
  return new AelionError([
    {
      code,
      severity: 'error',
      message,
      path: [operation.collection, operation.id, ...('path' in operation ? operation.path : [])],
      entityId: operation.id,
      recoverable: true,
    },
  ]);
}

function cloneValue<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

function getEntity(project: AelionProject, operation: AtomicOperation): ProjectEntity {
  const entity = project[operation.collection][operation.id] as ProjectEntity | undefined;
  if (entity === undefined) {
    throw operationError(
      'TRANSACTION_ENTITY_MISSING',
      `${operation.collection}/${operation.id} does not exist`,
      operation,
    );
  }
  return entity;
}

interface PathTarget {
  readonly parent: JsonObject;
  readonly key: string;
}

function resolveTarget(entity: ProjectEntity, path: readonly string[], operation: AtomicOperation): PathTarget {
  if (path.length === 0) {
    throw operationError('TRANSACTION_PATH_INVALID', 'Field path must contain at least one segment', operation);
  }

  let current: JsonObject = entity;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (next === null || Array.isArray(next) || typeof next !== 'object') {
      throw operationError('TRANSACTION_PATH_INVALID', `Path segment ${segment} is not an object`, operation);
    }
    current = next;
  }

  const key = path.at(-1);
  if (key === undefined) {
    throw operationError('TRANSACTION_PATH_INVALID', 'Field path must contain at least one segment', operation);
  }
  return { parent: current, key };
}

function getList(entity: ProjectEntity, path: readonly string[], operation: AtomicOperation): string[] {
  const { parent, key } = resolveTarget(entity, path, operation);
  const value = parent[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw operationError('TRANSACTION_LIST_INVALID', `Field ${path.join('.')} is not a string ID list`, operation);
  }
  return value as string[];
}

function insertionIndex(list: readonly string[], beforeId: string | undefined, operation: AtomicOperation): number {
  if (beforeId === undefined) return list.length;
  const index = list.indexOf(beforeId);
  if (index < 0) {
    throw operationError('TRANSACTION_LIST_ANCHOR_MISSING', `List anchor ${beforeId} does not exist`, operation);
  }
  return index;
}

function nextId(list: readonly string[], index: number): string | undefined {
  return list[index + 1];
}

export function applyOperation(project: AelionProject, operation: AtomicOperation): AtomicOperation {
  const collection = project[operation.collection] as Record<string, ProjectEntity>;

  switch (operation.op) {
    case 'createEntity': {
      if (collection[operation.id] !== undefined) {
        throw operationError(
          'TRANSACTION_ENTITY_EXISTS',
          `${operation.collection}/${operation.id} already exists`,
          operation,
        );
      }
      if (operation.value.id !== operation.id) {
        throw operationError('TRANSACTION_ENTITY_ID_MISMATCH', 'Entity value.id must match operation id', operation);
      }
      collection[operation.id] = cloneValue(operation.value) as ProjectEntity;
      return {
        op: 'deleteEntity',
        collection: operation.collection,
        id: operation.id,
      };
    }

    case 'deleteEntity': {
      const entity = getEntity(project, operation);
      Reflect.deleteProperty(collection, operation.id);
      return {
        op: 'createEntity',
        collection: operation.collection,
        id: operation.id,
        value: cloneValue(entity),
      };
    }

    case 'setField': {
      const entity = getEntity(project, operation);
      const { parent, key } = resolveTarget(entity, operation.path, operation);
      const existed = Object.hasOwn(parent, key);
      const previous = parent[key];
      parent[key] = cloneValue(operation.value);
      if (!existed) {
        return {
          op: 'removeField',
          collection: operation.collection,
          id: operation.id,
          path: operation.path,
        };
      }
      return {
        op: 'setField',
        collection: operation.collection,
        id: operation.id,
        path: operation.path,
        value: cloneValue(previous as JsonValue),
      };
    }

    case 'removeField': {
      const entity = getEntity(project, operation);
      const { parent, key } = resolveTarget(entity, operation.path, operation);
      if (!Object.hasOwn(parent, key)) {
        throw operationError(
          'TRANSACTION_FIELD_MISSING',
          `Field ${operation.path.join('.')} does not exist`,
          operation,
        );
      }
      const previous = parent[key] as JsonValue;
      Reflect.deleteProperty(parent, key);
      return {
        op: 'setField',
        collection: operation.collection,
        id: operation.id,
        path: operation.path,
        value: cloneValue(previous),
      };
    }

    case 'listInsert': {
      const list = getList(getEntity(project, operation), operation.path, operation);
      if (list.includes(operation.valueId)) {
        throw operationError('TRANSACTION_LIST_DUPLICATE', `List already contains ${operation.valueId}`, operation);
      }
      list.splice(insertionIndex(list, operation.beforeId, operation), 0, operation.valueId);
      return {
        op: 'listRemove',
        collection: operation.collection,
        id: operation.id,
        path: operation.path,
        valueId: operation.valueId,
      };
    }

    case 'listRemove': {
      const list = getList(getEntity(project, operation), operation.path, operation);
      const index = list.indexOf(operation.valueId);
      if (index < 0) {
        throw operationError('TRANSACTION_LIST_VALUE_MISSING', `List does not contain ${operation.valueId}`, operation);
      }
      const beforeId = nextId(list, index);
      list.splice(index, 1);
      return {
        op: 'listInsert',
        collection: operation.collection,
        id: operation.id,
        path: operation.path,
        ...(beforeId === undefined ? {} : { beforeId }),
        valueId: operation.valueId,
      };
    }

    case 'listMove': {
      const list = getList(getEntity(project, operation), operation.path, operation);
      const sourceIndex = list.indexOf(operation.valueId);
      if (sourceIndex < 0) {
        throw operationError('TRANSACTION_LIST_VALUE_MISSING', `List does not contain ${operation.valueId}`, operation);
      }
      if (operation.beforeId === operation.valueId) {
        throw operationError(
          'TRANSACTION_LIST_ANCHOR_INVALID',
          'A list entry cannot be moved before itself',
          operation,
        );
      }
      const previousBeforeId = nextId(list, sourceIndex);
      list.splice(sourceIndex, 1);
      list.splice(insertionIndex(list, operation.beforeId, operation), 0, operation.valueId);
      return {
        op: 'listMove',
        collection: operation.collection,
        id: operation.id,
        path: operation.path,
        ...(previousBeforeId === undefined ? {} : { beforeId: previousBeforeId }),
        valueId: operation.valueId,
      };
    }
  }
}

export function applyOperations(
  project: AelionProject,
  operations: readonly AtomicOperation[],
): readonly AtomicOperation[] {
  const inverse: AtomicOperation[] = [];
  for (const operation of operations) {
    inverse.unshift(applyOperation(project, operation));
  }
  return inverse;
}
