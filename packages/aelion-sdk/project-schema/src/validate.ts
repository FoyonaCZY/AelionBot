import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import type { Diagnostic, JsonObject, JsonValue, Result } from '@aelionsdk/core';
import { err, ok } from '@aelionsdk/core';

import {
  COLLECTION_NAMES,
  itemPairKey,
  trackOccupancy,
  trackRole,
  transitionJoinedPairs,
  type AelionProject,
  type CollectionName,
  type ItemEntity,
} from './types.js';
import { assertAdmittedProjectInput, ProjectInputAdmissionError, snapshotProjectInput } from './admission.js';
import {
  CURRENT_PROJECT_SCHEMA_URI,
  CURRENT_PROJECT_SCHEMA_VERSION,
  migrateAdmittedProjectToCurrent,
  type ProjectIdentityMigration,
} from './migration.js';
import { decomposeProjectSchema, entityValidator, type DecomposedProjectSchema } from './schema-decomposition.js';

const MAX_PROJECT_DIAGNOSTICS = 64;

interface DiagnosticSink {
  push(...diagnostics: Diagnostic[]): number;
  /** How many diagnostics have been collected, so a caller can tell if it added any. */
  readonly count: number;
}

class BoundedDiagnosticCollector implements DiagnosticSink {
  readonly #diagnostics: Diagnostic[] = [];
  #truncated = false;

  public get count(): number {
    return this.#diagnostics.length;
  }

  public get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  public push(...diagnostics: Diagnostic[]): number {
    for (const diagnostic of diagnostics) {
      if (this.#diagnostics.length < MAX_PROJECT_DIAGNOSTICS - 1) {
        this.#diagnostics.push(diagnostic);
      } else if (!this.#truncated) {
        this.#diagnostics.push({
          code: 'PROJECT_DIAGNOSTICS_TRUNCATED',
          severity: 'error',
          message: `Project validation produced more than ${MAX_PROJECT_DIAGNOSTICS.toString()} diagnostics`,
          recoverable: false,
        });
        this.#truncated = true;
      }
    }
    return this.#diagnostics.length;
  }
}

export type ProjectSchemaValidationMode = 'auto' | 'ajv' | 'structural';

export interface ProjectValidatorOptions {
  readonly projectSchema: JsonObject;
  readonly materialInstanceSchema: JsonObject;
  /**
   * Controls JSON Schema compilation:
   * - `'auto'` (default): compiles Ajv2020 when allowed, and automatically falls back to
   *   CSP-safe structural + full semantic validation if dynamic code generation (`new Function`)
   *   is blocked by Content-Security-Policy (`EvalError`).
   * - `'ajv'`: requires Ajv2020 compilation.
   * - `'structural'`: skips Ajv2020 compilation completely (zero `new Function()` calls).
   */
  readonly schemaMode?: ProjectSchemaValidationMode;
  /** Shorthand for `schemaMode: 'structural'`. */
  readonly skipAjvCompile?: boolean;
}

export interface ProjectValidationSuccess {
  readonly project: AelionProject;
  /** Present when a legacy 1.1/1.2 RC document identity was upgraded. */
  readonly migration?: ProjectIdentityMigration;
}

function schemaDiagnostic(error: ErrorObject, prefix: readonly string[] = []): Diagnostic {
  const path = [
    ...prefix,
    ...error.instancePath
      .split('/')
      .slice(1)
      .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~')),
  ];
  return {
    code: 'PROJECT_SCHEMA_INVALID',
    severity: 'error',
    message: error.message ?? 'Project does not conform to its JSON Schema',
    path,
    recoverable: false,
    details: {
      keyword: error.keyword,
      schemaPath: error.schemaPath,
      params: error.params as JsonValue,
    },
  };
}

function unspecifiedSchemaDiagnostic(): Diagnostic {
  return {
    code: 'PROJECT_SCHEMA_INVALID',
    severity: 'error',
    message: 'Project does not conform to its JSON Schema',
    recoverable: false,
  };
}

function semanticDiagnostic(
  code: string,
  message: string,
  path: readonly (string | number)[],
  entityId?: string,
): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    path,
    ...(entityId === undefined ? {} : { entityId }),
    recoverable: false,
  };
}

function validateEntityMap(project: AelionProject, collection: CollectionName, diagnostics: DiagnosticSink): void {
  const entities = project[collection];
  // Keys rather than entries: this runs over every entity on every commit, and
  // `Object.entries` builds a two-element array per entity to carry a pair the
  // loop immediately takes apart again.
  for (const key of Object.keys(entities)) {
    const entity = entities[key];
    if (entity !== undefined && key !== entity.id) {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_ENTITY_KEY_MISMATCH',
          `${collection} key ${key} does not match entity id ${entity.id}`,
          [collection, key, 'id'],
          entity.id,
        ),
      );
    }
  }
}

/**
 * Reports a reference that does not resolve.
 *
 * Call sites test `Object.hasOwn` themselves and only come here when it fails,
 * so the path array -- which is what naming a reference costs -- is built for
 * the references that are broken rather than for all ten thousand that are not.
 */
function missingReference(
  id: string,
  expectedCollection: CollectionName,
  path: readonly (string | number)[],
): Diagnostic {
  return semanticDiagnostic(
    'PROJECT_REFERENCE_MISSING',
    `Reference ${id} does not exist in ${expectedCollection}`,
    path,
    id,
  );
}

function requireReference(
  values: Readonly<Record<string, unknown>>,
  id: string,
  expectedCollection: CollectionName,
  path: readonly (string | number)[],
  diagnostics: DiagnosticSink,
): boolean {
  if (Object.hasOwn(values, id)) return true;
  diagnostics.push(missingReference(id, expectedCollection, path));
  return false;
}

/**
 * Reports any id that appears twice in a reference list.
 *
 * Short lists are compared in place. A `Set` is the right structure once a list
 * is long, and the wrong one for the two-member link groups and three-member
 * Track lists that make up almost every list in a Project -- there it allocates
 * a hash table to answer a question one comparison settles.
 */
