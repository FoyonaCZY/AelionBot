import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { join } from 'node:path';
import { isLiveEntry as live } from '../../../shared/state-sync';
const collections = new Set([
  'messages',
  'runs',
  'bots',
  'peerMessages',
  'groupRunMessages',
  'peerExchanges',
  'groupDeliveries',
  'groupOutbox',
  'modelUsage',
  'processes',
  'attachments',
  'artifacts',
  'scheduledTasks',
  'workItems',
  'previewHistory',
]);
const histories = new Set(['conversations', 'peerContexts', 'groupContexts']);
/** Collections this small are always serialized: it is cheap, and settings-like rows edited in place land at once. */
const SMALL_COLLECTION = 64;
/** The last rows of every collection and history are always serialized: that is where streaming edits happen. */
const HOT_TAIL = 4;
/**
 * A sweep starts at most every SWEEP_INTERVAL_MS and slices its work into SWEEP_SLICE_MS steps with SWEEP_PAUSE_MS
 * pauses, so it never holds up input and costs a few percent of one core while writes keep coming.
 */
const SWEEP_INTERVAL_MS = 2000,
  SWEEP_SLICE_MS = 4,
  SWEEP_PAUSE_MS = 8;
// arrays[field] is either a legacy length (rows keyed by index) or the ordered row keys. Rows of entries with a
// string id are keyed by that id, so inserting, deleting or sorting one entry no longer rewrites every later row.
interface Layout {
  root: Record<string, unknown>;
  arrays: Record<string, number | string[]>;
  histories: Record<string, Record<string, number>>;
}
/**
 * `full` serializes every row. `quick` only visits what changed: the rows after the first position whose entry is
 * no longer the same object, the newest rows, running entries and rows a sweep found edited in place. On a large
 * profile that is a few milliseconds instead of ~100 ms on the thread that also delivers input.
 */
export type WriteMode = 'full' | 'quick';
/** One collection field or one history scope as last written: its row keys, entries and stored text by position. */
interface Part {
  keys: string[];
  entries: unknown[];
  json: string[];
  /** Collections only: position of each key. */
  index?: Map<string, number>;
  /** Collections only: JSON text of `keys` for the layout row. */
  keysJson?: string;
  /** Collections only: positions that were running when written; they are serialized once more after they finish. */
  live?: Set<number>;
}
// Same text as JSON.stringify([field, 'id', id]) / JSON.stringify([field, i]) / JSON.stringify([field, scope, i]);
// field names are plain identifiers.
const idKey = (field: string, entry: unknown) =>
  entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string'
    ? `["${field}","id",${JSON.stringify((entry as { id: string }).id)}]`
    : undefined;
