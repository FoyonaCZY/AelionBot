// Backups of the app's data: one .aelionbackup file (a gzipped tar) with everything a restore needs, and the restore
// itself. A restore runs in two steps because the running app holds the files it would replace:
//   1. stageRestore, while the app runs: checks the backup, unpacks it into a folder beside the data and makes its
//      secrets readable here, then leaves a marker.
//   2. applyPendingRestore, at the next start before anything is opened: moves the current data aside and the
//      unpacked data in. The data it replaced is kept; a failure moves everything back.
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { mkdir, open, rename, rm, stat, utimes, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable, pipeline as pipe } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { AppError } from '../../../shared/errors';
import { compareVersions } from '../../../shared/version';
import { atomicJson } from '../storage/store';
import {
  BACKUP_TEMP,
  RESTORE_PENDING,
  RESTORE_PREVIOUS,
  RESTORE_RESULT,
  RESTORE_STAGING,
  archived,
  planBackup,
  topLevelKind,
} from './backup-rules';
import {
  collectSecrets,
  openSecrets,
  rewrapSecrets,
  sealSecrets,
  type SealedSecrets,
  type SecretCodec,
} from './backup-secrets';
import { snapshotSqlite } from './sqlite-snapshot';
import { invalidBackup, tar, untar, type TarEntry, type TarFile } from './tar';

export const BACKUP_EXTENSION = 'aelionbackup';

export interface BackupManifest {
  format: 'aelion-backup';
  version: 1;
  appVersion: string;
  createdAt: string;
  platform: string;
  /** The computer it was made on. */
  device: string;
  files: number;
  bytes: number;
  /** API keys and sign-ins are inside, sealed with a password. */
  secrets: boolean;
}
type Progress = (done: number, total: number) => void;

const invalid = invalidBackup;
const cancelled = () => new AppError('backup.cancelled', '已取消');
const pathKey = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const CHUNK = 256 * 1024;

/** Exactly `size` bytes of an open file. A file that shrank meanwhile is filled up with zeros. */
async function* exactly(handle: FileHandle, size: number, read: (bytes: number) => void): AsyncGenerator<Buffer> {
  let position = 0;
  while (position < size) {
    const chunk = Buffer.alloc(Math.min(CHUNK, size - position)),
      { bytesRead } = await handle.read(chunk, 0, chunk.length, position),
      part = bytesRead ? chunk.subarray(0, bytesRead) : chunk;
    position += part.length;
    read(part.length);
    yield part;
  }
}

