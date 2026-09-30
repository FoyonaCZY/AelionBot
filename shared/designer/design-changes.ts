/** Per-run file changes shown on the "第 N 轮产出" card. */
export interface DesignFileChange {
  writes: number;
  /** Line counts are omitted for binary or very large files. */
  added?: number;
  removed?: number;
}
export type DesignRunChanges = Record<string, Record<string, DesignFileChange>>;

const TEXT_LIMIT = 2 * 1024 * 1024;
const MAX_RUNS = 30;

function textLines(bytes: Uint8Array | undefined) {
  if (!bytes) return [];
  if (bytes.length > TEXT_LIMIT) return undefined;
  // A NUL byte means the file is not text.
  if (bytes.subarray(0, 8000).includes(0)) return undefined;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
}

/**
 * Lines added and removed between two versions, counted as a multiset difference. It matches a real
 * diff for edits and reports a moved line as unchanged, which is what a change summary needs.
 */
export function lineChanges(before: Uint8Array | undefined, after: Uint8Array) {
  const old = textLines(before),
    next = textLines(after);
  if (!old || !next) return undefined;
  const counts = new Map<string, number>();
  for (const line of old) counts.set(line, (counts.get(line) || 0) + 1);
  let added = 0;
  for (const line of next) {
    const left = counts.get(line) || 0;
    if (left) counts.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

/** Adds one write to the run's record; keeps only the most recent runs. */
export function recordDesignChange(
  changes: DesignRunChanges | undefined,
  runId: string,
  path: string,
  lines: { added: number; removed: number } | undefined,
): DesignRunChanges {
  const all = { ...changes },
    run = { ...all[runId] },
    previous = run[path];
  run[path] = {
    writes: (previous?.writes || 0) + 1,
    ...(lines && (!previous || previous.added !== undefined)
      ? { added: (previous?.added || 0) + lines.added, removed: (previous?.removed || 0) + lines.removed }
      : {}),
  };
  delete all[runId];
  all[runId] = run;
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_RUNS))) delete all[id];
  return all;
}
