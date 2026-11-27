import type { JsonObject, JsonValue } from '@aelionsdk/core';
import { AelionError } from '@aelionsdk/core';
import type { AelionProject, EntityId, ItemEntity, MarkerEntity, TrackEntity } from '@aelionsdk/project-schema';

import { violatesOccupancy, type TimelinePlacement } from './layout.js';
import type { TransactionHost } from './history.js';
import type { TransactionBuilder } from './transaction.js';
import type { EditOptions, TransactionCommit } from './types.js';

export type CommandOptions = EditOptions;

export interface InsertItemOptions extends CommandOptions {
  readonly item: ItemEntity;
  readonly beforeItemId?: EntityId;
}

export interface RemoveItemOptions extends CommandOptions {
  readonly itemId: EntityId;
}

export interface MoveItemOptions extends CommandOptions {
  readonly itemId: EntityId;
  readonly toTrackId?: EntityId;
  readonly startUs?: number;
  /** Omit to preserve order on the same Track; null explicitly moves to the end. */
  readonly beforeItemId?: EntityId | null;
}

export interface TrimItemOptions extends CommandOptions {
  readonly itemId: EntityId;
  readonly edge: 'start' | 'end';
  /** New edge position in Sequence time. */
  readonly toUs: number;
}

export interface SplitItemOptions extends CommandOptions {
  readonly itemId: EntityId;
  readonly rightItemId: EntityId;
  /** Split position in Sequence time. */
  readonly atUs: number;
}

export interface SplitItemResult {
  readonly commit: TransactionCommit;
  readonly leftItemId: EntityId;
  readonly rightItemId: EntityId;
}

export interface ReplaceItemOptions extends CommandOptions {
  readonly itemId: EntityId;
  /**
   * Complete replacement entity. ID, Track and ownership references must stay
   * unchanged; structural relocation uses moveItem instead.
   */
  readonly replacement: ItemEntity;
}

/** Commit options for applying a resolved timeline layout. */
export interface ApplyPlacementsOptions extends CommandOptions {
  /** Final position of every Item the interaction moves, keyed by Item id. */
  readonly placements: ReadonlyMap<EntityId, TimelinePlacement>;
  /**
   * Drop a Transition whose pair no longer sits on one Track, instead of
   * failing the whole edit. Defaults to true, which is what a drag wants: a
   * clip pulled onto another lane has plainly ended that Transition.
   */
  readonly dropSeparatedTransitions?: boolean;
}

/** Write-only policy used by {@link writeTimelinePlacements}. */
export interface WriteTimelinePlacementsOptions {
  /** See {@link ApplyPlacementsOptions.dropSeparatedTransitions}. Defaults to true. */
  readonly dropSeparatedTransitions?: boolean;
}

export interface ReorderTrackOptions extends CommandOptions {
  readonly sequenceId: EntityId;
  readonly trackId: EntityId;
  readonly beforeTrackId?: EntityId;
}

export interface SetTrackFlagOptions extends CommandOptions {
  readonly trackId: EntityId;
  readonly value: boolean;
}

export interface LinkItemsOptions extends CommandOptions {
  readonly groupId: EntityId;
  readonly itemIds: readonly EntityId[];
  readonly kind?: 'av-sync' | 'edit-group';
}

export interface UnlinkItemsOptions extends CommandOptions {
  readonly groupId: EntityId;
  /** Omit to unlink every member and delete the group. */
  readonly itemIds?: readonly EntityId[];
}

export interface MoveLinkedGroupOptions extends CommandOptions {
  readonly groupId: EntityId;
  readonly deltaUs: number;
}

export interface SlipItemOptions extends CommandOptions {
  readonly itemId: EntityId;
  /** Signed source presentation-time offset. Timeline range is unchanged. */
  readonly deltaSourceUs: number;
}

export interface RollEditOptions extends CommandOptions {
  readonly leftItemId: EntityId;
  readonly rightItemId: EntityId;
  /** New shared boundary in Sequence time. */
  readonly toUs: number;
}

export interface SlideItemOptions extends CommandOptions {
  readonly itemId: EntityId;
  readonly deltaUs: number;
}

export interface RippleInsertItemOptions extends InsertItemOptions {
  /** Defaults to every Track in the target Sequence. */
  readonly trackIds?: readonly EntityId[];
}

export interface RippleRemoveItemOptions extends RemoveItemOptions {
  /** Defaults to every Track in the source Sequence. */
  readonly trackIds?: readonly EntityId[];
}

export interface AddMarkerOptions extends CommandOptions {
  readonly marker: MarkerEntity;
}

export interface UpdateMarkerOptions extends CommandOptions {
  readonly markerId: EntityId;
  readonly timeUs?: number;
  readonly durationUs?: number;
  readonly markerLabel?: string | null;
  readonly markerColor?: string | null;
  readonly payload?: JsonValue;
}

export interface RemoveMarkerOptions extends CommandOptions {
  readonly markerId: EntityId;
}

export interface SetSelectionMetadataOptions extends CommandOptions {
  readonly sequenceId: EntityId;
  readonly itemIds: readonly EntityId[];
  readonly range?: { readonly startUs: number; readonly durationUs: number };
}

export interface TrimLinkedGroupOptions extends CommandOptions {
  readonly groupId: EntityId;
  readonly edge: 'start' | 'end';
  /** Signed trim amount applied to every member; must be positive. */
  readonly amountUs: number;
}

export interface RemoveLinkedGroupOptions extends CommandOptions {
  readonly groupId: EntityId;
}

export interface SplitLinkedGroupOptions extends CommandOptions {
  readonly groupId: EntityId;
  readonly rightGroupId: EntityId;
  /** Sequence time; every member must contain this point. */
  readonly atUs: number;
  readonly rightItemIds: Readonly<Record<EntityId, EntityId>>;
}

export interface SplitLinkedGroupResult {
  readonly commit: TransactionCommit;
  readonly leftGroupId: EntityId;
  readonly rightGroupId: EntityId;
  readonly rightItemIds: Readonly<Record<EntityId, EntityId>>;
}

interface MediaSourceView {
  readonly sourceRange: { readonly startUs: number; readonly durationUs: number };
  readonly timeMapping: {
    readonly type: 'linear';
    readonly rate: { readonly numerator: number; readonly denominator: number };
    readonly reverse: boolean;
  };
}

function commandError(code: string, message: string, entityId?: string): AelionError {
  return new AelionError([
    {
      code,
      severity: 'error',
      message,
      ...(entityId === undefined ? {} : { entityId }),
      recoverable: true,
    },
  ]);
}

function assertTime(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw commandError('COMMAND_TIME_INVALID', `${name} must be a non-negative safe integer`);
  }
}

function assertTimeDelta(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw commandError('COMMAND_TIME_INVALID', `${name} must be a safe integer`);
  }
}

function itemIn(project: Readonly<AelionProject>, itemId: EntityId): ItemEntity {
  const item = project.items[itemId];
  if (item === undefined) {
    throw commandError('COMMAND_ITEM_MISSING', `Item ${itemId} does not exist`, itemId);
  }
  return item;
}

function trackIn(project: Readonly<AelionProject>, trackId: EntityId): TrackEntity {
  const track = project.tracks[trackId];
  if (track === undefined) {
    throw commandError('COMMAND_TRACK_MISSING', `Track ${trackId} does not exist`, trackId);
  }
  return track;
}

function assertUnlocked(track: TrackEntity): void {
  if (track.locked) {
    throw commandError('COMMAND_TRACK_LOCKED', `Track ${track.id} is locked`, track.id);
  }
}

function assertItemTrackCompatible(item: ItemEntity, track: TrackEntity): void {
  // A Gap is blank time and belongs on whichever Track needs the pause held
  // open, so it is the one Item type without a required Track kind.
  if (item.type === 'gap') return;
  const requiredKind = item.type === 'audio' ? 'audio' : item.type === 'caption' ? 'caption' : 'visual';
  if (track.kind !== requiredKind) {
    throw commandError(
      'COMMAND_TRACK_KIND_MISMATCH',
      `Item ${item.id} requires a ${requiredKind} Track, not ${track.kind}`,
      item.id,
    );
  }
}

function assertAnchor(track: TrackEntity, beforeId: EntityId | undefined): void {
  if (beforeId !== undefined && !track.itemIds.includes(beforeId)) {
    throw commandError(
      'COMMAND_ITEM_ANCHOR_MISSING',
      `Item anchor ${beforeId} does not belong to Track ${track.id}`,
      beforeId,
    );
  }
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === 'object'
    ? value
    : undefined;
}

function mediaSource(item: ItemEntity): MediaSourceView | undefined {
  const source = asObject(item.source);
  if (source === undefined) return undefined;
  const sourceRange = asObject(source.sourceRange);
  const timeMapping = asObject(source.timeMapping);
  const rate = asObject(timeMapping?.rate);
  if (
    sourceRange === undefined ||
    timeMapping === undefined ||
    timeMapping.type !== 'linear' ||
    rate === undefined ||
    typeof sourceRange.startUs !== 'number' ||
    typeof sourceRange.durationUs !== 'number' ||
    typeof rate.numerator !== 'number' ||
    typeof rate.denominator !== 'number' ||
    typeof timeMapping.reverse !== 'boolean'
  ) {
    throw commandError(
      'COMMAND_TIME_MAPPING_UNSUPPORTED',
      `Item ${item.id} does not have a supported linear media mapping`,
      item.id,
    );
  }
  return {
    sourceRange: {
      startUs: sourceRange.startUs,
      durationUs: sourceRange.durationUs,
    },
    timeMapping: {
      type: 'linear',
      rate: { numerator: rate.numerator, denominator: rate.denominator },
      reverse: timeMapping.reverse,
    },
  };
}

