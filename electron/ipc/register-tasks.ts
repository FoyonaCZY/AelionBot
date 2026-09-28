import { WorkItems } from '../core/agent/work-items';
import type { IpcContext } from './context';

export function registerTasks(ctx: IpcContext) {
  const { handle } = ctx;
  handle('createScheduledTask', (input) => ctx.scheduler!.create(input));
  handle('updateScheduledTask', (input) => ctx.scheduler!.update(input));
  handle('deleteScheduledTask', (id) => ctx.scheduler!.remove(String(id)));
  handle('runScheduledTask', (id) => ctx.scheduler!.runNow(String(id)));
  handle('workAction', (input) => {
    const work = new WorkItems(ctx.store),
      existing = work.get(input?.id);
    if (input?.action === 'start') {
      if (ctx.harness.isRunning(existing.botId) || ctx.chatPins?.hasPending(existing.botId))
        throw Error('Bot 正在处理消息，请先暂停当前任务或稍后继续');
      if (!ctx.store.modelFor(existing.botId).model) throw Error('请先为 Bot 选择模型');
    }
    const item = work.action(input);
    if (input.action !== 'start') {
      if (item.activeRunId && ctx.harness.isRunning(item.botId)) {
        const run = ctx.store.data.runs.find((r) => r.id === item.activeRunId);
        if (run) {
          ctx.peerChats?.cancelRun(run);
          ctx.groupChats?.cancelRun(run);
        }
        ctx.harness.cancel(item.botId);
      }
      ctx.changed();
      return;
    }
    if (item.scope.kind === 'group') {
      ctx.groupChats!.startWork(item);
      ctx.changed();
      return;
    }
    ctx.greetings?.cancel(item.botId);
    ctx.groupChats?.yieldToUser(item.botId);
    void ctx.harness
      .run(
        item.botId,
        '用户已点击' +
          (item.kind === 'plan' ? '执行计划' : '继续目标') +
          '。沿用已保存步骤和执行记录：' +
          item.objective,
        { workItemId: item.id, workspaceDir: item.workspaceDir },
      )
      .catch((error) => {
        item.status = 'blocked';
        item.reason = (error as Error).message;
        delete item.activeRunId;
        ctx.store.save();
        ctx.changed();
      });
    ctx.changed();
  });
  handle('stopLiveWork', async (input) => {
    await ctx.harness.stopLiveWork(
      String(input?.botId),
      input?.kind === 'terminal' ? 'terminal' : 'process',
      String(input?.id),
    );
  });
}
