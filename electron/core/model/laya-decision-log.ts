import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { GroupChoice, GroupDecisionRecord, LayaDecisionRecord } from '../../../shared/types/laya-types';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY = 500;
const groupChoice = (value: unknown): GroupChoice | undefined =>
  value === 'observe' ? 'observe' : ['participate', 'reply', 'act'].includes(String(value)) ? 'participate' : undefined;

// Legacy three-way choices are converted at the persistence boundary, never in UI components.
function normalizeRecord(value: unknown): LayaDecisionRecord | undefined {
  if (!value || typeof value !== 'object') return;
  const event = value as LayaDecisionRecord;
  if (typeof event.sourceId !== 'string' || typeof event.choice !== 'string') return;
  if (event.scope === 'game' || event.scope === 'game_speech') return event;
  if (event.scope !== 'group') return;
  const choice = groupChoice(event.choice);
  if (!choice) return;
  const probabilities = event.probabilities;
  return {
    ...event,
    choice,
    appliedChoice: groupChoice(event.appliedChoice),
    probabilities: probabilities
      ? {
          ...(probabilities.observe !== undefined ? { observe: probabilities.observe } : {}),
          ...(probabilities.participate !== undefined
            ? { participate: probabilities.participate }
            : probabilities.reply !== undefined || probabilities.act !== undefined
              ? { participate: (probabilities.reply || 0) + (probabilities.act || 0) }
              : {}),
        }
      : undefined,
  };
}

export class LayaDecisionLog {
  private readonly file: string;
  private history: LayaDecisionRecord[] = [];
  private logBytes = 0;
  constructor(
    dir: string,
    private changed: () => void = () => {},
  ) {
    this.file = join(dir, 'laya-decisions.jsonl');
    try {
      const fd = openSync(this.file, 'r');
      let tail: string;
      try {
        this.logBytes = fstatSync(fd).size;
        const offset = Math.max(0, this.logBytes - MAX_LOG_BYTES);
        const buffer = Buffer.alloc(Math.min(this.logBytes, MAX_LOG_BYTES));
        const bytes = readSync(fd, buffer, 0, buffer.length, offset);
        tail = buffer.subarray(0, bytes).toString('utf8');
        // The bounded read may begin inside a record (or a UTF-8 character).
        if (offset) {
          const newline = tail.indexOf('\n');
          tail = newline < 0 ? '' : tail.slice(newline + 1);
        }
      } finally {
        closeSync(fd);
      }
      for (const line of tail.split('\n')) {
        try {
          const event = normalizeRecord(JSON.parse(line));
          if (event) this.history.push(event);
        } catch {}
      }
      this.history = this.history.slice(-MAX_HISTORY);
      // Repair oversized legacy files and incomplete final writes before appending.
      if (this.logBytes > MAX_LOG_BYTES || (tail && !tail.endsWith('\n'))) this.compactLog();
    } catch {}
  }
  groupDecisions(ids: Set<string>) {
    return this.history.filter(
      (event): event is GroupDecisionRecord => event.scope === 'group' && ids.has(event.sourceId),
    );
  }
  private compactLog() {
    const lines: string[] = [];
    let bytes = 0;
    for (const event of this.history.slice().reverse()) {
      const line = JSON.stringify(event) + '\n';
      const size = Buffer.byteLength(line);
      // A single oversized snapshot stays in memory but cannot defeat the disk limit.
      if (size > MAX_LOG_BYTES) continue;
      if (bytes + size > MAX_LOG_BYTES) break;
      lines.push(line);
      bytes += size;
    }
    const temporary = this.file + '.tmp';
    try {
      writeFileSync(temporary, lines.reverse().join(''), { mode: 0o600 });
      renameSync(temporary, this.file);
      this.logBytes = bytes;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  record(event: LayaDecisionRecord) {
    event.time = new Date().toISOString();
    this.history.push(event);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const line = JSON.stringify(event) + '\n';
      const bytes = Buffer.byteLength(line);
      if (this.logBytes + bytes > MAX_LOG_BYTES) this.compactLog();
      else {
        appendFileSync(this.file, line, { mode: 0o600 });
        this.logBytes += bytes;
      }
    } catch (error) {
      console.warn('Laya decision log:', error);
    }
    this.changed();
  }
}