function scaledDuration(
  durationUs: number,
  rate: { readonly numerator: number; readonly denominator: number },
): number {
  return Math.floor((durationUs * rate.numerator) / rate.denominator);
}

function signedScaledDuration(
  durationUs: number,
  rate: { readonly numerator: number; readonly denominator: number },
): number {
  return Math.sign(durationUs) * scaledDuration(Math.abs(durationUs), rate);
}

function sourceAssetDuration(project: Readonly<AelionProject>, item: ItemEntity): number | undefined {
  const source = asObject(item.source);
  const assetId = source?.assetId;
  if (typeof assetId !== 'string') return undefined;
  const asset = project.assets[assetId];
  const probeHint = asObject(asset?.probeHint);
  const durationUs = probeHint?.durationUs;
  return typeof durationUs === 'number' && Number.isSafeInteger(durationUs) ? durationUs : undefined;
}

function assertSourceRange(
  project: Readonly<AelionProject>,
  item: ItemEntity,
  range: { readonly startUs: number; readonly durationUs: number },
): void {
  const assetDurationUs = sourceAssetDuration(project, item);
  if (
    !Number.isSafeInteger(range.startUs) ||
    !Number.isSafeInteger(range.durationUs) ||
    range.startUs < 0 ||
    range.durationUs < 1 ||
    (assetDurationUs !== undefined && range.startUs + range.durationUs > assetDurationUs)
  ) {
    throw commandError(
      'COMMAND_SOURCE_HANDLE_UNAVAILABLE',
      `Item ${item.id} does not have enough source media for this edit`,
      item.id,
    );
  }
}

function adjustedLinearSourceRange(
  project: Readonly<AelionProject>,
  item: ItemEntity,
  edge: 'start' | 'end',
  deltaUs: number,
): { readonly startUs: number; readonly durationUs: number } | undefined {
  const source = mediaSource(item);
  if (source === undefined) return undefined;
  const mappedDeltaUs = signedScaledDuration(deltaUs, source.timeMapping.rate);
  const startUs =
    edge === 'start'
      ? source.sourceRange.startUs + (source.timeMapping.reverse ? 0 : mappedDeltaUs)
      : source.sourceRange.startUs - (source.timeMapping.reverse ? mappedDeltaUs : 0);
  const durationUs = source.sourceRange.durationUs + (edge === 'start' ? -mappedDeltaUs : mappedDeltaUs);
  const range = { startUs, durationUs };
  assertSourceRange(project, item, range);
  return range;
}

function assertProfessionalEditItems(project: Readonly<AelionProject>, items: readonly ItemEntity[]): void {
  const ids = new Set(items.map((item) => item.id));
  for (const item of items) {
    assertUnlocked(trackIn(project, item.trackId));
    if (item.linkGroupId !== undefined) {
      throw commandError(
        'COMMAND_LINKED_EDIT_REQUIRES_GROUP',
        `Item ${item.id} is linked; use a LinkGroup edit or unlink it first`,
        item.id,
      );
    }
    if (containsAnimation(item)) {
      throw commandError(
        'COMMAND_EDIT_ANIMATION_UNSUPPORTED',
        `Item ${item.id} contains automation that requires an explicit retiming policy`,
        item.id,
      );
    }
  }
  const transition = Object.values(project.transitions).find(
    (value) => ids.has(value.fromItemId) || ids.has(value.toItemId),
  );
  if (transition !== undefined) {
    throw commandError(
      'COMMAND_EDIT_TRANSITION_CONFLICT',
      `Edit conflicts with Transition ${transition.id}`,
      transition.id,
    );
  }
}

function setSourceRange(
  transaction: import('./transaction.js').TransactionBuilder,
  item: ItemEntity,
  range: { readonly startUs: number; readonly durationUs: number } | undefined,
): void {
  if (range === undefined) return;
  transaction.setField('items', item.id, ['source', 'sourceRange', 'startUs'], range.startUs);
  transaction.setField('items', item.id, ['source', 'sourceRange', 'durationUs'], range.durationUs);
}

function trimmedSourceRange(
  item: ItemEntity,
  edge: 'start' | 'end',
  removedDurationUs: number,
): { readonly startUs: number; readonly durationUs: number } | undefined {
  const source = mediaSource(item);
  if (source === undefined) return undefined;
  const removedSourceUs = scaledDuration(removedDurationUs, source.timeMapping.rate);
  const durationUs = source.sourceRange.durationUs - removedSourceUs;
  if (durationUs < 1) {
    throw commandError('COMMAND_SOURCE_RANGE_EMPTY', `Trim would empty Item ${item.id}'s source range`, item.id);
  }
  const advancesLowEdge =
    (!source.timeMapping.reverse && edge === 'start') || (source.timeMapping.reverse && edge === 'end');
  return {
    startUs: source.sourceRange.startUs + (advancesLowEdge ? removedSourceUs : 0),
    durationUs,
  };
}

function rippleTracks(
  project: Readonly<AelionProject>,
  sequenceId: string,
  requested: readonly string[] | undefined,
): readonly TrackEntity[] {
  const sequence = project.sequences[sequenceId];
  if (sequence === undefined) {
    throw commandError('COMMAND_SEQUENCE_MISSING', `Sequence ${sequenceId} does not exist`);
  }
  const ids = requested === undefined ? [...sequence.trackIds] : [...new Set(requested)];
  if (ids.length === 0 || ids.some((id) => !sequence.trackIds.includes(id))) {
    throw commandError(
      'COMMAND_RIPPLE_TRACK_MISMATCH',
      `Every ripple Track must belong to Sequence ${sequenceId}`,
      sequenceId,
    );
  }
  return ids.map((id) => trackIn(project, id));
}

function assertRippleClosure(
  project: Readonly<AelionProject>,
  shiftedItemIds: ReadonlySet<string>,
  ignoredItemIds: ReadonlySet<string> = new Set(),
): readonly import('@aelionsdk/project-schema').TransitionEntity[] {
  for (const id of shiftedItemIds) {
    const groupId = project.items[id]?.linkGroupId;
    if (groupId === undefined) continue;
    const group = project.linkGroups[groupId];
    if (group?.itemIds.some((memberId) => !shiftedItemIds.has(memberId)) === true) {
      throw commandError(
        'COMMAND_RIPPLE_LINK_GROUP_CONFLICT',
        `Ripple would move only part of LinkGroup ${group.id}`,
        group.id,
      );
    }
  }
  const shiftedTransitions: import('@aelionsdk/project-schema').TransitionEntity[] = [];
  for (const transition of Object.values(project.transitions)) {
    if (ignoredItemIds.has(transition.fromItemId) || ignoredItemIds.has(transition.toItemId)) {
      continue;
    }
    const fromShifted = shiftedItemIds.has(transition.fromItemId);
    const toShifted = shiftedItemIds.has(transition.toItemId);
    if (fromShifted !== toShifted) {
      throw commandError(
        'COMMAND_RIPPLE_TRANSITION_CONFLICT',
        `Ripple would move only one side of Transition ${transition.id}`,
        transition.id,
      );
    }
    if (fromShifted) shiftedTransitions.push(transition);
  }
  return shiftedTransitions;
}

function appendRippleShift(
  project: Readonly<AelionProject>,
  transaction: import('./transaction.js').TransactionBuilder,
  items: readonly ItemEntity[],
  transitions: readonly import('@aelionsdk/project-schema').TransitionEntity[],
  sequenceId: string,
  markerPivotUs: number,
  deltaUs: number,
): void {
  for (const item of items) {
    transaction.setField('items', item.id, ['range', 'startUs'], item.range.startUs + deltaUs);
  }
  for (const transition of transitions) {
    transaction.setField('transitions', transition.id, ['range', 'startUs'], transition.range.startUs + deltaUs);
  }
  for (const marker of Object.values(project.markers)) {
    const owner = asObject(marker.owner);
    if (
      owner?.type !== 'sequence' ||
      owner.id !== sequenceId ||
      typeof marker.timeUs !== 'number' ||
      marker.timeUs < markerPivotUs
    ) {
      continue;
    }
    transaction.setField('markers', marker.id, ['timeUs'], Math.max(0, marker.timeUs + deltaUs));
  }
}

function appendRemoveItem(
  project: Readonly<AelionProject>,
  item: ItemEntity,
  transaction: import('./transaction.js').TransactionBuilder,
  skipLinkGroup = false,
): void {
  const track = trackIn(project, item.trackId);
  for (const transition of Object.values(project.transitions)) {
    if (transition.fromItemId !== item.id && transition.toItemId !== item.id) continue;
    transaction.listRemove('sequences', transition.sequenceId, ['transitionIds'], transition.id);
    transaction.deleteEntity('transitions', transition.id);
    transaction.deleteEntity('materialInstances', transition.materialInstanceId);
  }

  const ownedMarkerIds = Object.values(project.markers)
    .filter((marker) => {
      const owner = asObject(marker.owner);
      return owner?.type === 'item' && owner.id === item.id;
    })
    .map((marker) => marker.id);
  const markerIds = new Set([...(item.markerIds ?? []), ...ownedMarkerIds]);
  for (const markerId of markerIds) {
    for (const sequence of Object.values(project.sequences)) {
      if (sequence.markerIds.includes(markerId)) {
        transaction.listRemove('sequences', sequence.id, ['markerIds'], markerId);
      }
    }
    if (project.markers[markerId] !== undefined) transaction.deleteEntity('markers', markerId);
  }

  if (!skipLinkGroup && item.linkGroupId !== undefined) {
    const group = project.linkGroups[item.linkGroupId];
    if (group !== undefined) {
      const remaining = group.itemIds.filter((id) => id !== item.id);
      if (remaining.length < 2) {
        for (const remainingId of remaining) {
          if (project.items[remainingId]?.linkGroupId === group.id) {
            transaction.removeField('items', remainingId, ['linkGroupId']);
          }
        }
        transaction.deleteEntity('linkGroups', group.id);
      } else {
        transaction.listRemove('linkGroups', group.id, ['itemIds'], item.id);
        if (group.syncOffsetsUs !== undefined && Object.hasOwn(group.syncOffsetsUs, item.id)) {
          transaction.removeField('linkGroups', group.id, ['syncOffsetsUs', item.id]);
        }
      }
    }
  }

  transaction.listRemove('tracks', track.id, ['itemIds'], item.id);
  transaction.deleteEntity('items', item.id);
  for (const materialId of item.materialInstanceIds) {
    transaction.deleteEntity('materialInstances', materialId);
  }
}

