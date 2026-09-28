import type { IpcContext } from './context';

export function registerWebPreview(ctx: IpcContext) {
  const { handle } = ctx;
  handle('captureWebPreviewMenu', (input) => ctx.webPreview!.captureMenu(input.id));
  handle('freezeWebPreview', (input) => ctx.webPreview!.freeze(input.id, input.frozen, input.revision));
  handle('previewEditorCommand', (input) => ctx.webPreview!.editor.command(input.id, input.command));
  handle('openWebPreview', (input) => ctx.webPreview!.open(String(input?.id), input?.source));
  handle('layoutWebPreview', (input) =>
    ctx.webPreview!.bounds(String(input?.id), input?.rect, input?.visible === true),
  );
  handle('webPreviewAction', (input) =>
    ctx.webPreview!.action(String(input?.id), String(input?.action), input?.url, input?.factor),
  );
  handle('closeWebPreview', (id) => ctx.webPreview!.close(String(id)));
}
