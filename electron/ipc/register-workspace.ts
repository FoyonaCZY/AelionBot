import { dialog } from 'electron';
import { join } from 'node:path';
import { respondToInteraction } from '../core/agent/interactions';
import { assertWorkspaceScope, conversationWorkspace, setConversationWorkspace } from '../core/storage/workspaces';
import type { IpcContext } from './context';

export function registerWorkspace(ctx: IpcContext) {
  const { handle } = ctx;
  handle('respondInteraction', async (input) => {
    if (input?.action === 'takeover') {
      const request = ctx.interactions.get(String(input.id));
      if (request.kind === 'vm_takeover') await ctx.computer.ensure(request.botId);
    }
    return respondToInteraction(ctx.interactions, ctx.computer, input);
  });
  handle('setHostPermissionMode', (input) => {
    if (ctx.hostApprovals.set(input?.scope, input?.mode)) ctx.interactions.refreshHostPolicy();
    ctx.changed();
  });
  handle('setCommandPermissionEnabled', (input) => {
    if (typeof input?.id !== 'string' || typeof input.enabled !== 'boolean') throw new Error('无效命令权限参数');
    ctx.commandPermissions.setEnabled(input.id, input.enabled);
    ctx.interactions.applyCommandRules();
    ctx.changed();
  });
  handle('removeCommandPermission', (id) => {
    if (typeof id !== 'string') throw new Error('无效命令模式');
    ctx.commandPermissions.remove(id);
    ctx.changed();
  });
  const mentionSearches = new Map<string, AbortController>();
  handle('searchMentionFiles', async (input) => {
    const scope = assertWorkspaceScope(ctx.store, input?.scope),
      key = scope.kind + ':' + scope.id;
    mentionSearches.get(key)?.abort();
    const controller = new AbortController();
    mentionSearches.set(key, controller);
    try {
      let directory = conversationWorkspace(ctx.store, scope) || ctx.host.workspaceSettings().workspaceDir;
      if (input?.designSessionId) {
        const task = ctx.designStore.get(input.designSessionId);
        if (task.origin.kind !== scope.kind || task.origin.id !== scope.id) throw Error('设计任务不属于当前会话');
        directory = ctx.designerFiles.absolute(task, '.', true);
      } else if (scope.kind === 'bot' && ctx.store.bot(scope.id).type === 'designer')
        return {
          workspaceDir: join(ctx.host.workspaceSettings().workspaceDir, 'designers'),
          files: [],
          truncated: false,
        };
      return await ctx.host.mentionFiles(input?.query, directory, controller.signal);
    } finally {
      if (mentionSearches.get(key) === controller) mentionSearches.delete(key);
    }
  });
  handle('pickConversationWorkspace', async (scope) => {
    assertWorkspaceScope(ctx.store, scope);
    const selected = await dialog.showOpenDialog(ctx.window!, {
      title: '选择会话工作目录',
      defaultPath: conversationWorkspace(ctx.store, scope) || ctx.host.workspaceSettings().workspaceDir,
      properties: ['openDirectory'],
    });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const path = setConversationWorkspace(ctx.store, ctx.host, scope, selected.filePaths[0]);
    ctx.changed();
    return path;
  });
  handle('chooseFolder', async () => {
    const selected = await dialog.showOpenDialog(ctx.window!, {
      title: '选择工作目录',
      defaultPath: ctx.host.workspaceSettings().workspaceDir,
      properties: ['openDirectory'],
    });
    return selected.canceled || !selected.filePaths[0] ? null : selected.filePaths[0];
  });
  handle('resetConversationWorkspace', (scope) => {
    setConversationWorkspace(ctx.store, ctx.host, scope, null);
    ctx.changed();
  });
  handle('saveHostWorkspace', (path) => {
    if (ctx.harness.busy) throw new Error('请等待当前任务结束后修改默认工作目录');
    if (typeof path !== 'string') throw new Error('无效工作目录');
    ctx.host.setWorkspaceDir(path);
    ctx.changed();
  });
  handle('pickHostWorkspace', async () => {
    const selected = await dialog.showOpenDialog(ctx.window!, {
      title: '选择本机默认工作目录',
      defaultPath: ctx.host.workspaceSettings().workspaceDir,
      properties: ['openDirectory'],
    });
    return selected.canceled ? null : selected.filePaths[0] || null;
  });
}
