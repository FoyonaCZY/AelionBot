import { PreviewFileOpener } from '../core/preview/preview-open';
import { choosePreviewApplication } from '../windows/preview-open';
import { prepareDesignHtml } from '../core/designer/design-export';
import { editedBytes } from '../core/preview/preview-editing';
import { sourceTextFile } from '../../shared/preview/source-language';
import { dialog, shell } from 'electron';
import { join, basename } from 'node:path';
import { writeFileSync } from 'node:fs';
import { safeRelativePath } from '../core/agent/harness';
import { writeFile } from 'node:fs/promises';
import type { IpcContext } from './context';

export function registerFiles(ctx: IpcContext) {
  const { handle } = ctx;
  handle('listFiles', async (botId) => {
    const id = String(botId);
    const files = await ctx.artifacts.list(id);
    if (ctx.artifacts.importKnown(id, files)) ctx.changed();
    return files;
  });
  handle('previewFile', async (input) => ctx.artifacts.preview(String(input?.botId), String(input?.path)));
  handle('setPreviewDirty', (dirty) => {
    if (typeof dirty !== 'boolean') throw Error('无效编辑状态');
    ctx.previewDirty = dirty;
  });
  handle('readEditableFile', (input) => ctx.artifacts.readEditable(String(input?.botId), String(input?.path)));
  handle('saveEditableFile', async (input) => {
    ctx.previewWrites++;
    try {
      const saved = await ctx.artifacts.saveEditable(String(input?.botId), String(input?.path), input?.edit);
      ctx.designStore.userEdit(String(input.botId), String(input.path), saved.revision);
      return saved;
    } finally {
      ctx.previewWrites--;
    }
  });
  handle('exportEditedText', async (input) => {
    if (typeof input?.name !== 'string' || input.name.length > 256 || !sourceTextFile(input.name))
      throw Error('无效文件名称');
    const bytes = editedBytes(input.content);
    ctx.previewWrites++;
    try {
      const target = await dialog.showSaveDialog(ctx.window!, {
        title: '保存编辑后的文件',
        defaultPath: basename(input.name),
      });
      if (target.canceled || !target.filePath) return null;
      await writeFile(target.filePath, bytes);
      return target.filePath;
    } finally {
      ctx.previewWrites--;
    }
  });

  handle('listWorkspaceDirectory', (input) => {
    if (typeof input?.botId !== 'string' || (input.path !== undefined && typeof input.path !== 'string'))
      throw Error('无效目录请求');
    return ctx.artifacts.directory(input.botId, input.path || '');
  });
  const previewOpener = new PreviewFileOpener({
    cacheDir: join(ctx.store.dir, 'opened-files'),
    open: (path) => shell.openPath(path),
    choose: (path) => choosePreviewApplication(ctx.window!, path),
    reveal: (path) => shell.showItemInFolder(path),
    resolve: async (target) => {
      if (target.kind === 'attachment') {
        const original = ctx.attachments.originalPath(target.id);
        if (original) return { path: original };
        const file = ctx.attachments.metadata(target.id);
        return { name: file.name, bytes: ctx.attachments.bytes(target.id), key: 'attachment:' + target.id };
      }
      ctx.store.bot(target.botId);
      if (ctx.designerFiles.owns(target.botId, target.path))
        return { path: ctx.designerFiles.hostPath(target.botId, target.path) };
      return {
        name: basename(target.path),
        bytes: await ctx.artifacts.read(target.botId, target.path),
        key: 'workspace:' + target.botId + ':' + target.path,
      };
    },
  });
  handle('openPreviewFile', (input) => previewOpener.open(input));
  handle('openFile', async (input) => {
    const bot = ctx.store.bot(String(input?.botId));
    if (ctx.computer.stateFor(bot.id).ownerBotId) throw new Error('Bot 正在操作桌面，请先接管电脑');
    await ctx.computer.ensure(bot.id);
    return ctx.artifacts.open(bot.id, String(input?.path));
  });
  handle('exportFile', async (input) => {
    ctx.store.bot(String(input?.botId));
    const name = safeRelativePath(String(input?.path || ''));
    let bytes = await ctx.artifacts.read(input.botId, name);
    const target = await dialog.showSaveDialog(ctx.window!, {
      defaultPath: name.split('/').pop(),
      title: '保存工作成果',
    });
    if (target.canceled || !target.filePath) return null;
    if (/\.html?$/i.test(name) && ctx.designerFiles.owns(input.botId, name)) {
      const session = ctx.designStore.data.sessions.find(
        (item) => item.botId === input.botId && name.startsWith(item.workspacePath + '/'),
      )!;
      bytes = Buffer.from(
        await prepareDesignHtml({
          rootDir: session.workspaceDir!,
          htmlPath: ctx.designerFiles.absolute(session, name),
          html: bytes.toString('utf8'),
        }),
      );
    }
    writeFileSync(target.filePath, bytes);
    return target.filePath;
  });
}
