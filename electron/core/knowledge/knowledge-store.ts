// The knowledge index: files, their passages, a word index and vectors, in one SQLite file of its own. The
// indexing thread writes files and passages; the main process reads them and adds vectors. It can be deleted and
// rebuilt from the files at any time: the knowledge bases themselves are part of the app state.
import { DatabaseSync } from 'node:sqlite';
import type { KnowledgeIssue } from '../../../shared/types/knowledge-types';

export interface StoredFile {
  id: number;
  path: string;
  size: number;
  mtime: number;
  hash: string;
  status: 'ok' | 'failed' | 'skipped';
  error?: string;
}
export interface NewChunk {
  heading: string;
  location: string;
  line?: number;
  text: string;
  hash: string;
  tokens: string;
}
interface StoredChunk {
  id: number;
  base: string;
  path: string;
  heading: string;
  location: string;
  line?: number;
  text: string;
}
export interface BaseStatus {
  indexedAt?: string;
  truncated?: boolean;
  missing?: string[];
  error?: string;
}
/** A vector as stored: one signed byte per dimension of the unit vector. */
function quantize(vector: Float32Array) {
  const out = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(vector[i] * 127)));
  return out;
}

export class KnowledgeStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS kb_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kb_files(id INTEGER PRIMARY KEY,base TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL,mtime INTEGER NOT NULL,hash TEXT NOT NULL,status TEXT NOT NULL,error TEXT,indexed_at TEXT NOT NULL,UNIQUE(base,path));
      CREATE TABLE IF NOT EXISTS kb_chunks(id INTEGER PRIMARY KEY,base TEXT NOT NULL,file INTEGER NOT NULL,seq INTEGER NOT NULL,heading TEXT NOT NULL,location TEXT NOT NULL,line INTEGER,text TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS kb_chunks_file ON kb_chunks(file);
      CREATE INDEX IF NOT EXISTS kb_chunks_base ON kb_chunks(base);
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(base UNINDEXED,tokens,tokenize='porter unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS kb_vectors(chunk INTEGER PRIMARY KEY,base TEXT NOT NULL,model TEXT NOT NULL,vec BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS kb_vectors_base ON kb_vectors(base);`);
  }
  close() {
    try {
      this.db.close();
    } catch {
      /* Already closed. */
    }
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  status(base: string): BaseStatus {
    const row = this.db.prepare('SELECT value FROM kb_meta WHERE key=?').get('status:' + base) as
      { value: string } | undefined;
    try {
      return row ? (JSON.parse(row.value) as BaseStatus) : {};
    } catch {
      return {};
    }
  }
  setStatus(base: string, status: BaseStatus) {
    this.db
      .prepare('INSERT INTO kb_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('status:' + base, JSON.stringify(status));
  }

  // ---------- Files and passages (the indexing thread) ----------

  files(base: string) {
    const map = new Map<string, StoredFile>();
    for (const row of this.db
      .prepare('SELECT id,path,size,mtime,hash,status,error FROM kb_files WHERE base=?')
      .all(base) as unknown as Array<StoredFile & { error: string | null }>)
      map.set(row.path, { ...row, error: row.error ?? undefined });
    return map;
  }
  private dropChunks(file: number) {
    this.db.prepare('DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE file=?)').run(file);
    this.db.prepare('DELETE FROM kb_vectors WHERE chunk IN (SELECT id FROM kb_chunks WHERE file=?)').run(file);
    this.db.prepare('DELETE FROM kb_chunks WHERE file=?').run(file);
  }
  /**
   * Records a file as read, with its passages in place of the ones it had. A passage whose text did not change
   * keeps its vector.
   */
  replaceFile(
    base: string,
    file: { path: string; size: number; mtime: number; hash: string; status: StoredFile['status']; error?: string },
    chunks: NewChunk[] = [],
  ) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM kb_files WHERE base=? AND path=?').get(base, file.path) as
        { id: number } | undefined;
      const kept = new Map<string, { model: string; vec: Uint8Array }>();
      if (existing) {
        for (const row of this.db
          .prepare(
            'SELECT c.hash hash,v.model model,v.vec vec FROM kb_chunks c JOIN kb_vectors v ON v.chunk=c.id WHERE c.file=?',
          )
          .all(existing.id) as unknown as Array<{ hash: string; model: string; vec: Uint8Array }>)
          kept.set(row.hash, { model: row.model, vec: row.vec });
        this.dropChunks(existing.id);
      }
      const now = new Date().toISOString();
      let id = existing?.id;
      if (id !== undefined)
        this.db
          .prepare('UPDATE kb_files SET size=?,mtime=?,hash=?,status=?,error=?,indexed_at=? WHERE id=?')
          .run(file.size, file.mtime, file.hash, file.status, file.error ?? null, now, id);
      else
        id = Number(
          this.db
            .prepare('INSERT INTO kb_files(base,path,size,mtime,hash,status,error,indexed_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(base, file.path, file.size, file.mtime, file.hash, file.status, file.error ?? null, now)
            .lastInsertRowid,
        );
      const insert = this.db.prepare(
          'INSERT INTO kb_chunks(base,file,seq,heading,location,line,text,hash) VALUES(?,?,?,?,?,?,?,?)',
        ),
        index = this.db.prepare('INSERT INTO kb_fts(rowid,base,tokens) VALUES(?,?,?)'),
        vector = this.db.prepare('INSERT OR REPLACE INTO kb_vectors VALUES(?,?,?,?)');
      chunks.forEach((chunk, seq) => {
        const chunkId = Number(
          insert.run(base, id!, seq, chunk.heading, chunk.location, chunk.line ?? null, chunk.text, chunk.hash)
            .lastInsertRowid,
        );
        index.run(chunkId, base, chunk.tokens);
        const old = kept.get(chunk.hash);
        if (old) vector.run(chunkId, base, old.model, old.vec);
      });
      return id!;
    });
  }
  /** The file changed on disk but not in content. */
  touchFile(id: number, size: number, mtime: number) {
    this.db.prepare('UPDATE kb_files SET size=?,mtime=? WHERE id=?').run(size, mtime, id);
  }
  removeFile(id: number) {
    this.transaction(() => {
      this.dropChunks(id);
      this.db.prepare('DELETE FROM kb_files WHERE id=?').run(id);
    });
  }
  removeBase(base: string) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE base=?)').run(base);
      this.db.prepare('DELETE FROM kb_vectors WHERE base=?').run(base);
      this.db.prepare('DELETE FROM kb_chunks WHERE base=?').run(base);
      this.db.prepare('DELETE FROM kb_files WHERE base=?').run(base);
      this.db.prepare('DELETE FROM kb_meta WHERE key=?').run('status:' + base);
    });
  }
  /** Bases the index holds something of; those without a knowledge base any more are cleared at startup. */
  knownBases() {
    return (this.db.prepare('SELECT DISTINCT base FROM kb_files').all() as Array<{ base: string }>).map(
      (row) => row.base,
    );
  }

  // ---------- Reading (the main process) ----------

  counts(base: string) {
    const row = this.db
      .prepare("SELECT sum(status='ok') files,sum(status<>'ok') issues FROM kb_files WHERE base=?")
      .get(base) as { files: number | null; issues: number | null };
    return { files: Number(row.files || 0), issues: Number(row.issues || 0) };
  }
  issues(base: string, limit = 200): KnowledgeIssue[] {
    return (
      this.db
        .prepare("SELECT path,error FROM kb_files WHERE base=? AND status<>'ok' ORDER BY path LIMIT ?")
        .all(base, limit) as Array<{ path: string; error: string | null }>
    ).map((row) => ({ path: row.path, reason: row.error || 'unreadable' }));
  }
  /** Passages matching any of the words, best first. `query` is an FTS5 expression of quoted terms. */
  match(query: string, bases: string[], limit: number) {
    if (!query || !bases.length) return [];
    return this.db
      .prepare(
        `SELECT rowid id FROM kb_fts WHERE kb_fts MATCH ? AND base IN (${bases.map(() => '?').join(',')}) ORDER BY rank LIMIT ?`,
      )
      .all(query, ...bases, limit) as Array<{ id: number }>;
  }
  chunks(ids: number[]) {
    const map = new Map<number, StoredChunk>();
    if (!ids.length) return map;
    for (const row of this.db
      .prepare(
        `SELECT c.id id,c.base base,f.path path,c.heading heading,c.location location,c.line line,c.text text FROM kb_chunks c JOIN kb_files f ON f.id=c.file WHERE c.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as unknown as Array<StoredChunk & { line: number | null }>)
      map.set(row.id, { ...row, line: row.line ?? undefined });
    return map;
  }

  // ---------- Vectors (the main process) ----------

  /** Passages after the given one that have no vector of this model, oldest first. */
  pendingVectors(model: string, bases: string[], limit: number, after = 0) {
    if (!bases.length) return [];
    return this.db
      .prepare(
        `SELECT c.id id,c.base base,c.heading heading,c.text text FROM kb_chunks c LEFT JOIN kb_vectors v ON v.chunk=c.id AND v.model=? WHERE v.chunk IS NULL AND c.id>? AND c.base IN (${bases.map(() => '?').join(',')}) ORDER BY c.id LIMIT ?`,
      )
      .all(model, after, ...bases, limit) as Array<{ id: number; base: string; heading: string; text: string }>;
  }
  setVectors(model: string, entries: Array<{ id: number; base: string; vector: Float32Array }>) {
    this.transaction(() => {
      // A passage replaced while its vector was being made is gone; its vector is not kept.
      const exists = this.db.prepare('SELECT 1 FROM kb_chunks WHERE id=?'),
        insert = this.db.prepare('INSERT OR REPLACE INTO kb_vectors VALUES(?,?,?,?)');
      for (const entry of entries)
        if (exists.get(entry.id)) {
          const bytes = quantize(entry.vector);
          insert.run(entry.id, entry.base, model, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        }
    });
  }
  /** Every vector of a base, side by side in one array. */
  vectors(model: string, base: string) {
    const rows = this.db
      .prepare('SELECT chunk,vec FROM kb_vectors WHERE base=? AND model=? ORDER BY chunk')
      .all(base, model) as unknown as Array<{ chunk: number; vec: Uint8Array }>;
    const dimension = rows[0]?.vec.byteLength || 0,
      ids = new Int32Array(rows.length),
      data = new Int8Array(rows.length * dimension);
    let count = 0;
    for (const row of rows) {
      if (row.vec.byteLength !== dimension) continue;
      ids[count] = row.chunk;
      data.set(new Int8Array(row.vec.buffer, row.vec.byteOffset, dimension), count * dimension);
      count++;
    }
    return { ids: ids.subarray(0, count), data: data.subarray(0, count * dimension), dimension };
  }
  dropOtherVectors(model: string) {
    this.db.prepare('DELETE FROM kb_vectors WHERE model<>?').run(model);
  }
}
