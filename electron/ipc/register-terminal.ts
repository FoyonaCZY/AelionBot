import { workspaceKey } from '../../shared/types/work-types';
import { assertWorkspaceScope, effectiveWorkspace } from '../core/storage/workspaces';
import type { IpcContext } from './context';

export function registerTerminal(ctx: IpcContext) {
  const { handle } = ctx;
  handle('openTerminal', (input) => {
    const scope = assertWorkspaceScope(ctx.store, input?.scope);
    return ctx.userTerminals.open(
      workspaceKey(scope),
      effectiveWorkspace(ctx.store, ctx.host, scope),
      input.cols,
      input.rows,
    );
  });
  handle('writeTerminal', (input) => ctx.userTerminals.write(String(input?.id), input?.text));
  handle('resizeTerminal', (input) => ctx.userTerminals.resize(String(input?.id), input?.cols, input?.rows));
  handle('closeTerminal', (id) => ctx.userTerminals.close(String(id)));
}
