import type { Snapshot, StreamingReply } from '../../../shared/types/core';
import {
  diffEntities,
  emptyBaseline,
  type EntityBaseline,
  type StateBase,
  type StateDelta,
} from '../../../shared/state-sync';

const ENTITY_FIELDS = ['messages', 'runs'] as const;

/**
 * Tracks what the renderer holds, so each push carries only what changed since the previous one. Messages and runs
 * are compared by reference (see isLiveEntry for the entries that are edited in place); the other fields are a few
 * hundred kilobytes in all and are compared by their JSON text.
 */
export class StateSync {
  private seq = 0;
  private fields = new Map<string, string>();
  private entities = new Map<string, EntityBaseline>();
  private streams = '[]';
  /** Entries found edited in place since the last push; they are sent again even though their reference is the same. */
  private edited = new WeakSet<object>();

  constructor(
    private readonly build: () => Snapshot,
    private readonly liveStreams: () => StreamingReply[],
  ) {}

  /** The whole state; the next delta is computed against it. */
  base(): StateBase {
    const snapshot = this.build(),
      streams = this.liveStreams();
    this.seq++;
    this.fields.clear();
    for (const [key, value] of Object.entries(snapshot))
      if (!(ENTITY_FIELDS as readonly string[]).includes(key) && value !== undefined)
        this.fields.set(key, JSON.stringify(value));
    for (const field of ENTITY_FIELDS)
      this.entities.set(field, diffEntities<{ id: string }>(emptyBaseline(), snapshot[field]).baseline);
    this.streams = JSON.stringify(streams);
    this.edited = new WeakSet();
    return { seq: this.seq, snapshot, streams };
  }

  /** What changed since the last base or delta, or undefined when nothing did. */
  delta(): StateDelta | undefined {
    if (!this.seq) return;
    const snapshot = this.build(),
      delta: StateDelta = { from: this.seq, seq: this.seq + 1, fields: {}, cleared: [] };
    let changed = false;
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(snapshot)) {
      if ((ENTITY_FIELDS as readonly string[]).includes(key) || value === undefined) continue;
      seen.add(key);
      const text = JSON.stringify(value);
      if (this.fields.get(key) === text) continue;
      this.fields.set(key, text);
      (delta.fields as Record<string, unknown>)[key] = value;
      changed = true;
    }
    for (const key of this.fields.keys())
      if (!seen.has(key)) {
        this.fields.delete(key);
        delta.cleared.push(key as keyof Snapshot);
        changed = true;
      }
    for (const field of ENTITY_FIELDS) {
      const result = diffEntities<{ id: string }>(this.entities.get(field)!, snapshot[field], this.edited);
      this.entities.set(field, result.baseline);
      if (result.delta) {
        (delta as unknown as Record<string, unknown>)[field] = result.delta;
        changed = true;
      }
    }
    this.edited = new WeakSet();
    const streams = this.liveStreams(),
      text = JSON.stringify(streams);
    if (text !== this.streams) {
      this.streams = text;
      delta.streams = streams;
      changed = true;
    }
    if (!changed) return;
    this.seq++;
    return delta;
  }

  /** Records live replies sent on their own, so the next delta only carries them when they changed again. */
  sentStreams(streams: StreamingReply[]) {
    this.streams = JSON.stringify(streams);
  }

  /**
   * Entries changed without being replaced; the next delta sends them again. Returns how many of them are messages
   * or runs, which should have been replaced (other collections are compared by text and need no help).
   */
  markEdited(entries: Iterable<object>) {
    let tracked = 0;
    for (const entry of entries) {
      this.edited.add(entry);
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && ENTITY_FIELDS.some((field) => this.entities.get(field)?.refs.get(id) === entry))
        tracked++;
    }
    return tracked;
  }
}
