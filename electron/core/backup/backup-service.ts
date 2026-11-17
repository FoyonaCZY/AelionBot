// Settings → 数据: writes backups, prepares restores and looks after the data a restore replaced. One backup or
// restore runs at a time; the page asks for its progress while it lasts.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { AppError } from '../../../shared/errors';
import type { BackupInfo, BackupOverview, BackupProgress } from '../../../shared/types/backup-types';
import { planBackup } from './backup-rules';
import type { SecretCodec } from './backup-secrets';
import {
  lastRestore,
  previousCopies,
  readManifest,
  removePreviousCopy,
  stageRestore,
  writeBackup,
  type BackupManifest,
} from './data-backup';

const password = (value: unknown) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 256) throw new AppError('backup.password_invalid', '密码无效');
  return value;
};

export class DataBackup {
  private job?: BackupProgress & { abort: AbortController };
  /** Backup files the person picked, by the ID the page was given. */
  private picked = new Map<string, { path: string; manifest: BackupManifest }>();
  constructor(
    private deps: {
      dataDir: string;
      configDir: string;
      appVersion: string;
      codec: SecretCodec;
      /** Writes pending state to disk, so the backup holds what the app shows. */
      flush: () => void;
      /** Quits and starts the app again; the restore is put in place as it starts. */
      restart: () => void;
    },
  ) {}
  async overview(): Promise<BackupOverview> {
    const plan = await planBackup(this.deps.dataDir, this.deps.configDir),
      last = lastRestore(this.deps.dataDir);
    return {
      bytes: plan.bytes,
      files: plan.files.length,
      copies: previousCopies(this.deps.dataDir),
      ...(last ? { lastRestore: { at: last.at, ok: last.ok, backupCreatedAt: last.backupCreatedAt } } : {}),
    };
  }
  progress(): BackupProgress | null {
    return this.job ? { kind: this.job.kind, done: this.job.done, total: this.job.total } : null;
  }
  cancel() {
    this.job?.abort.abort();
  }
  private async run<T>(kind: BackupProgress['kind'], work: (job: NonNullable<DataBackup['job']>) => Promise<T>) {
    if (this.job) throw new AppError('backup.busy', '正在处理另一个备份，请稍候');
    const job = (this.job = { kind, done: 0, total: 0, abort: new AbortController() });
    try {
      return await work(job);
    } finally {
      this.job = undefined;
    }
  }
  /** Writes a backup to `target`. With a password, API keys and sign-ins go with it. */
  export(target: string, secret?: unknown) {
    const key = password(secret);
    return this.run('export', async (job) => {
      this.deps.flush();
      const written = await writeBackup({
        dataDir: this.deps.dataDir,
        configDir: this.deps.configDir,
        target,
        appVersion: this.deps.appVersion,
        device: hostname(),
        password: key,
        codec: this.deps.codec,
        signal: job.abort.signal,
        onProgress: (done, total) => Object.assign(job, { done, total }),
      });
      return { path: target, bytes: written.archiveBytes };
    });
  }
  /** Reads what a backup file says about itself and remembers the file for restore(). */
  async inspect(path: string): Promise<BackupInfo> {
    const manifest = await readManifest(path),
      id = randomUUID();
    this.picked.clear();
    this.picked.set(id, { path, manifest });
    return {
      id,
      name: basename(path),
      createdAt: manifest.createdAt,
      appVersion: manifest.appVersion,
      device: manifest.device,
      bytes: (await stat(path)).size,
      secrets: manifest.secrets,
    };
  }
  /** Unpacks the picked backup beside the data and restarts the app, which puts it in place. */
  restore(input: { id: string; password?: unknown; skipSecrets?: unknown }) {
    const picked = this.picked.get(String(input?.id));
    if (!picked) throw new AppError('backup.not_picked', '请重新选择备份文件');
    const key = password(input.password);
    return this.run('restore', async (job) => {
      await stageRestore({
        file: picked.path,
        dataDir: this.deps.dataDir,
        configDir: this.deps.configDir,
        appVersion: this.deps.appVersion,
        codec: this.deps.codec,
        password: key,
        skipSecrets: input.skipSecrets === true,
        signal: job.abort.signal,
        onProgress: (done, total) => Object.assign(job, { done, total }),
      });
      this.picked.clear();
      this.deps.restart();
    });
  }
  copy(id: string) {
    const found = previousCopies(this.deps.dataDir).find((item) => item.id === id);
    if (!found) throw new AppError('backup.copy_not_found', '这份数据已经不在了');
    return found;
  }
  removeCopy(id: string) {
    return removePreviousCopy(this.deps.dataDir, this.copy(id).id);
  }
}
