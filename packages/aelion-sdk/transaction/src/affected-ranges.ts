import type { AelionProject, CollectionName, EntityId, ItemEntity, TimeRange } from '@aelionsdk/project-schema';

import type { AffectedRange, AtomicOperation } from './types.js';

function itemRange(project: AelionProject, item: ItemEntity): AffectedRange | undefined {
  const sequenceId = project.tracks[item.trackId]?.sequenceId;
  if (sequenceId === undefined) return undefined;
  return { sequenceId, startUs: item.range.startUs, durationUs: item.range.durationUs };
}

function rangesForItemIds(project: AelionProject, ids: readonly string[]): AffectedRange[] {
  return ids.flatMap((id) => {
    const item = project.items[id];
    if (item === undefined) return [];
    const range = itemRange(project, item);
    return range === undefined ? [] : [range];
  });
}

function ownerRanges(project: AelionProject, collection: CollectionName, id: EntityId): AffectedRange[] {
  switch (collection) {
    case 'items': {
      const item = project.items[id];
      if (item === undefined) return [];
      const range = itemRange(project, item);
      return range === undefined ? [] : [range];
    }
    case 'transitions': {
      const transition = project.transitions[id];
      return transition === undefined ? [] : [{ sequenceId: transition.sequenceId, ...transition.range }];
    }
    case 'tracks': {
      const track = project.tracks[id];
      return track === undefined ? [] : rangesForItemIds(project, track.itemIds);
    }
    case 'sequences': {
      const sequence = project.sequences[id];
      if (sequence === undefined) return [];
      return sequence.trackIds.flatMap((trackId) => {
        const track = project.tracks[trackId];
        return track === undefined ? [] : rangesForItemIds(project, track.itemIds);
      });
    }
    case 'materialInstances': {
      const ranges: AffectedRange[] = [];
      for (const sequence of Object.values(project.sequences)) {
        if (sequence.materialInstanceIds.includes(id)) {
          ranges.push(...ownerRanges(project, 'sequences', sequence.id));
        }
      }
      for (const track of Object.values(project.tracks)) {
        if (track.materialInstanceIds.includes(id)) {
          ranges.push(...ownerRanges(project, 'tracks', track.id));
        }
      }
      for (const item of Object.values(project.items)) {
        if (item.materialInstanceIds.includes(id)) {
          ranges.push(...ownerRanges(project, 'items', item.id));
        }
      }
      for (const transition of Object.values(project.transitions)) {
        if (transition.materialInstanceId === id) {
          ranges.push(...ownerRanges(project, 'transitions', transition.id));
        }
      }
      return ranges;
    }
    case 'assets': {
      const ids = Object.values(project.items)
        .filter((item) => {
          const source = item.source;
          return source !== null && typeof source === 'object' && !Array.isArray(source) && source.assetId === id;
        })
        .map((item) => item.id);
      return rangesForItemIds(project, ids);
    }
    case 'linkGroups': {
      const linkGroup = project.linkGroups[id];
      const ids = linkGroup?.itemIds;
      return Array.isArray(ids) && ids.every((value) => typeof value === 'string')
        ? rangesForItemIds(project, ids)
        : [];
    }
    case 'markers': {
      const marker = project.markers[id];
      if (marker === undefined) return [];
      const owner = marker.owner;
      const startUs = marker.timeUs;
      const durationUs = marker.durationUs;
      if (owner.type === 'sequence') return [{ sequenceId: owner.id, startUs, durationUs }];
      const item = project.items[owner.id];
      const base = item === undefined ? undefined : itemRange(project, item);
      return base === undefined ? [] : [{ ...base, startUs: base.startUs + startUs, durationUs }];
    }
  }
}

function mergeRanges(ranges: readonly AffectedRange[]): AffectedRange[] {
  const sorted = [...ranges]
    .filter((range) => range.durationUs >= 0)
    .sort(
      (left, right) =>
        left.sequenceId.localeCompare(right.sequenceId) ||
        left.startUs - right.startUs ||
        left.durationUs - right.durationUs,
    );
  const merged: { sequenceId: EntityId; startUs: number; durationUs: number }[] = [];

  for (const range of sorted) {
    const previous = merged.at(-1);
    const rangeEnd = range.startUs + range.durationUs;
    if (
      previous !== undefined &&
      previous.sequenceId === range.sequenceId &&
      range.startUs <= previous.startUs + previous.durationUs
    ) {
      const previousEnd = previous.startUs + previous.durationUs;
      previous.durationUs = Math.max(previousEnd, rangeEnd) - previous.startUs;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

function operationRanges(project: AelionProject, operation: AtomicOperation): AffectedRange[] {
  // Reordering a Track's itemIds only changes the compositing order of the
  // referenced Item. Treating it as a generic Track edit invalidates every
  // Item on the Track and defeats incremental compilation for insert/move.
  if (
    operation.collection === 'tracks' &&
    'path' in operation &&
    operation.path.length === 1 &&
    operation.path[0] === 'itemIds' &&
    'valueId' in operation
  ) {
    return rangesForItemIds(project, [operation.valueId]);
  }
  return ownerRanges(project, operation.collection, operation.id);
}

export function collectAffectedRanges(
  before: AelionProject,
  after: AelionProject,
  operations: readonly AtomicOperation[],
): readonly AffectedRange[] {
  return mergeRanges(
    operations.flatMap((operation) => [...operationRanges(before, operation), ...operationRanges(after, operation)]),
  );
}

export function rangeEnd(range: TimeRange): number {
  return range.startUs + range.durationUs;
}