function validateUniqueList(
  values: readonly string[],
  path: readonly (string | number)[],
  diagnostics: DiagnosticSink,
): void {
  const length = values.length;
  if (length < 2) return;
  if (length <= 8) {
    for (let index = 1; index < length; index += 1) {
      const value = values[index];
      if (value === undefined) continue;
      for (let earlier = 0; earlier < index; earlier += 1) {
        if (values[earlier] !== value) continue;
        diagnostics.push(
          semanticDiagnostic('PROJECT_DUPLICATE_REFERENCE', `Duplicate reference ${value}`, [...path, index], value),
        );
        break;
      }
    }
    return;
  }
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    if (seen.has(value)) {
      diagnostics.push(
        semanticDiagnostic('PROJECT_DUPLICATE_REFERENCE', `Duplicate reference ${value}`, [...path, index], value),
      );
    }
    seen.add(value);
  }
}

function validateReferences(project: AelionProject, diagnostics: DiagnosticSink): void {
  requireReference(
    project.sequences,
    project.settings.defaultSequenceId,
    'sequences',
    ['settings', 'defaultSequenceId'],
    diagnostics,
  );

  for (const sequence of Object.values(project.sequences)) {
    validateUniqueList(sequence.trackIds, ['sequences', sequence.id, 'trackIds'], diagnostics);
    validateUniqueList(sequence.transitionIds, ['sequences', sequence.id, 'transitionIds'], diagnostics);
    validateUniqueList(sequence.materialInstanceIds, ['sequences', sequence.id, 'materialInstanceIds'], diagnostics);
    validateUniqueList(sequence.markerIds, ['sequences', sequence.id, 'markerIds'], diagnostics);

    sequence.trackIds.forEach((id, index) => {
      if (
        requireReference(project.tracks, id, 'tracks', ['sequences', sequence.id, 'trackIds', index], diagnostics) &&
        project.tracks[id]?.sequenceId !== sequence.id
      ) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_HOST_MISMATCH',
            `Track ${id} belongs to another sequence`,
            ['sequences', sequence.id, 'trackIds', index],
            id,
          ),
        );
      }
    });
    sequence.transitionIds.forEach((id, index) =>
      requireReference(
        project.transitions,
        id,
        'transitions',
        ['sequences', sequence.id, 'transitionIds', index],
        diagnostics,
      ),
    );
    sequence.materialInstanceIds.forEach((id, index) =>
      requireReference(
        project.materialInstances,
        id,
        'materialInstances',
        ['sequences', sequence.id, 'materialInstanceIds', index],
        diagnostics,
      ),
    );
    sequence.markerIds.forEach((id, index) =>
      requireReference(project.markers, id, 'markers', ['sequences', sequence.id, 'markerIds', index], diagnostics),
    );
  }

  for (const track of Object.values(project.tracks)) {
    requireReference(project.sequences, track.sequenceId, 'sequences', ['tracks', track.id, 'sequenceId'], diagnostics);
    validateUniqueList(track.itemIds, ['tracks', track.id, 'itemIds'], diagnostics);
    validateUniqueList(track.materialInstanceIds, ['tracks', track.id, 'materialInstanceIds'], diagnostics);
    // The hottest reference loop in the Project: every Item on every Track, on
    // every commit. The lookup is what it costs; naming the position is only
    // needed when something is wrong with it.
    const itemIds = track.itemIds;
    for (let index = 0; index < itemIds.length; index += 1) {
      const id = itemIds[index];
      if (id === undefined) continue;
      const item = project.items[id];
      if (item === undefined) {
        diagnostics.push(missingReference(id, 'items', ['tracks', track.id, 'itemIds', index]));
      } else if (item.trackId !== track.id) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_HOST_MISMATCH',
            `Item ${id} belongs to another track`,
            ['tracks', track.id, 'itemIds', index],
            id,
          ),
        );
      }
    }
    const trackMaterialIds = track.materialInstanceIds;
    for (let index = 0; index < trackMaterialIds.length; index += 1) {
      const id = trackMaterialIds[index];
      if (id === undefined) continue;
      if (!Object.hasOwn(project.materialInstances, id)) {
        diagnostics.push(missingReference(id, 'materialInstances', ['tracks', track.id, 'materialInstanceIds', index]));
      }
    }
  }

  for (const item of Object.values(project.items)) {
    if (!Object.hasOwn(project.tracks, item.trackId)) {
      diagnostics.push(missingReference(item.trackId, 'tracks', ['items', item.id, 'trackId']));
    }
    validateUniqueList(item.materialInstanceIds, ['items', item.id, 'materialInstanceIds'], diagnostics);
    const itemMaterialIds = item.materialInstanceIds;
    for (let index = 0; index < itemMaterialIds.length; index += 1) {
      const id = itemMaterialIds[index];
      if (id === undefined) continue;
      if (!Object.hasOwn(project.materialInstances, id)) {
        diagnostics.push(missingReference(id, 'materialInstances', ['items', item.id, 'materialInstanceIds', index]));
      }
    }
    if (item.type === 'nested-sequence') {
      const source = item.source as { readonly sequenceId?: unknown } | undefined;
      if (typeof source?.sequenceId === 'string') {
        requireReference(
          project.sequences,
          source.sequenceId,
          'sequences',
          ['items', item.id, 'source', 'sequenceId'],
          diagnostics,
        );
      }
    }
    if (item.type === 'image') {
      const source = item.source as { readonly stream?: { readonly type?: unknown } } | undefined;
      if (source?.stream?.type !== 'video') {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_IMAGE_STREAM_INVALID',
            `Image Item ${item.id} must use the visual stream adapter`,
            ['items', item.id, 'source', 'stream', 'type'],
            item.id,
          ),
        );
      }
    }
    const visual = (item as { readonly visual?: unknown }).visual;
    if (visual !== null && typeof visual === 'object' && !Array.isArray(visual)) {
      const mask: unknown = Reflect.get(visual, 'mask');
      if (mask !== null && typeof mask === 'object' && !Array.isArray(mask)) {
        const sourceItemId: unknown = Reflect.get(mask, 'sourceItemId');
        if (typeof sourceItemId === 'string') {
          const exists = requireReference(
            project.items,
            sourceItemId,
            'items',
            ['items', item.id, 'visual', 'mask', 'sourceItemId'],
            diagnostics,
          );
          const sourceTrackId = project.items[sourceItemId]?.trackId;
          const ownerSequenceId = project.tracks[item.trackId]?.sequenceId;
          const sourceSequenceId = sourceTrackId === undefined ? undefined : project.tracks[sourceTrackId]?.sequenceId;
          if (exists && (sourceItemId === item.id || sourceSequenceId !== ownerSequenceId)) {
            diagnostics.push(
              semanticDiagnostic(
                'PROJECT_MASK_SOURCE_INVALID',
                `Mask source ${sourceItemId} must be another Item in the same Sequence`,
                ['items', item.id, 'visual', 'mask', 'sourceItemId'],
                item.id,
              ),
            );
          }
        }
      }
    }
    if (item.linkGroupId !== undefined) {
      if (
        requireReference(
          project.linkGroups,
          item.linkGroupId,
          'linkGroups',
          ['items', item.id, 'linkGroupId'],
          diagnostics,
        ) &&
        !project.linkGroups[item.linkGroupId]?.itemIds.includes(item.id)
      ) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_LINK_GROUP_BACKREF_MISSING',
            `LinkGroup ${item.linkGroupId} does not contain Item ${item.id}`,
            ['items', item.id, 'linkGroupId'],
            item.id,
          ),
        );
      }
    }
  }

  for (const group of Object.values(project.linkGroups)) {
    validateUniqueList(group.itemIds, ['linkGroups', group.id, 'itemIds'], diagnostics);
    if (group.itemIds.length < 2) {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_LINK_GROUP_TOO_SMALL',
          `LinkGroup ${group.id} must contain at least two Items`,
          ['linkGroups', group.id, 'itemIds'],
          group.id,
        ),
      );
    }
    let sequenceId: string | undefined;
    const groupItemIds = group.itemIds;
    for (let index = 0; index < groupItemIds.length; index += 1) {
      const id = groupItemIds[index];
      if (id === undefined) continue;
      const item = project.items[id];
      if (item === undefined) {
        diagnostics.push(missingReference(id, 'items', ['linkGroups', group.id, 'itemIds', index]));
        continue;
      }
      if (item.linkGroupId !== group.id) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_LINK_GROUP_BACKREF_MISSING',
            `Item ${id} does not reference LinkGroup ${group.id}`,
            ['linkGroups', group.id, 'itemIds', index],
            id,
          ),
        );
      }
      const itemSequenceId = project.tracks[item.trackId]?.sequenceId;
      if (sequenceId === undefined) sequenceId = itemSequenceId;
      else if (itemSequenceId !== undefined && itemSequenceId !== sequenceId) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_LINK_GROUP_SEQUENCE_MISMATCH',
            `LinkGroup ${group.id} cannot span Sequences`,
            ['linkGroups', group.id, 'itemIds', index],
            group.id,
          ),
        );
      }
    }
    for (const id of Object.keys(group.syncOffsetsUs ?? {})) {
      if (!group.itemIds.includes(id)) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_LINK_GROUP_OFFSET_ORPHAN',
            `LinkGroup ${group.id} has an offset for non-member ${id}`,
            ['linkGroups', group.id, 'syncOffsetsUs', id],
            group.id,
          ),
        );
      }
    }
  }

  for (const transition of Object.values(project.transitions)) {
    requireReference(
      project.sequences,
      transition.sequenceId,
      'sequences',
      ['transitions', transition.id, 'sequenceId'],
      diagnostics,
    );
    requireReference(
      project.tracks,
      transition.trackId,
      'tracks',
      ['transitions', transition.id, 'trackId'],
      diagnostics,
    );
    requireReference(
      project.items,
      transition.fromItemId,
      'items',
      ['transitions', transition.id, 'fromItemId'],
      diagnostics,
    );
    requireReference(
      project.items,
      transition.toItemId,
      'items',
      ['transitions', transition.id, 'toItemId'],
      diagnostics,
    );
    requireReference(
      project.materialInstances,
      transition.materialInstanceId,
      'materialInstances',
      ['transitions', transition.id, 'materialInstanceId'],
      diagnostics,
    );
  }
}

