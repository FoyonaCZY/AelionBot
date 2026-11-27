import {
  itemPairKey,
  trackOccupancy,
  trackRole,
  transitionJoinedPairs,
  type AelionProject,
  type EntityId,
  type ItemEntity,
  type TrackEntity,
} from '@aelionsdk/project-schema';

/**
 * Resolving a timeline drag into final positions, without touching the Project.
 *
 * Every one of these functions is pure. That is the point: a drag recomputes
 * the layout on each pointer move to draw what it is proposing, and only the
 * release turns the result into a transaction. Committing per move instead
 * makes the timeline rearrange under the cursor and fills the undo stack with
 * intermediate states nobody asked for.
 */

/** Final Track and start time assigned to one Item by a layout plan. */
export interface TimelinePlacement {
  readonly trackId: EntityId;
  readonly startUs: number;
}

/** Pure preview result for one proposed timeline move. */
export interface TimelineMovePlan {
  /**
   * Where every Item that actually moves lands, the dragged clip included.
   *
   * Only Items whose Track or start time differ from the committed Project are
   * listed. Repacking a storyline recomputes a position for every clip on it,
   * but a drop near the end leaves the ones before it exactly where they were,
   * and reporting those costs a caller a write per clip on every pointer move
   * -- for a preview that would draw them in the same place either way. An
   * empty map therefore means the drop changes nothing.
   */
  readonly placements: ReadonlyMap<EntityId, TimelinePlacement>;
  /** Insertion line position on the storyline; absent when the drop is free. */
  readonly insertAtUs: number | undefined;
  /** Where the dragged Item is drawn while the pointer is still down. */
  readonly ghost: TimelinePlacement;
  readonly mode: 'reorder' | 'free';
}

/** Item, pointer destination and policy used to resolve a timeline move. */
export interface PlanTimelineMoveOptions {
  readonly movedItemId: EntityId;
  readonly targetTrackId: EntityId;
  readonly targetStartUs: number;
  /** Defaults to the Sequence's storyline Track; pass `null` to disable packing. */
  readonly storylineTrackId?: EntityId | null;
  readonly sequenceId?: EntityId;
  /** Carry `av-sync` partners along with whatever moves. Defaults to true. */
  readonly followLinks?: boolean;
}

/** One or more Item ids excluded from a Track occupancy query. */
export type ItemExcept = EntityId | readonly EntityId[] | undefined;

function exceptSet(except: ItemExcept): ReadonlySet<EntityId> {
  if (except === undefined) return new Set();
  return new Set(typeof except === 'string' ? [except] : except);
}

/** Returns the intersection duration of two half-open microsecond ranges. */
export function rangeOverlapUs(
  startUs: number,
  durationUs: number,
  otherStartUs: number,
  otherDurationUs: number,
): number {
  return Math.max(0, Math.min(startUs + durationUs, otherStartUs + otherDurationUs) - Math.max(startUs, otherStartUs));
}

/** Items on a Track in time order, ties broken by id so the order is total. */
export function itemsOnTrack(project: Readonly<AelionProject>, trackId: EntityId, except?: ItemExcept): ItemEntity[] {
  const track = project.tracks[trackId];
  if (track === undefined) return [];
  const skip = exceptSet(except);
  return track.itemIds
    .flatMap((id) => {
      if (skip.has(id)) return [];
      const item = project.items[id];
      return item === undefined ? [] : [item];
    })
    .sort((left, right) => left.range.startUs - right.range.startUs || left.id.localeCompare(right.id));
}

