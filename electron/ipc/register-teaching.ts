import { AppError } from '../../shared/errors';
import type { IpcContext } from './context';

export function registerTeaching(ctx: IpcContext) {
  const { handle } = ctx;
  const service = () => {
    if (!ctx.teaching) throw new AppError('teaching.unavailable', '示教录制服务暂不可用');
    return ctx.teaching;
  };
  handle('teachingListWindows', () => service().listHostWindows());
  handle('teachingStart', (input) => service().start(input));
  handle('teachingStatus', (sessionId) => service().status(String(sessionId || '')));
  handle('teachingVmWindow', (sessionId) => service().vmWindowTitle(String(sessionId || '')));
  handle('teachingFinish', (input) => service().finish(input));
  handle('teachingCancel', (id) => service().cancel(typeof id === 'string' ? id : undefined));
  handle('teachingSend', (input) => service().sendDraft(input));
}
