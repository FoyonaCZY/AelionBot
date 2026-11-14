import { AppError } from '../../shared/errors';
import type { IpcContext } from './context';

/** Settings → 手机访问: turning phone access on, pairing phones and removing them. */
export function registerRemote(ctx: IpcContext) {
  const { handle } = ctx;
  const hub = () => {
    if (!ctx.remote) throw new AppError('remote.unavailable', '手机访问还没有准备好');
    return ctx.remote;
  };
  handle('saveRemoteSettings', async (input) => {
    if (!input || typeof input !== 'object') throw new AppError('remote.invalid', '设置无效');
    await hub().update(input);
  });
  handle('startRemotePairing', () => hub().startPairing());
  handle('cancelRemotePairing', () => hub().cancelPairing());
  handle('decideRemotePairing', (input) => hub().decidePairing(input?.allow === true));
  handle('removeRemoteDevice', (id) => hub().removeDevice(String(id)));
}
