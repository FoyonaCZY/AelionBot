import { editableText } from '../core/preview/preview-editing';
import { sourceTextFile } from '../../shared/preview/source-language';
import { dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import { AttachmentDrops } from '../core/attachments/attachment-drop';
import { readAttachmentClipboard } from '../core/attachments/attachment-clipboard';
import { setConversationWorkspace } from '../core/storage/workspaces';
import type { IpcContext } from './context';

export function registerAttachments(ctx: IpcContext) {
  const { handle } = ctx;
  handle('pickAttachments', async (scope) => {
    ctx.attachments.scope(scope);
    const result = await dialog.showOpenDialog(ctx.window!, {
      title: '添加附件',
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : ctx.attachments.importPaths(scope, result.filePaths);
  });
  const attachmentDrops = new AttachmentDrops(ctx.attachments, (scope, path) => {
    const selected = setConversationWorkspace(ctx.store, ctx.host, scope, path);
    ctx.changed();
    return selected;
  });
  handle('prepareAttachmentDropPaths', (input) => attachmentDrops.prepare(input?.scope, input?.paths));
  handle('applyAttachmentDrop', (input) => attachmentDrops.apply(input?.scope, input?.ids, input?.action));
  handle('prepareAttachmentPaste', async (scope) => {
    ctx.attachments.scope(scope);
    const data = await readAttachmentClipboard();
    return {
      entries: data.paths.length ? await attachmentDrops.prepare(scope, data.paths) : [],
      attachments: data.files.length ? ctx.attachments.importFiles(scope, data.files) : [],
    };
  });
  handle('importAttachments', (input) => ctx.attachments.importFiles(input?.scope, input?.files));
  handle('pasteAttachments', async (scope) => {
    ctx.attachments.scope(scope);
    const data = await readAttachmentClipboard();
    return data.paths.length
      ? ctx.attachments.importPaths(scope, data.paths)
      : data.files.length
        ? ctx.attachments.importFiles(scope, data.files)
        : [];
  });
  handle('previewAttachment', (id) => ctx.attachments.previewRich(id));
  handle('saveAttachment', async (id) => {
    const file = ctx.attachments.metadata(id);
    const result = await dialog.showSaveDialog(ctx.window!, { defaultPath: file.name });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, ctx.attachments.bytes(id));
    return result.filePath;
  });
  handle('readEditableAttachment', (id) => {
    const file = ctx.attachments.metadata(id);
    if (!sourceTextFile(file.name)) throw Error('此附件不支持文本编辑');
    return editableText(ctx.attachments.bytes(id), 'attachment:' + id);
  });
}