function validateNestedSequenceCycles(project: AelionProject, diagnostics: DiagnosticSink): void {
  const edges = new Map<string, { readonly itemId: string; readonly target: string }[]>();
  for (const item of Object.values(project.items)) {
    if (item.type !== 'nested-sequence') continue;
    const owner = project.tracks[item.trackId]?.sequenceId;
    const source = item.source as { readonly sequenceId?: unknown } | undefined;
    if (owner === undefined || typeof source?.sequenceId !== 'string') continue;
    const values = edges.get(owner);
    const edge = { itemId: item.id, target: source.sequenceId };
    if (values === undefined) edges.set(owner, [edge]);
    else values.push(edge);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (sequenceId: string): void => {
    if (visited.has(sequenceId)) return;
    visiting.add(sequenceId);
    stack.push(sequenceId);
    for (const edge of edges.get(sequenceId) ?? []) {
      if (visiting.has(edge.target)) {
        const cycleStart = stack.indexOf(edge.target);
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_NESTED_SEQUENCE_CYCLE',
            `Nested Sequence cycle: ${[...stack.slice(cycleStart), edge.target].join(' -> ')}`,
            ['items', edge.itemId, 'source', 'sequenceId'],
            edge.itemId,
          ),
        );
      } else {
        visit(edge.target);
      }
    }
    stack.pop();
    visiting.delete(sequenceId);
    visited.add(sequenceId);
  };
  for (const sequenceId of Object.keys(project.sequences)) visit(sequenceId);
}

function validateMaterialOwnership(project: AelionProject, diagnostics: DiagnosticSink): void {
  // The owner is recorded as the collection and id it came from, not as a
  // formatted string: naming an owner is only read when two of them collide,
  // and this runs over every Item in the Project on every commit.
  const owners = new Map<string, { readonly kind: string; readonly id: string }>();
  const claim = (instanceId: string, kind: string, ownerId: string, path: readonly (string | number)[]): void => {
    if (!Object.hasOwn(project.materialInstances, instanceId)) return;
    const existing = owners.get(instanceId);
    if (existing !== undefined) {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_MATERIAL_MULTIPLE_OWNERS',
          `Material instance ${instanceId} is owned by both ${existing.kind}:${existing.id} and ${kind}:${ownerId}`,
          path,
          instanceId,
        ),
      );
      return;
    }
    owners.set(instanceId, { kind, id: ownerId });
  };

  /** Claims one owner's whole list, skipping the empty ones without a callback. */
  const claimList = (ids: readonly string[], kind: string, ownerId: string): void => {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined) continue;
      claim(id, kind, ownerId, [`${kind}s`, ownerId, 'materialInstanceIds', index]);
    }
  };

  for (const sequence of Object.values(project.sequences)) {
    claimList(sequence.materialInstanceIds, 'sequence', sequence.id);
  }
  for (const track of Object.values(project.tracks)) {
    claimList(track.materialInstanceIds, 'track', track.id);
  }
  for (const item of Object.values(project.items)) {
    claimList(item.materialInstanceIds, 'item', item.id);
  }
  for (const transition of Object.values(project.transitions)) {
    claim(transition.materialInstanceId, 'transition', transition.id, [
      'transitions',
      transition.id,
      'materialInstanceId',
    ]);
  }

  for (const id of Object.keys(project.materialInstances)) {
    if (!owners.has(id)) {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_MATERIAL_ORPHAN',
          `Material instance ${id} has no owner`,
          ['materialInstances', id],
          id,
        ),
      );
    }
  }
}