function splitSourceRanges(
  item: ItemEntity,
  leftDurationUs: number,
):
  | {
      readonly left: { readonly startUs: number; readonly durationUs: number };
      readonly right: { readonly startUs: number; readonly durationUs: number };
    }
  | undefined {
  const source = mediaSource(item);
  if (source === undefined) return undefined;
  const leftMappedUs = scaledDuration(leftDurationUs, source.timeMapping.rate);
  if (leftMappedUs < 1 || leftMappedUs >= source.sourceRange.durationUs) {
    throw commandError(
      'COMMAND_SOURCE_SPLIT_OUT_OF_RANGE',
      `Split point maps outside Item ${item.id}'s source range`,
      item.id,
    );
  }
  const rightMappedUs = source.sourceRange.durationUs - leftMappedUs;
  return source.timeMapping.reverse
    ? {
        left: {
          startUs: source.sourceRange.startUs + rightMappedUs,
          durationUs: leftMappedUs,
        },
        right: { startUs: source.sourceRange.startUs, durationUs: rightMappedUs },
      }
    : {
        left: { startUs: source.sourceRange.startUs, durationUs: leftMappedUs },
        right: {
          startUs: source.sourceRange.startUs + leftMappedUs,
          durationUs: rightMappedUs,
        },
      };
}

function sameIds(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

interface ItemMarkerSplit {
  readonly leftMarkerIds: EntityId[];
  readonly leftDurationClamps: readonly { readonly id: EntityId; readonly durationUs: number }[];
  readonly rightMarkerIds: EntityId[];
  readonly rightMoves: readonly { readonly id: EntityId; readonly timeUs: number }[];
}

function collectOwnedMarkerIds(project: Readonly<AelionProject>, item: ItemEntity): EntityId[] {
  const seen = new Set<EntityId>();
  const ids: EntityId[] = [];
  const add = (id: EntityId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const id of item.markerIds ?? []) add(id);
  for (const marker of Object.values(project.markers)) {
    const owner = asObject(marker.owner);
    if (owner?.type === 'item' && owner.id === item.id) add(marker.id);
  }
  return ids;
}

function planItemMarkerSplit(
  project: Readonly<AelionProject>,
  item: ItemEntity,
  leftDurationUs: number,
): ItemMarkerSplit {
  const leftMarkerIds: EntityId[] = [];
  const leftDurationClamps: { id: EntityId; durationUs: number }[] = [];
  const rightMarkerIds: EntityId[] = [];
  const rightMoves: { id: EntityId; timeUs: number }[] = [];
  for (const id of collectOwnedMarkerIds(project, item)) {
    const marker = project.markers[id];
    if (marker === undefined) continue;
    if (marker.timeUs < leftDurationUs) {
      leftMarkerIds.push(id);
      const maxDurationUs = leftDurationUs - marker.timeUs;
      if (marker.durationUs > maxDurationUs) {
        leftDurationClamps.push({ id, durationUs: maxDurationUs });
      }
    } else {
      rightMarkerIds.push(id);
      rightMoves.push({ id, timeUs: marker.timeUs - leftDurationUs });
    }
  }
  return { leftMarkerIds, leftDurationClamps, rightMarkerIds, rightMoves };
}

function assignRightItemMarkers(right: ItemEntity, plan: ItemMarkerSplit): void {
  if (plan.rightMarkerIds.length > 0) {
    right.markerIds = [...plan.rightMarkerIds];
  } else {
    Reflect.deleteProperty(right, 'markerIds');
  }
}

function applyItemMarkerSplit(
  transaction: import('./transaction.js').TransactionBuilder,
  item: ItemEntity,
  rightItemId: EntityId,
  plan: ItemMarkerSplit,
): void {
  if (plan.leftMarkerIds.length === 0 && plan.rightMarkerIds.length === 0 && plan.leftDurationClamps.length === 0) {
    return;
  }
  if (plan.leftMarkerIds.length > 0) {
    transaction.setField('items', item.id, ['markerIds'], [...plan.leftMarkerIds]);
  } else if (item.markerIds !== undefined) {
    transaction.removeField('items', item.id, ['markerIds']);
  }
  for (const clamp of plan.leftDurationClamps) {
    transaction.setField('markers', clamp.id, ['durationUs'], clamp.durationUs);
  }
  for (const move of plan.rightMoves) {
    transaction.setField('markers', move.id, ['owner', 'id'], rightItemId);
    transaction.setField('markers', move.id, ['timeUs'], move.timeUs);
  }
}

function containsAnimation(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsAnimation(entry));
  if (value === null || typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'animation')) return true;
  return Object.values(value).some((entry) => entry !== undefined && containsAnimation(entry));
}

function assertDirectTimeEditSupported(item: ItemEntity, command: 'move' | 'trim'): void {
  if (item.linkGroupId !== undefined) {
    throw commandError(
      `COMMAND_${command.toUpperCase()}_LINKED_UNSUPPORTED`,
      `Item ${item.id} is linked; edit the LinkGroup atomically or unlink it first`,
      item.id,
    );
  }
  if (command === 'trim' && containsAnimation(item)) {
    throw commandError(
      'COMMAND_TRIM_ANIMATION_UNSUPPORTED',
      `Item ${item.id} contains animation; an explicit keyframe trim policy is required`,
      item.id,
    );
  }
}

function commandEditOptions(options: CommandOptions, fallbackLabel: string): EditOptions {
  return {
    label: options.label ?? fallbackLabel,
    ...(options.baseRevision === undefined ? {} : { baseRevision: options.baseRevision }),
    ...(options.historyGroup === undefined ? {} : { historyGroup: options.historyGroup }),
  };
}

/** Where a Transition sits for a given adjacent pair: centred on their cut. */
function transitionRangeForPair(
  earlier: ItemEntity,
  later: ItemEntity,
  durationUs: number,
): { readonly startUs: number; readonly durationUs: number } {
  const earlierEnd = earlier.range.startUs + earlier.range.durationUs;
  const overlapStart = Math.max(earlier.range.startUs, later.range.startUs);
  const overlapEnd = Math.min(earlierEnd, later.range.startUs + later.range.durationUs);
  const cutUs = overlapEnd > overlapStart ? Math.round((overlapStart + overlapEnd) / 2) : earlierEnd;
  return { startUs: Math.max(0, cutUs - Math.floor(durationUs / 2)), durationUs };
}

function relocated(item: ItemEntity, placed: ReadonlyMap<EntityId, TimelinePlacement>): ItemEntity {
  const next = placed.get(item.id);
  if (next === undefined) return item;
  return { ...item, trackId: next.trackId, range: { ...item.range, startUs: next.startUs } };
}

/**
 * Keeps Transitions attached to the pair they describe after a batch move.
 *
 * A Transition names two Items and a place between them. Moving either one
 * without this leaves it pointing at a cut that no longer exists -- and a
 * reorder can even swap which of the pair now comes first, so the direction has
 * to be re-derived rather than preserved.
 */
function appendTransitionRebind(
  project: Readonly<AelionProject>,
  transaction: TransactionBuilder,
  placed: ReadonlyMap<EntityId, TimelinePlacement>,
  dropSeparated: boolean,
): void {
  for (const transition of Object.values(project.transitions)) {
    const fromItem = project.items[transition.fromItemId];
    const toItem = project.items[transition.toItemId];
    if (fromItem === undefined || toItem === undefined) continue;
    if (!placed.has(fromItem.id) && !placed.has(toItem.id)) continue;
    const from = relocated(fromItem, placed);
    const to = relocated(toItem, placed);
    if (from.trackId !== to.trackId) {
      if (!dropSeparated) {
        throw commandError(
          'COMMAND_TRANSITION_PAIR_SEPARATED',
          `Placements would move Transition ${transition.id} pair onto different Tracks`,
          transition.id,
        );
      }
      transaction.listRemove('sequences', transition.sequenceId, ['transitionIds'], transition.id);
      transaction.deleteEntity('transitions', transition.id);
      transaction.deleteEntity('materialInstances', transition.materialInstanceId);
      continue;
    }
    const earlier = from.range.startUs <= to.range.startUs ? from : to;
    const later = earlier === from ? to : from;
    const range = transitionRangeForPair(earlier, later, transition.range.durationUs);
    if (transition.fromItemId !== earlier.id) {
      transaction.setField('transitions', transition.id, ['fromItemId'], earlier.id);
    }
    if (transition.toItemId !== later.id) {
      transaction.setField('transitions', transition.id, ['toItemId'], later.id);
    }
    if (transition.trackId !== from.trackId) {
      transaction.setField('transitions', transition.id, ['trackId'], from.trackId);
    }
    if (transition.range.startUs !== range.startUs) {
      transaction.setField('transitions', transition.id, ['range', 'startUs'], range.startUs);
    }
  }
}

