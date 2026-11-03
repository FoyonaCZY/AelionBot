import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../storage/store';
import type { ChatMessage } from '../../../shared/types/core';
import { excerpt, resultDigest } from '../context/context-budget';
import { AppError } from '../../../shared/errors';
import { MemoryStore } from './memory-store';
import { allOf, anyOf, queryTokens, searchTokens, signature } from './memory-text';
import { sensitivity } from './memory-policy';
import { botScope, conversationKey, groupScope } from './memory-scope';

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
  /** Long-term memory: facts, episodes, their history and index. */
  readonly items: MemoryStore;
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
    this.items = new MemoryStore(this.db);
    this.db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS history_words USING fts5(id UNINDEXED,bot_id UNINDEXED,tokens,tokenize='porter unicode61 remove_diacritics 2');",
    );
    this.items.recoverJobs();
    this.db.prepare("UPDATE review_jobs SET status='queued' WHERE status='running'").run();
    // A review's payload is a copy of its run's conversation, only needed until the review ends. Finished jobs kept
    // theirs, hundreds of megabytes on a long profile; clear those once. jobStatus() clears them from now on.
    if (this.get('review-payloads-pruned') !== '1') {
      this.db.prepare(`UPDATE review_jobs SET payload='{}' WHERE status NOT IN ('queued','running','held')`).run();
      this.set('review-payloads-pruned', '1');
    }
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
        if (
          !this.db.prepare('SELECT 1 FROM memory_facts WHERE bot_id=? LIMIT 1').get(bot.id) &&
          !this.db.prepare('SELECT 1 FROM mem_items WHERE scope=? LIMIT 1').get(botScope(bot.id))
        ) {
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
    this.migrateMemories();
    for (const bot of store.data.bots)
      if (bot.contextResetAt && this.get('context-reset:' + bot.id) !== bot.contextResetAt) this.clearBot(bot.id);
    this.indexWordsOnce();
    this.syncHistory();
    this.backfillEpisodes();
  }
  /**
   * Moves facts from the bounded table of earlier versions into long-term memory. They stay private to their Bot,
   * as they were: facts about the user are only suggested for sharing, for the user to confirm. The old rows stay
   * readable for a version or two, so going back loses nothing. Forgotten texts become unreadable signatures.
   */
  private migrateMemories() {
    if (!this.get('memory-v2-start')) this.set('memory-v2-start', new Date().toISOString());
    const change = { actor: 'system' as const };
    const messages = new Map(this.store.data.messages.map((message) => [message.id, message]));
    for (const bot of this.store.data.bots) {
      if (this.get('memory-v2:' + bot.id)) continue;
      this.items.transaction(() => {
        const rows = this.db
          .prepare('SELECT * FROM memory_facts WHERE bot_id=? ORDER BY created_at,id')
          .all(bot.id) as Array<{
          id: string;
          target: string;
          content: string;
          source_refs: string;
          created_at: string;
        }>;
        for (const row of rows) {
          const refs = JSON.parse(row.source_refs) as string[],
            sources = refs
              .map((id) => messages.get(id))
              .filter((message): message is ChatMessage => Boolean(message))
              .map((message) => ({ messageId: message.id, role: message.role, tool: message.tool, at: message.time }));
          const item = this.items.create(
            {
              scope: botScope(bot.id),
              kind: row.target === 'user' ? 'preference' : 'project',
              text: row.content,
              origin: sources.some((source) => source.role === 'user')
                ? 'user_stated'
                : sources.length
                  ? 'tool_verified'
                  : 'model_inferred',
              sensitivity: sensitivity(row.content),
              authorBot: bot.id,
              sources,
              recordedAt: row.created_at,
            },
            change,
          );
          if (row.target === 'user')
            this.items.save(
              { ...item, suggest: { scope: 'user', reason: '这条像是关于你的事实，可以让所有 Bot 都知道' } },
              'suggest',
              change,
              false,
            );
        }
        this.set('memory-v2:' + bot.id, '1');
      });
    }
    if (this.get('memory-v2-tombstones') !== '1')
      this.items.transaction(() => {
        const add = this.db.prepare('INSERT INTO mem_tombstones VALUES(?,?,?,?)'),
          at = new Date().toISOString();
        for (const row of this.db.prepare('SELECT bot_id,fingerprint FROM memory_tombstones').all() as Array<{
          bot_id: string;
          fingerprint: string;
        }>)
          add.run(botScope(row.bot_id), signature(row.fingerprint), null, at);
        this.db.exec('DELETE FROM memory_tombstones');
        this.db.exec("UPDATE knowledge_events SET before_text=NULL WHERE kind='memory' AND action='remove'");
        this.set('memory-v2-tombstones', '1');
      });
  }
  private indexWordsOnce() {
    if (this.get('history-words') === '1') return;
    this.db.exec('BEGIN');
    try {
      const insert = this.db.prepare('INSERT INTO history_words VALUES(?,?,?)');
      this.db.exec('DELETE FROM history_words');
      for (const row of this.db
        .prepare("SELECT id,bot_id,content FROM history WHERE role IN ('user','assistant') AND content<>''")
        .all() as Array<{ id: string; bot_id: string; content: string }>)
        insert.run(row.id, row.bot_id, searchTokens(row.content.slice(0, 2000)).join(' '));
      this.set('history-words', '1');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Summaries of compacted work, written before episodes existed, become episodes without calling a model. */
  private backfillEpisodes() {
    if (this.get('memory-v2-epochs') === '1') return;
    for (const row of this.db.prepare('SELECT * FROM context_epochs ORDER BY created_at').all() as Array<{
      id: string;
      bot_id: string;
      summary: string;
      stats: string;
      created_at: string;
    }>) {
      let scopeKey: string | undefined;
      try {
        scopeKey = JSON.parse(row.stats)?.scopeKey;
      } catch {
        /* An unreadable record counts as the main chat. */
      }
      this.recordEpoch({ id: row.id, botId: row.bot_id, scopeKey, summary: row.summary, at: row.created_at });
    }
    this.set('memory-v2-epochs', '1');
  }
  /**
   * What a compaction summarized, kept as an episode. Summaries are written by a model from content that may have
   * come from anywhere, so they never become facts.
   */
  recordEpoch(input: { id: string; botId: string; scopeKey?: string; summary: string; at: string }) {
    if (!this.store.data.bots.some((bot) => bot.id === input.botId) || input.scopeKey?.startsWith('peer:')) return;
    const group = /^group:([^:]+):/.exec(input.scopeKey || '')?.[1],
      session = input.scopeKey?.startsWith('session:') ? input.scopeKey.slice('session:'.length) : undefined;
    let summary: { goal?: unknown; done?: unknown; decisions?: unknown; pending?: unknown };
    try {
      summary = JSON.parse(input.summary);
    } catch {
      return;
    }
    const list = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    const goal = typeof summary.goal === 'string' ? summary.goal : '';
    if (!goal) return;
    this.items.addEpisode({
      botId: input.botId,
      scope: group ? groupScope(group) : botScope(input.botId),
      conversation: conversationKey({ botId: input.botId, sessionId: session, groupId: group }),
      title: goal,
      summary: [...list(summary.done).slice(-3), ...list(summary.decisions).slice(-2)].join('；') || goal,
      outcome: list(summary.pending).length ? 'partial' : 'done',
      pending: list(summary.pending).slice(-3),
      entities: [],
      origin: 'compaction',
      startedAt: input.at,
      endedAt: input.at,
      sourceKey: 'epoch:' + input.id,
    });
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
      removeWords = this.db.prepare('DELETE FROM history_words WHERE id=?'),
      insertWords = this.db.prepare('INSERT INTO history_words VALUES(?,?,?)'),
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
          removeWords.run(id);
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
        removeWords.run(message.id);
        if ((message.role === 'user' || message.role === 'assistant') && message.content)
          insertWords.run(message.id, message.botId, searchTokens(message.content.slice(0, 2000)).join(' '));
        this.synced.set(message.id, { stamp, seq });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.synced.clear();
      throw error;
    }
  }
  /**
   * `here` is the conversation searching (null for the main chat): its records rank first among equals.
   * Conversation text is matched by words, so a natural question finds it; tool output by literal fragments, and only
   * when asked for or when the conversation itself has too little.
   */
  search(
    botId: string,
    query: string,
    limit = 8,
    here: string | null = null,
    options: { since?: string; until?: string; includeToolOutput?: boolean } = {},
  ) {
    this.store.bot(botId);
    this.syncHistory(botId);
    query = query.trim().slice(0, 300);
    if (!query) throw new Error('请输入要查找的历史内容');
    limit = Math.max(1, Math.min(20, limit));
    const pool = limit * 5,
      inRange = (row: any) => {
        if (!options.since && !options.until) return true;
        const time = this.historyTime(row.id);
        return (
          Boolean(time) && (!options.since || time! >= options.since) && (!options.until || time! <= options.until)
        );
      };
    const ranked = new Map<string, { row: any; score: number }>();
    const merge = (rows: any[], weight: number) =>
      rows.filter(inRange).forEach((row, rank) => {
        const entry = ranked.get(row.id) || { row, score: 0 };
        entry.score += weight / (30 + rank);
        ranked.set(row.id, entry);
      });
    const words = queryTokens(query);
    if (words.length)
      merge(
        this.db
          .prepare(
            'SELECT h.* FROM history_words f JOIN history h ON h.id=f.id WHERE history_words MATCH ? AND f.bot_id=? ORDER BY rank LIMIT ?',
          )
          // One unbroken name such as a path or a constant is one thing, not a choice between its parts.
          .all(/^[!-~]+$/.test(query) && /[_./:-]/.test(query) ? allOf(words) : anyOf(words), botId, pool) as any[],
        1,
      );
    // Words that were typed apart may be literal fragments, as may a whole query such as a path or an error text.
    const terms = [...new Set(query.split(/\s+/).filter(Boolean))].slice(0, 12),
      long = terms.filter((term) => [...term].length >= 3),
      short = terms.filter((term) => [...term].length < 3);
    if (options.includeToolOutput || ranked.size < limit) {
      if (long.length)
        merge(
          this.db
            .prepare(
              'SELECT h.* FROM history_fts f JOIN history h ON h.id=f.id WHERE history_fts MATCH ? AND h.bot_id=? ORDER BY rank LIMIT ?',
            )
            .all(long.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR '), botId, pool) as any[],
          options.includeToolOutput ? 1 : 0.6,
        );
      // Two-character terms in tool output have no index; scanning for them is only worth it when asked for.
      if (options.includeToolOutput && short.length)
        merge(
          this.db
            .prepare(
              `SELECT * FROM history WHERE bot_id=? AND (${short.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ')}) ORDER BY seq DESC LIMIT ?`,
            )
            .all(botId, ...short.map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`), pool) as any[],
          0.5,
        );
    }
    const covered = (row: any) => {
      const text = String(row.content).toLowerCase();
      return terms.reduce((sum, term) => sum + (text.includes(term.toLowerCase()) ? 1 : 0), 0);
    };
    const rows = [...ranked.values()]
      .map((item, order) => ({
        ...item,
        order,
        covered: covered(item.row),
        spoken: item.row.role === 'user' ? 1 : item.row.role === 'assistant' ? 0.5 : 0,
      }))
      .sort(
        (a, b) =>
          b.covered - a.covered ||
          Number((b.row.scope ?? null) === here) - Number((a.row.scope ?? null) === here) ||
          b.score + b.spoken * 0.01 - (a.score + a.spoken * 0.01) ||
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
      try {
        this.recordEpoch({
          id,
          botId: input.botId,
          scopeKey: (input.stats as { scopeKey?: string } | undefined)?.scopeKey,
          summary: input.summary,
          at: new Date().toISOString(),
        });
      } catch {
        /* The timeline is a convenience; a compaction never fails over it. */
      }
      return id;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** The active facts a Bot holds itself and those about the user, oldest first. */
  memories(botId: string): MemoryFact[] {
    this.store.bot(botId);
    return this.items.list({ scopes: ['user', botScope(botId)], statuses: ['active'] }).map((item) => ({
      id: item.id,
      botId,
      target: item.scope === 'user' ? 'user' : 'memory',
      content: item.text,
      sourceRefs: item.sources.flatMap((source) => (source.messageId ? [source.messageId] : [])),
      createdAt: item.recordedAt,
      updatedAt: item.updatedAt,
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
  /** `held` waits for the conversation to be read, which decides whether a skill review is worth running. */
  enqueue(botId: string, runId: string, payload: unknown, status: 'queued' | 'held' = 'queued') {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE review_jobs SET status='superseded',payload='{}',updated_at=? WHERE bot_id=? AND status IN ('queued','held')",
      )
      .run(now, botId);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO review_jobs VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, botId, runId, status, 0, JSON.stringify(payload), null, now, now);
    return id;
  }
  releaseReviews(botId: string, worthy: boolean) {
    this.db
      .prepare(
        `UPDATE review_jobs SET status=?,payload=CASE WHEN ? THEN payload ELSE '{}' END,updated_at=? WHERE bot_id=? AND status='held'`,
      )
      .run(worthy ? 'queued' : 'skipped', worthy ? 1 : 0, new Date().toISOString(), botId);
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
    // Only a job that can still run needs its payload.
    this.db
      .prepare(
        "UPDATE review_jobs SET status=?,result=?,updated_at=?,attempts=attempts+?,payload=CASE WHEN ? IN ('queued','running','held') THEN payload ELSE '{}' END WHERE id=?",
      )
      .run(status, result, new Date().toISOString(), increment ? 1 : 0, status, id);
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
        'history_words',
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
      this.items.clearBot(botId);
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