function validateVisualTransitionOverlap(project: AelionProject, diagnostics: DiagnosticSink): void {
  const bySequence = new Map<
    string,
    {
      readonly id: string;
      readonly startUs: bigint;
      readonly endUs: bigint;
    }[]
  >();

  for (const transition of Object.values(project.transitions)) {
    if (transition.kind !== 'visual') continue;
    const startUs = BigInt(transition.range.startUs);
    const interval = {
      id: transition.id,
      startUs,
      endUs: startUs + BigInt(transition.range.durationUs),
    };
    const transitions = bySequence.get(transition.sequenceId);
    if (transitions === undefined) {
      bySequence.set(transition.sequenceId, [interval]);
    } else {
      transitions.push(interval);
    }
  }

  for (const transitions of bySequence.values()) {
    transitions.sort((left, right) => {
      if (left.startUs !== right.startUs) return left.startUs < right.startUs ? -1 : 1;
      if (left.endUs !== right.endUs) return left.endUs < right.endUs ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

    let active = transitions[0];
    for (const transition of transitions.slice(1)) {
      if (active !== undefined && transition.startUs < active.endUs) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_VISUAL_TRANSITION_OVERLAP',
            `Visual transition ${transition.id} overlaps ${active.id} in the same sequence`,
            ['transitions', transition.id, 'range'],
            transition.id,
          ),
        );
      }
      if (active === undefined || transition.startUs >= active.endUs) {
        active = transition;
      } else if (transition.endUs > active.endUs) {
        active = transition;
      }
    }
  }
}

/**
 * Rejects stacked Items on a Track that declared exclusive occupancy.
 *
 * Overlap stays legal everywhere else: layered titles and stacked audio need
 * it. Declaring `exclusive` is how a Track opts into being a single readable
 * lane of cuts, and this is what makes that declaration mean something --
 * otherwise every host has to police it, and each one polices it differently.
 */
function validateTrackOccupancy(project: AelionProject, diagnostics: DiagnosticSink): void {
  const joined = transitionJoinedPairs(project);
  for (const track of Object.values(project.tracks)) {
    if (trackOccupancy(track) !== 'exclusive') continue;
    const spans = track.itemIds
      .flatMap((id) => {
        const item = project.items[id];
        if (item === undefined) return [];
        const startUs = BigInt(item.range.startUs);
        return [{ id, startUs, endUs: startUs + BigInt(item.range.durationUs) }];
      })
      .sort((left, right) => {
        if (left.startUs !== right.startUs) return left.startUs < right.startUs ? -1 : 1;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      });
    const active: typeof spans = [];
    for (const current of spans) {
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if ((active[index]?.endUs ?? 0n) <= current.startUs) active.splice(index, 1);
      }
      const conflicting = active.find((previous) => !joined.has(itemPairKey(previous.id, current.id)));
      if (conflicting !== undefined) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_TRACK_OCCUPANCY_OVERLAP',
            `Item ${current.id} overlaps ${conflicting.id} on exclusive Track ${track.id}`,
            ['items', current.id, 'range'],
            current.id,
          ),
        );
      }
      active.push(current);
    }
  }
}

function validateTrackRoles(project: AelionProject, diagnostics: DiagnosticSink): void {
  for (const sequence of Object.values(project.sequences)) {
    const storylines = sequence.trackIds.filter((id) => {
      const track = project.tracks[id];
      return track !== undefined && trackRole(track) === 'storyline';
    });
    if (storylines.length <= 1) continue;
    diagnostics.push(
      semanticDiagnostic(
        'PROJECT_MULTIPLE_STORYLINE_TRACKS',
        `Sequence ${sequence.id} declares multiple storyline Tracks: ${storylines.join(', ')}`,
        ['sequences', sequence.id, 'trackIds'],
        sequence.id,
      ),
    );
  }
}

function validateItemTimeMapping(item: ItemEntity, diagnostics: DiagnosticSink): void {
  {
    if (item.type !== 'video' && item.type !== 'audio' && item.type !== 'nested-sequence') return;
    // Optional, because the schema is a constructor option: a host that supplies
    // a looser one can reach here with an Item the shipped schema would have
    // rejected, and a semantic pass must report that rather than throw.
    const source = item.source as
      | {
          readonly timeMapping?: {
            readonly type?: unknown;
            readonly points?: readonly {
              readonly itemTimeUs?: unknown;
            }[];
          };
        }
      | undefined;
    const mapping = source?.timeMapping;
    if (mapping?.type !== 'curve' || !Array.isArray(mapping.points)) return;
    const points = mapping.points as readonly unknown[];
    const pointTime = (value: unknown): unknown =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Reflect.get(value, 'itemTimeUs')
        : undefined;
    const firstTime = pointTime(points[0]);
    const lastTime = pointTime(points.at(-1));
    if (firstTime !== 0 || lastTime !== item.range.durationUs) {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_TIME_MAPPING_ENDPOINT_INVALID',
          `Curve TimeMap for ${item.id} must start at 0 and end at the Item duration`,
          ['items', item.id, 'source', 'timeMapping', 'points'],
          item.id,
        ),
      );
    }
    for (let index = 1; index < points.length; index += 1) {
      const previous = pointTime(points[index - 1]);
      const current = pointTime(points[index]);
      if (typeof previous === 'number' && typeof current === 'number' && current <= previous) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_TIME_MAPPING_ORDER_INVALID',
            `Curve TimeMap Item times must strictly increase for ${item.id}`,
            ['items', item.id, 'source', 'timeMapping', 'points', index, 'itemTimeUs'],
            item.id,
          ),
        );
        break;
      }
    }
  }
}