/**
 * Writes a resolved timeline layout into a transaction builder.
 *
 * This is the shared bridge between speculative preview and commit. Pass the
 * same placements to an `AelionPreviewOptions.overlay` callback while dragging,
 * then to `EditingCommands.applyPlacements` on pointer-up. The helper updates
 * Track membership and rebinds affected Transitions; it does not commit or
 * validate the resulting Project by itself.
 */
export function writeTimelinePlacements(
  transaction: TransactionBuilder,
  project: Readonly<AelionProject>,
  placements: ReadonlyMap<EntityId, TimelinePlacement>,
  options: WriteTimelinePlacementsOptions = {},
): void {
  for (const [id, placement] of placements) {
    const item = itemIn(project, id);
    if (item.trackId !== placement.trackId) {
      transaction.listRemove('tracks', item.trackId, ['itemIds'], item.id);
      transaction.setField('items', item.id, ['trackId'], placement.trackId);
      transaction.listInsert('tracks', placement.trackId, ['itemIds'], item.id);
    }
    if (item.range.startUs !== placement.startUs) {
      transaction.setField('items', item.id, ['range', 'startUs'], placement.startUs);
    }
  }
  appendTransitionRebind(project, transaction, placements, options.dropSeparatedTransitions ?? true);
}

/** Domain-level editing commands built exclusively from atomic transactions. */
export class EditingCommands {
  readonly #host: TransactionHost;

  public constructor(host: TransactionHost) {
    this.#host = host;
  }

