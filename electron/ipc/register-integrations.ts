import { dialog, shell } from 'electron';
import type { IpcContext } from './context';

export function registerIntegrations(ctx: IpcContext) {
  const { handle } = ctx;
  handle('refreshIntegrations', async () => {
    if (ctx.harness.busy) throw new Error('请等待当前任务结束后重新扫描');
    await ctx.integrations.refresh();
  });
  handle('manageSkill', (input) => {
    if (ctx.harness.busy) throw Error('请等待当前任务结束');
    const result = ctx.integrations.skills.manage(
      String(input?.botId),
      String(input?.id),
      String(input?.action),
      input?.revision,
    );
    ctx.changed();
    return result;
  });
  handle('setSkillEnabled', (input) => {
    if (ctx.harness.busy) throw Error('请等待当前任务结束');
    if (typeof input?.id !== 'string' || typeof input?.enabled !== 'boolean') throw Error('无效技能状态');
    ctx.integrations.skills.setEnabled(input.id, input.enabled);
    ctx.changed();
  });
  handle('readSkill', (input) =>
    ctx.integrations.skills.read(input?.botId === undefined ? undefined : String(input.botId), String(input?.id), true),
  );
  handle('openIntegrationPath', async (input) => {
    const target = ctx.integrations.path(input || {});
    const result = await shell.openPath(target);
    if (result) throw new Error(result);
  });
  handle('addIntegrationSource', async (kind) => {
    if (!['skills', 'mcp'].includes(kind)) throw new Error('未知配置类型');
    if (ctx.harness.busy) throw new Error('请等待当前任务结束');
    if (kind === 'mcp') throw new Error('请粘贴 MCP 配置');
    const selected = await dialog.showOpenDialog(ctx.window!, {
      title: '添加共享技能目录',
      properties: ['openDirectory'],
    });
    if (!selected.canceled && selected.filePaths[0]) {
      await ctx.integrations.add(kind, selected.filePaths[0]);
      ctx.changed();
    }
  });
  handle('importMcpSnippet', async (text) => {
    if (ctx.harness.busy) throw new Error('请等待当前任务结束');
    const names = await ctx.integrations.importMcpSnippet(text);
    ctx.changed();
    return names;
  });
  handle('setMcpEnabled', async (input) => {
    if (ctx.harness.busy) throw new Error('请等待当前任务结束后修改 MCP');
    if (typeof input?.enabled !== 'boolean') throw new Error('无效状态');
    await ctx.integrations.setEnabled(String(input.id), input.enabled);
  });
  handle('testMcp', async (id) => {
    const result = await ctx.integrations.mcp.listTools(String(id));
    return { tools: result.tools.map((tool) => tool.name) };
  });
}
