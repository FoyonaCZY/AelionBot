import type Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';

import type { JsonObject, JsonValue } from '@aelionsdk/core';

import { COLLECTION_NAMES, type CollectionName } from './types.js';

/**
 * Splits a Project schema into a document shell and one validator per entity.
 *
 * Validating a Project as one Ajv call re-reads the whole document every time,
 * and the Item map makes that far worse than it sounds: `item` is an eleven
 * branch `oneOf`, so proving one branch matches means running the other ten and
 * proving they do not. A thousand-clip Sequence pays that eleven thousand
 * times, on load and again on every commit.
 *
 * Both problems have the same answer. The map schemas do nothing but say "an
 * object whose keys are entity ids and whose values are <entity>", so the
 * document splits cleanly into a shell that checks the root and the map shapes,
 * plus a validator that checks one entity -- and once entities are checked one
 * at a time, an Item can be dispatched straight to the branch its `type` names.
 *
 * The split is refused rather than guessed at. A schema that does not have this
 * exact shape -- an inline entity schema, a `patternProperties` map, an
 * `unevaluatedProperties` that would read annotations across the boundary, a
 * `oneOf` whose branches are not each pinned to a distinct constant -- falls
 * back to validating the whole document, which is always correct and merely
 * slower.
 */

export type EntityCheck =
  | { readonly kind: 'single'; readonly validate: ValidateFunction }
  | {
      readonly kind: 'discriminated';
      readonly property: string;
      readonly byValue: ReadonlyMap<string, ValidateFunction>;
      /**
       * Used when the discriminant is absent or names no branch. The full
       * `oneOf` rejects those, and reproducing exactly how is not worth doing
       * twice.
       */
      readonly fallback: ValidateFunction;
    };

export interface DecomposedProjectSchema {
  /** Root fields plus each collection's map shape, with entity bodies removed. */
  readonly shell: ValidateFunction;
  readonly byCollection: ReadonlyMap<CollectionName, EntityCheck>;
}

