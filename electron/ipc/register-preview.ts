import { commentsFromAnnotations } from '../../shared/preview/designer-canvas';
import { applyDomEdits } from '../core/preview/html-preview-edits';
import { PreviewFeedbackService, designFeedbackFile } from '../core/preview/preview-feedback';
import { feedbackCaptureRect } from '../../shared/preview/preview-feedback';
import type { IpcContext } from './context';

export function registerPreview(ctx: IpcContext) {
  const { handle } = ctx;
  handle('updatePreviewFeedbackOverlay', (input) => ctx.webPreview!.feedback(input));
  handle('patchPreviewHtml', (input) => applyDomEdits(input.content, input.edits));
  handle('acknowledgePreview', (id) => {
    if (typeof id !== 'string' || id.length > 100) throw Error('无效预览 ID');
    ctx.agentPreviews?.acknowledge(id);
  });
  const feedbackDesign = (input?: import('../../shared/preview/preview-feedback').PreviewFeedbackInput) => {
    if (!input?.designSessionId) return undefined;
    const design = ctx.designStore.get(input.designSessionId, undefined, {
        kind: input.scope.kind,
        id: input.scope.id,
      }),
      path = designFeedbackFile(input, design);
    if (path && design.location === 'host') ctx.designerFiles.absolute(design, path);
    return design;
  };
  const previewFeedback = new PreviewFeedbackService({
    validate: (scope) => {
      ctx.attachments.scope(scope);
      if (scope.kind === 'bot') {
        if (!ctx.store.modelFor(scope.id).model) throw Error('请先为这个 Bot 选择模型');
      } else {
        const room = ctx.store.data.groups.find((room) => room.id === scope.id);
        if (
          !room?.members.some(
            (member) =>
              !member.leftAt &&
              ctx.store.data.bots.some((bot) => bot.id === member.id) &&
              ctx.store.modelFor(member.id).model,
          )
        )
          throw Error('请先为群内 Bot 选择模型');
      }
    },
    capture: async (input) => {
      feedbackDesign(input);
      if (!ctx.window || ctx.window.isDestroyed() || ctx.window.isMinimized() || !ctx.window.isVisible())
        throw Error('请保持预览窗口可见后再发送');
      feedbackCaptureRect(input.rect, input.viewport, input.viewport);
      const webCapture = await ctx.webPreview?.capture(input.rect);
      if (webCapture) return webCapture;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capture = await Promise.race([
        ctx.window.webContents.capturePage(undefined, { stayHidden: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('预览截图超时，请重试')), 10000);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (capture.isEmpty()) throw Error('未能截取预览画面，请重试');
      let cropped = capture.crop(feedbackCaptureRect(input.rect, input.viewport, capture.getSize()));
      const size = cropped.getSize();
      if (Math.max(size.width, size.height) > 2560)
        cropped = cropped.resize(
          size.width >= size.height ? { width: 2560, quality: 'best' } : { height: 2560, quality: 'best' },
        );
      return cropped.toPNG();
    },
    attach: (scope, name, bytes) => ctx.attachments.importFiles(scope, [{ name, bytes }])[0],
    discard: (scope, id) => ctx.attachments.discardUnsentDraft(scope, id),
    send: (scope, message, attachmentId, previewPrompt, input) => {
      const design = feedbackDesign(input);
      if (design && input?.annotations?.length)
        ctx.designStore.addComments(
          design.id,
          commentsFromAnnotations(
            input.file?.path || input.file?.url || input.file?.name || '',
            input.text,
            input.annotations,
            design.comments || [],
          ),
        );
      const offset =
          message.indexOf(previewPrompt, message.indexOf('\n') + 1) -
          (input?.text.length || 0) +
          (input?.text.trimStart().length || 0),
        extras = {
          designSessionId: design?.id,
          attachmentIds: [...(input?.attachmentIds || []), attachmentId],
          mentions: input?.mentions?.map((m) => ({ ...m, start: m.start + offset, end: m.end + offset })),
          replyToMessageId: input?.replyToMessageId,
          previewPrompt,
        };
      if (scope.kind === 'bot')
        ctx.chatPins!.send({
          botId: scope.id,
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          message,
          ...extras,
        });
      else ctx.groupChats!.send({ id: scope.id, message, ...extras });
    },
    delivered: (scope, id) =>
      (scope.kind === 'bot'
        ? ctx.store.data.messages.filter((message) => message.botId === scope.id && message.role === 'user')
        : ctx.store.data.groups
            .find((room) => room.id === scope.id)
            ?.messages.filter((message) => message.sender.kind === 'user') || []
      ).some((message) => message.attachments?.some((file) => file.id === id)),
  });
  handle('sendPreviewFeedback', (input) => previewFeedback.send(input));
  handle('focusPreviewFeedback', () => {
    if (ctx.window && !ctx.window.isDestroyed() && ctx.window.isFocused()) ctx.window.webContents.focus();
  });
}
