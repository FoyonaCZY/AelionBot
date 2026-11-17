// Finds the files of a knowledge base: walks its folders in a fixed order, honouring .gitignore files and leaving
// out what is not a document.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { KnowledgeIssue, KnowledgeSource } from '../../../shared/types/knowledge-types';
import { documentKind, SIZE_LIMIT, type DocumentKind } from './knowledge-extract';

interface ScanEntry {
  path: string;
  size: number;
  mtime: number;
  kind: DocumentKind;
}
export interface ScanResult {
  files: ScanEntry[];
  /** Files that are documents but are left out, with the reason. */
  skipped: KnowledgeIssue[];
  /** Sources that are not on this computer now; what was indexed from them is kept. */
  missing: string[];
  /** There were more files than the limit. */
  truncated: boolean;
}
/** Folders that hold tooling, not documents. Hidden folders and files are left out as well. */
const SKIPPED_FOLDERS = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  'bower_components',
  '$RECYCLE.BIN',
  'System Volume Information',
]);
const key = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
/** Whether a path lies inside (or is) a folder. */
export const within = (folder: string, path: string) => {
  const root = key(resolve(folder)),
    target = key(resolve(path));
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
};

export async function scanSources(
  sources: KnowledgeSource[],
  limit: number,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const result: ScanResult = { files: [], skipped: [], missing: [], truncated: false },
    seen = new Set<string>();
  const add = async (path: string, explicit: boolean) => {
    if (seen.has(key(path))) return;
    const kind = documentKind(path);
    if (!kind) {
      if (explicit) result.skipped.push({ path, reason: 'unsupported' });
      return;
    }
    let info;
    try {
      info = await stat(path);
    } catch {
      if (explicit) result.missing.push(path);
      return;
    }
    if (!info.isFile()) return;
    seen.add(key(path));
    if (result.files.length >= limit) {
      result.truncated = true;
      return;
    }
    if (info.size > SIZE_LIMIT[kind]) result.skipped.push({ path, reason: 'too_large' });
    else if (info.size > 0) result.files.push({ path, size: info.size, mtime: Math.floor(info.mtimeMs), kind });
  };
  const walk = async (root: string) => {
    // Each folder on the way down may bring its own .gitignore; a path is tested against every one above it.
    const stack: Array<{ dir: string; rules: Array<{ base: string; rule: Ignore }> }> = [{ dir: root, rules: [] }];
    while (stack.length) {
      signal?.throwIfAborted();
      if (result.truncated) return;
      const { dir, rules } = stack.pop()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      let own = rules;
      if (entries.some((entry) => entry.name === '.gitignore' && entry.isFile()))
        try {
          own = [...rules, { base: dir, rule: ignore().add(await readFile(join(dir, '.gitignore'), 'utf8')) }];
        } catch {
          /* An unreadable .gitignore ignores nothing. */
        }
      const ignored = (path: string, folder: boolean) =>
        own.some(({ base, rule }) => {
          const name = relative(base, path).split(sep).join('/');
          return Boolean(name) && rule.ignores(folder ? name + '/' : name);
        });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const folders: string[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name) && !ignored(path, true)) folders.push(path);
        } else if (entry.isFile() && documentKind(path) && !ignored(path, false)) await add(path, false);
      }
      // Depth first, in name order: the same files are kept when the limit cuts the walk short.
      for (const folder of folders.reverse()) stack.push({ dir: folder, rules: own });
    }
  };
  for (const source of sources) {
    signal?.throwIfAborted();
    const path = resolve(source.path);
    let info;
    try {
      info = await stat(path);
    } catch {
      result.missing.push(path);
      continue;
    }
    if (info.isDirectory()) await walk(path);
    else await add(path, true);
  }
  return result;
}
