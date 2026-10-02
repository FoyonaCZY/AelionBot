/**
 * What a file edit changed, for display only: built from the tool's own arguments (old and new text, or the
 * patch) after it succeeds, stored on the tool message and never sent back to the model.
 */
interface DiffLine {
  /** ' ' context, '-' removed, '+' added, '…' a gap between hunks. */
  op: ' ' | '-' | '+' | '…';
  text: string;
}
export interface FileDiff {
  path: string;
  kind: 'update' | 'add' | 'delete' | 'move';
  moveTo?: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}
export interface ToolDiff {
  files: FileDiff[];
  /** Some lines were left out to keep the message small; the counts are still exact. */
  truncated?: boolean;
}

/** Display budget across all files; the file itself holds the full change. */
const MAX_LINES = 400,
  MAX_LINE = 300,
  MAX_FILES = 40,
  CONTEXT = 3,
  /** Above this the line diff is not attempted (quadratic); the edit shows as replaced lines. */
  MAX_LCS = 1_000_000;

const split = (text: string) => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
};

/** Line diff between two texts (LCS), with CONTEXT lines around each change and gaps marked. */
export function lineDiff(before: string, after: string): Omit<FileDiff, 'path' | 'kind'> {
  const a = before ? split(before) : [],
    b = after ? split(after) : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA),
    midB = b.slice(start, endB),
    ops: Array<{ op: ' ' | '-' | '+'; text: string }> = a.slice(0, start).map((text) => ({ op: ' ', text }));
  if (midA.length * midB.length <= MAX_LCS) {
    const n = midA.length,
      m = midB.length,
      table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ op: ' ', text: midA[i] });
        i++;
        j++;
      } else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) ops.push({ op: '-', text: midA[i++] });
      else ops.push({ op: '+', text: midB[j++] });
    }
  } else {
    for (const text of midA) ops.push({ op: '-', text });
    for (const text of midB) ops.push({ op: '+', text });
  }
  for (const text of a.slice(endA)) ops.push({ op: ' ', text });
  return { ...withContext(ops), ...counts(ops) };
}

const counts = (ops: Array<{ op: string }>) => ({
  added: ops.filter((line) => line.op === '+').length,
  removed: ops.filter((line) => line.op === '-').length,
});

/** Keeps CONTEXT unchanged lines around each change; longer unchanged runs become a single gap marker. */
function withContext(ops: Array<{ op: ' ' | '-' | '+'; text: string }>): { lines: DiffLine[] } {
  const keep = new Uint8Array(ops.length);
  ops.forEach((line, index) => {
    if (line.op === ' ') return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++) keep[k] = 1;
  });
  const lines: DiffLine[] = [];
  let gap = false;
  ops.forEach((line, index) => {
    if (keep[index]) {
      if (gap && lines.length) lines.push({ op: '…', text: '' });
      gap = false;
      lines.push(line);
    } else gap = true;
  });
  return { lines };
}

/** Parses the apply_patch format leniently: display never fails, unknown lines are skipped. */
function patchFiles(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined,
    hunk = 0;
  for (const raw of patch.replace(/\r\n?/g, '\n').split('\n')) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(raw);
    if (header) {
      file = {
        path: header[2].trim(),
        kind: header[1].toLowerCase() as FileDiff['kind'],
        added: 0,
        removed: 0,
        lines: [],
      };
      files.push(file);
      hunk = 0;
      continue;
    }
    if (!file || raw === '*** Begin Patch' || raw === '*** End Patch' || raw === '*** End of File') continue;
    const move = /^\*\*\* Move to: (.+)$/.exec(raw);
    if (move) {
      file.moveTo = move[1].trim();
      if (file.kind === 'update') file.kind = 'move';
      continue;
    }
    if (raw.startsWith('@@')) {
      if (hunk++ && file.lines.length) file.lines.push({ op: '…', text: '' });
      continue;
    }
    if (file.kind === 'delete') continue;
    const op = raw === '' ? ' ' : raw[0];
    if (op !== ' ' && op !== '+' && op !== '-') continue;
    file.lines.push({ op, text: raw.slice(1) });
    if (op === '+') file.added++;
    if (op === '-') file.removed++;
  }
  return files;
}

/** Applies the display budget across files, keeping each file's exact counts. */
function bounded(files: FileDiff[], clean: (text: string) => string): ToolDiff | undefined {
  if (!files.length) return;
  let budget = MAX_LINES,
    truncated = files.length > MAX_FILES;
  const out = files.slice(0, MAX_FILES).map((file) => {
    const lines = file.lines.slice(0, Math.max(0, budget)).map((line) => {
      const text = line.text.length > MAX_LINE ? line.text.slice(0, MAX_LINE) + '…' : line.text;
      return { op: line.op, text: clean(text) };
    });
    if (lines.length < file.lines.length) truncated = true;
    budget -= lines.length;
    return { ...file, path: clean(file.path), ...(file.moveTo ? { moveTo: clean(file.moveTo) } : {}), lines };
  });
  return truncated ? { files: out, truncated } : { files: out };
}

/**
 * The diff for a successful file-edit call, or undefined for other tools. `clean` redacts secrets and private paths
 * the same way the rest of the tool record is redacted.
 */
export function toolDiff(tool: string, args: Record<string, unknown>, clean: (text: string) => string = (t) => t) {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  if (tool === 'host_file_patch' || tool === 'file_patch') {
    const path = text(args.path);
    if (!path || typeof args.oldText !== 'string' || typeof args.newText !== 'string') return;
    // A replaceAll edit changes every match; the arguments show the change once.
    return bounded([{ path, kind: 'update', ...lineDiff(args.oldText, args.newText) }], clean);
  }
  if (tool === 'apply_patch' && typeof args.patch === 'string') return bounded(patchFiles(args.patch), clean);
  return;
}
