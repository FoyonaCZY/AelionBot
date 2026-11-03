import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type {
  MemoryEpisode,
  MemoryEvent,
  MemoryItem,
  MemoryJob,
  MemoryJobKind,
  MemoryKind,
  MemorySource,
  MemoryStatus,
} from '../../../shared/types/memory-types';
import { anyOf, searchTokens, signature, signatureSimilarity } from './memory-text';

type MemoryActor = MemoryEvent['actor'];
export interface ItemInput {
  scope: string;
  kind: MemoryKind;
  text: string;
  cues?: string[];
  entities?: string[];
  origin: MemoryItem['origin'];
  confidence?: number;
  sensitivity?: MemoryItem['sensitivity'];
  status?: MemoryStatus;
  pinned?: boolean;
  validFrom?: string;
  validUntil?: string;
  verifiedAt?: string;
  supersedes?: string;
  authorBot?: string;
  speaker?: string;
  note?: string;
  sources?: MemorySource[];
  recordedAt?: string;
}
export interface Change {
  actor: MemoryActor;
  runId?: string;
  jobId?: string;
}
interface Suggestion {
  scope?: string;
  reason?: string;
}
export type StoredItem = MemoryItem & { coreRank?: number; suggest?: Suggestion };
export interface FtsHit {
  owner: string;
  kind: 'item' | 'episode';
  scope: string;
  rank: number;
}

const json = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
const optional = (value: unknown) => (value === null || value === undefined ? undefined : String(value));
const now = () => new Date().toISOString();
export const shortId = (id: string) => id.replace(/-/g, '').slice(0, 6);

function itemRow(row: Record<string, unknown>): StoredItem {
  return {
    id: String(row.id),
    scope: String(row.scope),
    kind: row.kind as MemoryKind,
    text: String(row.text),
    cues: json(row.cues, []),
    entities: json(row.entities, []),
    origin: row.origin as MemoryItem['origin'],
    confidence: Number(row.confidence),
    sensitivity: row.sensitivity as MemoryItem['sensitivity'],
    status: row.status as MemoryStatus,
    pinned: Boolean(row.pinned),
    validFrom: optional(row.valid_from),
    validUntil: optional(row.valid_until),
    verifiedAt: optional(row.verified_at),
    recordedAt: String(row.recorded_at),
    updatedAt: String(row.updated_at),
    supersedes: optional(row.supersedes),
    supersededBy: optional(row.superseded_by),
    confirmations: Number(row.confirmations),
    recallCount: Number(row.recall_count),
    lastRecalledAt: optional(row.last_recalled_at),
    authorBot: optional(row.author_bot),
    speaker: optional(row.speaker),
    note: optional(row.note),
    sources: json(row.sources, []),
    ...(row.core_rank === null || row.core_rank === undefined ? {} : { coreRank: Number(row.core_rank) }),
    ...(row.suggest ? { suggest: json<Suggestion>(row.suggest, {}) } : {}),
  };
}
function episodeRow(row: Record<string, unknown>): MemoryEpisode {
  return {
    id: String(row.id),
    botId: String(row.bot_id),
    scope: String(row.scope),
    conversation: String(row.conversation),
    title: String(row.title),
    summary: String(row.summary),
    outcome: row.outcome as MemoryEpisode['outcome'],
    pending: json(row.pending, []),
    entities: json(row.entities, []),
    origin: row.origin as MemoryEpisode['origin'],
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    firstMessage: optional(row.first_message),
    lastMessage: optional(row.last_message),
  };
}
const ITEM_COLUMNS = [
  'id',
  'scope',
  'kind',
  'text',
  'cues',
  'entities',
  'origin',
  'confidence',
  'sensitivity',
  'status',
  'pinned',
  'valid_from',
  'valid_until',
  'verified_at',
  'recorded_at',
  'updated_at',
  'supersedes',
  'superseded_by',
  'confirmations',
  'recall_count',
  'last_recalled_at',
  'author_bot',
  'speaker',
  'note',
  'core_rank',
  'suggest',
  'sources',
] as const;
function itemValues(item: StoredItem) {
  return [
    item.id,
    item.scope,
    item.kind,
    item.text,
    JSON.stringify(item.cues),
    JSON.stringify(item.entities),
    item.origin,
    item.confidence,
    item.sensitivity,
    item.status,
    item.pinned ? 1 : 0,
    item.validFrom ?? null,
    item.validUntil ?? null,
    item.verifiedAt ?? null,
    item.recordedAt,
    item.updatedAt,
    item.supersedes ?? null,
    item.supersededBy ?? null,
    item.confirmations,
    item.recallCount,
    item.lastRecalledAt ?? null,
    item.authorBot ?? null,
    item.speaker ?? null,
    item.note ?? null,
    item.coreRank ?? null,
    item.suggest ? JSON.stringify(item.suggest) : null,
    JSON.stringify(item.sources),
  ];
}
const unique = (values: string[], limit: number) =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, limit);
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32);