/** Writes a backup of `dataDir` (and the configuration folder) to `target`. */
export async function writeBackup(options: {
  dataDir: string;
  configDir?: string;
  target: string;
  appVersion: string;
  device: string;
  /** With a password and a codec, secrets are added sealed with the password. */
  password?: string;
  codec?: SecretCodec;
  onProgress?: Progress;
  signal?: AbortSignal;
  now?: Date;
}) {
  const { dataDir, target, signal } = options,
    partial = target + '.partial',
    temp = join(dataDir, BACKUP_TEMP, randomUUID()),
    now = options.now || new Date();
  await mkdir(temp, { recursive: true });
  try {
    const own = new Set([pathKey(target), pathKey(partial)]),
      files = (await planBackup(dataDir, options.configDir)).files.filter((file) => !own.has(pathKey(file.source)));
    // Databases in use are copied first, so each is one consistent snapshot and its size is known.
    let copies = 0;
    for (const file of files) {
      if (!file.sqlite) continue;
      if (signal?.aborted) throw cancelled();
      const copy = join(temp, copies++ + '.sqlite');
      try {
        await snapshotSqlite(file.source, copy);
        file.size = (await stat(copy)).size;
        file.source = copy;
      } catch {
        // Not a database SQLite can read: take the file as it is.
        await rm(copy, { force: true });
      }
    }
    const total = files.reduce((sum, file) => sum + file.size, 0);
    let sealed: SealedSecrets | undefined;
    if (options.password && options.codec) {
      const state = files.find((file) => file.path === 'data/state.sqlite')?.source;
      sealed = await sealSecrets(
        collectSecrets((name) => (name === 'state.sqlite' ? state : join(dataDir, name)), options.codec),
        options.password,
      );
    }
    const manifest: BackupManifest = {
      format: 'aelion-backup',
      version: 1,
      appVersion: options.appVersion,
      createdAt: now.toISOString(),
      platform: process.platform,
      device: options.device,
      files: files.length,
      bytes: total,
      secrets: Boolean(sealed),
    };
    let done = 0,
      written = 0,
      writtenBytes = 0,
      skipped = 0;
    const json = (path: string, value: unknown): TarFile => {
      const bytes = Buffer.from(JSON.stringify(value, null, 2));
      return {
        path,
        size: bytes.length,
        mtime: Math.floor(now.getTime() / 1000),
        mode: 0o600,
        body: async function* () {
          yield bytes;
        },
      };
    };
    const entries = async function* (): AsyncGenerator<TarFile> {
      yield json('manifest.json', manifest);
      if (sealed) yield json('secrets.json', sealed);
      for (const file of files) {
        if (signal?.aborted) throw cancelled();
        let handle: FileHandle;
        try {
          handle = await open(file.source, 'r');
        } catch {
          // Deleted since the files were listed.
          skipped++;
          options.onProgress?.((done += file.size), total);
          continue;
        }
        try {
          const size = (await handle.stat()).size;
          yield {
            path: file.path,
            size,
            mtime: Math.floor(file.mtimeMs / 1000),
            mode: file.mode || 0o600,
            body: () => exactly(handle, size, (bytes) => options.onProgress?.(Math.min((done += bytes), total), total)),
          };
          written++;
          writtenBytes += size;
        } finally {
          await handle.close();
        }
      }
      // The last entry: a file without it was cut short.
      yield json('complete.json', { files: written, bytes: writtenBytes });
    };
    await pipeline(
      Readable.from(tar(entries()), { objectMode: false }),
      createGzip({ level: 4 }),
      createWriteStream(partial, { mode: 0o600 }),
      { signal },
    );
    await rename(partial, target);
    return { manifest, archiveBytes: (await stat(target)).size, skipped };
  } catch (error) {
    await rm(partial, { force: true });
    throw signal?.aborted ? cancelled() : error;
  } finally {
    await rm(temp, { recursive: true, force: true });
    try {
      if (!readdirSync(join(dataDir, BACKUP_TEMP)).length) rmSync(join(dataDir, BACKUP_TEMP), { recursive: true });
    } catch {
      /* Another backup is using it, or it is already gone. */
    }
  }
}

/** The bytes inside a backup file. */
async function* unpacked(file: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const gunzip = createGunzip();
  pipe(createReadStream(file), gunzip, () => {});
  try {
    for await (const chunk of gunzip) {
      if (signal?.aborted) throw cancelled();
      yield chunk as Buffer;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code || '';
    throw code.startsWith('Z_') || code === 'ERR_STREAM_PREMATURE_CLOSE' ? invalid('文件不完整或格式不对') : error;
  } finally {
    gunzip.destroy();
  }
}
async function contents(entry: TarEntry, limit: number) {
  if (entry.size > limit) throw invalid(entry.path + ' 过大');
  const parts: Buffer[] = [];
  for await (const chunk of entry.body()) parts.push(chunk);
  return Buffer.concat(parts);
}
function parseJson(bytes: Buffer, name: string): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* Reported below. */
  }
  throw invalid(name + ' 无效');
}
function parseManifest(bytes: Buffer): BackupManifest {
  const value = parseJson(bytes, 'manifest.json');
  if (value.format !== 'aelion-backup') throw invalid('不是备份文件');
  if (typeof value.version !== 'number' || value.version > 1)
    throw new AppError('backup.newer', '这个备份来自更新的版本，请先更新 AelionBot 再恢复');
  if (
    typeof value.appVersion !== 'string' ||
    typeof value.createdAt !== 'string' ||
    Number.isNaN(Date.parse(value.createdAt))
  )
    throw invalid('manifest.json 无效');
  return {
    format: 'aelion-backup',
    version: 1,
    appVersion: value.appVersion.slice(0, 40),
    createdAt: value.createdAt,
    platform: typeof value.platform === 'string' ? value.platform.slice(0, 40) : '',
    device: typeof value.device === 'string' ? value.device.slice(0, 120) : '',
    files: Number(value.files) || 0,
    bytes: Number(value.bytes) || 0,
    secrets: value.secrets === true,
  };
}

