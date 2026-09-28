import { botType } from '../../shared/types/designer-types';
import { resumableRun } from '../core/agent/resume-run';
import type { IpcContext } from './context';

export function registerChat(ctx: IpcContext) {
  const { handle } = ctx;
  handle('compactContext', (input) => {
    const botId = String(input?.botId || ''),
      focus = typeof input?.focus === 'string' ? input.focus.slice(0, 1000) : '';
    if (botType(ctx.store.bot(botId).type) !== 'general') throw Error('设计 Bot 的上下文由设计会话管理');
    return ctx.generalHarness.compactContext(botId, focus);
  });
  handle('send', (input) => {
    if (!input || typeof input.botId !== 'string' || typeof input.message !== 'string') throw new Error('无效消息');
    if (input.designSessionId)
      ctx.designStore.get(String(input.designSessionId), input.botId, { kind: 'bot', id: input.botId });
    return ctx.chatPins!.send(input);
  });
  handle('resumeChat', (input) => {
    if (typeof input?.botId !== 'string' || typeof input.runId !== 'string') throw Error('恢复任务参数无效');
    if (ctx.harness.isRunning(input.botId) || ctx.chatPins?.hasPending(input.botId))
      throw Error('Bot 正在处理消息，请稍后继续');
    const run = resumableRun(ctx.store, input.botId, input.runId);
    ctx.greetings?.cancel(input.botId);
    if (run.groupOrigin) ctx.groupChats!.retryRun(run);
    else if (run.peerOrigin) ctx.peerChats!.retryRun(run);
    else
      void ctx.harness.resume(input.botId, input.runId).catch((error) => {
        ctx.store.message(input.botId, 'event', (error as Error).message);
        ctx.changed();
      });
    ctx.changed();
  });
  handle('pinChat', (input) => ctx.chatPins!.pin(input));
  handle('cancel', (id) => {
    const botId = String(id);
    ctx.chatPins?.cancel(botId);
    const run = ctx.store.data.runs.find((run) => run.botId === botId && run.status === 'running');
    if (run) {
      ctx.peerChats?.cancelRun(run);
      ctx.groupChats?.cancelRun(run);
    }
    ctx.harness.cancel(botId);
  });
  handle('readToolResult', (input) => ctx.store.readToolResult(String(input?.botId), String(input?.messageId)));
  handle('setBackgroundLearning', (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('无效设置');
    ctx.cognition.learning.setEnabled(enabled);
  });
}
