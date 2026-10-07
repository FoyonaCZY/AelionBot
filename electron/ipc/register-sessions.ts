import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { botType } from '../../shared/types/designer-types';
import type { WorkSession } from '../../shared/types/core';
import { setConversationWorkspace } from '../core/storage/workspaces';
import type { IpcContext } from './context';

const sessionName = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
    throw new AppError('session.name_invalid', '名称需要 1–80 个字符');
  return value.trim();
};

/** Work sessions: more chats with one Bot, each for one piece of work (see WorkSession). */
export function registerSessions(ctx: IpcContext) {
  const { handle } = ctx;
  const find = (id: unknown) => {
    const session = ctx.store.data.workSessions?.find((item) => item.id === id);
    if (!session) throw new AppError('session.not_found', '工作会话不存在');
    return session;
  };
  handle('createWorkSession', (input) => {
    const bot = ctx.store.bot(String(input?.botId || ''));
    if (botType(bot.type) !== 'general') throw new AppError('session.bot_type', '设计 Bot 的工作在设计任务里进行');
    const name = sessionName(input?.name);
    // Checked before the session exists, so an unusable folder creates nothing.
    const workspaceDir = input?.workspaceDir ? ctx.host.validateWorkspace(input.workspaceDir) : undefined;
    const now = new Date().toISOString();
    const session: WorkSession = { id: randomUUID(), botId: bot.id, name, createdAt: now, updatedAt: now };
    (ctx.store.data.workSessions ||= []).push(session);
    if (workspaceDir)
      setConversationWorkspace(ctx.store, ctx.host, { kind: 'bot', id: bot.id, sessionId: session.id }, workspaceDir);
    ctx.store.save();
    ctx.changed();
    return session;
  });
  handle('updateWorkSession', (input) => {
    const session = find(input?.id);
    if (input.name !== undefined) session.name = sessionName(input.name);
    if (input.archived !== undefined) {
      if (typeof input.archived !== 'boolean') throw new Error('无效的归档操作');
      if (input.archived) session.archivedAt ||= new Date().toISOString();
      else delete session.archivedAt;
    }
    ctx.store.save();
    ctx.changed();
  });
  handle('deleteWorkSession', (id) => {
    const session = find(id);
    ctx.chatPins?.cancel(session.botId, session.id);
    ctx.store.deleteWorkSession(session.id);
    ctx.scheduler?.removeTarget({ kind: 'bot', id: session.botId, sessionId: session.id });
    ctx.changed();
  });
}