/** What a backup file says about itself, without unpacking it. */
export async function readManifest(file: string): Promise<BackupManifest> {
  for await (const entry of untar(unpacked(file))) {
    if (entry.path !== 'manifest.json') break;
    return parseManifest(await contents(entry, 64 * 1024));
  }
  throw invalid('缺少 manifest.json');
}

/** A path from an archive as segments, or undefined when it could lead outside the folder it is unpacked into. */
function safeSegments(path: string) {
  const segments = path.split('/');
  if (
    !path ||
    path.length > 1024 ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || /^[a-z]:/i.test(segment))
  )
    return undefined;
  return segments;
}
/** Names this system cannot create. Only Windows is picky; such a file is left out of the restore. */
const creatable = (segments: string[]) =>
  process.platform !== 'win32' ||
  segments.every(
    (segment) =>
      !/[<>:"|?*\u0000-\u001f]/.test(segment) &&
      !/[. ]$/.test(segment) &&
      !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(segment),
  );

interface PendingRestore {
  version: 1;
  id: string;
  /** The unpacked backup, relative to the data directory. */
  staging: string;
  /** Where its `config` part goes; absent when the backup has none. */
  configDir?: string;
  createdAt: string;
  backup: { createdAt: string; appVersion: string; device: string };
  /**
   * How far the swap got, so a start that was cut off continues instead of starting over: `out` moves the current
   * data aside, `in` moves the backup in. After a failure, `clear` removes what was moved in and `back` returns
   * the data that was moved aside.
   */
  phase: 'ready' | 'out' | 'in' | 'clear' | 'back';
  /** The folder under restore-previous that receives the replaced data. */
  previous?: string;
  attempts?: number;
  error?: string;
}

/**
 * Checks a backup and unpacks it beside the data, ready for the next start to put in place. Secrets sealed with a
 * password are opened with it and encrypted again for this computer.
 */
export async function stageRestore(options: {
  file: string;
  dataDir: string;
  configDir?: string;
  appVersion: string;
  codec?: SecretCodec;
  password?: string;
  /** Restore a backup that holds sealed secrets without them. */
  skipSecrets?: boolean;
  onProgress?: Progress;
  signal?: AbortSignal;
  now?: Date;
}) {
  const { dataDir, file, signal } = options,
    id = randomUUID(),
    root = join(dataDir, RESTORE_STAGING),
    staging = join(root, id);
  // One restore waits at a time: an earlier one that never ran is dropped.
  await rm(join(dataDir, RESTORE_PENDING), { force: true });
  await rm(root, { recursive: true, force: true });
  await mkdir(join(staging, 'data'), { recursive: true });
  try {
    let manifest: BackupManifest | undefined,
      plain: Record<string, string> = {},
      complete = false,
      hasConfig = false,
      done = 0,
      skipped = 0;
    for await (const entry of untar(unpacked(file, signal))) {
      if (!manifest) {
        if (entry.path !== 'manifest.json') throw invalid('缺少 manifest.json');
        manifest = parseManifest(await contents(entry, 64 * 1024));
        if (compareVersions(manifest.appVersion, options.appVersion) > 0)
          throw new AppError('backup.newer', '这个备份来自更新的版本，请先更新 AelionBot 再恢复');
        if (manifest.secrets && !options.password && !options.skipSecrets)
          throw new AppError('backup.password_required', '这个备份设了密码，请输入密码');
        continue;
      }
      if (entry.type !== 'file') continue;
      if (entry.path === 'secrets.json') {
        const sealed = parseJson(await contents(entry, 16 * 1024 * 1024), 'secrets.json') as unknown as SealedSecrets;
        if (options.password && !options.skipSecrets) plain = await openSecrets(sealed, options.password);
        continue;
      }
      if (entry.path === 'complete.json') {
        complete = true;
        continue;
      }
      const segments = safeSegments(entry.path),
        part = segments?.[0];
      if (!segments || segments.length < 2 || (part !== 'data' && part !== 'config'))
        throw invalid('包含不该有的文件 ' + entry.path.slice(0, 200));
      // Only what a backup would hold is accepted, so a crafted file cannot plant anything else in the profile.
      if (part === 'data' && !archived(segments.slice(1).join('/')))
        throw invalid('包含不该有的文件 ' + entry.path.slice(0, 200));
      if (part === 'config') hasConfig = true;
      if (!creatable(segments)) {
        skipped++;
        options.onProgress?.((done += entry.size), manifest.bytes);
        continue;
      }
      const target = join(staging, ...segments);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(
        Readable.from(entry.body(), { objectMode: false }),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            options.onProgress?.(Math.min((done += chunk.length), manifest!.bytes), manifest!.bytes);
            yield chunk;
          }
        },
        createWriteStream(target, { mode: entry.mode ? (entry.mode & 0o777) | 0o600 : 0o600 }),
      );
      if (entry.mtime > 0) await utimes(target, entry.mtime, entry.mtime).catch(() => {});
    }
    if (!manifest) throw invalid('缺少 manifest.json');
    if (!complete) throw invalid('文件不完整');
    if (signal?.aborted) throw cancelled();
    const secrets = options.codec
      ? rewrapSecrets((name) => join(staging, 'data', name), options.codec, plain)
      : { rewrapped: 0, unreadable: 0 };
    const pending: PendingRestore = {
      version: 1,
      id,
      staging: RESTORE_STAGING + '/' + id,
      ...(hasConfig && options.configDir ? { configDir: resolve(options.configDir) } : {}),
      createdAt: (options.now || new Date()).toISOString(),
      backup: { createdAt: manifest.createdAt, appVersion: manifest.appVersion, device: manifest.device },
      phase: 'ready',
    };
    atomicJson(join(dataDir, RESTORE_PENDING), pending);
    return { manifest, skipped, unreadableSecrets: secrets.unreadable };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw signal?.aborted ? cancelled() : error;
  }
}

