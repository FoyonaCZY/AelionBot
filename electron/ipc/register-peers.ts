import type { IpcContext } from './context';

export function registerPeers(ctx: IpcContext) {
  const { handle } = ctx;
  handle('readPrivateChat', (input) => ctx.peerChats!.read(input));
  handle('cancelPeerExchange', (id) => ctx.peerChats!.cancel(id));
}