function validateItemAudio(item: ItemEntity, diagnostics: DiagnosticSink): void {
  {
    if (item.type !== 'audio') return;
    const typedItem = item as {
      readonly audio?: {
        readonly fadeInUs?: unknown;
        readonly fadeOutUs?: unknown;
        readonly pitchPolicy?: unknown;
      };
      readonly source?: { readonly timeMapping?: { readonly type?: unknown } };
    };
    const audio = typedItem.audio;
    for (const property of ['fadeInUs', 'fadeOutUs'] as const) {
      const durationUs = audio?.[property];
      if (typeof durationUs !== 'number' || durationUs <= item.range.durationUs) continue;
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_AUDIO_FADE_OUT_OF_RANGE',
          `${property} for audio item ${item.id} cannot exceed the Item duration`,
          ['items', item.id, 'audio', property],
          item.id,
        ),
      );
    }
    if (audio?.pitchPolicy === 'preserve' && typedItem.source?.timeMapping?.type !== 'linear') {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_AUDIO_PITCH_POLICY_UNSUPPORTED',
          `Pitch-preserving stretch for audio item ${item.id} requires a linear TimeMap`,
          ['items', item.id, 'audio', 'pitchPolicy'],
          item.id,
        ),
      );
    }
  }
}

function validateColorSemantics(project: AelionProject, diagnostics: DiagnosticSink): void {
  for (const sequence of Object.values(project.sequences)) {
    const format = sequence.format as {
      readonly workingColorSpace?: unknown;
      readonly colorPrimaries?: unknown;
      readonly transferFunction?: unknown;
      readonly matrixCoefficients?: unknown;
      readonly chromaSubsampling?: unknown;
      readonly toneMapping?: unknown;
      readonly bitDepth?: unknown;
    };
    const expectedPrimaries =
      format.workingColorSpace === 'display-p3-linear'
        ? 'display-p3'
        : format.workingColorSpace === 'rec2020-linear'
          ? 'bt2020'
          : 'bt709';
    if (format.colorPrimaries !== undefined && format.colorPrimaries !== expectedPrimaries) {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_COLOR_PRIMARIES_MISMATCH',
          `Sequence ${sequence.id} color primaries do not match its linear working space`,
          ['sequences', sequence.id, 'format', 'colorPrimaries'],
          sequence.id,
        ),
      );
    }
    const hdr = format.transferFunction === 'pq' || format.transferFunction === 'hlg';
    if (hdr && (format.workingColorSpace !== 'rec2020-linear' || format.bitDepth !== 10)) {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_HDR_FORMAT_INVALID',
          `HDR Sequence ${sequence.id} requires rec2020-linear working space and 10-bit output`,
          ['sequences', sequence.id, 'format'],
          sequence.id,
        ),
      );
    }
    if (format.toneMapping !== undefined && format.toneMapping !== 'none' && !hdr) {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_TONE_MAPPING_INPUT_INVALID',
          `Sequence ${sequence.id} tone mapping requires PQ or HLG input`,
          ['sequences', sequence.id, 'format', 'toneMapping'],
          sequence.id,
        ),
      );
    }
    if (format.chromaSubsampling === 'rgb' && format.matrixCoefficients !== 'rgb') {
      diagnostics.push(
        semanticDiagnostic(
          'PROJECT_RGB_MATRIX_INVALID',
          `Sequence ${sequence.id} RGB chroma requires RGB matrix coefficients`,
          ['sequences', sequence.id, 'format', 'matrixCoefficients'],
          sequence.id,
        ),
      );
    }
  }
}

function validateImageSequenceReferences(project: AelionProject, diagnostics: DiagnosticSink): void {
  for (const asset of Object.values(project.assets)) {
    if (asset.kind !== 'image-sequence') continue;
    const sequence = asset.imageSequence as { readonly frameAssetIds?: readonly string[] } | undefined;
    const frameAssetIds = sequence?.frameAssetIds;
    if (frameAssetIds === undefined) continue;
    frameAssetIds.forEach((frameAssetId, index) => {
      const frameAsset = project.assets[frameAssetId];
      if (frameAsset === undefined) {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_IMAGE_SEQUENCE_FRAME_MISSING',
            `Image sequence ${asset.id} references missing frame Asset ${frameAssetId}`,
            ['assets', asset.id, 'imageSequence', 'frameAssetIds', index],
            asset.id,
          ),
        );
      } else if (frameAsset.kind !== 'image') {
        diagnostics.push(
          semanticDiagnostic(
            'PROJECT_IMAGE_SEQUENCE_FRAME_KIND_INVALID',
            `Frame Asset ${frameAssetId} of image sequence ${asset.id} must be an image Asset`,
            ['assets', asset.id, 'imageSequence', 'frameAssetIds', index],
            asset.id,
          ),
        );
      }
    });
  }
}

function admissionFailure(error: unknown): Result<ProjectValidationSuccess> {
  const admission =
    error instanceof ProjectInputAdmissionError
      ? error
      : new ProjectInputAdmissionError('PROJECT_INPUT_INVALID', 'Project input could not be safely inspected', []);
  return err({
    code: admission.code,
    severity: 'error',
    message: admission.message,
    path: admission.path,
    recoverable: false,
  });
}

const VALID_TRACK_KINDS = new Set(['visual', 'audio', 'caption']);
const VALID_SAMPLE_RATES = new Set([44_100, 48_000, 96_000]);
const VALID_CHANNEL_LAYOUTS = new Set(['mono', 'stereo', '5.1']);
const VALID_ITEM_TYPES = new Set([
  'video',
  'audio',
  'image',
  'text',
  'caption',
  'shape',
  'generator',
  'adjustment',
  'nested-sequence',
  'material-content',
  'gap',
]);
const ENTITY_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/u;
const MAX_ENTITY_ID_LENGTH = 128;
const FORBIDDEN_ENTITY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidEntityId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ENTITY_ID_LENGTH &&
    !FORBIDDEN_ENTITY_KEYS.has(value) &&
    ENTITY_ID_PATTERN.test(value)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isValidTimeRange(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    typeof value.startUs === 'number' &&
    Number.isSafeInteger(value.startUs) &&
    value.startUs >= 0 &&
    typeof value.durationUs === 'number' &&
    Number.isSafeInteger(value.durationUs) &&
    value.durationUs > 0
  );
}

let cachedDynamicCodeGen: boolean | undefined;