export interface RestoreOutcome {
  ok: boolean;
  at: string;
  backupCreatedAt?: string;
  /** The replaced data, relative to the data directory. */
  previous?: string;
  error?: string;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Moves a file or folder; across volumes it is copied. Windows scanners hold files briefly, so busy ones retry. */
function move(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt++)
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true, preserveTimestamps: true });
        rmSync(from, { recursive: true, force: true });
        return;
      }
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(code || '') || attempt >= 20) throw error;
      sleep(150);
    }
}
const names = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

/**
 * Puts a prepared restore in place. Call it at startup before anything in the data directory is opened. Returns
 * undefined when no restore was waiting. The data it replaces is kept under restore-previous; when a step fails,
 * what was moved in is removed, the data is moved back and the outcome says so.
 */
export function applyPendingRestore(dataDir: string, now = new Date()): RestoreOutcome | undefined {
  const marker = join(dataDir, RESTORE_PENDING);
  if (!existsSync(marker)) return;
  const finish = (outcome: RestoreOutcome) => {
    rmSync(marker, { force: true });
    rmSync(join(dataDir, RESTORE_STAGING), { recursive: true, force: true });
    try {
      atomicJson(join(dataDir, RESTORE_RESULT), outcome);
    } catch {
      /* Only the settings page reads it. */
    }
    return outcome;
  };
  let pending: PendingRestore;
  try {
    pending = JSON.parse(readFileSync(marker, 'utf8'));
    if (pending.version !== 1 || !/^restore-staging\/[0-9a-f-]{36}$/.test(pending.staging)) throw new Error();
  } catch {
    return finish({ ok: false, at: now.toISOString(), error: '恢复标记无效' });
  }
  const outcome = (ok: boolean, error?: string): RestoreOutcome => ({
    ok,
    at: now.toISOString(),
    backupCreatedAt: pending.backup?.createdAt,
    ...(ok ? { previous: RESTORE_PREVIOUS + '/' + pending.previous } : {}),
    ...(error ? { error } : {}),
  });
  const staging = join(dataDir, ...pending.staging.split('/')),
    configDir = pending.configDir && isAbsolute(pending.configDir) ? pending.configDir : undefined;
  if (pending.phase === 'ready' && !existsSync(join(staging, 'data')))
    return finish(outcome(false, '找不到解包后的备份'));
  // A start that keeps failing must not lock the person out of the app.
  if ((pending.attempts || 0) >= 3)
    return finish(outcome(false, '多次尝试后仍未完成，原来的数据在 ' + join(dataDir, RESTORE_PREVIOUS)));
  pending.attempts = (pending.attempts || 0) + 1;
  pending.previous ||= now.toISOString().replace(/[:.]/g, '-');
  const previous = join(dataDir, RESTORE_PREVIOUS, pending.previous),
    save = (phase: PendingRestore['phase']) => {
      pending.phase = phase;
      atomicJson(marker, pending);
    },
    /** The two folders a restore replaces, with the part of the backup and of the kept copy each belongs to. */
    targets: Array<[part: string, target: string]> = [
      ['data', dataDir],
      ...(configDir ? [['config', configDir] as [string, string]] : []),
    ],
    /** What a restore replaces in a target: everything in the configuration folder, the app's own data in the other. */
    replaced = (part: string, target: string) =>
      names(target).filter((name) => part === 'config' || topLevelKind(name) !== 'local');
  const swap = () => {
    if (pending.phase !== 'in') {
      save('out');
      for (const [part, target] of targets)
        for (const name of replaced(part, target)) move(join(target, name), join(previous, part, name));
      save('in');
    }
    for (const [part, target] of targets)
      for (const name of names(join(staging, part))) {
        // Left by a copy that was cut off.
        rmSync(join(target, name), { recursive: true, force: true });
        move(join(staging, part, name), join(target, name));
      }
  };
  const undo = () => {
    if (pending.phase === 'in' || pending.phase === 'clear') {
      save('clear');
      for (const [part, target] of targets)
        for (const name of replaced(part, target)) rmSync(join(target, name), { recursive: true, force: true });
    }
    save('back');
    for (const [part, target] of targets)
      for (const name of names(join(previous, part))) {
        rmSync(join(target, name), { recursive: true, force: true });
        move(join(previous, part, name), join(target, name));
      }
    rmSync(previous, { recursive: true, force: true });
    try {
      if (!names(join(dataDir, RESTORE_PREVIOUS)).length) rmSync(join(dataDir, RESTORE_PREVIOUS), { recursive: true });
    } catch {
      /* Not empty after all. */
    }
  };
  let failure = pending.phase === 'clear' || pending.phase === 'back' ? pending.error || '恢复没有完成' : undefined;
  if (failure === undefined)
    try {
      swap();
    } catch (error) {
      failure = pending.error = (error as Error).message;
    }
  if (failure === undefined) return finish(outcome(true));
  try {
    undo();
  } catch (error) {
    // The marker keeps the phase: the next start continues putting the data back.
    throw new Error(
      `从备份恢复时出错，也没能把原来的数据放回去。原来的数据在 ${previous}。（${failure}；${(error as Error).message}）`,
    );
  }
  return finish(outcome(false, failure));
}