  public insertItem(options: InsertItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const track = trackIn(project, options.item.trackId);
    assertUnlocked(track);
    assertItemTrackCompatible(options.item, track);
    assertAnchor(track, options.beforeItemId);
    if (project.items[options.item.id] !== undefined) {
      throw commandError('COMMAND_ITEM_EXISTS', `Item ${options.item.id} already exists`, options.item.id);
    }
    return this.#host.edit(commandEditOptions(options, 'Insert item'), (transaction) => {
      transaction.createEntity('items', options.item.id, options.item);
      transaction.listInsert('tracks', track.id, ['itemIds'], options.item.id, options.beforeItemId);
    });
  }

  public removeItem(options: RemoveItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const item = itemIn(project, options.itemId);
    const track = trackIn(project, item.trackId);
    assertUnlocked(track);
    return this.#host.edit(commandEditOptions(options, 'Remove item'), (transaction) => {
      appendRemoveItem(project, item, transaction);
    });
  }

  public rippleInsertItem(options: RippleInsertItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const targetTrack = trackIn(project, options.item.trackId);
    assertUnlocked(targetTrack);
    assertItemTrackCompatible(options.item, targetTrack);
    assertAnchor(targetTrack, options.beforeItemId);
    if (options.item.linkGroupId !== undefined) {
      throw commandError(
        'COMMAND_RIPPLE_NEW_ITEM_LINKED',
        'A ripple-inserted Item cannot reference a LinkGroup that is not created atomically',
        options.item.id,
      );
    }
    if (project.items[options.item.id] !== undefined) {
      throw commandError('COMMAND_ITEM_EXISTS', `Item ${options.item.id} already exists`);
    }
    const tracks = rippleTracks(project, targetTrack.sequenceId, options.trackIds);
    if (!tracks.some((track) => track.id === targetTrack.id)) {
      throw commandError(
        'COMMAND_RIPPLE_TRACK_MISMATCH',
        'Ripple Tracks must include the inserted Item Track',
        targetTrack.id,
      );
    }
    const shiftedItems = tracks.flatMap((track) =>
      track.itemIds.flatMap((id) => {
        const item = project.items[id];
        return item !== undefined && item.range.startUs >= options.item.range.startUs ? [item] : [];
      }),
    );
    for (const track of tracks) {
      if (shiftedItems.some((item) => item.trackId === track.id)) assertUnlocked(track);
    }
    const shiftedIds = new Set(shiftedItems.map((item) => item.id));
    const transitions = assertRippleClosure(project, shiftedIds);
    return this.#host.edit(commandEditOptions(options, 'Ripple insert item'), (transaction) => {
      appendRippleShift(
        project,
        transaction,
        shiftedItems,
        transitions,
        targetTrack.sequenceId,
        options.item.range.startUs,
        options.item.range.durationUs,
      );
      transaction.createEntity('items', options.item.id, options.item);
      transaction.listInsert('tracks', targetTrack.id, ['itemIds'], options.item.id, options.beforeItemId);
    });
  }

  public rippleRemoveItem(options: RippleRemoveItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const item = itemIn(project, options.itemId);
    const sourceTrack = trackIn(project, item.trackId);
    assertUnlocked(sourceTrack);
    if (item.linkGroupId !== undefined) {
      throw commandError(
        'COMMAND_RIPPLE_LINK_GROUP_DELETE_UNSUPPORTED',
        `Unlink Item ${item.id} before ripple deletion`,
        item.id,
      );
    }
    const tracks = rippleTracks(project, sourceTrack.sequenceId, options.trackIds);
    if (!tracks.some((track) => track.id === sourceTrack.id)) {
      throw commandError(
        'COMMAND_RIPPLE_TRACK_MISMATCH',
        'Ripple Tracks must include the removed Item Track',
        sourceTrack.id,
      );
    }
    const endUs = item.range.startUs + item.range.durationUs;
    const shiftedItems = tracks.flatMap((track) =>
      track.itemIds.flatMap((id) => {
        const candidate = project.items[id];
        return candidate !== undefined && candidate.id !== item.id && candidate.range.startUs >= endUs
          ? [candidate]
          : [];
      }),
    );
    for (const track of tracks) {
      if (shiftedItems.some((candidate) => candidate.trackId === track.id)) assertUnlocked(track);
    }
    const shiftedIds = new Set(shiftedItems.map((candidate) => candidate.id));
    const shiftedTransitions = assertRippleClosure(project, shiftedIds, new Set([item.id]));
    return this.#host.edit(commandEditOptions(options, 'Ripple remove item'), (transaction) => {
      appendRemoveItem(project, item, transaction);
      appendRippleShift(
        project,
        transaction,
        shiftedItems,
        shiftedTransitions,
        sourceTrack.sequenceId,
        endUs,
        -item.range.durationUs,
      );
    });
  }

  public moveItem(options: MoveItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const item = itemIn(project, options.itemId);
    const sourceTrack = trackIn(project, item.trackId);
    const targetTrack = trackIn(project, options.toTrackId ?? item.trackId);
    assertUnlocked(sourceTrack);
    assertUnlocked(targetTrack);
    assertItemTrackCompatible(item, targetTrack);
    assertDirectTimeEditSupported(item, 'move');
    if (options.startUs !== undefined) assertTime(options.startUs, 'startUs');
    const anchor = options.beforeItemId ?? undefined;
    assertAnchor(targetTrack, anchor);
    if (options.beforeItemId === item.id) {
      throw commandError('COMMAND_ITEM_ANCHOR_INVALID', 'An Item cannot be moved before itself', item.id);
    }
    if (sourceTrack.id !== targetTrack.id) {
      const transition = Object.values(project.transitions).find(
        (value) => value.fromItemId === item.id || value.toItemId === item.id,
      );
      if (transition !== undefined) {
        throw commandError(
          'COMMAND_TRANSITION_TRACK_CONFLICT',
          `Item ${item.id} participates in Transition ${transition.id}; remove it before moving Tracks`,
          item.id,
        );
      }
    }
    if (sourceTrack.id === targetTrack.id && options.startUs === undefined && !Object.hasOwn(options, 'beforeItemId')) {
      throw commandError('COMMAND_NO_CHANGE', `Move does not change Item ${item.id}`, item.id);
    }
    return this.#host.edit(commandEditOptions(options, 'Move item'), (transaction) => {
      if (sourceTrack.id !== targetTrack.id) {
        transaction.listRemove('tracks', sourceTrack.id, ['itemIds'], item.id);
        transaction.setField('items', item.id, ['trackId'], targetTrack.id);
        transaction.listInsert('tracks', targetTrack.id, ['itemIds'], item.id, anchor);
      } else if (Object.hasOwn(options, 'beforeItemId')) {
        transaction.listMove('tracks', sourceTrack.id, ['itemIds'], item.id, anchor);
      }
      if (options.startUs !== undefined && options.startUs !== item.range.startUs) {
        transaction.setField('items', item.id, ['range', 'startUs'], options.startUs);
      }
    });
  }

  public trimItem(options: TrimItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const item = itemIn(project, options.itemId);
    assertUnlocked(trackIn(project, item.trackId));
    assertDirectTimeEditSupported(item, 'trim');
    assertTime(options.toUs, 'toUs');
    const endUs = item.range.startUs + item.range.durationUs;
    if (options.toUs <= item.range.startUs || options.toUs >= endUs) {
      throw commandError('COMMAND_TRIM_OUT_OF_RANGE', `Trim point must be inside Item ${item.id}`, item.id);
    }
    const removedDurationUs = options.edge === 'start' ? options.toUs - item.range.startUs : endUs - options.toUs;
    const newDurationUs = item.range.durationUs - removedDurationUs;
    const sourceRange = trimmedSourceRange(item, options.edge, removedDurationUs);
    for (const transition of Object.values(project.transitions)) {
      if (transition.fromItemId !== item.id && transition.toItemId !== item.id) continue;
      const transitionEnd = transition.range.startUs + transition.range.durationUs;
      const newStart = options.edge === 'start' ? options.toUs : item.range.startUs;
      const newEnd = options.edge === 'end' ? options.toUs : endUs;
      if (transition.range.startUs < newStart || transitionEnd > newEnd) {
        throw commandError(
          'COMMAND_TRIM_TRANSITION_CONFLICT',
          `Trim would remove part of Transition ${transition.id}`,
          item.id,
        );
      }
    }
    return this.#host.edit(commandEditOptions(options, 'Trim item'), (transaction) => {
      if (options.edge === 'start') {
        transaction.setField('items', item.id, ['range', 'startUs'], options.toUs);
      }
      transaction.setField('items', item.id, ['range', 'durationUs'], newDurationUs);
      if (sourceRange !== undefined) {
        transaction.setField('items', item.id, ['source', 'sourceRange', 'startUs'], sourceRange.startUs);
        transaction.setField('items', item.id, ['source', 'sourceRange', 'durationUs'], sourceRange.durationUs);
      }
    });
  }

  public splitItem(options: SplitItemOptions): SplitItemResult {
    const project = this.#host.getSnapshot();
    const item = itemIn(project, options.itemId);
    const track = trackIn(project, item.trackId);
    assertUnlocked(track);
    assertTime(options.atUs, 'atUs');
    const endUs = item.range.startUs + item.range.durationUs;
    if (options.atUs <= item.range.startUs || options.atUs >= endUs) {
      throw commandError('COMMAND_SPLIT_OUT_OF_RANGE', `Split point must be inside Item ${item.id}`, item.id);
    }
    if (project.items[options.rightItemId] !== undefined || options.rightItemId === item.id) {
      throw commandError(
        'COMMAND_ITEM_EXISTS',
        `Right Item ID ${options.rightItemId} already exists`,
        options.rightItemId,
      );
    }
    if (item.materialInstanceIds.length > 0) {
      throw commandError(
        'COMMAND_SPLIT_OWNED_ENTITY_UNSUPPORTED',
        `Item ${item.id} owns Material entities; an explicit split policy is required`,
        item.id,
      );
    }
    if (containsAnimation(item)) {
      throw commandError(
        'COMMAND_SPLIT_ANIMATION_UNSUPPORTED',
        `Item ${item.id} contains animation; an explicit keyframe split policy is required`,
        item.id,
      );
    }
    if (item.linkGroupId !== undefined) {
      throw commandError(
        'COMMAND_SPLIT_LINKED_UNSUPPORTED',
        `Item ${item.id} is linked; split the LinkGroup atomically or unlink it first`,
        item.id,
      );
    }
    const leftDurationUs = options.atUs - item.range.startUs;
    const rightDurationUs = endUs - options.atUs;
    const sourceRanges = splitSourceRanges(item, leftDurationUs);
    const leftSourceRange = sourceRanges?.left;
    const rightSourceRange = sourceRanges?.right;
    for (const transition of Object.values(project.transitions)) {
      const transitionEnd = transition.range.startUs + transition.range.durationUs;
      if (
        (transition.fromItemId === item.id || transition.toItemId === item.id) &&
        options.atUs > transition.range.startUs &&
        options.atUs < transitionEnd
      ) {
        throw commandError(
          'COMMAND_SPLIT_TRANSITION_CONFLICT',
          `Split point intersects Transition ${transition.id}`,
          item.id,
        );
      }
    }
    const markerPlan = planItemMarkerSplit(project, item, leftDurationUs);
    const right = structuredClone(item);
    right.id = options.rightItemId;
    assignRightItemMarkers(right, markerPlan);
    Reflect.set(right.range, 'startUs', options.atUs);
    Reflect.set(right.range, 'durationUs', rightDurationUs);
    if (rightSourceRange !== undefined) {
      const source = asObject(right.source);
      const range = asObject(source?.sourceRange);
      if (range !== undefined) {
        range.startUs = rightSourceRange.startUs;
        range.durationUs = rightSourceRange.durationUs;
      }
    }
    const itemIndex = track.itemIds.indexOf(item.id);
    const beforeId = track.itemIds[itemIndex + 1];
    const commit = this.#host.edit(commandEditOptions(options, 'Split item'), (transaction) => {
      transaction.setField('items', item.id, ['range', 'durationUs'], leftDurationUs);
      if (leftSourceRange !== undefined) {
        transaction.setField('items', item.id, ['source', 'sourceRange', 'startUs'], leftSourceRange.startUs);
        transaction.setField('items', item.id, ['source', 'sourceRange', 'durationUs'], leftSourceRange.durationUs);
      }
      transaction.createEntity('items', right.id, right);
      applyItemMarkerSplit(transaction, item, right.id, markerPlan);
      transaction.listInsert('tracks', track.id, ['itemIds'], right.id, beforeId);
      for (const transition of Object.values(project.transitions)) {
        if (transition.range.startUs < options.atUs) continue;
        if (transition.fromItemId === item.id) {
          transaction.setField('transitions', transition.id, ['fromItemId'], right.id);
        }
        if (transition.toItemId === item.id) {
          transaction.setField('transitions', transition.id, ['toItemId'], right.id);
        }
      }
    });
    return { commit, leftItemId: item.id, rightItemId: right.id };
  }

  public replaceItem(options: ReplaceItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const item = itemIn(project, options.itemId);
    assertUnlocked(trackIn(project, item.trackId));
    const replacement = options.replacement;
    assertItemTrackCompatible(replacement, trackIn(project, item.trackId));
    if (replacement.id !== item.id || replacement.trackId !== item.trackId) {
      throw commandError(
        'COMMAND_REPLACE_TOPOLOGY_CHANGED',
        'Replacement must preserve Item id and trackId; use moveItem for relocation',
        item.id,
      );
    }
    if (
      !sameIds(replacement.materialInstanceIds, item.materialInstanceIds) ||
      !sameIds(replacement.markerIds, item.markerIds) ||
      replacement.linkGroupId !== item.linkGroupId
    ) {
      throw commandError(
        'COMMAND_REPLACE_OWNERSHIP_CHANGED',
        'Replacement must preserve Material, Marker and LinkGroup ownership references',
        item.id,
      );
    }
    return this.#host.edit(commandEditOptions(options, 'Replace item'), (transaction) => {
      transaction.deleteEntity('items', item.id);
      transaction.createEntity('items', item.id, replacement);
    });
  }

  public linkItems(options: LinkItemsOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    if (project.linkGroups[options.groupId] !== undefined) {
      throw commandError('COMMAND_LINK_GROUP_EXISTS', `LinkGroup ${options.groupId} already exists`, options.groupId);
    }
    const itemIds = [...new Set(options.itemIds)];
    if (itemIds.length !== options.itemIds.length || itemIds.length < 2) {
      throw commandError(
        'COMMAND_LINK_GROUP_INVALID',
        'A LinkGroup requires at least two unique Items',
        options.groupId,
      );
    }
    const items = itemIds.map((id) => itemIn(project, id));
    let sequenceId: string | undefined;
    for (const item of items) {
      const track = trackIn(project, item.trackId);
      assertUnlocked(track);
      if (item.linkGroupId !== undefined) {
        throw commandError(
          'COMMAND_ITEM_ALREADY_LINKED',
          `Item ${item.id} already belongs to LinkGroup ${item.linkGroupId}`,
          item.id,
        );
      }
      sequenceId ??= track.sequenceId;
      if (track.sequenceId !== sequenceId) {
        throw commandError(
          'COMMAND_LINK_GROUP_SEQUENCE_MISMATCH',
          'A LinkGroup cannot span Sequences',
          options.groupId,
        );
      }
    }
    const anchorStartUs = items[0]?.range.startUs ?? 0;
    const group: JsonObject = {
      id: options.groupId,
      kind: options.kind ?? 'edit-group',
      itemIds,
      ...((options.kind ?? 'edit-group') === 'av-sync'
        ? {
            syncOffsetsUs: Object.fromEntries(items.map((item) => [item.id, item.range.startUs - anchorStartUs])),
          }
        : {}),
    };
    return this.#host.edit(commandEditOptions(options, 'Link items'), (transaction) => {
      transaction.createEntity('linkGroups', options.groupId, group);
      for (const item of items) {
        transaction.setField('items', item.id, ['linkGroupId'], options.groupId);
      }
    });
  }

  public unlinkItems(options: UnlinkItemsOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const group = project.linkGroups[options.groupId];
    if (group === undefined) {
      throw commandError('COMMAND_LINK_GROUP_MISSING', `LinkGroup ${options.groupId} does not exist`, options.groupId);
    }
    const selected = options.itemIds === undefined ? [...group.itemIds] : [...new Set(options.itemIds)];
    if (selected.length === 0 || selected.some((id) => !group.itemIds.includes(id))) {
      throw commandError(
        'COMMAND_LINK_GROUP_MEMBER_MISSING',
        `Every unlinked Item must belong to LinkGroup ${group.id}`,
        group.id,
      );
    }
    const remaining = group.itemIds.filter((id) => !selected.includes(id));
    const removed = remaining.length < 2 ? [...group.itemIds] : selected;
    for (const id of removed) {
      const item = itemIn(project, id);
      assertUnlocked(trackIn(project, item.trackId));
    }
    return this.#host.edit(commandEditOptions(options, 'Unlink items'), (transaction) => {
      for (const id of removed) transaction.removeField('items', id, ['linkGroupId']);
      if (remaining.length < 2) {
        transaction.deleteEntity('linkGroups', group.id);
      } else {
        for (const id of selected) {
          transaction.listRemove('linkGroups', group.id, ['itemIds'], id);
          if (group.syncOffsetsUs !== undefined && Object.hasOwn(group.syncOffsetsUs, id)) {
            transaction.removeField('linkGroups', group.id, ['syncOffsetsUs', id]);
          }
        }
      }
    });
  }

  public moveLinkedGroup(options: MoveLinkedGroupOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const group = project.linkGroups[options.groupId];
    if (group === undefined) {
      throw commandError('COMMAND_LINK_GROUP_MISSING', `LinkGroup ${options.groupId} does not exist`, options.groupId);
    }
    assertTimeDelta(options.deltaUs, 'deltaUs');
    if (options.deltaUs === 0) {
      throw commandError('COMMAND_NO_CHANGE', 'Linked move deltaUs cannot be zero', group.id);
    }
    const items = group.itemIds.map((id) => itemIn(project, id));
    for (const item of items) {
      assertUnlocked(trackIn(project, item.trackId));
      if (item.range.startUs + options.deltaUs < 0) {
        throw commandError(
          'COMMAND_MOVE_OUT_OF_RANGE',
          `Linked move would place Item ${item.id} before Sequence time zero`,
          item.id,
        );
      }
    }
    const ids = new Set(group.itemIds);
    const transitions = Object.values(project.transitions).filter(
      (value) => ids.has(value.fromItemId) || ids.has(value.toItemId),
    );
    for (const transition of transitions) {
      if (!ids.has(transition.fromItemId) || !ids.has(transition.toItemId)) {
        throw commandError(
          'COMMAND_TRANSITION_LINK_GROUP_CONFLICT',
          `Transition ${transition.id} crosses the LinkGroup boundary`,
          transition.id,
        );
      }
      if (transition.range.startUs + options.deltaUs < 0) {
        throw commandError(
          'COMMAND_MOVE_OUT_OF_RANGE',
          `Linked move would place Transition ${transition.id} before Sequence time zero`,
          transition.id,
        );
      }
    }
    return this.#host.edit(commandEditOptions(options, 'Move linked group'), (transaction) => {
      for (const item of items) {
        transaction.setField('items', item.id, ['range', 'startUs'], item.range.startUs + options.deltaUs);
      }
      for (const transition of transitions) {
        transaction.setField(
          'transitions',
          transition.id,
          ['range', 'startUs'],
          transition.range.startUs + options.deltaUs,
        );
      }
    });
  }

  public trimLinkedGroup(options: TrimLinkedGroupOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const group = project.linkGroups[options.groupId];
    if (group === undefined) {
      throw commandError('COMMAND_LINK_GROUP_MISSING', `LinkGroup ${options.groupId} does not exist`, options.groupId);
    }
    if (!Number.isSafeInteger(options.amountUs) || options.amountUs <= 0) {
      throw commandError('COMMAND_TIME_INVALID', 'amountUs must be a positive safe integer');
    }
    const items = group.itemIds.map((id) => itemIn(project, id));
    const updates = items.map((item) => {
      assertUnlocked(trackIn(project, item.trackId));
      if (containsAnimation(item)) {
        throw commandError(
          'COMMAND_TRIM_ANIMATION_UNSUPPORTED',
          `Item ${item.id} contains animation; an explicit keyframe trim policy is required`,
          item.id,
        );
      }
      if (options.amountUs >= item.range.durationUs) {
        throw commandError('COMMAND_TRIM_OUT_OF_RANGE', `Linked trim would empty Item ${item.id}`, item.id);
      }
      return {
        item,
        range: trimmedSourceRange(item, options.edge, options.amountUs),
      };
    });
    const ids = new Set(group.itemIds);
    for (const transition of Object.values(project.transitions)) {
      if (!ids.has(transition.fromItemId) && !ids.has(transition.toItemId)) continue;
      if (!ids.has(transition.fromItemId) || !ids.has(transition.toItemId)) {
        throw commandError(
          'COMMAND_TRANSITION_LINK_GROUP_CONFLICT',
          `Transition ${transition.id} crosses the LinkGroup boundary`,
          transition.id,
        );
      }
      const transitionEnd = transition.range.startUs + transition.range.durationUs;
      for (const { item } of updates) {
        if (transition.fromItemId !== item.id && transition.toItemId !== item.id) continue;
        const itemStart = item.range.startUs + (options.edge === 'start' ? options.amountUs : 0);
        const itemEnd = item.range.startUs + item.range.durationUs - (options.edge === 'end' ? options.amountUs : 0);
        if (transition.range.startUs < itemStart || transitionEnd > itemEnd) {
          throw commandError(
            'COMMAND_TRIM_TRANSITION_CONFLICT',
            `Linked trim would remove part of Transition ${transition.id}`,
            transition.id,
          );
        }
      }
    }
    return this.#host.edit(commandEditOptions(options, 'Trim linked group'), (transaction) => {
      for (const { item, range } of updates) {
        if (options.edge === 'start') {
          transaction.setField('items', item.id, ['range', 'startUs'], item.range.startUs + options.amountUs);
        }
        transaction.setField('items', item.id, ['range', 'durationUs'], item.range.durationUs - options.amountUs);
        setSourceRange(transaction, item, range);
      }
    });
  }

  public removeLinkedGroup(options: RemoveLinkedGroupOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const group = project.linkGroups[options.groupId];
    if (group === undefined) {
      throw commandError('COMMAND_LINK_GROUP_MISSING', `LinkGroup ${options.groupId} does not exist`, options.groupId);
    }
    const items = group.itemIds.map((id) => itemIn(project, id));
    for (const item of items) assertUnlocked(trackIn(project, item.trackId));
    return this.#host.edit(commandEditOptions(options, 'Remove linked group'), (transaction) => {
      const removedTransitions = new Set<string>();
      for (const item of items) {
        // appendRemoveItem owns all Item resources. Avoid duplicate Transition
        // deletes when both endpoints are members by filtering the immutable snapshot.
        for (const transition of Object.values(project.transitions)) {
          if (
            removedTransitions.has(transition.id) ||
            (transition.fromItemId !== item.id && transition.toItemId !== item.id)
          ) {
            continue;
          }
          removedTransitions.add(transition.id);
        }
      }
      for (const transitionId of removedTransitions) {
        const transition = project.transitions[transitionId];
        if (transition === undefined) continue;
        transaction.listRemove('sequences', transition.sequenceId, ['transitionIds'], transition.id);
        transaction.deleteEntity('transitions', transition.id);
        transaction.deleteEntity('materialInstances', transition.materialInstanceId);
      }
      const projectWithoutTransitions = {
        ...project,
        transitions: Object.fromEntries(
          Object.entries(project.transitions).filter(([id]) => !removedTransitions.has(id)),
        ),
      } as Readonly<AelionProject>;
      for (const item of items) appendRemoveItem(projectWithoutTransitions, item, transaction, true);
      transaction.deleteEntity('linkGroups', group.id);
    });
  }

  public splitLinkedGroup(options: SplitLinkedGroupOptions): SplitLinkedGroupResult {
    const project = this.#host.getSnapshot();
    const group = project.linkGroups[options.groupId];
    if (group === undefined) {
      throw commandError('COMMAND_LINK_GROUP_MISSING', `LinkGroup ${options.groupId} does not exist`, options.groupId);
    }
    if (project.linkGroups[options.rightGroupId] !== undefined || options.rightGroupId === group.id) {
      throw commandError(
        'COMMAND_LINK_GROUP_EXISTS',
        `LinkGroup ${options.rightGroupId} already exists`,
        options.rightGroupId,
      );
    }
    assertTime(options.atUs, 'atUs');
    const mappedIds = Object.keys(options.rightItemIds);
    if (
      mappedIds.length !== group.itemIds.length ||
      group.itemIds.some((id) => typeof options.rightItemIds[id] !== 'string')
    ) {
      throw commandError(
        'COMMAND_SPLIT_GROUP_MAPPING_INVALID',
        'rightItemIds must map every LinkGroup member exactly once',
        group.id,
      );
    }
    const rightIds = group.itemIds.map((id) => {
      const value = options.rightItemIds[id];
      if (value === undefined) {
        throw commandError('COMMAND_SPLIT_GROUP_MAPPING_INVALID', `Missing right Item ID for ${id}`);
      }
      return value;
    });
    const rightIdAt = (index: number): string => {
      const value = rightIds[index];
      if (value === undefined) throw new RangeError('Right Item index is outside the group');
      return value;
    };
    if (
      new Set(rightIds).size !== rightIds.length ||
      rightIds.some((id) => project.items[id] !== undefined || group.itemIds.includes(id))
    ) {
      throw commandError('COMMAND_ITEM_EXISTS', 'Every right-side Item ID must be new and unique', group.id);
    }
    const split = group.itemIds.map((id, index) => {
      const item = itemIn(project, id);
      const track = trackIn(project, item.trackId);
      assertUnlocked(track);
      const endUs = item.range.startUs + item.range.durationUs;
      if (options.atUs <= item.range.startUs || options.atUs >= endUs) {
        throw commandError(
          'COMMAND_SPLIT_OUT_OF_RANGE',
          `Split point must be inside every linked Item; ${item.id} does not contain it`,
          item.id,
        );
      }
      if (item.materialInstanceIds.length > 0 || containsAnimation(item)) {
        throw commandError(
          'COMMAND_SPLIT_OWNED_ENTITY_UNSUPPORTED',
          `Linked Item ${item.id} requires an explicit owned-entity split policy`,
          item.id,
        );
      }
      const leftDurationUs = options.atUs - item.range.startUs;
      const sourceRanges = splitSourceRanges(item, leftDurationUs);
      const markerPlan = planItemMarkerSplit(project, item, leftDurationUs);
      const right = structuredClone(item);
      right.id = rightIdAt(index);
      assignRightItemMarkers(right, markerPlan);
      right.linkGroupId = options.rightGroupId;
      right.range = { startUs: options.atUs, durationUs: endUs - options.atUs };
      const rightSource = sourceRanges?.right;
      if (rightSource !== undefined) {
        const range = asObject(asObject(right.source)?.sourceRange);
        if (range !== undefined) {
          range.startUs = rightSource.startUs;
          range.durationUs = rightSource.durationUs;
        }
      }
      return { item, track, leftDurationUs, sourceRanges, right, markerPlan };
    });
    for (const transition of Object.values(project.transitions)) {
      const transitionEnd = transition.range.startUs + transition.range.durationUs;
      if (
        (group.itemIds.includes(transition.fromItemId) || group.itemIds.includes(transition.toItemId)) &&
        options.atUs > transition.range.startUs &&
        options.atUs < transitionEnd
      ) {
        throw commandError(
          'COMMAND_SPLIT_TRANSITION_CONFLICT',
          `Split point intersects Transition ${transition.id}`,
          transition.id,
        );
      }
    }
    const rightGroup: JsonObject = {
      id: options.rightGroupId,
      kind: group.kind,
      itemIds: rightIds,
      ...(group.syncOffsetsUs === undefined
        ? {}
        : {
            syncOffsetsUs: Object.fromEntries(group.itemIds.map((_id, index) => [rightIdAt(index), 0])),
          }),
    };
    const commit = this.#host.edit(commandEditOptions(options, 'Split linked group'), (transaction) => {
      for (const entry of split) {
        transaction.setField('items', entry.item.id, ['range', 'durationUs'], entry.leftDurationUs);
        setSourceRange(transaction, entry.item, entry.sourceRanges?.left);
        transaction.createEntity('items', entry.right.id, entry.right);
        applyItemMarkerSplit(transaction, entry.item, entry.right.id, entry.markerPlan);
        const itemIndex = entry.track.itemIds.indexOf(entry.item.id);
        transaction.listInsert(
          'tracks',
          entry.track.id,
          ['itemIds'],
          entry.right.id,
          entry.track.itemIds[itemIndex + 1],
        );
      }
      transaction.createEntity('linkGroups', options.rightGroupId, rightGroup);
      for (const transition of Object.values(project.transitions)) {
        if (transition.range.startUs < options.atUs) continue;
        const fromIndex = group.itemIds.indexOf(transition.fromItemId);
        const toIndex = group.itemIds.indexOf(transition.toItemId);
        if (fromIndex >= 0) {
          transaction.setField('transitions', transition.id, ['fromItemId'], rightIdAt(fromIndex));
        }
        if (toIndex >= 0) {
          transaction.setField('transitions', transition.id, ['toItemId'], rightIdAt(toIndex));
        }
      }
    });
    return {
      commit,
      leftGroupId: group.id,
      rightGroupId: options.rightGroupId,
      rightItemIds: { ...options.rightItemIds },
    };
  }

  public slipItem(options: SlipItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const item = itemIn(project, options.itemId);
    assertUnlocked(trackIn(project, item.trackId));
    if (item.linkGroupId !== undefined) {
      throw commandError(
        'COMMAND_LINKED_EDIT_REQUIRES_GROUP',
        `Item ${item.id} is linked; use a LinkGroup edit or unlink it first`,
        item.id,
      );
    }
    assertTimeDelta(options.deltaSourceUs, 'deltaSourceUs');
    if (options.deltaSourceUs === 0) {
      throw commandError('COMMAND_NO_CHANGE', 'Slip deltaSourceUs cannot be zero', item.id);
    }
    const source = asObject(item.source);
    const sourceRange = asObject(source?.sourceRange);
    const mapping = asObject(source?.timeMapping);
    if (
      sourceRange === undefined ||
      mapping === undefined ||
      typeof sourceRange.startUs !== 'number' ||
      typeof sourceRange.durationUs !== 'number'
    ) {
      throw commandError('COMMAND_TIME_MAPPING_UNSUPPORTED', `Item ${item.id} does not have a media TimeMap`, item.id);
    }
    const shiftedRange = {
      startUs: sourceRange.startUs + options.deltaSourceUs,
      durationUs: sourceRange.durationUs,
    };
    assertSourceRange(project, item, shiftedRange);
    const curvePoints =
      mapping.type === 'curve' && Array.isArray(mapping.points)
        ? mapping.points.map((value) => asObject(value))
        : undefined;
    if (mapping.type !== 'linear' && curvePoints === undefined) {
      throw commandError('COMMAND_TIME_MAPPING_UNSUPPORTED', `Item ${item.id} has an unsupported TimeMap`, item.id);
    }
    if (curvePoints?.some((point) => point === undefined || typeof point.sourceTimeUs !== 'number') === true) {
      throw commandError('COMMAND_TIME_MAPPING_UNSUPPORTED', `Item ${item.id} has an invalid curve TimeMap`, item.id);
    }
    return this.#host.edit(commandEditOptions(options, 'Slip item'), (transaction) => {
      transaction.setField('items', item.id, ['source', 'sourceRange', 'startUs'], shiftedRange.startUs);
      if (curvePoints !== undefined) {
        transaction.setField(
          'items',
          item.id,
          ['source', 'timeMapping', 'points'],
          curvePoints.map((point) => ({
            ...point,
            sourceTimeUs: (point?.sourceTimeUs as number) + options.deltaSourceUs,
          })) as JsonValue,
        );
      }
    });
  }

  public rollEdit(options: RollEditOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const left = itemIn(project, options.leftItemId);
    const right = itemIn(project, options.rightItemId);
    if (left.trackId !== right.trackId) {
      throw commandError('COMMAND_ROLL_TRACK_MISMATCH', 'Roll Items must share one Track');
    }
    assertProfessionalEditItems(project, [left, right]);
    assertTime(options.toUs, 'toUs');
    const boundaryUs = left.range.startUs + left.range.durationUs;
    if (boundaryUs !== right.range.startUs) {
      throw commandError('COMMAND_ROLL_ITEMS_NOT_ADJACENT', 'Roll Items must share an exact half-open boundary');
    }
    if (options.toUs <= left.range.startUs || options.toUs >= right.range.startUs + right.range.durationUs) {
      throw commandError('COMMAND_ROLL_OUT_OF_RANGE', 'Roll boundary would empty an Item');
    }
    const deltaUs = options.toUs - boundaryUs;
    if (deltaUs === 0) throw commandError('COMMAND_NO_CHANGE', 'Roll boundary is unchanged');
    const leftSource = adjustedLinearSourceRange(project, left, 'end', deltaUs);
    const rightSource = adjustedLinearSourceRange(project, right, 'start', deltaUs);
    return this.#host.edit(commandEditOptions(options, 'Roll edit'), (transaction) => {
      transaction.setField('items', left.id, ['range', 'durationUs'], left.range.durationUs + deltaUs);
      transaction.setField('items', right.id, ['range', 'startUs'], options.toUs);
      transaction.setField('items', right.id, ['range', 'durationUs'], right.range.durationUs - deltaUs);
      setSourceRange(transaction, left, leftSource);
      setSourceRange(transaction, right, rightSource);
    });
  }

  public slideItem(options: SlideItemOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const item = itemIn(project, options.itemId);
    assertTimeDelta(options.deltaUs, 'deltaUs');
    if (options.deltaUs === 0) throw commandError('COMMAND_NO_CHANGE', 'Slide deltaUs is zero');
    const track = trackIn(project, item.trackId);
    const left = track.itemIds
      .map((id) => project.items[id])
      .find((value) => value !== undefined && value.range.startUs + value.range.durationUs === item.range.startUs);
    const itemEndUs = item.range.startUs + item.range.durationUs;
    const right = track.itemIds
      .map((id) => project.items[id])
      .find((value) => value !== undefined && value.range.startUs === itemEndUs);
    if (left === undefined || right === undefined) {
      throw commandError(
        'COMMAND_SLIDE_NEIGHBOR_MISSING',
        `Item ${item.id} requires adjacent left and right Items`,
        item.id,
      );
    }
    assertProfessionalEditItems(project, [left, item, right]);
    if (left.range.durationUs + options.deltaUs < 1 || right.range.durationUs - options.deltaUs < 1) {
      throw commandError('COMMAND_SLIDE_OUT_OF_RANGE', 'Slide would empty an adjacent Item');
    }
    const leftSource = adjustedLinearSourceRange(project, left, 'end', options.deltaUs);
    const rightSource = adjustedLinearSourceRange(project, right, 'start', options.deltaUs);
    return this.#host.edit(commandEditOptions(options, 'Slide item'), (transaction) => {
      transaction.setField('items', left.id, ['range', 'durationUs'], left.range.durationUs + options.deltaUs);
      transaction.setField('items', item.id, ['range', 'startUs'], item.range.startUs + options.deltaUs);
      transaction.setField('items', right.id, ['range', 'startUs'], right.range.startUs + options.deltaUs);
      transaction.setField('items', right.id, ['range', 'durationUs'], right.range.durationUs - options.deltaUs);
      setSourceRange(transaction, left, leftSource);
      setSourceRange(transaction, right, rightSource);
    });
  }

  public addMarker(options: AddMarkerOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const marker = options.marker;
    if (project.markers[marker.id] !== undefined) {
      throw commandError('COMMAND_MARKER_EXISTS', `Marker ${marker.id} already exists`, marker.id);
    }
    assertTime(marker.timeUs, 'marker.timeUs');
    assertTime(marker.durationUs, 'marker.durationUs');
    let sequenceId: string;
    let item: ItemEntity | undefined;
    if (marker.owner.type === 'sequence') {
      if (project.sequences[marker.owner.id] === undefined) {
        throw commandError('COMMAND_MARKER_OWNER_MISSING', `Sequence ${marker.owner.id} does not exist`, marker.id);
      }
      sequenceId = marker.owner.id;
    } else {
      item = itemIn(project, marker.owner.id);
      const track = trackIn(project, item.trackId);
      assertUnlocked(track);
      sequenceId = track.sequenceId;
      if (marker.timeUs + marker.durationUs > item.range.durationUs) {
        throw commandError('COMMAND_MARKER_OUT_OF_RANGE', `Marker ${marker.id} exceeds Item ${item.id}`, marker.id);
      }
    }
    const sequence = project.sequences[sequenceId];
    if (sequence === undefined) throw commandError('COMMAND_SEQUENCE_MISSING', sequenceId);
    return this.#host.edit(commandEditOptions(options, 'Add marker'), (transaction) => {
      transaction.createEntity('markers', marker.id, marker);
      transaction.listInsert('sequences', sequence.id, ['markerIds'], marker.id);
      if (item !== undefined) {
        if (item.markerIds === undefined) {
          transaction.setField('items', item.id, ['markerIds'], [marker.id]);
        } else {
          transaction.listInsert('items', item.id, ['markerIds'], marker.id);
        }
      }
    });
  }

  public updateMarker(options: UpdateMarkerOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const marker = project.markers[options.markerId];
    if (marker === undefined) {
      throw commandError('COMMAND_MARKER_MISSING', `Marker ${options.markerId} does not exist`, options.markerId);
    }
    const timeUs = options.timeUs ?? marker.timeUs;
    const durationUs = options.durationUs ?? marker.durationUs;
    assertTime(timeUs, 'timeUs');
    assertTime(durationUs, 'durationUs');
    if (marker.owner.type === 'item') {
      const item = itemIn(project, marker.owner.id);
      assertUnlocked(trackIn(project, item.trackId));
      if (timeUs + durationUs > item.range.durationUs) {
        throw commandError('COMMAND_MARKER_OUT_OF_RANGE', `Marker ${marker.id} exceeds Item ${item.id}`, marker.id);
      }
    }
    return this.#host.edit(commandEditOptions(options, 'Update marker'), (transaction) => {
      if (options.timeUs !== undefined) {
        transaction.setField('markers', marker.id, ['timeUs'], options.timeUs);
      }
      if (options.durationUs !== undefined) {
        transaction.setField('markers', marker.id, ['durationUs'], options.durationUs);
      }
      for (const [property, optionProperty] of [
        ['label', 'markerLabel'],
        ['color', 'markerColor'],
      ] as const) {
        const value = options[optionProperty];
        if (value === undefined) continue;
        if (value === null) {
          if (marker[property] !== undefined) transaction.removeField('markers', marker.id, [property]);
        } else {
          transaction.setField('markers', marker.id, [property], value);
        }
      }
      if (Object.hasOwn(options, 'payload')) {
        transaction.setField('markers', marker.id, ['payload'], options.payload ?? null);
      }
    });
  }

  public removeMarker(options: RemoveMarkerOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const marker = project.markers[options.markerId];
    if (marker === undefined) {
      throw commandError('COMMAND_MARKER_MISSING', `Marker ${options.markerId} does not exist`, options.markerId);
    }
    const sequenceId =
      marker.owner.type === 'sequence'
        ? marker.owner.id
        : trackIn(project, itemIn(project, marker.owner.id).trackId).sequenceId;
    const sequence = project.sequences[sequenceId];
    return this.#host.edit(commandEditOptions(options, 'Remove marker'), (transaction) => {
      if (sequence?.markerIds.includes(marker.id) === true) {
        transaction.listRemove('sequences', sequence.id, ['markerIds'], marker.id);
      }
      if (marker.owner.type === 'item') {
        const item = itemIn(project, marker.owner.id);
        if (item.markerIds?.includes(marker.id) === true) {
          transaction.listRemove('items', item.id, ['markerIds'], marker.id);
        }
      }
      transaction.deleteEntity('markers', marker.id);
    });
  }

  public setSelectionMetadata(options: SetSelectionMetadataOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const sequence = project.sequences[options.sequenceId];
    if (sequence === undefined) {
      throw commandError('COMMAND_SEQUENCE_MISSING', `Sequence ${options.sequenceId} does not exist`);
    }
    const itemIds = [...new Set(options.itemIds)];
    if (itemIds.length !== options.itemIds.length) {
      throw commandError('COMMAND_SELECTION_INVALID', 'Selection Item IDs must be unique');
    }
    for (const id of itemIds) {
      const item = itemIn(project, id);
      if (trackIn(project, item.trackId).sequenceId !== sequence.id) {
        throw commandError(
          'COMMAND_SELECTION_SEQUENCE_MISMATCH',
          `Item ${id} does not belong to Sequence ${sequence.id}`,
          id,
        );
      }
    }
    if (options.range !== undefined) {
      assertTime(options.range.startUs, 'range.startUs');
      assertTime(options.range.durationUs, 'range.durationUs');
    }
    const extensions = asObject(sequence.extensions) ?? {};
    return this.#host.edit(commandEditOptions(options, 'Set selection metadata'), (transaction) => {
      transaction.setField('sequences', sequence.id, ['extensions'], {
        ...extensions,
        'aelion.selection': {
          itemIds,
          ...(options.range === undefined ? {} : { range: options.range }),
        },
      });
    });
  }

  /**
   * Writes a whole resolved interaction -- every Item it moves -- as one edit.
   *
   * A real timeline gesture is never one Item: reordering a storyline displaces
   * its neighbours, linked audio travels with its video, and a clip leaving a
   * lane closes the hole behind it. Expressing that as a sequence of single-Item
   * moves means publishing states the user never asked for, each one its own
   * revision and its own undo entry, several of them momentarily invalid.
   *
   * So this takes the finished layout -- normally straight from
   * {@link planTimelineMove} -- and commits it atomically, re-attaching
   * Transitions to whatever pair ends up adjacent. It is the counterpart of the
   * pure planner: the planner decides, this writes.
   */
  public applyPlacements(options: ApplyPlacementsOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const placements = [...options.placements].flatMap(([id, placement]) => {
      const item = project.items[id];
      if (item === undefined) {
        throw commandError('COMMAND_ITEM_MISSING', `Item ${id} does not exist`, id);
      }
      return [{ item, placement }];
    });
    if (placements.length === 0) {
      throw commandError('COMMAND_PLACEMENTS_EMPTY', 'applyPlacements requires a placement');
    }

    for (const { item, placement } of placements) {
      assertTime(placement.startUs, 'startUs');
      const target = trackIn(project, placement.trackId);
      assertUnlocked(trackIn(project, item.trackId));
      assertUnlocked(target);
      assertItemTrackCompatible(item, target);
    }

    const placed = new Map(placements.map(({ item, placement }) => [item.id, placement]));
    if (violatesOccupancy(project, placed)) {
      throw commandError(
        'COMMAND_TRACK_OCCUPANCY_OVERLAP',
        'Placements would stack Items on a Track declared exclusive',
      );
    }

    return this.#host.edit(commandEditOptions(options, 'Move items'), (transaction) => {
      writeTimelinePlacements(transaction, project, placed, {
        ...(options.dropSeparatedTransitions === undefined
          ? {}
          : { dropSeparatedTransitions: options.dropSeparatedTransitions }),
      });
    });
  }

  public reorderTrack(options: ReorderTrackOptions): TransactionCommit {
    const project = this.#host.getSnapshot();
    const sequence = project.sequences[options.sequenceId];
    if (!sequence?.trackIds.includes(options.trackId)) {
      throw commandError(
        'COMMAND_TRACK_SEQUENCE_MISMATCH',
        `Track ${options.trackId} does not belong to Sequence ${options.sequenceId}`,
        options.trackId,
      );
    }
    if (options.beforeTrackId !== undefined && !sequence.trackIds.includes(options.beforeTrackId)) {
      throw commandError(
        'COMMAND_TRACK_ANCHOR_MISSING',
        `Track anchor ${options.beforeTrackId} does not belong to Sequence ${sequence.id}`,
        options.beforeTrackId,
      );
    }
    return this.#host.edit(commandEditOptions(options, 'Reorder track'), (transaction) => {
      transaction.listMove('sequences', sequence.id, ['trackIds'], options.trackId, options.beforeTrackId);
    });
  }

  public setTrackLocked(options: SetTrackFlagOptions): TransactionCommit {
    trackIn(this.#host.getSnapshot(), options.trackId);
    return this.#host.edit(commandEditOptions(options, 'Set track lock'), (transaction) => {
      transaction.setField('tracks', options.trackId, ['locked'], options.value);
    });
  }

  public setTrackEnabled(options: SetTrackFlagOptions): TransactionCommit {
    trackIn(this.#host.getSnapshot(), options.trackId);
    return this.#host.edit(commandEditOptions(options, 'Set track enabled'), (transaction) => {
      transaction.setField('tracks', options.trackId, ['enabled'], options.value);
    });
  }

  public setTrackMuted(options: SetTrackFlagOptions): TransactionCommit {
    const track = trackIn(this.#host.getSnapshot(), options.trackId);
    if (track.kind !== 'audio' || asObject(track.audio) === undefined) {
      throw commandError(
        'COMMAND_TRACK_AUDIO_REQUIRED',
        `Track ${track.id} is not an audio Track with mixer properties`,
        track.id,
      );
    }
    return this.#host.edit(commandEditOptions(options, 'Set track mute'), (transaction) => {
      transaction.setField('tracks', options.trackId, ['audio', 'muted'], options.value);
    });
  }

  public setTrackSolo(options: SetTrackFlagOptions): TransactionCommit {
    const track = trackIn(this.#host.getSnapshot(), options.trackId);
    if (track.kind !== 'audio' || asObject(track.audio) === undefined) {
      throw commandError(
        'COMMAND_TRACK_AUDIO_REQUIRED',
        `Track ${track.id} is not an audio Track with mixer properties`,
        track.id,
      );
    }
    return this.#host.edit(commandEditOptions(options, 'Set track solo'), (transaction) => {
      transaction.setField('tracks', options.trackId, ['audio', 'solo'], options.value);
    });
  }
}
