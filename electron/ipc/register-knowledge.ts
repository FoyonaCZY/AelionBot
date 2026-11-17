import { dialog } from 'electron';
import { AppError } from '../../shared/errors';
import type { IpcContext } from './context';

export function registerKnowledge(ctx: IpcContext) {
  const { handle } = ctx;
  const service = () => {
    if (!ctx.knowledge) throw new AppError('knowledge.unavailable', '知识库尚未就绪');
    return ctx.knowledge;
  };
  const id = (value: unknown) => {
    if (typeof value !== 'string' || !value) throw new AppError('knowledge.not_found', '知识库不存在');
    return value;
  };
  handle('saveKnowledgeBase', (input) => service().save(input));
  handle('removeKnowledgeBase', (value) => service().remove(id(value)));
  handle('reindexKnowledgeBase', (value) => service().reindex(id(value)));
  handle('knowledgeIssues', (value) => service().issues(id(value)));
  handle('pickKnowledgeSources', async (kind) => {
    const options: Electron.OpenDialogOptions = {
      properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory', 'multiSelections'],
    };
    const result = ctx.window ? await dialog.showOpenDialog(ctx.window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths.slice(0, 40);
  });
}