/** The result of the last restore, for the settings page. */
export function lastRestore(dataDir: string): RestoreOutcome | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, RESTORE_RESULT), 'utf8')) as RestoreOutcome;
    return typeof value.ok === 'boolean' && typeof value.at === 'string' ? value : undefined;
  } catch {
    return;
  }
}
/** The data sets earlier restores replaced, newest first. */
export function previousCopies(dataDir: string) {
  const root = join(dataDir, RESTORE_PREVIOUS);
  return names(root)
    .filter((name) => /^[0-9TZ-]+$/.test(name))
    .flatMap((name) => {
      try {
        const created = name.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z');
        return statSync(join(root, name)).isDirectory() && !Number.isNaN(Date.parse(created))
          ? [{ id: name, path: join(root, name), createdAt: created }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}
export async function removePreviousCopy(dataDir: string, id: string) {
  if (!/^[0-9TZ-]+$/.test(id)) throw new AppError('backup.copy_not_found', '这份数据已经不在了');
  await rm(join(dataDir, RESTORE_PREVIOUS, id), { recursive: true, force: true });
  try {
    if (!names(join(dataDir, RESTORE_PREVIOUS)).length) rmSync(join(dataDir, RESTORE_PREVIOUS), { recursive: true });
  } catch {
    /* Not empty after all. */
  }
}
