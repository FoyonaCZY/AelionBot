import { readFile, writeFile } from 'node:fs/promises';
import { dialog } from 'electron';
import { AppError } from '../../shared/errors';
import type { IpcContext } from './context';

const id = (value: unknown) => {
  if (typeof value !== 'string' || !value) throw new AppError('memory.not_found', '这条记忆已不存在');
  return value;
};
export function registerMemory(ctx: IpcContext) {
  const { handle } = ctx;
  handle('memoryOverview', () => ctx.memoryAdmin.overview());
  handle('memoryList', (query) => ctx.memoryAdmin.list(query || {}));
  handle('memoryDetail', (value) => ctx.memoryAdmin.detail(id(value)));
  handle('memoryUpdate', (input) => {
    const saved = ctx.memoryAdmin.update(input);
    ctx.changed();
    return saved;
  });
  handle('memoryForget', (value) => {
    ctx.memoryAdmin.forget(id(value));
    ctx.changed();
  });
  handle('memoryConfirm', (value) => {
    ctx.memoryAdmin.confirm(id(value));
    ctx.changed();
  });
  handle('memoryReject', (value) => {
    ctx.memoryAdmin.reject(id(value));
    ctx.changed();
  });
  handle('memoryTimeline', (query) => ctx.memoryAdmin.timeline(query || {}));
  handle('memoryUndoJob', (value) => {
    const result = ctx.memoryAdmin.undoJob(id(value));
    ctx.changed();
    return result;
  });
  handle('memorySetBotOptions', (input) => {
    ctx.memoryAdmin.setBotOptions(input);
    ctx.changed();
  });
  handle('memoryBotOptions', (botId) => ({
    shareUser: ctx.cognition.memory.sharesUser(String(botId)),
    mode: ctx.cognition.memory.mode(String(botId)),
  }));

  handle('setMemoryModel', (selection) => {
    ctx.providers.setMemoryModel(selection);
    ctx.changed();
  });
  handle('memorySetEmbedding', async (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('无效设置');
    await ctx.memoryAdmin.embedder?.setEnabled(enabled);
    ctx.changed();
  });
  handle('memoryPastEstimate', () => ctx.memoryAdmin.pastEstimate());
  handle('memoryReadPast', () => ctx.memoryAdmin.readPast());
  handle('memoryExport', async () => {
    const options = {
      defaultPath: 'aelion-memories.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const choice = ctx.window ? await dialog.showSaveDialog(ctx.window, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return null;
    await writeFile(choice.filePath, ctx.memoryAdmin.exportData(), 'utf8');
    return choice.filePath;
  });
  handle('memoryImport', async (scope) => {
    const options = {
      properties: ['openFile' as const],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const choice = ctx.window ? await dialog.showOpenDialog(ctx.window, options) : await dialog.showOpenDialog(options);
    if (choice.canceled || !choice.filePaths[0]) return null;
    const result = ctx.memoryAdmin.importData(await readFile(choice.filePaths[0], 'utf8'), String(scope));
    ctx.changed();
    return result;
  });
}
