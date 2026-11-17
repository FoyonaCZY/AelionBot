import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog, shell } from 'electron';
import { AppError } from '../../shared/errors';
import type { BotFilePreview } from '../../shared/types/backup-types';
import {
  BOT_FILE_EXTENSION,
  memoryCount,
  packBotFile,
  unpackBotFile,
  type BotFileContent,
} from '../core/backup/bot-file';
import { exportBotContent, importBotContent, localModel, type BotTransferDeps } from '../core/backup/bot-transfer';
import { BACKUP_EXTENSION } from '../core/backup/data-backup';
import type { IpcContext } from './context';

/** A name the file system accepts everywhere. */
const fileName = (name: string) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'Bot';

export function registerBackup(ctx: IpcContext) {
  const { handle } = ctx;
  const backup = () => {
    if (!ctx.dataBackup) throw new AppError('app.starting', '应用仍在启动，请稍后再试');
    return ctx.dataBackup;
  };
  const saveDialog = (options: Electron.SaveDialogOptions) =>
    ctx.window ? dialog.showSaveDialog(ctx.window, options) : dialog.showSaveDialog(options);
  const openDialog = (options: Electron.OpenDialogOptions) =>
    ctx.window ? dialog.showOpenDialog(ctx.window, options) : dialog.showOpenDialog(options);

  // ---- Data backup ----
  handle('backupOverview', () => backup().overview());
  handle('backupProgress', () => ctx.dataBackup?.progress() ?? null);
  handle('cancelBackup', () => ctx.dataBackup?.cancel());
  handle('exportBackup', async (input) => {
    const service = backup(),
      choice = await saveDialog({
        defaultPath: join(
          app.getPath('documents'),
          `AelionBot-backup-${new Date().toISOString().slice(0, 10)}.${BACKUP_EXTENSION}`,
        ),
        filters: [{ name: 'AelionBot Backup', extensions: [BACKUP_EXTENSION] }],
      });
    if (choice.canceled || !choice.filePath) return null;
    return service.export(choice.filePath, input?.password);
  });
  handle('pickBackup', async () => {
    const service = backup(),
      choice = await openDialog({
        properties: ['openFile'],
        filters: [{ name: 'AelionBot Backup', extensions: [BACKUP_EXTENSION] }],
      });
    if (choice.canceled || !choice.filePaths[0]) return null;
    return service.inspect(choice.filePaths[0]);
  });
  handle('restoreBackup', (input) => backup().restore(input));
  handle('removeBackupCopy', (id) => backup().removeCopy(String(id)));
  handle('openBackupCopy', async (id) => {
    const issue = await shell.openPath(backup().copy(String(id)).path);
    if (issue) throw new Error(issue);
  });

  // ---- Bot files ----
  /** The Bot file the person picked, by the ID the page was given. */
  const picked = new Map<string, BotFileContent>();
  const transfer = (): BotTransferDeps => ({
    store: ctx.store,
    dataDir: ctx.dataDir,
    skills: ctx.integrations.skills,
    providers: ctx.providers,
    persona: ctx.persona,
    memory: ctx.memoryAdmin,
  });
  handle('exportBot', async (input) => {
    const bot = ctx.store.bot(String(input?.botId)),
      bytes = packBotFile(exportBotContent(transfer(), bot.id, input?.memories === true), {
        appVersion: app.getVersion(),
        exportedAt: new Date().toISOString(),
      });
    const choice = await saveDialog({
      defaultPath: join(app.getPath('documents'), `${fileName(bot.name)}.${BOT_FILE_EXTENSION}`),
      filters: [{ name: 'AelionBot Bot', extensions: [BOT_FILE_EXTENSION] }],
    });
    if (choice.canceled || !choice.filePath) return null;
    await writeFile(choice.filePath, bytes);
    return choice.filePath;
  });
  handle('pickBotFile', async (): Promise<BotFilePreview | null> => {
    const choice = await openDialog({
      properties: ['openFile'],
      filters: [{ name: 'AelionBot Bot', extensions: [BOT_FILE_EXTENSION] }],
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    if ((await stat(choice.filePaths[0])).size > 48 * 1024 * 1024)
      throw new AppError('bot_file.too_large', 'Bot 文件超过 48 MB');
    const content = unpackBotFile(await readFile(choice.filePaths[0])),
      id = randomUUID();
    picked.clear();
    picked.set(id, content);
    return {
      id,
      name: content.name,
      soul: content.soul,
      palette: content.palette,
      skills: content.skills.map(({ name, description }) => ({ name, description })),
      memories: memoryCount(content.memories),
      persona: Boolean(content.persona),
      ...(content.model
        ? {
            model: {
              provider: content.model.provider,
              model: content.model.model,
              available: Boolean(localModel(transfer(), content.model)),
            },
          }
        : {}),
    };
  });
  handle('importBot', (input) => {
    const content = picked.get(String(input?.id));
    if (!content) throw new AppError('bot_file.not_picked', '请重新选择 Bot 文件');
    const bot = importBotContent(transfer(), content, input?.memories === true);
    picked.clear();
    ctx.changed();
    void ctx.greetings?.greet(bot.id);
    return bot;
  });
}