const indexKey = (field: string, i: number) => `["${field}",${i}]`;
export class StateDatabase {
  private db: DatabaseSync;
  private cached: Map<string, string>;
  private putRow: StatementSync;
  private removeRow: StatementSync;
  /** What the last write stored, by part id (`a:field` or `h:field:scope`); unset until the first write. */
  private parts?: Map<string, Part>;
  /** Positions a sweep found edited in place since they were written, by part id. */
  private stale = new Map<string, Set<number>>();
  /** Entries the owner reported edited in place since the last write (Store.touch). */
  private touched = new WeakSet<object>();
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private sweepAgain = false;
  private lastSweep = 0;
  /** Called with the entries a sweep found edited in place, so the owner writes (and shows) them again. */
  onStale?: (entries: object[]) => void;
  constructor(dir: string) {
    this.db = new DatabaseSync(join(dir, 'state.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS parts(key TEXT PRIMARY KEY,value TEXT NOT NULL);',
    );
    this.cached = new Map(
      (this.db.prepare('SELECT key,value FROM parts').all() as Array<{ key: string; value: string }>).map((row) => [
        row.key,
        row.value,
      ]),
    );
    this.putRow = this.db.prepare('INSERT INTO parts VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    this.removeRow = this.db.prepare('DELETE FROM parts WHERE key=?');
  }
  /**
   * Reads the stored state. What it returns is also what the next write compares with, so the first write after
   * starting only visits what changed, like every later one.
   */
  read(): Record<string, any> | undefined {
    const raw = this.cached.get('layout');
    if (!raw) return;
    const layout = JSON.parse(raw) as Layout,
      data = layout.root,
      parts = new Map<string, Part>();
    const text = (key: string) => {
      const raw = this.cached.get(key);
      if (raw === undefined) throw Error('状态数据库缺少记录，已保留原数据库');
      return raw;
    };
    for (const [field, stored] of Object.entries(layout.arrays)) {
      const keys = typeof stored === 'number' ? Array.from({ length: stored }, (_, i) => indexKey(field, i)) : stored,
        json = keys.map(text),
        entries = json.map((row) => JSON.parse(row));
      data[field] = entries;
      parts.set('a:' + field, {
        keys,
        entries: [...entries],
        json,
        index: new Map(keys.map((key, i) => [key, i])),
        keysJson: JSON.stringify(keys),
        live: new Set(entries.flatMap((entry, i) => (live(entry) ? [i] : []))),
      });
    }
    for (const [field, scopes] of Object.entries(layout.histories))
      data[field] = Object.fromEntries(
        Object.entries(scopes).map(([scope, length]) => {
          const keys = Array.from({ length }, (_, i) => JSON.stringify([field, scope, i])),
            json = keys.map(text),
            entries = json.map((row) => JSON.parse(row));
          parts.set('h:' + field + ':' + scope, { keys, entries: [...entries], json });
          return [scope, entries];
        }),
      );
    this.parts = parts;
    return data;
  }
  /** Entries edited in place: the next quick write serializes them again without waiting for a sweep. */
  touch(entries: object[]) {
    for (const entry of entries) this.touched.add(entry);
  }
  write(data: Record<string, any>, mode: WriteMode = 'full') {
    const changes = mode === 'quick' && this.parts ? this.writeChanged(data) : this.writeAll(data);
    this.stale.clear();
    this.touched = new WeakSet();
    if (mode === 'quick') this.scheduleSweep();
    return changes;
  }
  /** Serializes every row and diffs it with what is stored. */
  private writeAll(data: Record<string, any>) {
    const next = new Map<string, string>(),
      parts = new Map<string, Part>(),
      layout: Layout = { root: {}, arrays: {}, histories: {} };
    for (const [field, value] of Object.entries(data)) {
      if (collections.has(field) && Array.isArray(value)) {
        const part: Part = { keys: [], entries: [...value], json: [], index: new Map(), live: new Set() };
        value.forEach((entry, i) => {
          let key = idKey(field, entry) ?? indexKey(field, i);
          if (part.index!.has(key)) key = indexKey(field, i);
          if (live(entry)) part.live!.add(i);
          const text = JSON.stringify(entry);
          part.keys.push(key);
          part.json.push(text);
          part.index!.set(key, i);
          next.set(key, text);
        });
        part.keysJson = JSON.stringify(part.keys);
        parts.set('a:' + field, part);
        layout.arrays[field] = part.keys;
      } else if (histories.has(field) && value) {
        layout.histories[field] = {};
        for (const [scope, history] of Object.entries(value) as [string, unknown[]][]) {
          layout.histories[field][scope] = history.length;
          const part: Part = { keys: [], entries: [...history], json: [] },
            prefix = `["${field}",${JSON.stringify(scope)},`;
          history.forEach((m, i) => {
            const key = prefix + i + ']',
              text = JSON.stringify(m);
            part.keys.push(key);
            part.json.push(text);
            next.set(key, text);
          });
          parts.set('h:' + field + ':' + scope, part);
        }
      } else layout.root[field] = value;
    }
    next.set('layout', JSON.stringify(layout));
    const puts = new Map<string, string>(),
      removes: string[] = [];
    for (const [key, value] of next) if (this.cached.get(key) !== value) puts.set(key, value);
    for (const key of this.cached.keys()) if (!next.has(key)) removes.push(key);
    this.commit(puts, removes);
    this.cached = next;
    this.parts = parts;
    return puts.size + removes.length;
  }
  /**
   * Visits only what may have changed since the last write. Nothing is changed in memory until the transaction
   * commits, so a failed write leaves the next one to redo the same work.
   */
  private writeChanged(data: Record<string, any>) {
    const previous = this.parts!,
      parts = new Map<string, Part>(),
      puts = new Map<string, string>(),
      removes: string[] = [],
      layoutArrays: string[] = [],
      layoutHistories: Record<string, Record<string, number>> = {},
      root: Record<string, unknown> = {};
    const put = (key: string, text: string) => {
      if (this.cached.get(key) !== text) puts.set(key, text);
    };
    for (const [field, value] of Object.entries(data)) {
      if (collections.has(field) && Array.isArray(value)) {
        const id = 'a:' + field,
          old = previous.get(id),
          part = this.collection(field, value, old, this.stale.get(id), put, removes);
        parts.set(id, part);
        layoutArrays.push(JSON.stringify(field) + ':' + part.keysJson);
      } else if (histories.has(field) && value) {
        layoutHistories[field] = {};
        for (const [scope, history] of Object.entries(value) as [string, unknown[]][]) {
          const id = 'h:' + field + ':' + scope;
          layoutHistories[field][scope] = history.length;
          parts.set(
            id,
            this.history(
              `["${field}",${JSON.stringify(scope)},`,
              history,
              previous.get(id),
              this.stale.get(id),
              put,
              removes,
            ),
          );
        }
      } else root[field] = value;
    }
    for (const [id, part] of previous) if (!parts.has(id)) removes.push(...part.keys);
    // The same text as JSON.stringify(layout), without re-serializing every row key of every collection.
    const layout = `{"root":${JSON.stringify(root)},"arrays":{${layoutArrays.join(',')}},"histories":${JSON.stringify(layoutHistories)}}`;
    put('layout', layout);
    this.commit(puts, removes);
    for (const key of removes) if (!puts.has(key)) this.cached.delete(key);
    for (const [key, text] of puts) this.cached.set(key, text);
    this.parts = parts;
    return puts.size + removes.length;
  }
  private collection(
    field: string,
    value: unknown[],
    old: Part | undefined,
    stale: Set<number> | undefined,
    put: (key: string, text: string) => void,
    removes: string[],
  ): Part {
    const oldKeys = old?.keys || [],
      oldEntries = old?.entries || [];
    // Rows before `same` hold the same objects as last time, so their keys and positions are unchanged.
    let same = 0;
    const limit = Math.min(oldEntries.length, value.length);
    while (same < limit && oldEntries[same] === value[same]) same++;
    const hot = value.length <= SMALL_COLLECTION ? 0 : value.length - HOT_TAIL,
      json = old ? old.json.slice(0, same) : [],
      wasLive = old?.live,
      liveNow = new Set<number>();
    // Unchanged positions still need text when they are hot, running or found edited in place.
    const refresh = (i: number) => {
      const text = JSON.stringify(value[i]);
      json[i] = text;
      put(oldKeys[i], text);
    };
    for (let i = Math.max(0, Math.min(hot, same)); i < same; i++) refresh(i);
    for (let i = 0; i < same; i++) {
      const running = live(value[i]);
      if (running) liveNow.add(i);
      if (i < hot && (running || stale?.has(i) || wasLive?.has(i) || this.touched.has(value[i] as object))) refresh(i);
    }
    if (same === value.length && same === oldKeys.length && old) {
      return { keys: oldKeys, entries: oldEntries, json, index: old.index, keysJson: old.keysJson, live: liveNow };
    }
    // Rows from `same` on were inserted, removed, replaced or moved: key them again, and reuse the stored text
    // of an entry that only moved.
    const keys = oldKeys.slice(0, same),
      entries = value.slice(),
      index = new Map(old?.index),
      oldTail = new Map<string, number>();
    for (let i = same; i < oldKeys.length; i++) {
      oldTail.set(oldKeys[i], i);
      index.delete(oldKeys[i]);
    }
    const kept = new Set<string>();
    for (let i = same; i < value.length; i++) {
      const entry = value[i];
      let key = idKey(field, entry) ?? indexKey(field, i);
      if (index.has(key)) key = indexKey(field, i);
      index.set(key, i);
      keys.push(key);
      const from = oldTail.get(key),
        running = live(entry);
      if (from !== undefined) kept.add(key);
      if (running) liveNow.add(i);
      const text =
        from !== undefined &&
        oldEntries[from] === entry &&
        !stale?.has(from) &&
        !this.touched.has(entry as object) &&
        !wasLive?.has(from) &&
        i < hot &&
        !running
          ? old!.json[from]
          : JSON.stringify(entry);
      json[i] = text;
      put(key, text);
    }
    for (const key of oldTail.keys()) if (!kept.has(key)) removes.push(key);
    return { keys, entries, json, index, keysJson: JSON.stringify(keys), live: liveNow };
  }
  private history(
    prefix: string,
    history: unknown[],
    old: Part | undefined,
    stale: Set<number> | undefined,
    put: (key: string, text: string) => void,
    removes: string[],
  ): Part {
    const oldEntries = old?.entries || [];
    let same = 0;
    const limit = Math.min(oldEntries.length, history.length);
    while (same < limit && oldEntries[same] === history[same]) same++;
    const hot = history.length - HOT_TAIL,
      keys = old ? old.keys.slice(0, Math.min(old.keys.length, history.length)) : [],
      json = old ? old.json.slice(0, same) : [];
    for (let i = 0; i < history.length; i++) {
      if (i < same && i < hot && !stale?.has(i)) continue;
      const key = keys[i] ?? prefix + i + ']',
        text = JSON.stringify(history[i]);
      keys[i] = key;
      json[i] = text;
      put(key, text);
    }
    for (let i = history.length; i < (old?.keys.length || 0); i++) removes.push(old!.keys[i]);
    return { keys, entries: history.slice(), json };
  }
  private commit(puts: Map<string, string>, removes: string[]) {
    if (!puts.size && !removes.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of puts) this.putRow.run(key, value);
      for (const key of removes) if (!puts.has(key)) this.removeRow.run(key);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private scheduleSweep() {
    if (this.sweepTimer) {
      this.sweepAgain = true;
      return;
    }
    this.sweepTimer = setTimeout(() => this.sweep(), Math.max(0, this.lastSweep + SWEEP_INTERVAL_MS - Date.now()));
    this.sweepTimer.unref?.();
  }
  /** Compares every reused row with its entry, a few milliseconds at a time, and reports rows edited in place. */
  private sweep() {
    this.lastSweep = Date.now();
    this.sweepAgain = false;
    const parts = [...(this.parts || [])],
      edited: object[] = [];
    let p = 0,
      i = 0;
    const step = () => {
      this.sweepTimer = undefined;
      if (!this.db.isOpen) return;
      const until = performance.now() + SWEEP_SLICE_MS;
      while (p < parts.length && performance.now() < until) {
        const [id, part] = parts[p];
        for (const end = Math.min(part.entries.length, i + 32); i < end; i++) {
          const entry = part.entries[i];
          if (
            entry !== null &&
            typeof entry === 'object' &&
            this.parts?.get(id) === part &&
            JSON.stringify(entry) !== part.json[i]
          ) {
            let marks = this.stale.get(id);
            if (!marks) this.stale.set(id, (marks = new Set()));
            marks.add(i);
            edited.push(entry);
          }
        }
        if (i >= part.entries.length) {
          p++;
          i = 0;
        }
      }
      if (p < parts.length) {
        this.sweepTimer = setTimeout(step, SWEEP_PAUSE_MS);
        this.sweepTimer.unref?.();
      } else if (this.stale.size) this.onStale?.(edited);
      else if (this.sweepAgain) this.scheduleSweep();
    };
    step();
  }
  close() {
    clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
    if (this.db.isOpen) this.db.close();
  }
}