function record(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

/** Resolves a local `#/$defs/...` pointer, and nothing more adventurous. */
function resolveLocal(root: JsonObject, reference: string): JsonObject | undefined {
  if (!reference.startsWith('#/')) return undefined;
  let current: JsonValue | undefined = root;
  for (const raw of reference.slice(2).split('/')) {
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    const next = record(current);
    if (next === undefined) return undefined;
    current = next[segment];
  }
  return record(current);
}

/** Turns a `$ref` on the entity side of a map into one Ajv can compile alone. */
function absoluteReference(reference: string, baseId: string): string | undefined {
  if (reference.startsWith('#/')) return `${baseId}${reference}`;
  // An absolute reference to another document, such as the Material instance
  // schema, already resolves on its own.
  return reference.includes('://') ? reference : undefined;
}

/**
 * Reads the discriminant constant a `oneOf` branch pins, wherever it declares
 * it: directly, or inside an `allOf` alongside the `$ref` to the shared base.
 */
function branchConstants(branch: JsonObject): Map<string, JsonValue> {
  const constants = new Map<string, JsonValue>();
  const collect = (schema: JsonObject): void => {
    for (const [name, value] of Object.entries(record(schema.properties) ?? {})) {
      const property = record(value);
      if (property !== undefined && 'const' in property && property.const !== undefined) {
        constants.set(name, property.const);
      }
    }
  };
  collect(branch);
  const allOf = branch.allOf;
  if (Array.isArray(allOf)) {
    for (const member of allOf) {
      const schema = record(member);
      if (schema !== undefined) collect(schema);
    }
  }
  return constants;
}

/**
 * Finds a property every branch pins to a distinct string, or `undefined`.
 *
 * Distinctness is what makes dispatch equal to `oneOf`: with every branch
 * naming a different value, at most one can match any document, so the branch
 * the discriminant names is the only one worth running. A branch that pins
 * nothing could match alongside another, which `oneOf` rejects and dispatch
 * would not, so the whole split is refused.
 */
function discriminantProperty(branches: readonly JsonObject[]): string | undefined {
  if (branches.length < 2) return undefined;
  const perBranch = branches.map(branchConstants);
  const first = perBranch[0];
  if (first === undefined) return undefined;
  for (const candidate of first.keys()) {
    const seen = new Set<string>();
    let usable = true;
    for (const constants of perBranch) {
      const value = constants.get(candidate);
      if (typeof value !== 'string' || seen.has(value)) {
        usable = false;
        break;
      }
      seen.add(value);
    }
    if (usable) return candidate;
  }
  return undefined;
}

const ANNOTATION_KEYWORDS = ['unevaluatedProperties', 'unevaluatedItems'] as const;
const MAP_ENTITY_KEYWORDS = ['patternProperties', 'properties', 'additionalItems'] as const;

/**
 * Whether a map schema says only "an object of entity ids mapped to entities".
 *
 * Anything else -- pattern-matched keys, per-key schemas, an annotation
 * keyword whose result would depend on what the entity schema evaluated -- ties
 * the map and its values together, and then they cannot be checked apart.
 */
function isPlainEntityMap(map: JsonObject): boolean {
  for (const keyword of [...ANNOTATION_KEYWORDS, ...MAP_ENTITY_KEYWORDS]) {
    if (keyword in map) return false;
  }
  return typeof record(map.additionalProperties)?.$ref === 'string';
}

export function decomposeProjectSchema(ajv: Ajv2020, projectSchema: JsonObject): DecomposedProjectSchema | undefined {
  const baseId = projectSchema.$id;
  const properties = record(projectSchema.properties);
  if (typeof baseId !== 'string' || baseId === '' || properties === undefined) return undefined;
  for (const keyword of ANNOTATION_KEYWORDS) {
    if (keyword in projectSchema) return undefined;
  }

  const shellProperties: JsonObject = { ...properties };
  const byCollection = new Map<CollectionName, EntityCheck>();

  for (const collection of COLLECTION_NAMES) {
    const declared = record(properties[collection]);
    if (declared === undefined) return undefined;
    const reference = declared.$ref;
    const map = typeof reference === 'string' ? resolveLocal(projectSchema, reference) : declared;
    if (map === undefined || !isPlainEntityMap(map)) return undefined;

    const entityReference = record(map.additionalProperties)?.$ref as string;
    const entityTarget = resolveLocal(projectSchema, entityReference);

    // The shell keeps the map's own constraints -- key pattern, sizes -- and
    // stops describing what a value is.
    shellProperties[collection] = { ...map, additionalProperties: true } as JsonValue;

    const oneOf = entityTarget?.oneOf;
    const branchRefs =
      Array.isArray(oneOf) && Object.keys(entityTarget ?? {}).length === 1
        ? oneOf.map((branch) => record(branch)?.$ref)
        : undefined;
    const branches =
      branchRefs?.every((value) => typeof value === 'string') === true
        ? (branchRefs as string[]).map((value) => resolveLocal(projectSchema, value))
        : undefined;

    if (branches !== undefined && branches.every((branch) => branch !== undefined)) {
      const resolved = branches as JsonObject[];
      const property = discriminantProperty(resolved);
      const constants = resolved.map((branch) => branchConstants(branch).get(property ?? ''));
      if (property !== undefined) {
        const byValue = new Map<string, ValidateFunction>();
        (branchRefs as string[]).forEach((branchRef, index) => {
          const value = constants[index];
          const absolute = absoluteReference(branchRef, baseId);
          if (typeof value !== 'string' || absolute === undefined) return;
          byValue.set(value, ajv.compile({ $ref: absolute }));
        });
        if (byValue.size === resolved.length) {
          const fallbackRef = absoluteReference(entityReference, baseId);
          if (fallbackRef === undefined) return undefined;
          byCollection.set(collection, {
            kind: 'discriminated',
            property,
            byValue,
            fallback: ajv.compile({ $ref: fallbackRef }),
          });
          continue;
        }
      }
    }

    const absolute = absoluteReference(entityReference, baseId);
    if (absolute === undefined) return undefined;
    byCollection.set(collection, { kind: 'single', validate: ajv.compile({ $ref: absolute }) });
  }

  // The shell is registered under its own base so it can carry a copy of
  // `$defs` and resolve its local references without colliding with the
  // document schema. `$id` may not carry a fragment, so the base is varied with
  // a query instead.
  const shell = ajv.compile({
    ...projectSchema,
    $id: `${baseId}${baseId.includes('?') ? '&' : '?'}aelion-shell=1`,
    properties: shellProperties,
  });
  return { shell, byCollection };
}

/** The validator that decides one entity of `collection`. */
export function entityValidator(check: EntityCheck, entity: unknown): ValidateFunction {
  if (check.kind === 'single') return check.validate;
  const discriminant = record(entity)?.[check.property];
  if (typeof discriminant !== 'string') return check.fallback;
  return check.byValue.get(discriminant) ?? check.fallback;
}
