import type { IpcContext } from './context';

export function registerWidgets(ctx: IpcContext) {
  const { handle } = ctx;
  handle('pinWidget', (input) => ctx.pinnedWidgets!.pin(input));
  handle('updatePinnedWidget', (input) => ctx.pinnedWidgets!.update(input));
  handle('unpinWidget', (id) => ctx.pinnedWidgets!.unpin(id));
}