/**
 * The tables of long-term memory, in the same database as the history index. Every change to an item is recorded
 * as an event holding the whole item before and after, so a consolidation can be undone by replaying them.
 */
export class MemoryStore {
  private depth = 0;
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS mem_items(${ITEM_COLUMNS.map((column) =>
      column === 'id' ? 'id TEXT PRIMARY KEY' : column,
    ).join(',')});
      CREATE INDEX IF NOT EXISTS mem_items_scope ON mem_items(scope,status);
      CREATE TABLE IF NOT EXISTS mem_events(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT,actor TEXT NOT NULL,run_id TEXT,job_id TEXT,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mem_events_item ON mem_events(item_id,at);
      CREATE INDEX IF NOT EXISTS mem_events_job ON mem_events(job_id);
      CREATE TABLE IF NOT EXISTS mem_episodes(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,scope TEXT NOT NULL,conversation TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,outcome TEXT NOT NULL,pending TEXT NOT NULL,entities TEXT NOT NULL,cues TEXT NOT NULL,origin TEXT NOT NULL,started_at TEXT NOT NULL,ended_at TEXT NOT NULL,first_message TEXT,last_message TEXT,source_key TEXT);
      CREATE INDEX IF NOT EXISTS mem_episodes_bot ON mem_episodes(bot_id,ended_at);
      CREATE UNIQUE INDEX IF NOT EXISTS mem_episodes_source ON mem_episodes(source_key);
      CREATE TABLE IF NOT EXISTS mem_cursors(conversation TEXT PRIMARY KEY,bot_id TEXT NOT NULL,through_time TEXT NOT NULL,through_id TEXT,failures INTEGER NOT NULL,retry_at TEXT,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mem_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,target TEXT NOT NULL,label TEXT,status TEXT NOT NULL,detail TEXT,changes INTEGER NOT NULL,input_tokens INTEGER,output_tokens INTEGER,started_at TEXT NOT NULL,ended_at TEXT);
      CREATE INDEX IF NOT EXISTS mem_jobs_time ON mem_jobs(started_at);
      CREATE TABLE IF NOT EXISTS mem_tombstones(scope TEXT NOT NULL,sig BLOB NOT NULL,vec BLOB,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mem_vectors(owner TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,model TEXT NOT NULL,hash TEXT NOT NULL,vec BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS mem_scopes(scope TEXT PRIMARY KEY,label TEXT NOT NULL,detail TEXT,updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(owner UNINDEXED,kind UNINDEXED,scope UNINDEXED,tokens,tokenize='porter unicode61 remove_diacritics 2');`);
  }
  // Items

  get(id: string): StoredItem | undefined {
    const row = this.db.prepare('SELECT * FROM mem_items WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? itemRow(row) : undefined;
  }
  /** Finds an item by its full ID or by the short ID shown to models, among the given scopes. */
  resolve(reference: string, scopes: string[]): StoredItem | undefined {
    const value = reference.trim().replace(/^#/, '').toLowerCase();
    if (!value) return undefined;
    const exact = this.get(value);
    if (exact) return scopes.includes(exact.scope) && exact.status !== 'deleted' ? exact : undefined;
    if (value.length < 4 || !/^[0-9a-f]+$/.test(value)) return undefined;
    const matches = this.list({ scopes, statuses: ['active', 'candidate', 'archived'] }).filter((item) =>
      item.id.replace(/-/g, '').startsWith(value),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  list(filter: { scopes?: string[]; statuses?: MemoryStatus[]; kinds?: MemoryKind[]; limit?: number } = {}) {
    const where: string[] = [],
      params: Array<string | number> = [];
    if (filter.scopes) {
      if (!filter.scopes.length) return [];
      where.push(`scope IN (${filter.scopes.map(() => '?').join(',')})`);
      params.push(...filter.scopes);
    }
    if (filter.statuses) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    if (filter.kinds) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`);
      params.push(...filter.kinds);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM mem_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY recorded_at,id${filter.limit ? ' LIMIT ' + Math.floor(filter.limit) : ''}`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(itemRow);
  }
  count(scope: string, statuses: MemoryStatus[] = ['active']) {
    return Number(
      (
        this.db
          .prepare(
            `SELECT count(*) n FROM mem_items WHERE scope=? AND status IN (${statuses.map(() => '?').join(',')})`,
          )
          .get(scope, ...statuses) as { n: number }
      ).n,
    );
  }
  scopesInUse() {
    return (
      this.db
        .prepare(`SELECT scope,count(*) n FROM mem_items WHERE status IN ('active','candidate') GROUP BY scope`)
        .all() as Array<{ scope: string; n: number }>
    ).map((row) => ({ scope: row.scope, count: Number(row.n) }));
  }
  pending() {
    return (
      this.db
        .prepare(
          `SELECT * FROM mem_items WHERE status='candidate' OR (status='active' AND suggest IS NOT NULL) ORDER BY updated_at DESC`,
        )
        .all() as Array<Record<string, unknown>>
    ).map(itemRow);
  }
  /** Runs `work` in one transaction; nested calls join the outer one. */
  transaction<T>(work: () => T): T {
    // Inside a caller's own transaction, as when a Bot's whole record is cleared.
    if (this.db.isTransaction && !this.depth) return work();
    if (this.depth) {
      this.depth++;
      try {
        return work();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
    }
  }
  create(input: ItemInput, change: Change): StoredItem {
    const at = now(),
      item: StoredItem = {
        id: randomUUID(),
        scope: input.scope,
        kind: input.kind,
        text: input.text.trim(),
        cues: unique(input.cues || [], 16),
        entities: unique(input.entities || [], 12),
        origin: input.origin,
        confidence: Math.max(0, Math.min(1, input.confidence ?? 0.8)),
        sensitivity: input.sensitivity || 'normal',
        status: input.status || 'active',
        pinned: Boolean(input.pinned),
        ...(input.validFrom ? { validFrom: input.validFrom } : {}),
        ...(input.validUntil ? { validUntil: input.validUntil } : {}),
        ...(input.verifiedAt ? { verifiedAt: input.verifiedAt } : {}),
        recordedAt: input.recordedAt || at,
        updatedAt: at,
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
        confirmations: 1,
        recallCount: 0,
        ...(input.authorBot ? { authorBot: input.authorBot } : {}),
        ...(input.speaker ? { speaker: input.speaker } : {}),
        ...(input.note ? { note: input.note } : {}),
        sources: (input.sources || []).slice(0, 12),
      };
    return this.transaction(() => {
      this.db
        .prepare(`INSERT INTO mem_items(${ITEM_COLUMNS.join(',')}) VALUES(${ITEM_COLUMNS.map(() => '?').join(',')})`)
        .run(...itemValues(item));
      this.index(item);
      this.event(item.id, 'create', undefined, item, change);
      return item;
    });
  }
  /** Writes a changed copy of an item. `action` names the change in its history. */
  save(next: StoredItem, action: string, change: Change, touch = true): StoredItem {
    const before = this.get(next.id);
    if (!before) throw new Error('记忆不存在');
    const item: StoredItem = { ...next, updatedAt: touch ? now() : next.updatedAt };
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE mem_items SET ${ITEM_COLUMNS.slice(1)
            .map((column) => column + '=?')
            .join(',')} WHERE id=?`,
        )
        .run(...itemValues(item).slice(1), item.id);
      if (item.status === 'deleted') this.unindex(item.id);
      else if (before.text !== item.text || before.scope !== item.scope || before.cues.join() !== item.cues.join())
        this.index(item);
      this.event(item.id, action, before, item, change);
      return item;
    });
  }
  update(id: string, patch: Partial<StoredItem>, action: string, change: Change) {
    const item = this.get(id);
    if (!item) throw new Error('记忆不存在');
    return this.save({ ...item, ...patch, id }, action, change);
  }
  /** Replaces an item with a new one that points back to it; the old one stays in history, out of use. */
  supersede(oldId: string, input: ItemInput, change: Change) {
    return this.transaction(() => {
      const old = this.get(oldId);
      if (!old) throw new Error('记忆不存在');
      const next = this.create({ ...input, supersedes: old.id, pinned: input.pinned ?? old.pinned }, change);
      this.save({ ...old, status: 'superseded', supersededBy: next.id }, 'supersede', change);
      return next;
    });
  }
  /**
   * Forgets an item: its text leaves the item, its history and the index, and a signature that cannot be read
   * back keeps it from being learned again.
   */
  forget(id: string, change: Change, vector?: Float32Array) {
    return this.transaction(() => {
      const item = this.get(id);
      if (!item) return undefined;
      if (item.text)
        this.db
          .prepare('INSERT INTO mem_tombstones VALUES(?,?,?,?)')
          .run(item.scope, signature(item.text), vector ? Buffer.from(vector.buffer) : null, now());
      const blank = { text: '', cues: [], entities: [], sources: [], note: undefined, suggest: undefined };
      this.db
        .prepare(
          "UPDATE mem_items SET status='deleted',text='',cues='[]',entities='[]',sources='[]',note=NULL,suggest=NULL,updated_at=? WHERE id=?",
        )
        .run(now(), id);
      // Earlier versions of the text live on in this item's history and in the items it replaced.
      const chain = [id];
      for (let previous = item.supersedes; previous && chain.length < 50;) {
        chain.push(previous);
        previous = this.get(previous)?.supersedes;
      }
      for (const itemId of chain)
        this.db
          .prepare(
            `UPDATE mem_events SET before_json=CASE WHEN before_json IS NULL THEN NULL ELSE '{"forgotten":true}' END,after_json=CASE WHEN after_json IS NULL THEN NULL ELSE '{"forgotten":true}' END WHERE item_id=?`,
          )
          .run(itemId);
      for (const itemId of chain.slice(1)) {
        const previous = this.get(itemId);
        if (previous?.status === 'superseded') {
          if (previous.text)
            this.db
              .prepare('INSERT INTO mem_tombstones VALUES(?,?,?,?)')
              .run(previous.scope, signature(previous.text), null, now());
          this.db
            .prepare(
              "UPDATE mem_items SET status='deleted',text='',cues='[]',entities='[]',sources='[]',note=NULL WHERE id=?",
            )
            .run(itemId);
          this.unindex(itemId);
          this.db.prepare('DELETE FROM mem_vectors WHERE owner=?').run(itemId);
        }
      }
      this.unindex(id);
      this.db.prepare('DELETE FROM mem_vectors WHERE owner=?').run(id);
      this.event(id, 'forget', undefined, { ...item, ...blank, status: 'deleted' }, change, false);
      return item;
    });
  }
  /** A forgotten text, or a close rewording of it, in this scope. */
  tombstoned(scope: string, text: string, vector?: Float32Array, threshold = 0.6) {
    const sig = signature(text);
    for (const row of this.db.prepare('SELECT sig,vec FROM mem_tombstones WHERE scope=?').all(scope) as Array<{
      sig: Uint8Array;
      vec: Uint8Array | null;
    }>) {
      if (signatureSimilarity(sig, row.sig) >= threshold) return true;
      if (vector && row.vec) {
        const other = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
        if (other.length === vector.length && vector.reduce((sum, value, i) => sum + value * other[i], 0) >= 0.92)
          return true;
      }
    }
    return false;
  }
  recalled(ids: string[], at = now()) {
    const update = this.db.prepare(
      'UPDATE mem_items SET recall_count=recall_count+1,last_recalled_at=? WHERE id=? AND status<>?',
    );
    for (const id of ids) update.run(at, id, 'deleted');
  }
  // History of changes

  private event(
    itemId: string,
    action: string,
    before: StoredItem | undefined,
    after: StoredItem | undefined,
    change: Change,
    keepText = true,
  ) {
    const strip = (item?: StoredItem) => (item ? JSON.stringify(keepText ? item : { ...item, text: '' }) : null);
    this.db
      .prepare('INSERT INTO mem_events VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        itemId,
        action,
        strip(before),
        strip(after),
        change.actor,
        change.runId ?? null,
        change.jobId ?? null,
        now(),
      );
  }
  events(filter: { itemId?: string; jobId?: string; limit?: number }): MemoryEvent[] {
    const rows = (
      filter.itemId
        ? this.db
            .prepare('SELECT * FROM mem_events WHERE item_id=? ORDER BY at DESC,rowid DESC LIMIT ?')
            .all(filter.itemId, filter.limit || 50)
        : this.db.prepare('SELECT * FROM mem_events WHERE job_id=? ORDER BY at,rowid').all(filter.jobId ?? '')
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      itemId: String(row.item_id),
      action: String(row.action),
      ...(row.before_json ? { before: json(row.before_json, {}) } : {}),
      ...(row.after_json ? { after: json(row.after_json, {}) } : {}),
      actor: row.actor as MemoryActor,
      ...(row.run_id ? { runId: String(row.run_id) } : {}),
      ...(row.job_id ? { jobId: String(row.job_id) } : {}),
      at: String(row.at),
    }));
  }
  /**
   * Restores every item a job changed to how it was before, newest change first. An item changed again since
   * then is left as it is, so a later correction is never undone by accident. Returns the items restored.
   */
  undoJob(jobId: string, change: Change) {
    return this.transaction(() => {
      // Newest first: restoring each event's earlier state in turn ends at the state before the job.
      const events = this.events({ jobId }).reverse(),
        restored = new Set<string>(),
        skipped = new Set<string>();
      const lastByItem = new Map<string, MemoryEvent>();
      for (const event of events) if (!lastByItem.has(event.itemId)) lastByItem.set(event.itemId, event);
      for (const event of events) {
        if (skipped.has(event.itemId)) continue;
        const current = this.get(event.itemId);
        if (!current) continue;
        const last = lastByItem.get(event.itemId)!;
        if (!restored.has(event.itemId) && (last.after as StoredItem | undefined)?.updatedAt !== current.updatedAt) {
          skipped.add(event.itemId);
          continue;
        }
        const before = event.before as StoredItem | undefined;
        if (before && (before as unknown as { forgotten?: boolean }).forgotten) continue;
        if (before) this.save(before, 'undo', change, false);
        else this.save({ ...current, status: 'deleted' }, 'undo', change);
        restored.add(event.itemId);
      }
      this.db.prepare("UPDATE mem_jobs SET status='undone' WHERE id=?").run(jobId);
      return { restored: restored.size, skipped: skipped.size };
    });
  }
  // Search index

  private index(item: StoredItem) {
    this.unindex(item.id);
    if (item.status === 'deleted' || !item.text) return;
    this.db
      .prepare('INSERT INTO mem_fts VALUES(?,?,?,?)')
      .run(item.id, 'item', item.scope, searchTokens([item.text, ...item.cues, ...item.entities].join('\n')).join(' '));
  }
  private unindex(owner: string) {
    this.db.prepare('DELETE FROM mem_fts WHERE owner=?').run(owner);
  }
  /** Items and episodes matching any token, best first, within the scopes. */
  searchIndex(tokens: string[], scopes: string[], kinds: Array<'item' | 'episode'>, limit = 60): FtsHit[] {
    if (!tokens.length || !scopes.length) return [];
    return (
      this.db
        .prepare(
          `SELECT owner,kind,scope,rank FROM mem_fts WHERE mem_fts MATCH ? AND scope IN (${scopes.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY rank LIMIT ?`,
        )
        .all(anyOf(tokens), ...scopes, ...kinds, limit) as Array<Record<string, unknown>>
    ).map((row) => ({
      owner: String(row.owner),
      kind: row.kind as 'item' | 'episode',
      scope: String(row.scope),
      rank: Number(row.rank),
    }));
  }
  /** Which of the given owners contain the token, and in how many entries of the scopes it appears. */
  tokenMatches(token: string, scopes: string[], kinds: Array<'item' | 'episode'>) {
    const owners = new Set(
      (
        this.db
          .prepare(
            `SELECT owner FROM mem_fts WHERE mem_fts MATCH ? AND scope IN (${scopes.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')}) LIMIT 2000`,
          )
          .all(anyOf([token]), ...scopes, ...kinds) as Array<{ owner: string }>
      ).map((row) => row.owner),
    );
    return owners;
  }
  indexedCount(scopes: string[], kinds: Array<'item' | 'episode'>) {
    if (!scopes.length) return 0;
    return Number(
      (
        this.db
          .prepare(
            `SELECT count(*) n FROM mem_fts WHERE scope IN (${scopes.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')})`,
          )
          .get(...scopes, ...kinds) as { n: number }
      ).n,
    );
  }
  // Episodes

  addEpisode(input: Omit<MemoryEpisode, 'id'> & { cues?: string[]; sourceKey?: string }) {
    if (input.sourceKey && this.db.prepare('SELECT 1 FROM mem_episodes WHERE source_key=?').get(input.sourceKey))
      return undefined;
    const episode: MemoryEpisode = {
      id: randomUUID(),
      botId: input.botId,
      scope: input.scope,
      conversation: input.conversation,
      title: input.title.trim().slice(0, 120),
      summary: input.summary.trim().slice(0, 1200),
      outcome: input.outcome,
      pending: unique(input.pending, 6).map((value) => value.slice(0, 200)),
      entities: unique(input.entities, 12),
      origin: input.origin,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      ...(input.firstMessage ? { firstMessage: input.firstMessage } : {}),
      ...(input.lastMessage ? { lastMessage: input.lastMessage } : {}),
    };
    const cues = unique(input.cues || [], 16);
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO mem_episodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          episode.id,
          episode.botId,
          episode.scope,
          episode.conversation,
          episode.title,
          episode.summary,
          episode.outcome,
          JSON.stringify(episode.pending),
          JSON.stringify(episode.entities),
          JSON.stringify(cues),
          episode.origin,
          episode.startedAt,
          episode.endedAt,
          episode.firstMessage ?? null,
          episode.lastMessage ?? null,
          input.sourceKey ?? null,
        );
      this.db
        .prepare('INSERT INTO mem_fts VALUES(?,?,?,?)')
        .run(
          episode.id,
          'episode',
          episode.scope,
          searchTokens(
            [episode.title, episode.summary, ...episode.pending, ...episode.entities, ...cues].join('\n'),
          ).join(' '),
        );
    });
    return episode;
  }
  episode(id: string) {
    const row = this.db.prepare('SELECT * FROM mem_episodes WHERE id=?').get(id) as Record<string, unknown> | undefined;
    return row ? episodeRow(row) : undefined;
  }
  episodes(filter: {
    botId?: string;
    scopes?: string[];
    conversation?: string;
    before?: string;
    since?: string;
    limit?: number;
  }) {
    const where: string[] = [],
      params: string[] = [];
    if (filter.botId) {
      where.push('bot_id=?');
      params.push(filter.botId);
    }
    if (filter.scopes) {
      if (!filter.scopes.length) return [];
      where.push(`scope IN (${filter.scopes.map(() => '?').join(',')})`);
      params.push(...filter.scopes);
    }
    if (filter.conversation) {
      where.push('conversation=?');
      params.push(filter.conversation);
    }
    if (filter.before) {
      where.push('ended_at<?');
      params.push(filter.before);
    }
    if (filter.since) {
      where.push('ended_at>=?');
      params.push(filter.since);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM mem_episodes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ended_at DESC LIMIT ?`,
        )
        .all(...params, filter.limit || 30) as Array<Record<string, unknown>>
    ).map(episodeRow);
  }
  deleteEpisode(id: string) {
    this.db.prepare('DELETE FROM mem_episodes WHERE id=?').run(id);
    this.unindex(id);
    this.db.prepare('DELETE FROM mem_vectors WHERE owner=?').run(id);
  }
  // Capture progress, per conversation

  cursor(conversation: string) {
    return this.db.prepare('SELECT * FROM mem_cursors WHERE conversation=?').get(conversation) as
      { through_time: string; through_id: string | null; failures: number; retry_at: string | null } | undefined;
  }
  setCursor(conversation: string, botId: string, throughTime: string, throughId?: string) {
    this.db
      .prepare(
        'INSERT INTO mem_cursors VALUES(?,?,?,?,0,NULL,?) ON CONFLICT(conversation) DO UPDATE SET through_time=excluded.through_time,through_id=excluded.through_id,failures=0,retry_at=NULL,updated_at=excluded.updated_at',
      )
      .run(conversation, botId, throughTime, throughId ?? null, now());
  }
  /** Backs off a conversation whose capture failed: 2, 4, 8… minutes, at most 6 hours. */
  failCursor(conversation: string, botId: string, fallbackTime: string) {
    const current = this.cursor(conversation),
      failures = (current?.failures || 0) + 1,
      retry = new Date(Date.now() + Math.min(360, 2 ** failures) * 60000).toISOString();
    this.db
      .prepare(
        'INSERT INTO mem_cursors VALUES(?,?,?,NULL,?,?,?) ON CONFLICT(conversation) DO UPDATE SET failures=excluded.failures,retry_at=excluded.retry_at,updated_at=excluded.updated_at',
      )
      .run(conversation, botId, current?.through_time || fallbackTime, failures, retry, now());
    return failures;
  }
  // Job log

  startJob(kind: MemoryJobKind, target: string, label?: string) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO mem_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, kind, target, label ?? null, 'running', null, 0, null, null, now(), null);
    return id;
  }
  endJob(
    id: string,
    status: MemoryJob['status'],
    detail = '',
    changes = 0,
    usage?: { input?: number; output?: number },
  ) {
    this.db
      .prepare('UPDATE mem_jobs SET status=?,detail=?,changes=?,input_tokens=?,output_tokens=?,ended_at=? WHERE id=?')
      .run(status, detail.slice(0, 300), changes, usage?.input ?? null, usage?.output ?? null, now(), id);
  }
  jobs(limit = 30, since?: string): MemoryJob[] {
    return (
      (since
        ? this.db
            .prepare('SELECT * FROM mem_jobs WHERE started_at>=? ORDER BY started_at DESC LIMIT ?')
            .all(since, limit)
        : this.db.prepare('SELECT * FROM mem_jobs ORDER BY started_at DESC LIMIT ?').all(limit)) as Array<
        Record<string, unknown>
      >
    ).map((row) => ({
      id: String(row.id),
      kind: row.kind as MemoryJobKind,
      target: String(row.target),
      ...(row.label ? { label: String(row.label) } : {}),
      status: row.status as MemoryJob['status'],
      ...(row.detail ? { detail: String(row.detail) } : {}),
      changes: Number(row.changes),
      ...(row.input_tokens === null ? {} : { inputTokens: Number(row.input_tokens) }),
      ...(row.output_tokens === null ? {} : { outputTokens: Number(row.output_tokens) }),
      startedAt: String(row.started_at),
      ...(row.ended_at ? { endedAt: String(row.ended_at) } : {}),
    }));
  }
  /** Jobs left running by a previous process are recorded as interrupted. */
  recoverJobs() {
    this.db
      .prepare("UPDATE mem_jobs SET status='failed',detail='应用退出时中断',ended_at=? WHERE status='running'")
      .run(now());
  }
  // Scope labels

  label(scope: string) {
    return (this.db.prepare('SELECT label FROM mem_scopes WHERE scope=?').get(scope) as { label: string } | undefined)
      ?.label;
  }
  setLabel(scope: string, label: string, detail?: string) {
    this.db
      .prepare(
        "INSERT INTO mem_scopes VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET label=excluded.label,detail=excluded.detail,updated_at=excluded.updated_at WHERE label<>excluded.label OR IFNULL(detail,'')<>IFNULL(excluded.detail,'')",
      )
      .run(scope, label, detail ?? null, now());
  }
  labels() {
    return this.db.prepare('SELECT scope,label,detail FROM mem_scopes').all() as Array<{
      scope: string;
      label: string;
      detail: string | null;
    }>;
  }
  // Vectors

  setVector(
    owner: string,
    kind: 'item' | 'episode' | 'message',
    scope: string,
    model: string,
    hash: string,
    vec: Float32Array,
  ) {
    this.db
      .prepare(
        'INSERT INTO mem_vectors VALUES(?,?,?,?,?,?) ON CONFLICT(owner) DO UPDATE SET kind=excluded.kind,scope=excluded.scope,model=excluded.model,hash=excluded.hash,vec=excluded.vec',
      )
      .run(owner, kind, scope, model, hash, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  }
  vectors(scopes: string[], model: string, kinds: Array<'item' | 'episode' | 'message'>) {
    if (!scopes.length) return [];
    return (
      this.db
        .prepare(
          `SELECT owner,kind,vec FROM mem_vectors WHERE model=? AND scope IN (${scopes.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')})`,
        )
        .all(model, ...scopes, ...kinds) as Array<{ owner: string; kind: string; vec: Uint8Array }>
    ).map((row) => ({
      owner: row.owner,
      kind: row.kind as 'item' | 'episode' | 'message',
      vec: new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4),
    }));
  }
  vectorHashes(model: string) {
    return new Map(
      (
        this.db.prepare('SELECT owner,hash FROM mem_vectors WHERE model=?').all(model) as Array<{
          owner: string;
          hash: string;
        }>
      ).map((row) => [row.owner, row.hash]),
    );
  }
  vectorCount(model: string) {
    return Number((this.db.prepare('SELECT count(*) n FROM mem_vectors WHERE model=?').get(model) as { n: number }).n);
  }
  dropVectors(owner: string) {
    this.db.prepare('DELETE FROM mem_vectors WHERE owner=?').run(owner);
  }
  dropOtherModels(model: string) {
    this.db.prepare('DELETE FROM mem_vectors WHERE model<>?').run(model);
  }
  // A Bot is deleted

  clearBot(botId: string) {
    this.transaction(() => {
      const scope = 'bot:' + botId;
      for (const { id } of this.db.prepare('SELECT id FROM mem_items WHERE scope=?').all(scope) as Array<{
        id: string;
      }>)
        this.unindex(id);
      this.db.prepare('DELETE FROM mem_events WHERE item_id IN (SELECT id FROM mem_items WHERE scope=?)').run(scope);
      this.db.prepare('DELETE FROM mem_items WHERE scope=?').run(scope);
      this.db.prepare('DELETE FROM mem_tombstones WHERE scope=?').run(scope);
      for (const { id } of this.db.prepare('SELECT id FROM mem_episodes WHERE bot_id=?').all(botId) as Array<{
        id: string;
      }>)
        this.deleteEpisode(id);
      this.db.prepare('DELETE FROM mem_cursors WHERE bot_id=?').run(botId);
      this.db.prepare('DELETE FROM mem_vectors WHERE scope=?').run(scope);
    });
  }
  /** Removes what a conversation produced: its episodes and its capture cursor. Facts learned from it remain. */
  clearConversation(conversation: string) {
    for (const { id } of this.db
      .prepare('SELECT id FROM mem_episodes WHERE conversation=?')
      .all(conversation) as Array<{
      id: string;
    }>)
      this.deleteEpisode(id);
    this.db.prepare('DELETE FROM mem_cursors WHERE conversation=?').run(conversation);
  }
}
