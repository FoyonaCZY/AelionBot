import { dialog } from 'electron';
import { writeFile } from 'node:fs/promises';
import { translateFor } from '../../shared/i18n';
import { ConversationSearch, conversationMarkdown } from '../core/app/conversations';
import type { IpcContext } from './context';

/** Search across every chat, and saving a chat as a file. */
export function registerConversations(ctx: IpcContext) {
  const { handle } = ctx;
  const search = new ConversationSearch(ctx.store);
  handle('searchConversations', (input) => search.search(input));
  handle('exportConversation', async (input) => {
    const { name, text } = conversationMarkdown(ctx.store, input?.scope, { steps: input?.steps === true });
    const options = {
      title: translateFor(ctx.store.data.language || 'zh-CN', '导出对话'),
      defaultPath: name,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const choice = ctx.window ? await dialog.showSaveDialog(ctx.window, options) : await dialog.showSaveDialog(options);
    if (choice.canceled || !choice.filePath) return null;
    await writeFile(choice.filePath, text, 'utf8');
    return choice.filePath;
  });
}
