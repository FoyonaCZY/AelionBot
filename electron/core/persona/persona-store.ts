import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Traits, Scope } from '../../../shared/persona/persona-model';
import type { GrowthObservation, GrowthReviewRecord } from '../../../shared/types/persona-growth-types';
import type {
  PersonaEpisode as Episode,
  PersonaHighlight as Highlight,
  PersonaProfile,
  PersonaTraitPoint as TraitPoint,
} from '../../../shared/types/persona-types';
export type { Episode, Highlight, PersonaProfile, TraitPoint };

/** A timed, sourced change in how one Bot regards someone (docs/ai-personality-module.md §11.2). */
export interface AffinityModifier {
  id: string;
  botId: string;
  /** Another Bot's id, or 'user' for the human. */
  targetId: string;
  value: number;
  createdAt: number;
  durationDays: number;
  source: string;
}
const DAY = 86_400_000;
const HIGHLIGHT_KEEP_DAYS = 180;
const EPISODE_KEEP_DAYS = 90;

/** Persona data lives in its own SQLite file so growing history never enters the main store loaded at start. */
export class PersonaStore {
  private db: DatabaseSync;
  constructor(dir: string) {
    this.db = new DatabaseSync(join(dir, 'persona.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS affinity(id TEXT PRIMARY KEY, bot TEXT NOT NULL, target TEXT NOT NULL, value REAL NOT NULL,
        created INTEGER NOT NULL, days REAL NOT NULL, source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS affinity_bot ON affinity(bot, target);
      CREATE TABLE IF NOT EXISTS highlight(id TEXT PRIMARY KEY, bot TEXT NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL,
        grp TEXT NOT NULL, summary TEXT NOT NULL, type TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER);
      CREATE INDEX IF NOT EXISTS highlight_bot ON highlight(bot, created);
      CREATE TABLE IF NOT EXISTS highlight_member(highlight TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY(highlight, member));
      CREATE TABLE IF NOT EXISTS settled(match TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS profile(bot TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forgotten_member(member TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS episode(id TEXT PRIMARY KEY, bot TEXT NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL,
        kind TEXT NOT NULL, summary TEXT NOT NULL, s TEXT NOT NULL, o REAL NOT NULL, delta TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS episode_bot ON episode(bot, created);
      CREATE TABLE IF NOT EXISTS trait_history(bot TEXT NOT NULL, traits TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS trait_history_bot ON trait_history(bot, created);
      CREATE TABLE IF NOT EXISTS growth_observation(id TEXT PRIMARY KEY, bot TEXT NOT NULL, created INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS growth_observation_bot ON growth_observation(bot, consumed, created);
      CREATE TABLE IF NOT EXISTS growth_discarded_match(bot TEXT NOT NULL, match TEXT NOT NULL, PRIMARY KEY(bot, match));
      CREATE TABLE IF NOT EXISTS growth_review(id TEXT PRIMARY KEY, bot TEXT NOT NULL, created INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS growth_review_bot ON growth_review(bot, created);
      CREATE TABLE IF NOT EXISTS growth_epoch(bot TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS growth_movement(id TEXT PRIMARY KEY, bot TEXT NOT NULL, created INTEGER NOT NULL, delta TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS growth_movement_bot ON growth_movement(bot, created);
      INSERT OR IGNORE INTO growth_movement(id, bot, created, delta)
        SELECT CASE WHEN kind IN ('growth_review', 'growth_review_undo') THEN source ELSE id END, bot, created, delta FROM episode;`);
    // Reviews survive a growth reset; repair their budget ledger if an older build already removed episodes.
    const movement = this.db.prepare('INSERT OR IGNORE INTO growth_movement VALUES (?, ?, ?, ?)');
    for (const review of this.allGrowthReviews())
      if (review.status === 'applied' || review.status === 'reverted')
        movement.run(review.id, review.botId, review.completedAt ?? review.createdAt, JSON.stringify(review.delta));
  }
  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  growthEpoch(botId: string): number {
    return Number(
      (this.db.prepare('SELECT epoch FROM growth_epoch WHERE bot = ?').get(botId) as { epoch: number } | undefined)
        ?.epoch || 0,
    );
  }
  advanceGrowthEpoch(botId: string): number {
    const epoch = this.growthEpoch(botId) + 1;
    this.db.prepare('INSERT OR REPLACE INTO growth_epoch VALUES (?, ?)').run(botId, epoch);
    return epoch;
  }
  addGrowthObservation(observation: GrowthObservation) {
    if (
      this.db
        .prepare('SELECT 1 FROM growth_discarded_match WHERE bot = ? AND match = ?')
        .get(observation.botId, observation.matchId)
    )
      return;
    const consumed = this.db
      .prepare(
        "SELECT 1 FROM growth_observation WHERE bot = ? AND consumed = 1 AND json_extract(json, '$.matchId') = ? LIMIT 1",
      )
      .get(observation.botId, observation.matchId)
      ? 1
      : 0;
    this.db
      .prepare('INSERT OR IGNORE INTO growth_observation(id, bot, created, consumed, json) VALUES (?, ?, ?, ?, ?)')
      .run(observation.id, observation.botId, observation.createdAt, consumed, JSON.stringify(observation));
  }
  pendingGrowthObservations(botId: string, limit = 60): GrowthObservation[] {
    return (
      this.db
        .prepare('SELECT json FROM growth_observation WHERE bot = ? AND consumed = 0 ORDER BY created, id LIMIT ?')
        .all(botId, limit) as Array<{ json: string }>
    ).map((r) => JSON.parse(r.json) as GrowthObservation);
  }
  pendingGrowthBots(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT bot FROM growth_observation WHERE consumed = 0').all() as Array<{ bot: string }>
    ).map((r) => r.bot);
  }
  consumeGrowthObservations(ids: string[]) {
    const find = this.db.prepare('SELECT json FROM growth_observation WHERE id = ?');
    const consume = this.db.prepare(
      "UPDATE growth_observation SET consumed = 1 WHERE bot = ? AND json_extract(json, '$.matchId') = ?",
    );
    for (const id of ids) {
      const row = find.get(id) as { json: string } | undefined;
      if (!row) continue;
      const observation = JSON.parse(row.json) as GrowthObservation;
      consume.run(observation.botId, observation.matchId);
    }
  }
  discardGrowthObservations(botId: string) {
    // Reset/manual settings discard evidence, but completed-match recovery may deliver it again.
    // A match can be settled before its first observation write succeeds. Snapshot its identity too,
    // so replay cannot introduce pre-reset behavior merely because no observation row existed yet.
    this.db.prepare('INSERT OR IGNORE INTO growth_discarded_match SELECT ?, match FROM settled').run(botId);
    this.db.prepare('UPDATE growth_observation SET consumed = 1 WHERE bot = ?').run(botId);
  }
  saveGrowthReview(review: GrowthReviewRecord) {
    this.db
      .prepare('INSERT OR REPLACE INTO growth_review VALUES (?, ?, ?, ?)')
      .run(review.id, review.botId, review.createdAt, JSON.stringify(review));
  }
  growthReviews(botId: string, limit = 20): GrowthReviewRecord[] {
    return (
      this.db
        .prepare('SELECT json FROM growth_review WHERE bot = ? ORDER BY created DESC, rowid DESC LIMIT ?')
        .all(botId, limit) as Array<{ json: string }>
    ).map((r) => JSON.parse(r.json) as GrowthReviewRecord);
  }
  interruptedGrowthReviews(): GrowthReviewRecord[] {
    return (this.db.prepare('SELECT json FROM growth_review').all() as Array<{ json: string }>)
      .map((r) => JSON.parse(r.json) as GrowthReviewRecord)
      .filter((r) => r.status === 'running');
  }
  allGrowthReviews(): GrowthReviewRecord[] {
    return (
      this.db.prepare('SELECT json FROM growth_review ORDER BY created, rowid').all() as Array<{ json: string }>
    ).map((r) => JSON.parse(r.json) as GrowthReviewRecord);
  }
  latestAppliedGrowthReview(botId: string): GrowthReviewRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT json FROM growth_review WHERE bot = ? AND json_extract(json, '$.status') = 'applied' ORDER BY created DESC, rowid DESC LIMIT 1",
      )
      .get(botId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as GrowthReviewRecord) : undefined;
  }
  latestThrottledGrowthReview(botId: string): GrowthReviewRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT json FROM growth_review WHERE bot = ? AND json_extract(json, '$.status') IN ('applied', 'unchanged', 'rejected', 'failed') ORDER BY created DESC, rowid DESC LIMIT 1",
      )
      .get(botId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as GrowthReviewRecord) : undefined;
  }
  hasGrowthReversal(reviewId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM growth_review WHERE json_extract(json, '$.reverts') = ? LIMIT 1")
      .get(reviewId);
  }
  /** Absolute movement cannot be refunded by a reversal or resetting displayed growth history. */
  growthMovedSince(botId: string, since: number): Partial<Traits> {
    const moved: Partial<Traits> = {};
    for (const { delta } of this.db
      .prepare('SELECT delta FROM growth_movement WHERE bot = ? AND created >= ?')
      .all(botId, since) as Array<{ delta: string }>) {
      for (const [key, value] of Object.entries(JSON.parse(delta) as Traits))
        moved[key as keyof Traits] = (moved[key as keyof Traits] || 0) + Math.abs(value);
    }
    return moved;
  }
  isForgotten(memberId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM forgotten_member WHERE member = ?').get(memberId);
  }
  profile(botId: string): PersonaProfile | undefined {
    const row = this.db.prepare('SELECT json FROM profile WHERE bot = ?').get(botId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as PersonaProfile) : undefined;
  }
  saveProfile(p: PersonaProfile) {
    this.db.prepare('INSERT OR REPLACE INTO profile(bot, json) VALUES (?, ?)').run(p.botId, JSON.stringify(p));
  }
  addEpisode(e: Omit<Episode, 'id'>) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO episode VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        e.botId,
        e.scope,
        e.sourceId,
        e.kind,
        e.summary,
        JSON.stringify(e.s),
        e.o,
        JSON.stringify(e.delta),
        e.createdAt,
      );
    if (Object.values(e.delta).some((value) => value !== 0))
      this.db
        .prepare('INSERT OR IGNORE INTO growth_movement VALUES (?, ?, ?, ?)')
        .run(
          e.kind === 'growth_review' || e.kind === 'growth_review_undo' ? e.sourceId : id,
          e.botId,
          e.createdAt,
          JSON.stringify(e.delta),
        );
  }
  episodes(botId: string, limit = 30): Episode[] {
    return (
      this.db.prepare('SELECT * FROM episode WHERE bot = ? ORDER BY created DESC LIMIT ?').all(botId, limit) as Array<
        Record<string, unknown>
      >
    ).map((r) => ({
      id: String(r.id),
      botId: String(r.bot),
      scope: r.scope as Scope,
      sourceId: String(r.source),
      kind: String(r.kind),
      summary: String(r.summary),
      s: JSON.parse(String(r.s)),
      o: Number(r.o),
      delta: JSON.parse(String(r.delta)),
      createdAt: Number(r.created),
    }));
  }
  /** How far each trait already moved in this scope since `since` (the daily cap, §8.4). */
  movedSince(botId: string, scope: Scope, since: number): Partial<Traits> {
    const used: Partial<Traits> = {};
    for (const r of this.db
      .prepare('SELECT delta FROM episode WHERE bot = ? AND scope = ? AND created >= ?')
      .all(botId, scope, since) as Array<{ delta: string }>)
      for (const [k, v] of Object.entries(JSON.parse(r.delta) as Traits))
        used[k as keyof Traits] = (used[k as keyof Traits] || 0) + v;
    return used;
  }
  addHistory(botId: string, traits: Traits, reason: string, at: number) {
    this.db.prepare('INSERT INTO trait_history VALUES (?, ?, ?, ?)').run(botId, JSON.stringify(traits), reason, at);
  }
  history(botId: string, limit = 200): TraitPoint[] {
    return (
      this.db
        .prepare('SELECT * FROM trait_history WHERE bot = ? ORDER BY created DESC LIMIT ?')
        .all(botId, limit) as Array<Record<string, unknown>>
    )
      .map((r) => ({ traits: JSON.parse(String(r.traits)), reason: String(r.reason), createdAt: Number(r.created) }))
      .reverse();
  }
  /** Affinity modifiers this Bot holds towards anyone, for the profile page. */
  affinityTargets(botId: string): string[] {
    return (
      this.db.prepare('SELECT DISTINCT target FROM affinity WHERE bot = ?').all(botId) as Array<{ target: string }>
    ).map((r) => r.target);
  }
  recentHighlights(botId: string, limit = 10): Highlight[] {
    const ids = (
      this.db
        .prepare('SELECT id FROM highlight WHERE bot = ? ORDER BY created DESC LIMIT ?')
        .all(botId, limit) as Array<{
        id: string;
      }>
    ).map((r) => r.id);
    const who = this.db.prepare('SELECT member FROM highlight_member WHERE highlight = ?');
    return ids.map((id) => {
      const r = this.db.prepare('SELECT * FROM highlight WHERE id = ?').get(id) as Record<string, unknown>;
      return {
        id,
        botId: String(r.bot),
        scope: r.scope as Highlight['scope'],
        sourceId: String(r.source),
        groupId: String(r.grp),
        participants: (who.all(id) as Array<{ member: string }>).map((x) => x.member),
        summary: String(r.summary),
        type: String(r.type),
        createdAt: Number(r.created),
        lastUsedAt: r.used === null || r.used === undefined ? undefined : Number(r.used),
      };
    });
  }
  /** Reset growth: keep relationships and memories, drop episodes and history (§14 reset). */
  resetGrowth(botId: string) {
    this.db.prepare('DELETE FROM episode WHERE bot = ?').run(botId);
    this.db.prepare('DELETE FROM trait_history WHERE bot = ?').run(botId);
  }
  /** Settlement is idempotent per match: returns false if this match was already settled. */
  claimMatch(matchId: string, now = Date.now()) {
    const r = this.db.prepare('INSERT OR IGNORE INTO settled(match, at) VALUES (?, ?)').run(matchId, now);
    return Number(r.changes) > 0;
  }
  addAffinity(m: Omit<AffinityModifier, 'id'>) {
    this.db
      .prepare('INSERT INTO affinity VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), m.botId, m.targetId, m.value, m.createdAt, m.durationDays, m.source);
  }
  affinity(botId: string, targetId: string): AffinityModifier[] {
    return (
      this.db
        .prepare('SELECT * FROM affinity WHERE bot = ? AND target = ? ORDER BY created')
        .all(botId, targetId) as Array<Record<string, unknown>>
    ).map((r) => ({
      id: String(r.id),
      botId: String(r.bot),
      targetId: String(r.target),
      value: Number(r.value),
      createdAt: Number(r.created),
      durationDays: Number(r.days),
      source: String(r.source),
    }));
  }
  addHighlight(h: Omit<Highlight, 'id'>) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO highlight VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(id, h.botId, h.scope, h.sourceId, h.groupId, h.summary, h.type, h.createdAt);
    const member = this.db.prepare('INSERT OR IGNORE INTO highlight_member VALUES (?, ?)');
    for (const p of new Set(h.participants)) member.run(id, p);
    return id;
  }
  /** Highlights of this Bot that involve any of the given members, newest first. */
  highlightsWith(botId: string, members: string[], limit = 20): Highlight[] {
    if (!members.length) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT h.* FROM highlight h JOIN highlight_member m ON m.highlight = h.id
         WHERE h.bot = ? AND m.member IN (${members.map(() => '?').join(',')}) ORDER BY h.created DESC LIMIT ?`,
      )
      .all(botId, ...members, limit) as Array<Record<string, unknown>>;
    const who = this.db.prepare('SELECT member FROM highlight_member WHERE highlight = ?');
    return rows.map((r) => ({
      id: String(r.id),
      botId: String(r.bot),
      scope: r.scope as Highlight['scope'],
      sourceId: String(r.source),
      groupId: String(r.grp),
      participants: (who.all(String(r.id)) as Array<{ member: string }>).map((x) => x.member),
      summary: String(r.summary),
      type: String(r.type),
      createdAt: Number(r.created),
      lastUsedAt: r.used === null || r.used === undefined ? undefined : Number(r.used),
    }));
  }
  markUsed(id: string, at = Date.now()) {
    this.db.prepare('UPDATE highlight SET used = ? WHERE id = ?').run(at, id);
  }
  /** Delete everything this store remembers about one member (§13, forget). */
  forget(memberId: string) {
    this.db.prepare('INSERT OR IGNORE INTO forgotten_member VALUES (?)').run(memberId);
    this.db.prepare('DELETE FROM affinity WHERE target = ? OR bot = ?').run(memberId, memberId);
    for (const table of [
      'profile',
      'episode',
      'trait_history',
      'growth_observation',
      'growth_discarded_match',
      'growth_review',
      'growth_epoch',
      'growth_movement',
    ])
      this.db.prepare(`DELETE FROM ${table} WHERE bot = ?`).run(memberId);
    const ids = (
      this.db
        .prepare(
          'SELECT id AS highlight FROM highlight WHERE bot = ? UNION SELECT highlight FROM highlight_member WHERE member = ?',
        )
        .all(memberId, memberId) as Array<{
        highlight: string;
      }>
    ).map((r) => r.highlight);
    for (const id of ids) {
      this.db.prepare('DELETE FROM highlight_member WHERE highlight = ?').run(id);
      this.db.prepare('DELETE FROM highlight WHERE id = ?').run(id);
    }
  }
  /** Retention (§15.1): expired modifiers after 7 days, ordinary highlights after 180 days. */
  prune(now = Date.now()) {
    this.db.prepare('DELETE FROM affinity WHERE created + (days + 7) * ? < ?').run(DAY, now);
    const old = now - HIGHLIGHT_KEEP_DAYS * DAY;
    this.db
      .prepare('DELETE FROM highlight_member WHERE highlight IN (SELECT id FROM highlight WHERE created < ?)')
      .run(old);
    this.db.prepare('DELETE FROM highlight WHERE created < ?').run(old);
    this.db.prepare('DELETE FROM episode WHERE created < ?').run(now - EPISODE_KEEP_DAYS * DAY);
    // Unassessed evidence expires with ordinary episodes; immutable completed audits remain reviewable.
    this.db
      .prepare('DELETE FROM growth_observation WHERE consumed = 0 AND created < ?')
      .run(now - EPISODE_KEEP_DAYS * DAY);
  }
  close() {
    this.db.close();
  }
}