/** Finds the Item with the greatest overlap against a proposed Track range. */
export function overlappingItemOnTrack(
  project: Readonly<AelionProject>,
  trackId: EntityId,
  startUs: number,
  durationUs: number,
  except?: ItemExcept,
): ItemEntity | undefined {
  let best: ItemEntity | undefined;
  let bestOverlap = 0;
  for (const item of itemsOnTrack(project, trackId, except)) {
    const overlap = rangeOverlapUs(startUs, durationUs, item.range.startUs, item.range.durationUs);
    if (overlap > bestOverlap) {
      best = item;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Returns whether a non-negative range is unoccupied on a Track. */
export function isRangeFreeOnTrack(
  project: Readonly<AelionProject>,
  trackId: EntityId,
  startUs: number,
  durationUs: number,
  except?: ItemExcept,
): boolean {
  return startUs >= 0 && overlappingItemOnTrack(project, trackId, startUs, durationUs, except) === undefined;
}

/** First time at or after `startUs` where `[t, t + durationUs)` is empty on the Track. */
export function firstFreeStartOnTrack(
  project: Readonly<AelionProject>,
  trackId: EntityId,
  startUs: number,
  durationUs: number,
  except?: ItemExcept,
): number {
  const items = itemsOnTrack(project, trackId, except);
  let cursor = Math.max(0, startUs);
  for (const item of items) {
    const endUs = item.range.startUs + item.range.durationUs;
    if (endUs <= cursor) continue;
    if (item.range.startUs >= cursor + durationUs) return cursor;
    cursor = endUs;
  }
  return cursor;
}

/** Tracks of a Sequence in document order, skipping ids that do not resolve. */
export function sequenceTracks(project: Readonly<AelionProject>, sequenceId?: EntityId): TrackEntity[] {
  const sequence = project.sequences[sequenceId ?? project.settings.defaultSequenceId];
  if (sequence === undefined) return [];
  return sequence.trackIds.flatMap((id) => {
    const track = project.tracks[id];
    return track === undefined ? [] : [track];
  });
}

/**
 * The Sequence's storyline Track, or `undefined` when none is declared.
 *
 * Read from the Track's declared role rather than inferred from position. A
 * host that never sets a role gets `undefined` and every Track behaves freely,
 * which is what those documents did before roles existed.
 */
export function storylineTrackId(project: Readonly<AelionProject>, sequenceId?: EntityId): EntityId | undefined {
  return sequenceTracks(project, sequenceId).find((track) => trackRole(track) === 'storyline')?.id;
}

interface PlannedItem {
  readonly id: EntityId;
  readonly durationUs: number;
}

function plannedItems(project: Readonly<AelionProject>, trackId: EntityId, except: ItemExcept): PlannedItem[] {
  return itemsOnTrack(project, trackId, except).map((item) => ({
    id: item.id,
    durationUs: item.range.durationUs,
  }));
}

/**
 * Packs a storyline from its first clip, leaving no gap and no overlap.
 *
 * Gap Items are ordinary members of the sequence, so deliberate blank space
 * survives packing while accidental holes do not.
 */
export function packTrack(items: readonly PlannedItem[], startUs: number): Map<EntityId, number> {
  const placed = new Map<EntityId, number>();
  let cursor = Math.max(0, startUs);
  for (const item of items) {
    placed.set(item.id, cursor);
    cursor += item.durationUs;
  }
  return placed;
}

/**
 * Insertion index for a clip dropped at `targetStartUs`.
 *
 * Compared against each resident clip's midpoint, which is what makes the drop
 * feel decided rather than fought over: the dragged clip takes a slot once its
 * own start passes the middle of the clip holding it, so there is exactly one
 * boundary rather than a band where nothing happens.
 */
function insertionIndex(items: readonly PlannedItem[], targetStartUs: number): number {
  let cursor = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) break;
    if (targetStartUs < cursor + item.durationUs / 2) return index;
    cursor += item.durationUs;
  }
  return items.length;
}

/**
 * Shifts `av-sync` partners by the same delta as the clip they belong to.
 *
 * Every placed clip is considered, not just the dragged one: repacking a
 * storyline moves its other clips too, and their audio has to travel with them
 * or the drag quietly pulls the cut out of sync. Partners keep their own lane
 * and never take part in packing, so an audio Track stays freely positioned.
 *
 * Returns false when a partner would land before zero. Clamping it there would
 * hold it still while its video kept moving, which is exactly the desync this
 * exists to prevent, so the move is refused instead.
 */
function carryLinkedPartners(project: Readonly<AelionProject>, placements: Map<EntityId, TimelinePlacement>): boolean {
  for (const [id, at] of [...placements]) {
    const item = project.items[id];
    const groupId = item?.linkGroupId;
    if (item === undefined || groupId === undefined) continue;
    const deltaUs = at.startUs - item.range.startUs;
    if (deltaUs === 0) continue;
    for (const memberId of project.linkGroups[groupId]?.itemIds ?? []) {
      if (memberId === id || placements.has(memberId)) continue;
      const member = project.items[memberId];
      if (member === undefined) continue;
      const startUs = member.range.startUs + deltaUs;
      if (startUs < 0) return false;
      placements.set(memberId, { trackId: member.trackId, startUs });
    }
  }
  return true;
}

/**
 * Whether the resolved layout stacks two Items on a Track that forbids it.
 *
 * Only the storyline is packed, so nothing otherwise stops a linked partner
 * from landing on top of its neighbour -- and it will whenever audio is longer
 * than the video it belongs to, because packing the video says nothing about
 * the lengths below it. Refusing is the honest outcome: the alternatives are
 * silently desyncing the pair or overwriting audio the drag never mentioned.
 *
 * Only Tracks the plan touches are examined, so a Project that already contains
 * an overlap elsewhere stays draggable -- and only the Items on those Tracks
 * are read, rather than every Item in the Project, because a drag re-resolves
 * this on every pointer move.
 */
export function violatesOccupancy(
  project: Readonly<AelionProject>,
  placements: ReadonlyMap<EntityId, TimelinePlacement>,
): boolean {
  const touched = new Set<EntityId>();
  for (const [id, at] of placements) {
    touched.add(at.trackId);
    const item = project.items[id];
    if (item !== undefined) touched.add(item.trackId);
  }
  // An Item is relevant when it sits on a touched Track or is being placed onto
  // one. The first set is reachable through the Track, the second through the
  // plan, so the whole Item collection never has to be walked.
  const relevant = new Set<EntityId>();
  for (const trackId of touched) {
    const track = project.tracks[trackId];
    if (track === undefined || trackOccupancy(track) !== 'exclusive') continue;
    for (const id of track.itemIds) relevant.add(id);
  }
  for (const id of placements.keys()) relevant.add(id);

  const joined = transitionJoinedPairs(project);
  const lanes = new Map<EntityId, { id: EntityId; startUs: number; endUs: number }[]>();
  for (const id of relevant) {
    const item = project.items[id];
    if (item === undefined) continue;
    const at = placements.get(id);
    const trackId = at?.trackId ?? item.trackId;
    if (!touched.has(trackId)) continue;
    const track = project.tracks[trackId];
    if (track === undefined || trackOccupancy(track) !== 'exclusive') continue;
    const startUs = at?.startUs ?? item.range.startUs;
    const span = { id: item.id, startUs, endUs: startUs + item.range.durationUs };
    const lane = lanes.get(trackId);
    if (lane === undefined) lanes.set(trackId, [span]);
    else lane.push(span);
  }
  for (const lane of lanes.values()) {
    lane.sort((left, right) =>
      left.startUs !== right.startUs
        ? left.startUs - right.startUs
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
    );
    const active: typeof lane = [];
    for (const current of lane) {
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if ((active[index]?.endUs ?? 0) <= current.startUs) active.splice(index, 1);
      }
      // A pair carrying a Transition overlaps by design; that is the dissolve.
      if (active.some((previous) => !joined.has(itemPairKey(previous.id, current.id)))) return true;
      active.push(current);
    }
  }
  return false;
}

