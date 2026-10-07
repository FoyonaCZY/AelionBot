import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../storage/store';
import type { ChatMessage } from '../../../shared/types/core';
import { excerpt, resultDigest } from '../context/context-budget';
import { AppError } from '../../../shared/errors';

export interface ContextHead {
  revision: number;
  through: number;
  summary: string;
  anchors: string[];
}
export interface MemoryFact {
  id: string;
  botId: string;
  target: 'memory' | 'user';
  content: string;
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
}
export interface ReviewJob {
  id: string;
  botId: string;
  runId: string;
  status: string;
  attempts: number;
  payload: any;
  createdAt: string;
  updatedAt: string;
  result?: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** What the history index holds of a message; its position is kept apart, so moving it does not re-index it. */
const historyStamp = (status: string | null | undefined, content: string, scope?: string | null) =>
  hash(`${scope ? scope + ':' : ''}${status || ''}:${content}`);
export const normalizedFact = (text: string) => text.trim().replace(/\s+/g, ' ');
export class CognitiveStore {
  readonly db: DatabaseSync;
  private synced = new Map<string, { stamp: string; seq: number }>();
  constructor(readonly store: Store) {
    mkdirSync(store.dir, { recursive: true });
    this.db = new DatabaseSync(join(store.dir, 'cognition.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,run_id TEXT,seq INTEGER NOT NULL,role TEXT NOT NULL,tool TEXT,status TEXT,content TEXT NOT NULL,stamp TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(id UNINDEXED,bot_id UNINDEXED,text,tokenize='trigram');
      CREATE TABLE IF NOT EXISTS context_heads(bot_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,through_seq INTEGER NOT NULL,summary TEXT NOT NULL,anchors TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_pruning(bot_id TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL,content TEXT NOT NULL,PRIMARY KEY(bot_id,scope,source));
      CREATE TABLE IF NOT EXISTS context_state(bot_id TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(bot_id,scope,kind));
      CREATE TABLE IF NOT EXISTS context_epochs(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,run_id TEXT NOT NULL,from_seq INTEGER NOT NULL,through_seq INTEGER NOT NULL,summary TEXT NOT NULL,anchors TEXT NOT NULL,source_hash TEXT NOT NULL,stats TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_attempts(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,run_id TEXT NOT NULL,response TEXT NOT NULL,issue TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_facts(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,target TEXT NOT NULL,content TEXT NOT NULL,source_refs TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_tombstones(bot_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(bot_id,fingerprint));
      CREATE TABLE IF NOT EXISTS knowledge_events(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,run_id TEXT,kind TEXT NOT NULL,action TEXT NOT NULL,before_text TEXT,after_text TEXT,source_refs TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_jobs(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,run_id TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL,payload TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,bot_id TEXT NOT NULL,role TEXT NOT NULL,tool TEXT,content TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_usage(id TEXT PRIMARY KEY,run_id TEXT,bot_id TEXT,task TEXT NOT NULL,model TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,estimated_tokens INTEGER,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_bot_seq ON history(bot_id,seq); CREATE INDEX IF NOT EXISTS review_pending ON review_jobs(status,created_at);`);
    // scope: empty for the private conversation, group:<id> for the Bot's own work records in that group.
    if (
      !(this.db.prepare('PRAGMA table_info(history)').all() as Array<{ name: string }>).some((c) => c.name === 'scope')
    )
      this.db.exec('ALTER TABLE history ADD COLUMN scope TEXT');
    this.db.prepare("UPDATE review_jobs SET status='queued' WHERE status='running'").run();
    // Stamps once included the message's position: one message moved or removed early in the list re-indexed every
    // later one, over a minute on a long profile, on the main process. Older stamps are converted once.
    if (this.get('history-stamp') !== '2') {
      const restamp = this.db.prepare('UPDATE history SET stamp=? WHERE id=?');
      this.db.exec('BEGIN');
      try {
        for (const row of this.db.prepare('SELECT id,status,content,scope FROM history').all() as Array<{
          id: string;
          status: string | null;
          content: string;
          scope: string | null;
        }>)
          restamp.run(historyStamp(row.status, row.content, row.scope), row.id);
        this.set('history-stamp', '2');
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    for (const row of this.db.prepare('SELECT id,seq,stamp FROM history').all() as Array<{
      id: string;
      seq: number;
      stamp: string;
    }>)
      this.synced.set(row.id, { stamp: row.stamp, seq: row.seq });
    for (const bot of store.data.bots)
      if (!this.get(`memory-migrated:${bot.id}`)) {
        // Only a Bot from before memory_facts holds its memories solely in state.json. A Bot created since then
        // already has its facts here and `bot.memories` is merely their mirror; importing it again duplicated them.
        if (!this.db.prepare('SELECT 1 FROM memory_facts WHERE bot_id=? LIMIT 1').get(bot.id)) {
          const seen = new Set<string>();
          for (const text of bot.memories) {
            const key = normalizedFact(text);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const now = new Date().toISOString();
            this.db
              .prepare('INSERT OR IGNORE INTO memory_facts VALUES(?,?,?,?,?,?,?)')
              .run(randomUUID(), bot.id, 'memory', text, '[]', now, now);
          }
        }
        this.set(`memory-migrated:${bot.id}`, '1');
      }
    this.dedupeMemories();
    for (const bot of store.data.bots)
      if (bot.contextResetAt && this.get('context-reset:' + bot.id) !== bot.contextResetAt) this.clearBot(bot.id);
    this.syncHistory();
  }
  /**
   * Removes repeated copies of a fact (same Bot and normalized text) that the old restart migration created.
   * Target is not part of the key: that migration imported user facts as 'memory' too, since the state.json
   * mirror flattens both. Keeps the copy with source references (and so its target), else the oldest;
   * idempotent, so it simply runs on every start.
   * Returns how many rows were removed; affected Bots get a new knowledge revision so stale reviews cannot apply.
   */
  dedupeMemories() {
    const rows = this.db
      .prepare('SELECT id,bot_id,target,content,source_refs FROM memory_facts ORDER BY created_at,id')
      .all() as Array<{ id: string; bot_id: string; target: string; content: string; source_refs: string }>;
    const keep = new Map<string, (typeof rows)[number]>(),
      remove: string[] = [],
      bots = new Set<string>();
    for (const row of rows) {
      const key = `${row.bot_id}\n${normalizedFact(row.content)}`,
        kept = keep.get(key);
      if (!kept) {
        keep.set(key, row);
        continue;
      }
      const sourced = (value: string) => value !== '[]' && value !== '';
      // Rows arrive oldest first, so a later copy only wins when it alone carries its sources.
      if (!sourced(kept.source_refs) && sourced(row.source_refs)) {
        remove.push(kept.id);
        keep.set(key, row);
      } else remove.push(row.id);
      bots.add(row.bot_id);
    }
    if (!remove.length) return 0;
    this.db.exec('BEGIN');
    try {
      const drop = this.db.prepare('DELETE FROM memory_facts WHERE id=?');
      for (const id of remove) drop.run(id);
      for (const botId of bots) this.bump(botId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return remove.length;
  }
  get(key: string) {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as any)?.value as string | undefined;
  }
  contextState(botId: string, scope: string, kind: string, value?: string): string | undefined {
    // A prepared group request may finish after its short-lived reader closes.
    // Reopen only this table connection, never run initialization/job recovery.
    const db = this.db.isOpen ? this.db : new DatabaseSync(join(this.store.dir, 'cognition.sqlite'));
    try {
      if (db !== this.db) db.exec('PRAGMA busy_timeout=5000');
      if (value !== undefined) {
        db.prepare(
          'INSERT INTO context_state VALUES(?,?,?,?) ON CONFLICT(bot_id,scope,kind) DO UPDATE SET value=excluded.value WHERE value<>excluded.value',
        ).run(botId, scope, kind, value);
        return value;
      }
      return (
        db
          .prepare('SELECT value FROM context_state WHERE bot_id=? AND scope=? AND kind=?')
          .get(botId, scope, kind) as any
      )?.value;
    } finally {
      if (db !== this.db) db.close();
    }
  }
  set(key: string, value: string) {
    this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  readContextPruning(botId: string, scope: string) {
    return new Map(
      (
        this.db
          .prepare('SELECT source,content FROM context_pruning WHERE bot_id=? AND scope=?')
          .all(botId, scope) as Array<{ source: string; content: string }>
      ).map((row) => [row.source, row.content]),
    );
  }
  writeContextPruning(botId: string, scope: string, entries: Map<string, string>) {
    this.db.exec('BEGIN');
    try {
      const previous = this.readContextPruning(botId, scope),
        remove = this.db.prepare('DELETE FROM context_pruning WHERE bot_id=? AND scope=? AND source=?'),
        save = this.db.prepare(
          'INSERT INTO context_pruning VALUES(?,?,?,?) ON CONFLICT(bot_id,scope,source) DO UPDATE SET content=excluded.content',
        );
      for (const key of previous.keys()) if (!entries.has(key)) remove.run(botId, scope, key);
      for (const [key, value] of entries) if (previous.get(key) !== value) save.run(botId, scope, key, value);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  revision(botId: string) {
    return Number(this.get(`knowledge-revision:${botId}`) || 0);
  }
  bump(botId: string) {
    const revision = this.revision(botId) + 1;
    this.set(`knowledge-revision:${botId}`, String(revision));
    return revision;
  }
  /**
   * What a Bot's history search covers: its private conversation, and its own work records in each group (scope
   * `group:<id>`). Positions (seq) count within each source.
   */
  private historyEntries(botId?: string) {
    const groupOf = new Map<string, string>();
    for (const run of this.store.data.runs) if (run.groupOrigin) groupOf.set(run.id, run.groupOrigin.groupId);
    const entries: Array<{ message: ChatMessage; seq: number; scope: string | null }> = [];
    this.store.data.messages.forEach((message, seq) => {
      if (!botId || message.botId === botId)
        entries.push({ message, seq, scope: message.sessionId ? 'session:' + message.sessionId : null });
    });
    this.store.data.groupRunMessages.forEach((message, seq) => {
      const group = message.runId ? groupOf.get(message.runId) : undefined;
      if (group && (!botId || message.botId === botId)) entries.push({ message, seq, scope: 'group:' + group });
    });
    return entries;
  }
  syncHistory(botId?: string) {
    const upsert = this.db.prepare(
      'INSERT INTO history(id,bot_id,run_id,seq,role,tool,status,content,stamp,scope) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,status=excluded.status,content=excluded.content,stamp=excluded.stamp,scope=excluded.scope',
    );
    const move = this.db.prepare('UPDATE history SET seq=? WHERE id=?'),
      remove = this.db.prepare('DELETE FROM history_fts WHERE id=?'),
      insert = this.db.prepare('INSERT INTO history_fts VALUES(?,?,?)'),
      deleteHistory = this.db.prepare('DELETE FROM history WHERE id=?');
    // The JSON store is authoritative: migration can move group runs out of private history.
    const entries = this.historyEntries(botId),
      current = new Set(entries.map((entry) => entry.message.id));
    const indexed = (
      botId
        ? this.db.prepare('SELECT id FROM history WHERE bot_id=?').all(botId)
        : this.db.prepare('SELECT id FROM history').all()
    ) as Array<{ id: string }>;
    this.db.exec('BEGIN');
    try {
      const indexedIds = new Set(indexed.map((row) => row.id));
      for (const { id } of indexed)
        if (!current.has(id)) {
          deleteHistory.run(id);
          remove.run(id);
          this.synced.delete(id);
        }
      for (const id of current) if (!indexedIds.has(id)) this.synced.delete(id);
      for (const { message, seq, scope } of entries) {
        const stamp = historyStamp(message.status, message.content, scope),
          known = this.synced.get(message.id);
        if (known?.stamp === stamp) {
          if (known.seq !== seq) {
            move.run(seq, message.id);
            known.seq = seq;
          }
          continue;
        }
        upsert.run(
          message.id,
          message.botId,
          message.runId || null,
          seq,
          message.role,
          message.tool || null,
          message.status || null,
          message.content,
          stamp,
          scope,
        );
        remove.run(message.id);
        insert.run(
          message.id,
          message.botId,
          `${message.tool || ''}\n${message.role === 'tool' ? resultDigest(message.content, 4000) : message.content}`,
        );
        this.synced.set(message.id, { stamp, seq });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.synced.clear();
      throw error;
    }
  }
  /** `here` is the conversation searching (null for the main chat): its records rank first among equals. */
  search(botId: string, query: string, limit = 8, here: string | null = null) {
    this.store.bot(botId);
    this.syncHistory(botId);
    query = query.trim().slice(0, 300);
    if (!query) throw new Error('请输入要查找的历史内容');
    limit = Math.max(1, Math.min(20, limit));
    // The trigram index cannot match terms shorter than three characters, which covers most Chinese words
    // ("压缩 失败"). Those terms use LIKE; results are merged and ranked by how many terms they contain.
    const terms = [...new Set(query.split(/\s+/).filter(Boolean))].slice(0, 12),
      long = terms.filter((term) => [...term].length >= 3),
      short = terms.filter((term) => [...term].length < 3);
    const found = new Map<string, any>(),
      pool = limit * 5;
    if (long.length)
      for (const row of this.db
        .prepare(
          'SELECT h.* FROM history_fts f JOIN history h ON h.id=f.id WHERE history_fts MATCH ? AND h.bot_id=? ORDER BY rank LIMIT ?',
        )
        .all(long.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR '), botId, pool) as any[])
        found.set(row.id, row);
    if (short.length)
      for (const row of this.db
        .prepare(
          `SELECT * FROM history WHERE bot_id=? AND (${short.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ')}) ORDER BY seq DESC LIMIT ?`,
        )
        .all(botId, ...short.map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`), pool) as any[])
        if (!found.has(row.id)) found.set(row.id, row);
    const score = (row: any) => {
      const text = String(row.content).toLowerCase();
      return terms.reduce((sum, term) => sum + (text.includes(term.toLowerCase()) ? 1 : 0), 0);
    };
    const rows = [...found.values()]
      .map((row, order) => ({ row, order, score: score(row) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number((b.row.scope ?? null) === here) - Number((a.row.scope ?? null) === here) ||
          a.order - b.order,
      )
      .slice(0, limit)
      .map((item) => item.row);
    return rows.map((row) => ({
      messageId: row.id,
      runId: row.run_id,
      role: row.role,
      tool: row.tool,
      time: this.historyTime(row.id),
      ...this.historySource(row.scope),
      excerpt: this.searchExcerpt(row.content, query),
    }));
  }
  private historyTime(id: string) {
    return (
      this.store.data.messages.find((message) => message.id === id) ||
      this.store.data.groupRunMessages.find((message) => message.id === id)
    )?.time;
  }
  /** Where a record comes from, for the model: the private conversation or its own work in a named group. */
  /** Where a record comes from, for the model: the main chat, one of the Bot's work sessions, or its work in a group. */
  private historySource(scope: string | null) {
    if (scope?.startsWith('session:')) {
      const id = scope.slice('session:'.length);
      return {
        source: 'session' as const,
        session: { id, name: this.store.data.workSessions?.find((s) => s.id === id)?.name },
      };
    }
    if (!scope?.startsWith('group:')) return { source: 'private' as const };
    const id = scope.slice('group:'.length);
    return { source: 'group' as const, group: { id, name: this.store.data.groups.find((g) => g.id === id)?.name } };
  }
  private searchExcerpt(content: string, query: string) {
    const at = content.toLowerCase().indexOf(query.toLowerCase());
    return at < 0 ? excerpt(content, 900) : content.slice(Math.max(0, at - 200), at + 700);
  }
  sourceMessage(botId: string, reference: string) {
    return this.store.data.messages.find(
      (message) =>
        message.botId === botId &&
        (message.id === reference ||
          (message.role === 'tool' &&
            (() => {
              try {
                return JSON.parse(message.content).resultId === reference;
              } catch {
                return false;
              }
            })())),
    );
  }
  readHistory(botId: string, id: string, before = 1, after = 1) {
    this.store.bot(botId);
    this.syncHistory(botId);
    const hit = this.db.prepare('SELECT seq,scope FROM history WHERE id=? AND bot_id=?').get(id, botId) as any;
    if (!hit) throw new AppError('memory.history_not_found', '历史记录不存在或无权访问');
    // Neighbours come from the same conversation: the private one, or the same group's work records.
    const rows = this.db
        .prepare('SELECT * FROM history WHERE bot_id=? AND scope IS ? ORDER BY seq')
        .all(botId, hit.scope ?? null) as any[],
      index = rows.findIndex((row) => row.id === id);
    return rows
      .slice(Math.max(0, index - Math.min(3, Math.max(0, before))), index + 1 + Math.min(3, Math.max(0, after)))
      .map((row) => ({
        messageId: row.id,
        runId: row.run_id,
        role: row.role,
        tool: row.tool,
        time: this.historyTime(row.id),
        ...this.historySource(row.scope),
        content: excerpt(row.content, 2200),
      }));
  }
  head(botId: string): ContextHead {
    const row = this.db.prepare('SELECT * FROM context_heads WHERE bot_id=?').get(botId) as any;
    return row
      ? { revision: row.revision, through: row.through_seq, summary: row.summary, anchors: JSON.parse(row.anchors) }
      : { revision: 0, through: 0, summary: '', anchors: [] };
  }
  contextAttempt(botId: string, runId: string, response: string, issue?: string) {
    this.db
      .prepare('INSERT INTO context_attempts VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), botId, runId, response, issue || null, new Date().toISOString());
  }
  commitEpoch(input: {
    headKey?: string;
    botId: string;
    runId: string;
    expectedRevision: number;
    from: number;
    through: number;
    summary: string;
    anchors: string[];
    sourceHash: string;
    stats: unknown;
  }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const head = this.head(input.headKey || input.botId);
      if (head.revision !== input.expectedRevision) throw new Error('压缩期间上下文版本发生变化');
      const id = randomUUID();
      this.db
        .prepare('INSERT INTO context_epochs VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          input.botId,
          input.runId,
          input.from,
          input.through,
          input.summary,
          JSON.stringify(input.anchors),
          input.sourceHash,
          JSON.stringify(input.stats),
          new Date().toISOString(),
        );
      this.db
        .prepare(
          'INSERT INTO context_heads VALUES(?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET revision=excluded.revision,through_seq=excluded.through_seq,summary=excluded.summary,anchors=excluded.anchors',
        )
        .run(
          input.headKey || input.botId,
          head.revision + 1,
          input.through,
          input.summary,
          JSON.stringify(input.anchors),
        );
      this.db.exec('COMMIT');
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  memories(botId: string): MemoryFact[] {
    this.store.bot(botId);
    return (
      this.db.prepare('SELECT * FROM memory_facts WHERE bot_id=? ORDER BY created_at,id').all(botId) as any[]
    ).map((row) => ({
      id: row.id,
      botId: row.bot_id,
      target: row.target,
      content: row.content,
      sourceRefs: JSON.parse(row.source_refs),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  audit(
    botId: string,
    runId: string,
    kind: string,
    action: string,
    before: string | undefined,
    after: string | undefined,
    refs: string[],
  ) {
    this.db
      .prepare('INSERT INTO knowledge_events VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        randomUUID(),
        botId,
        runId,
        kind,
        action,
        before || null,
        after || null,
        JSON.stringify(refs),
        new Date().toISOString(),
      );
  }
  enqueue(botId: string, runId: string, payload: unknown) {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE review_jobs SET status='superseded',updated_at=? WHERE bot_id=? AND status='queued'")
      .run(now, botId);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO review_jobs VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, botId, runId, 'queued', 0, JSON.stringify(payload), null, now, now);
    return id;
  }
  jobs(botId?: string): ReviewJob[] {
    const rows = (
      botId
        ? this.db.prepare('SELECT * FROM review_jobs WHERE bot_id=? ORDER BY created_at DESC LIMIT 20').all(botId)
        : this.db.prepare("SELECT * FROM review_jobs WHERE status='queued' ORDER BY created_at").all()
    ) as any[];
    return rows.map((row) => ({
      id: row.id,
      botId: row.bot_id,
      runId: row.run_id,
      status: row.status,
      attempts: row.attempts,
      payload: JSON.parse(row.payload),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      result: row.result,
    }));
  }
  jobStatus(id: string, status: string, result = '', increment = false) {
    this.db
      .prepare('UPDATE review_jobs SET status=?,result=?,updated_at=?,attempts=attempts+? WHERE id=?')
      .run(status, result, new Date().toISOString(), increment ? 1 : 0, id);
  }
  reviewMessage(jobId: string, botId: string, role: string, content: string, tool?: string) {
    this.db
      .prepare('INSERT INTO review_messages(job_id,bot_id,role,tool,content,created_at) VALUES(?,?,?,?,?,?)')
      .run(jobId, botId, role, tool || null, content, new Date().toISOString());
  }
  usage(
    botId: string,
    runId: string,
    task: string,
    model: string,
    input: number | undefined,
    output: number | undefined,
    estimated: number,
  ) {
    this.db
      .prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), runId, botId, task, model, input ?? null, output ?? null, estimated, new Date().toISOString());
  }
  clearBot(botId: string) {
    this.db.exec('BEGIN');
    try {
      for (const table of [
        'history',
        'history_fts',
        'context_state',
        'context_pruning',
        'context_heads',
        'context_epochs',
        'context_attempts',
        'memory_facts',
        'memory_tombstones',
        'knowledge_events',
        'review_jobs',
        'review_messages',
        'model_usage',
      ])
        this.db
          .prepare(`DELETE FROM ${table} WHERE bot_id=? OR substr(bot_id,1,?)=? OR instr(bot_id,?)>0`)
          .run(botId, botId.length + 1, botId + ':', ':reset:' + botId + ':');
      const resetAt = this.store.data.bots.find((b) => b.id === botId)?.contextResetAt;
      if (resetAt)
        this.db
          .prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
          .run('context-reset:' + botId, resetAt);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    if (this.db.isOpen) this.db.close();
  }
}
