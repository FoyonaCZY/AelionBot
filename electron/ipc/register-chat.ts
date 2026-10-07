import { botType } from '../../shared/types/designer-types';
import { resumableRun } from '../core/agent/resume-run';
import type { IpcContext } from './context';
import { AppError } from '../../shared/errors';

export function registerChat(ctx: IpcContext) {
  const { handle } = ctx;
  handle('compactContext', (input) => {
    const botId = String(input?.botId || ''),
      focus = typeof input?.focus === 'string' ? input.focus.slice(0, 1000) : '',
      sessionId = typeof input?.sessionId === 'string' ? input.sessionId : undefined;
    if (botType(ctx.store.bot(botId).type) !== 'general') throw Error('设计 Bot 的上下文由设计会话管理');
    if (sessionId && !ctx.store.data.workSessions?.some((s) => s.id === sessionId && s.botId === botId))
      throw new AppError('session.not_found', '工作会话不存在');
    return ctx.generalHarness.compactContext(botId, focus, sessionId);
  });
  handle('send', (input) => {
    if (!input || typeof input.botId !== 'string' || typeof input.message !== 'string') throw new Error('无效消息');
    if (input.designSessionId)
      ctx.designStore.get(String(input.designSessionId), input.botId, { kind: 'bot', id: input.botId });
    return ctx.chatPins!.send(input);
  });
  handle('resumeChat', (input) => {
    if (typeof input?.botId !== 'string' || typeof input.runId !== 'string') throw Error('恢复任务参数无效');
    const run = resumableRun(ctx.store, input.botId, input.runId),
      lane = run.sessionId ?? null;
    if (ctx.harness.isRunning(input.botId, lane) || ctx.chatPins?.hasPending(input.botId, lane))
      throw Error('Bot 正在处理消息，请稍后继续');
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
  // Stops the work of the chat it is pressed in: the Bot's main chat (with its group and delegated work), or one
  // work session. The Bot's other chats keep working.
  handle('cancel', (id, session) => {
    const botId = String(id),
      lane = typeof session === 'string' ? session : null;
    ctx.chatPins?.cancel(botId, lane);
    const run = ctx.store.data.runs.find(
      (run) => run.botId === botId && run.status === 'running' && (run.sessionId ?? null) === lane,
    );
    if (run && !lane) {
      ctx.peerChats?.cancelRun(run);
      ctx.groupChats?.cancelRun(run);
    }
    ctx.harness.cancel(botId, lane);
  });
  handle('readToolResult', (input) => ctx.store.readToolResult(String(input?.botId), String(input?.messageId)));
  handle('setBackgroundLearning', (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('无效设置');
    ctx.cognition.learning.setEnabled(enabled);
  });
}