/**
 * Reorders a clip among its neighbours on a Track that is not the storyline.
 *
 * Resolved from the committed layout and the pointer alone, never from the last
 * preview, which is what lets it continue as long as the drag does: pushing
 * further simply passes more midpoints, so a clip can be shoved several places
 * along without letting go. A single exchange is just the two-clip case.
 *
 * The leading edge of travel is what counts as having passed a neighbour -- the
 * in-point heading left, the out-point heading right. Centre against centre
 * reads well but cannot express the move: two clips of equal length bring their
 * centres level only when exactly stacked, so the exchange has one reachable
 * position, and against the first clip on a Track the drag clamps at zero
 * before ever reaching it.
 *
 * Only the span between the old and new positions is reseated, packed from the
 * in-point of whichever clip started that span, so clips outside it never move
 * and unequal lengths cannot leave the pair overlapping.
 */
function reorderWithinTrack(
  project: Readonly<AelionProject>,
  trackId: EntityId,
  moved: ItemEntity,
  targetStartUs: number,
): Map<EntityId, number> | undefined {
  const items = itemsOnTrack(project, trackId);
  const oldIndex = items.findIndex((item) => item.id === moved.id);
  if (oldIndex < 0) return undefined;
  const others = items.filter((item) => item.id !== moved.id);
  const headingRight = targetStartUs > moved.range.startUs;
  const leadingEdgeUs = headingRight ? targetStartUs + moved.range.durationUs : targetStartUs;
  let newIndex = 0;
  for (const other of others) {
    const otherMidUs = other.range.startUs + other.range.durationUs / 2;
    const passed = headingRight ? leadingEdgeUs > otherMidUs : leadingEdgeUs < otherMidUs;
    if (headingRight ? !passed : passed) break;
    newIndex += 1;
  }
  if (newIndex === oldIndex) {
    // Pushing into a neighbour without having passed it yet. Holding the clip
    // in its own slot keeps the layout valid while the gesture is under way;
    // refusing would paint a dead band across the half of every neighbour the
    // drag has to cross to get anywhere.
    return new Map([[moved.id, moved.range.startUs]]);
  }
  const ordered = [...others.slice(0, newIndex), moved, ...others.slice(newIndex)];
  const low = Math.min(oldIndex, newIndex);
  const high = Math.max(oldIndex, newIndex);
  const anchorUs = items[low]?.range.startUs ?? targetStartUs;
  const placed = new Map<EntityId, number>();
  let cursor = anchorUs;
  for (let index = low; index <= high; index += 1) {
    const item = ordered[index];
    if (item === undefined) continue;
    placed.set(item.id, cursor);
    cursor += item.range.durationUs;
  }
  return placed;
}