function canUseDynamicCodeGen(): boolean {
  if (cachedDynamicCodeGen !== undefined) return cachedDynamicCodeGen;
  try {
    // Probe once before invoking Ajv2020 so strict-CSP environments do not emit noisy
    // Ajv schema-compilation error dumps to the console.
    const probe = new Function('return true') as () => boolean;
    cachedDynamicCodeGen = probe() === true;
  } catch {
    cachedDynamicCodeGen = false;
  }
  return cachedDynamicCodeGen;
}

function isCspEvalBlockedError(error: unknown): boolean {
  if (error instanceof EvalError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /unsafe-eval|Code generation from strings/iu.test(message);
}

function structuralDiagnostic(message: string, path: readonly (string | number)[]): Diagnostic {
  return {
    code: 'PROJECT_SCHEMA_INVALID',
    severity: 'error',
    message,
    path,
    recoverable: false,
  };
}

/**
 * CSP-safe structural validator used when `Ajv2020.compile()` (`new Function`) is skipped
 * or blocked by strict Electron/browser Content-Security-Policy. Runs ahead of the full
 * pure-JS semantic validation suite in `#check`.
 */
function validateStructuralProjectShell(
  candidate: JsonValue,
  expectedSchemaUri: string | undefined,
  expectedSchemaVersion: string | undefined,
): Diagnostic | undefined {
  if (!isPlainRecord(candidate)) {
    return structuralDiagnostic('Project document must be a JSON object', []);
  }
  if (expectedSchemaUri !== undefined && candidate.$schema !== expectedSchemaUri) {
    return structuralDiagnostic(`$schema must match ${expectedSchemaUri}`, ['$schema']);
  }
  if (
    typeof candidate.schemaVersion !== 'string' ||
    candidate.schemaVersion.length === 0 ||
    (expectedSchemaVersion !== undefined && candidate.schemaVersion !== expectedSchemaVersion)
  ) {
    return structuralDiagnostic(
      expectedSchemaVersion !== undefined
        ? `schemaVersion must match ${expectedSchemaVersion}`
        : 'schemaVersion must be a non-empty string',
      ['schemaVersion'],
    );
  }
  if (!isValidEntityId(candidate.projectId)) {
    return structuralDiagnostic('projectId must be a valid entity identifier', ['projectId']);
  }
  if (candidate.metadata !== undefined && !isPlainRecord(candidate.metadata)) {
    return structuralDiagnostic('metadata must be an object', ['metadata']);
  }
  if (candidate.extensions !== undefined && !isPlainRecord(candidate.extensions)) {
    return structuralDiagnostic('extensions must be an object', ['extensions']);
  }
  const settings = candidate.settings;
  if (!isPlainRecord(settings) || !isValidEntityId(settings.defaultSequenceId)) {
    return structuralDiagnostic('settings.defaultSequenceId must be a valid entity identifier', [
      'settings',
      'defaultSequenceId',
    ]);
  }
  for (const collection of COLLECTION_NAMES) {
    const map = candidate[collection];
    if (!isPlainRecord(map)) {
      return structuralDiagnostic(`${collection} must be an object map`, [collection]);
    }
    for (const key of Object.keys(map)) {
      if (!isValidEntityId(key)) {
        return structuralDiagnostic(`${collection} key ${key} is not a valid entity identifier`, [collection, key]);
      }
      const entry = map[key];
      if (!isPlainRecord(entry) || !isValidEntityId(entry.id)) {
        return structuralDiagnostic(`${collection}.${key} must be an object with a valid entity id`, [collection, key]);
      }
    }
  }
  const sequences = candidate.sequences as Record<string, Record<string, unknown>>;
  for (const [seqId, seq] of Object.entries(sequences)) {
    const format = seq.format;
    if (!isPlainRecord(format)) {
      return structuralDiagnostic(`Sequence ${seqId} must define a format object`, ['sequences', seqId, 'format']);
    }
    if (
      typeof format.width !== 'number' ||
      !Number.isSafeInteger(format.width) ||
      format.width <= 0 ||
      format.width > 65_535 ||
      typeof format.height !== 'number' ||
      !Number.isSafeInteger(format.height) ||
      format.height <= 0 ||
      format.height > 65_535
    ) {
      return structuralDiagnostic(`Sequence ${seqId} format dimensions must be integers in 1..65535`, [
        'sequences',
        seqId,
        'format',
      ]);
    }
    const frameRate = format.frameRate;
    if (
      !isPlainRecord(frameRate) ||
      typeof frameRate.numerator !== 'number' ||
      !Number.isSafeInteger(frameRate.numerator) ||
      frameRate.numerator <= 0 ||
      typeof frameRate.denominator !== 'number' ||
      !Number.isSafeInteger(frameRate.denominator) ||
      frameRate.denominator <= 0
    ) {
      return structuralDiagnostic(`Sequence ${seqId} format.frameRate must use positive integers`, [
        'sequences',
        seqId,
        'format',
        'frameRate',
      ]);
    }
    if (typeof format.sampleRate !== 'number' || !VALID_SAMPLE_RATES.has(format.sampleRate)) {
      return structuralDiagnostic(`Sequence ${seqId} format.sampleRate must be 44100, 48000, or 96000`, [
        'sequences',
        seqId,
        'format',
        'sampleRate',
      ]);
    }
    if (typeof format.channelLayout !== 'string' || !VALID_CHANNEL_LAYOUTS.has(format.channelLayout)) {
      return structuralDiagnostic(`Sequence ${seqId} format.channelLayout must be mono, stereo, or 5.1`, [
        'sequences',
        seqId,
        'format',
        'channelLayout',
      ]);
    }
    for (const field of ['trackIds', 'transitionIds', 'materialInstanceIds', 'markerIds'] as const) {
      if (!isStringArray(seq[field])) {
        return structuralDiagnostic(`Sequence ${seqId} must define ${field} string array`, ['sequences', seqId, field]);
      }
    }
  }
  const tracks = candidate.tracks as Record<string, Record<string, unknown>>;
  for (const [trackId, track] of Object.entries(tracks)) {
    if (!isValidEntityId(track.sequenceId)) {
      return structuralDiagnostic(`Track ${trackId} must define a valid sequenceId`, ['tracks', trackId, 'sequenceId']);
    }
    if (typeof track.kind !== 'string' || !VALID_TRACK_KINDS.has(track.kind)) {
      return structuralDiagnostic(`Track ${trackId} has unsupported kind`, ['tracks', trackId, 'kind']);
    }
    for (const field of ['itemIds', 'materialInstanceIds'] as const) {
      if (!isStringArray(track[field])) {
        return structuralDiagnostic(`Track ${trackId} must define ${field} string array`, ['tracks', trackId, field]);
      }
    }
  }
  const items = candidate.items as Record<string, Record<string, unknown>>;
  for (const [itemId, item] of Object.entries(items)) {
    if (!isValidEntityId(item.trackId)) {
      return structuralDiagnostic(`Item ${itemId} must define a valid trackId`, ['items', itemId, 'trackId']);
    }
    if (typeof item.type !== 'string' || !VALID_ITEM_TYPES.has(item.type)) {
      return structuralDiagnostic(`Item ${itemId} has unsupported type`, ['items', itemId, 'type']);
    }
    if (!isStringArray(item.materialInstanceIds)) {
      return structuralDiagnostic(`Item ${itemId} must define materialInstanceIds string array`, [
        'items',
        itemId,
        'materialInstanceIds',
      ]);
    }
    if (item.markerIds !== undefined && !isStringArray(item.markerIds)) {
      return structuralDiagnostic(`Item ${itemId} markerIds must be a string array`, ['items', itemId, 'markerIds']);
    }
    if (item.linkGroupId !== undefined && !isValidEntityId(item.linkGroupId)) {
      return structuralDiagnostic(`Item ${itemId} linkGroupId must be a valid entity identifier`, [
        'items',
        itemId,
        'linkGroupId',
      ]);
    }
    if (!isValidTimeRange(item.range)) {
      return structuralDiagnostic(`Item ${itemId} must define a valid non-negative range`, ['items', itemId, 'range']);
    }
  }
  const transitions = candidate.transitions as Record<string, Record<string, unknown>>;
  for (const [transitionId, transition] of Object.entries(transitions)) {
    for (const field of ['sequenceId', 'trackId', 'fromItemId', 'toItemId', 'materialInstanceId'] as const) {
      if (!isValidEntityId(transition[field])) {
        return structuralDiagnostic(`Transition ${transitionId} must define a valid ${field}`, [
          'transitions',
          transitionId,
          field,
        ]);
      }
    }
    if (!isValidTimeRange(transition.range)) {
      return structuralDiagnostic(`Transition ${transitionId} must define a valid non-negative range`, [
        'transitions',
        transitionId,
        'range',
      ]);
    }
  }
  const linkGroups = candidate.linkGroups as Record<string, Record<string, unknown>>;
  for (const [groupId, group] of Object.entries(linkGroups)) {
    if (!isStringArray(group.itemIds)) {
      return structuralDiagnostic(`LinkGroup ${groupId} must define itemIds string array`, [
        'linkGroups',
        groupId,
        'itemIds',
      ]);
    }
    if (group.syncOffsetsUs !== undefined && !isPlainRecord(group.syncOffsetsUs)) {
      return structuralDiagnostic(`LinkGroup ${groupId} syncOffsetsUs must be an object`, [
        'linkGroups',
        groupId,
        'syncOffsetsUs',
      ]);
    }
  }
  const markers = candidate.markers as Record<string, Record<string, unknown>>;
  for (const [markerId, marker] of Object.entries(markers)) {
    const owner = marker.owner;
    if (!isPlainRecord(owner) || (owner.type !== 'sequence' && owner.type !== 'item') || !isValidEntityId(owner.id)) {
      return structuralDiagnostic(`Marker ${markerId} must define a valid owner`, ['markers', markerId, 'owner']);
    }
    if (typeof marker.timeUs !== 'number' || !Number.isSafeInteger(marker.timeUs) || marker.timeUs < 0) {
      return structuralDiagnostic(`Marker ${markerId} timeUs must be a non-negative safe integer`, [
        'markers',
        markerId,
        'timeUs',
      ]);
    }
    if (typeof marker.durationUs !== 'number' || !Number.isSafeInteger(marker.durationUs) || marker.durationUs < 0) {
      return structuralDiagnostic(`Marker ${markerId} durationUs must be a non-negative safe integer`, [
        'markers',
        markerId,
        'durationUs',
      ]);
    }
  }
  return undefined;
}

export class ProjectValidator {
  readonly #schemaValidator: ValidateFunction | undefined;
  readonly #decomposed: DecomposedProjectSchema | undefined;
  readonly #schemaValidationMode: 'ajv' | 'structural';
  readonly #expectedSchemaUri: string | undefined;
  readonly #expectedSchemaVersion: string | undefined;
  readonly #migrateLegacyIdentity: boolean;
  /**
   * Frozen entities this validator has already accepted.
   *
   * A commit shares every untouched entity with the previous snapshot by object
   * identity, so on a long timeline nearly every entity handed to the schema on
   * one commit is the same object the last commit already accepted. Only frozen
   * entities are recorded: a frozen object cannot change, so a past verdict
   * stays true, while a mutable one could be edited between two calls.
   *
   * Keyed per validator because the verdict is only meaningful for the schema
   * that produced it, and held weakly so a released snapshot is collectable.
   */
  readonly #acceptedEntities = new WeakSet<object>();
  /** Items that passed the rules decided by the Item alone. See {@link ProjectValidator.validate}. */
  readonly #acceptedItemSemantics = new WeakSet<object>();

  public constructor(options: ProjectValidatorOptions) {
    const requestedMode: ProjectSchemaValidationMode = options.skipAjvCompile
      ? 'structural'
      : (options.schemaMode ?? 'auto');
    if (requestedMode === 'structural' || (requestedMode === 'auto' && !canUseDynamicCodeGen())) {
      this.#schemaValidator = undefined;
      this.#decomposed = undefined;
      this.#schemaValidationMode = 'structural';
    } else {
      try {
        const ajv = new Ajv2020({
          allErrors: false,
          allowUnionTypes: true,
          strict: true,
          validateFormats: true,
        });
        addFormats(ajv);
        ajv.addSchema(options.materialInstanceSchema);
        this.#schemaValidator = ajv.compile(options.projectSchema);
        this.#decomposed = decomposeProjectSchema(ajv, options.projectSchema);
        this.#schemaValidationMode = 'ajv';
      } catch (error) {
        if (requestedMode === 'auto' && isCspEvalBlockedError(error)) {
          this.#schemaValidator = undefined;
          this.#decomposed = undefined;
          this.#schemaValidationMode = 'structural';
        } else {
          throw error;
        }
      }
    }
    const properties = options.projectSchema.properties;
    const schemaVersion =
      properties !== null && typeof properties === 'object' && !Array.isArray(properties)
        ? properties.schemaVersion
        : undefined;
    this.#expectedSchemaUri =
      typeof options.projectSchema.$id === 'string' && options.projectSchema.$id.length > 0
        ? options.projectSchema.$id
        : undefined;
    this.#expectedSchemaVersion =
      schemaVersion !== null &&
      typeof schemaVersion === 'object' &&
      !Array.isArray(schemaVersion) &&
      typeof schemaVersion.const === 'string'
        ? schemaVersion.const
        : undefined;
    this.#migrateLegacyIdentity =
      this.#expectedSchemaUri === CURRENT_PROJECT_SCHEMA_URI &&
      this.#expectedSchemaVersion === CURRENT_PROJECT_SCHEMA_VERSION;
  }

  public get schemaValidationMode(): 'ajv' | 'structural' {
    return this.#schemaValidationMode;
  }

  /**
   * Reports the first schema violation in `candidate`, or `undefined`.
   *
   * Where the schema decomposes, this checks the document shell and then each
   * entity on its own, which is the same set of constraints applied to the same
   * values -- a map schema that only says "entity ids mapped to entities" adds
   * nothing to its values that checking them separately would lose. Where it
   * does not, the whole document goes through Ajv in one call. Under strict CSP
   * (or when `skipAjvCompile` / `schemaMode: 'structural'` is set), this runs
   * the pure-JS structural shell check instead of Ajv's `new Function()`.
   */
  #firstSchemaError(candidate: JsonValue): Diagnostic | undefined {
    const schemaValidator = this.#schemaValidator;
    if (schemaValidator === undefined) {
      return validateStructuralProjectShell(candidate, this.#expectedSchemaUri, this.#expectedSchemaVersion);
    }
    const decomposed = this.#decomposed;
    if (decomposed === undefined) {
      if (schemaValidator(candidate)) return undefined;
      const first = schemaValidator.errors?.[0];
      return first === undefined ? unspecifiedSchemaDiagnostic() : schemaDiagnostic(first);
    }

    if (!decomposed.shell(candidate)) {
      const first = decomposed.shell.errors?.[0];
      return first === undefined ? unspecifiedSchemaDiagnostic() : schemaDiagnostic(first);
    }
    const project = candidate as Record<string, Record<string, unknown>>;
    for (const [collection, check] of decomposed.byCollection) {
      const entities = project[collection];
      if (entities === undefined) continue;
      for (const id of Object.keys(entities)) {
        const entity = entities[id];
        if (typeof entity === 'object' && entity !== null && this.#acceptedEntities.has(entity)) {
          continue;
        }
        const validate = entityValidator(check, entity);
        if (!validate(entity)) {
          const first = validate.errors?.[0];
          return first === undefined ? unspecifiedSchemaDiagnostic() : schemaDiagnostic(first, [collection, id]);
        }
        if (typeof entity === 'object' && entity !== null && Object.isFrozen(entity)) {
          this.#acceptedEntities.add(entity);
        }
      }
    }
    return undefined;
  }

  public validate(value: unknown): Result<ProjectValidationSuccess> {
    let admitted;
    try {
      admitted = snapshotProjectInput(value);
    } catch (error) {
      return admissionFailure(error);
    }
    const migration = this.#migrateLegacyIdentity ? migrateAdmittedProjectToCurrent(admitted) : undefined;
    return this.#check(migration?.project ?? admitted, migration);
  }

  /**
   * Validates a document that is already an owned JSON snapshot, skipping the
   * cloning admission pass in favour of {@link assertAdmittedProjectInput}.
   *
   * Use this only where provenance is known — a transaction commit built from a
   * previously admitted snapshot, for example. Every externally supplied value
   * folded into such a document must have passed {@link snapshotProjectInput}
   * on its own first. Anything crossing a trust boundary (load, import,
   * restore) must keep using {@link ProjectValidator.validate}.
   *
   * Legacy identity migration is not applied: `$schema` and `schemaVersion` are
   * root fields that no entity-scoped edit can reach.
   */
  public validateAdmitted(value: unknown): Result<ProjectValidationSuccess> {
    try {
      assertAdmittedProjectInput(value);
    } catch (error) {
      return admissionFailure(error);
    }
    return this.#check(value as JsonValue, undefined);
  }

  #check(candidate: JsonValue, migration: ProjectIdentityMigration | undefined): Result<ProjectValidationSuccess> {
    const schemaError = this.#firstSchemaError(candidate);
    if (schemaError !== undefined) return err(schemaError);

    const project = candidate as AelionProject;
    const diagnostics = new BoundedDiagnosticCollector();
    for (const collection of COLLECTION_NAMES) validateEntityMap(project, collection, diagnostics);
    validateReferences(project, diagnostics);
    validateMaterialOwnership(project, diagnostics);
    validateNestedSequenceCycles(project, diagnostics);
    validateVisualTransitionOverlap(project, diagnostics);
    validateTrackRoles(project, diagnostics);
    validateTrackOccupancy(project, diagnostics);
    this.#validatePerItemSemantics(project, diagnostics);
    validateColorSemantics(project, diagnostics);
    validateImageSequenceReferences(project, diagnostics);
    return diagnostics.diagnostics.length === 0
      ? ok({ project, ...(migration?.migrated === true ? { migration } : {}) })
      : err(...diagnostics.diagnostics);
  }

  /**
   * Runs the semantic rules that read one Item and nothing else.
   *
   * Curve endpoints and audio fades are decided by the Item alone, so a frozen
   * Item that passed once passes forever -- the same reasoning that lets the
   * schema check skip an unchanged entity, and the same reason it is limited to
   * frozen objects. The genuinely cross-entity rules above stay whole-document,
   * because what they decide can change without any Item changing.
   */
  #validatePerItemSemantics(project: AelionProject, diagnostics: DiagnosticSink): void {
    for (const item of Object.values(project.items)) {
      if (this.#acceptedItemSemantics.has(item)) continue;
      const before = diagnostics.count;
      validateItemTimeMapping(item, diagnostics);
      validateItemAudio(item, diagnostics);
      if (diagnostics.count === before && Object.isFrozen(item)) {
        this.#acceptedItemSemantics.add(item);
      }
    }
  }
}
