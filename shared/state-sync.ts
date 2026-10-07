// How the main process keeps the renderer's copy of the app state current. The renderer reads the whole state once
// (a StateBase); after that every push is a StateDelta against the previous one. Messages and runs, nearly all of
// the state, travel entry by entry; every other field travels whole when it changed.
//
// Applying a delta keeps every object that did not change, so the renderer can compare by reference: an IPC message
// is a fresh structured clone, and without this every memoized component would have to compare by value.
import type { ChatMessage, RunRecord, Snapshot, StreamingReply } from './types/core';

/** Changes to an id-keyed collection. Without `order`, kept entries stay in place and new ones are appended. */
export interface EntityDelta<T extends { id: string }> {
  upsert: T[];
  remove: string[];
  /** The full id order, sent only when the order changed in a way upserts and removals do not describe. */
  order?: string[];
  /** The whole collection, sent when it cannot be described by ids (an id appears twice). */
  replace?: T[];
}

export interface StateBase {
  seq: number;
  snapshot: Snapshot;
  streams: StreamingReply[];
}

export interface StateDelta {
  /** The seq of the state this delta applies to; the renderer reads a new base when it holds another one. */
  from: number;
  seq: number;
  /** Fields that changed, other than messages and runs. */
  fields: Partial<Snapshot>;
  /** Fields that no longer have a value. */
  cleared: (keyof Snapshot)[];
  messages?: EntityDelta<ChatMessage>;
  runs?: EntityDelta<RunRecord>;
  streams?: StreamingReply[];
}

export type AppEvent = { type: 'state'; delta: StateDelta } | { type: 'streams'; streamingReplies: StreamingReply[] };

/**
 * Entries still being worked on (a running run, a streaming answer, a queued input) are edited in place by their
 * owner, so they are sent again on every push while they last and once more after they finish. Every other entry is
 * replaced, never edited, when it changes.
 */
export function isLiveEntry(entry: unknown) {
  if (!entry || typeof entry !== 'object') return false;
  const value = entry as { status?: unknown; activeRunId?: unknown; inputState?: unknown };
  return (
    value.status === 'running' ||
    value.status === 'planning' ||
    Boolean(value.activeRunId) ||
    value.inputState === 'queued'
  );
}

/** What was last sent for one collection. */
export interface EntityBaseline {
  ids: string[];
  refs: Map<string, object>;
  live: Set<string>;
}

export const emptyBaseline = (): EntityBaseline => ({ ids: [], refs: new Map(), live: new Set() });

/**
 * Compares a collection with what was last sent, by reference: entries are replaced when they change, so an entry
 * that is the same object is unchanged unless it is live or was found edited in place (`edited`).
 */
export function diffEntities<T extends { id: string }>(
  baseline: EntityBaseline,
  list: readonly T[],
  edited?: { has(entry: object): boolean },
): { delta?: EntityDelta<T>; baseline: EntityBaseline } {
  const ids: string[] = [],
    refs = new Map<string, object>(),
    live = new Set<string>(),
    upsert: T[] = [];
  for (const entry of list) {
    if (refs.has(entry.id)) {
      // Ids are not unique: positions cannot be described by ids, so send the collection as it is.
      const next = { ids: [], refs: new Map(), live: new Set<string>() };
      return { delta: { upsert: [], remove: [], replace: [...list] }, baseline: next };
    }
    ids.push(entry.id);
    refs.set(entry.id, entry);
    const running = isLiveEntry(entry);
    if (running) live.add(entry.id);
    if (baseline.refs.get(entry.id) !== entry || running || baseline.live.has(entry.id) || edited?.has(entry))
      upsert.push(entry);
  }
  const remove = baseline.ids.filter((id) => !refs.has(id));
  // The order the renderer arrives at without `order`: kept entries where they were, then new ones as listed.
  let expected = 0,
    ordered = true;
  const kept = baseline.ids.filter((id) => refs.has(id));
  for (const id of ids) {
    const want = expected < kept.length ? kept[expected] : undefined;
    if (want === id) expected++;
    else if (baseline.refs.has(id) || want !== undefined) {
      ordered = false;
      break;
    }
  }
  const next = { ids, refs, live };
  if (!upsert.length && !remove.length && ordered) return { baseline: next };
  return { delta: { upsert, remove, ...(ordered ? {} : { order: ids }) }, baseline: next };
}

/**
 * Returns `next`, reusing every part of `previous` that is deep-equal to it, so unchanged objects keep their
 * identity. Arrays of id-keyed objects are matched by id, so an insertion does not shift every later entry.
 */
export function share<T>(previous: unknown, next: T): T {
  if (previous === next) return next;
  if (typeof previous !== 'object' || typeof next !== 'object' || previous === null || next === null) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    const byId = keyedById(previous) && keyedById(next) ? new Map(previous.map((item) => [item.id, item])) : undefined;
    let same = previous.length === next.length;
    const result = next.map((item, index) => {
      const old = byId ? byId.get((item as { id: string }).id) : previous[index];
      const value = old === undefined ? item : share(old, item);
      if (value !== previous[index]) same = false;
      return value;
    });
    return (same ? previous : result) as T;
  }
  if (Array.isArray(previous)) return next;
  const before = previous as Record<string, unknown>,
    after = next as Record<string, unknown>,
    keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = share(before[key], after[key]);
    result[key] = value;
    if (value !== before[key] || !(key in before)) same = false;
  }
  return (same ? previous : result) as T;
}
const keyedById = (list: unknown[]): list is { id: string }[] =>
  list.length > 0 &&
  list.every((item) => item !== null && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string');

/** Applies a collection delta, keeping every entry that did not change, and `list` itself when nothing did. */
export function applyEntityDelta<T extends { id: string }>(list: T[], delta: EntityDelta<T>): T[] {
  if (delta.replace) return share(list, delta.replace);
  const previous = new Map(list.map((entry) => [entry.id, entry])),
    upserts = new Map(delta.upsert.map((entry) => [entry.id, entry])),
    removed = new Set(delta.remove);
  const take = (id: string) => {
    const old = previous.get(id),
      update = upserts.get(id);
    return update ? (old ? share(old, update) : update) : old;
  };
  let result: T[];
  if (delta.order) result = delta.order.map(take).filter((entry): entry is T => entry !== undefined);
  else {
    result = [];
    for (const entry of list) if (!removed.has(entry.id)) result.push(take(entry.id)!);
    for (const entry of delta.upsert) if (!previous.has(entry.id)) result.push(entry);
  }
  return result.length === list.length && result.every((entry, index) => entry === list[index]) ? list : result;
}

/** The renderer's state after a delta; fields that did not change keep their identity. */
export function applyStateDelta(state: Snapshot, delta: StateDelta): Snapshot {
  const next = { ...state } as Record<string, unknown>;
  for (const [key, value] of Object.entries(delta.fields)) next[key] = share(state[key as keyof Snapshot], value);
  for (const key of delta.cleared) delete next[key];
  if (delta.messages) next.messages = applyEntityDelta(state.messages, delta.messages);
  if (delta.runs) next.runs = applyEntityDelta(state.runs, delta.runs);
  return next as unknown as Snapshot;
}