/**
 * Resolves a drag into final Item positions.
 *
 * Returns `undefined` when the move cannot be expressed -- a locked Track, a
 * partner that would fall before zero, or a layout that would stack Items on a
 * Track declared exclusive. A refused plan is a drop the caller should reject,
 * not a plan to apply partially.
 */
export function planTimelineMove(
  project: Readonly<AelionProject>,
  options: PlanTimelineMoveOptions,
): TimelineMovePlan | undefined {
  const moved = project.items[options.movedItemId];
  const targetTrack = project.tracks[options.targetTrackId];
  if (moved === undefined || targetTrack === undefined || targetTrack.locked) return undefined;

  const storyline =
    options.storylineTrackId === null
      ? undefined
      : (options.storylineTrackId ?? storylineTrackId(project, options.sequenceId));

  const placements = new Map<EntityId, TimelinePlacement>();
  const targetStartUs = Math.max(0, Math.round(options.targetStartUs));
  const sourceWasStoryline = moved.trackId === storyline;
  const targetIsStoryline = options.targetTrackId === storyline;

  let movedStartUs: number;

  if (targetIsStoryline) {
    const residents = plannedItems(project, storyline, moved.id);
    const anchorUs = itemsOnTrack(project, storyline)[0]?.range.startUs ?? 0;
    const index = insertionIndex(residents, targetStartUs);
    const ordered = [
      ...residents.slice(0, index),
      { id: moved.id, durationUs: moved.range.durationUs },
      ...residents.slice(index),
    ];
    for (const [id, startUs] of packTrack(ordered, anchorUs)) {
      placements.set(id, { trackId: storyline, startUs });
    }
    movedStartUs = placements.get(moved.id)?.startUs ?? targetStartUs;
  } else {
    // Reordering is only for pushing into somebody. A drop that lands clear of
    // every other clip stays exactly where it was put, which is the whole point
    // of a Track that is not the storyline.
    const pushingInto =
      moved.trackId === options.targetTrackId &&
      overlappingItemOnTrack(project, options.targetTrackId, targetStartUs, moved.range.durationUs, moved.id) !==
        undefined;
    const reordered = pushingInto
      ? reorderWithinTrack(project, options.targetTrackId, moved, targetStartUs)
      : undefined;
    if (reordered !== undefined) {
      for (const [id, startUs] of reordered) {
        placements.set(id, { trackId: options.targetTrackId, startUs });
      }
      movedStartUs = reordered.get(moved.id) ?? targetStartUs;
    } else {
      movedStartUs = targetStartUs;
      placements.set(moved.id, { trackId: options.targetTrackId, startUs: movedStartUs });
    }
    // Leaving the storyline closes the hole the clip was occupying.
    if (sourceWasStoryline) {
      const residents = plannedItems(project, storyline, moved.id);
      const anchorUs = itemsOnTrack(project, storyline)[0]?.range.startUs ?? 0;
      for (const [id, startUs] of packTrack(residents, anchorUs)) {
        placements.set(id, { trackId: storyline, startUs });
      }
    }
  }

  if ((options.followLinks ?? true) && !carryLinkedPartners(project, placements)) return undefined;

  // Drop the Items the layout resolved back onto their own position. Packing
  // computes a position for every clip on the storyline, and on a long Track
  // almost all of them are already there; carrying them forward would make a
  // preview rewrite the whole timeline on every pointer move.
  for (const [id, at] of [...placements]) {
    const item = project.items[id];
    if (item !== undefined && item.trackId === at.trackId && item.range.startUs === at.startUs) {
      placements.delete(id);
    }
  }

  if (violatesOccupancy(project, placements)) return undefined;

  return {
    placements,
    insertAtUs: targetIsStoryline ? movedStartUs : undefined,
    ghost: { trackId: options.targetTrackId, startUs: movedStartUs },
    mode: targetIsStoryline ? 'reorder' : 'free',
  };
}

/** Whether a resolved plan would actually change anything. */
export function placementsChange(
  project: Readonly<AelionProject>,
  placements: ReadonlyMap<EntityId, TimelinePlacement>,
): boolean {
  for (const [id, next] of placements) {
    const item = project.items[id];
    if (item === undefined) continue;
    if (item.trackId !== next.trackId || item.range.startUs !== next.startUs) return true;
  }
  return false;
}
