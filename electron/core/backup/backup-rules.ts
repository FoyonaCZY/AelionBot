// What a backup takes from the data directory. The directory is also Electron's profile folder, so it mixes three
// kinds of things:
//   - app data: conversations, Bots, memory, attachments, settings. Backed up, and replaced by a restore.
//   - derived files: copies and leftovers that belong to the app data they sit beside (a WAL, the JSON mirror of the
//     state database, old migration backups). Not backed up, but removed with the data a restore replaces.
//   - local files: the work computer, downloaded models, caches, logs and Chromium's own profile. They stay with
//     this computer: never backed up, never touched by a restore.
// App data is everything that is not named below, so a data file added later is backed up without anyone
// remembering to list it here.
import { opendir, lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Names the app itself gives its files: lowercase with dots and hyphens. Chromium's have capitals, spaces or `_`. */
const APP_NAME = /^[a-z0-9][a-z0-9.-]*$/;

/** Working names of a backup or a restore inside the data directory. */
export const RESTORE_STAGING = 'restore-staging',
  RESTORE_PREVIOUS = 'restore-previous',
  RESTORE_PENDING = 'restore-pending.json',
  RESTORE_RESULT = 'restore-result.json',
  BACKUP_TEMP = 'backup-temp';

const LOCAL = new Set([
  // The work computer and what can be downloaded again.
  'vm',
  'downloads',
  'models',
  'laya-runtime',
  // Caches.
  'font-cache',
  'design-system-cache',
  'opened-files',
  // Logs.
  'events.jsonl',
  'laya-decisions.jsonl',
  // Tied to this installation.
  'update-launch-context.json',
  'release-notes-seen.json',
  'headless.lock',
  // Chromium files that happen to look like the app's.
  'lockfile',
  'databases',
  RESTORE_STAGING,
  RESTORE_PREVIOUS,
  RESTORE_PENDING,
  RESTORE_RESULT,
  BACKUP_TEMP,
]);
const DERIVED_TOP = new Set([
  'state.json',
  'history-recovery-backups',
  'group-context-backups',
  // The knowledge index is rebuilt from the sources; which knowledge bases there are is part of the app state.
  'knowledge.sqlite',
]);
/** Files that only mean something beside the file they belong to, at any depth. */
const DERIVED_FILE = /(\.sqlite-(wal|shm|journal)|\.tmp|\.partial)$/;

type EntryKind = 'data' | 'derived' | 'local';

/** How a restore and a backup treat a top-level name of the data directory. */
export function topLevelKind(name: string): EntryKind {
  // A backup saved into the data directory is the person's file, not data.
  if (!APP_NAME.test(name) || LOCAL.has(name) || /^diagnostic-events\.jsonl|\.aelionbackup(\.partial)?$/.test(name))
    return 'local';
  // Old migrations left copies of the state named *-backup.json.
  if (DERIVED_TOP.has(name) || DERIVED_FILE.test(name) || name.endsWith('-backup.json')) return 'derived';
  return 'data';
}
/** Whether a path inside the data directory (forward slashes) is part of a backup. */
export function archived(relativePath: string) {
  const segments = relativePath.split('/');
  return topLevelKind(segments[0]) === 'data' && !DERIVED_FILE.test(segments[segments.length - 1]);
}

interface PlannedFile {
  /** `data/…` or `config/…`, forward slashes. */
  path: string;
  source: string;
  size: number;
  mtimeMs: number;
  mode: number;
  /** A SQLite database: copied from a consistent snapshot instead of the live file. */
  sqlite: boolean;
}

/** The files under `root`, skipping what `keep` rejects (it sees top-level names first, then every file). */
async function* walk(
  root: string,
  keep: (relative: string, top: boolean) => boolean,
  inside = '',
): AsyncGenerator<{ relative: string; source: string }> {
  let dir;
  try {
    dir = await opendir(inside ? join(root, inside) : root);
  } catch {
    return;
  }
  for await (const item of dir) {
    const path = inside ? inside + '/' + item.name : item.name;
    // Links are not followed: a backup holds what is in the folder, not what it points at.
    if (item.isSymbolicLink() || (!inside && !keep(path, true))) continue;
    if (item.isDirectory()) yield* walk(root, keep, path);
    else if (item.isFile() && keep(path, false)) yield { relative: path, source: join(root, ...path.split('/')) };
  }
}

const within = (root: string, path: string) => {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Every file a backup of these folders holds, with the sizes they have now. */
export async function planBackup(dataDir: string, configDir?: string) {
  const files: PlannedFile[] = [];
  let bytes = 0;
  const add = async (path: string, source: string) => {
    let info;
    try {
      info = await lstat(source);
    } catch {
      return;
    }
    if (!info.isFile()) return;
    files.push({
      path,
      source,
      size: info.size,
      mtimeMs: info.mtimeMs,
      mode: info.mode & 0o777,
      sqlite: source.endsWith('.sqlite'),
    });
    bytes += info.size;
  };
  for await (const file of walk(dataDir, (path, top) => (top ? topLevelKind(path) === 'data' : archived(path))))
    await add('data/' + file.relative, file.source);
  // A configuration folder inside the data directory is already part of it.
  if (configDir && !within(dataDir, configDir))
    for await (const file of walk(configDir, (path) => !DERIVED_FILE.test(path)))
      await add('config/' + file.relative, file.source);
  return { files, bytes };
}
