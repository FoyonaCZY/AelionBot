import type { IpcContext } from './context';

export function registerDecisions(ctx: IpcContext) {
  const { handle } = ctx;
  handle('installLaya', () => ctx.layaFeature!.installRecommended());
  handle('selectLaya', (variant) => ctx.layaFeature!.select(variant));
  handle('setLayaEnabled', (enabled) => ctx.layaFeature!.setEnabled(enabled));
  handle('cancelLayaInstall', () => ctx.layaFeature!.cancel());
}
