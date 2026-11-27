import { usePreviewWorkbench, type PreviewChatInput } from './PreviewWorkbench';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AttachmentScope } from '../../shared/types/attachment-types';
import type { PreviewItem } from './FilePreviewContext';
import type { PreviewFeedbackInput } from '../../shared/preview/preview-feedback';
import type { PreviewAnnotation, PreviewViewport } from '../../shared/types/preview-editor-types';
import { unsentPins } from '../../shared/preview/preview-annotations';
import { useI18n } from '../i18n';
import { translate } from '../../shared/i18n';
import { previewErrorText } from './preview-utils';
import { PinChips } from './PreviewAnnotationChips';
import './preview-feedback.css';
const paint = () =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(translate('预览窗口暂不可用，请重试'))), 5000);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
/** Pins on screen in a file preview, in window pixels, for the close-ups cut from the screenshot. */
function filePinRects(content: Element | null | undefined, ids: string[]) {
  const rects: NonNullable<PreviewFeedbackInput['pinRects']> = [];
  for (const id of ids) {
    const node = content?.querySelector(`.file-annotation-layer [data-annotation-id="${CSS.escape(id)}"]`);
    if (!node) continue;
    const r = node.getBoundingClientRect(),
      x = Math.max(0, r.left),
      y = Math.max(0, r.top),
      width = Math.min(innerWidth, r.right) - x,
      height = Math.min(innerHeight, r.bottom) - y;
    if (width >= 1 && height >= 1) rects.push({ id, rect: { x, y, width, height } });
  }
  return rects;
}
export function PreviewFeedback({
  scope,
  item,
  panel,
  unsaved,
  onBusy,
  annotations = [],
  onSelectAnnotation,
  onAnnotationsChange,
  captureState,
  registerSend,
  onSent,
  composer = true,
}: {
  /** False when a conversation composer sits beside the preview; the pins show there, and text is typed there. */
  composer?: boolean;
  scope: AttachmentScope;
  item: PreviewItem;
  panel: { current: HTMLElement | null };
  unsaved: boolean;
  onBusy: (busy: boolean) => void;
  annotations?: PreviewAnnotation[];
  selectedAnnotationId?: string;
  onSelectAnnotation?: (id: string) => void;
  onAnnotationsChange?: (value: PreviewAnnotation[]) => Promise<unknown> | void;
  captureState?: () => Promise<{ annotations: PreviewAnnotation[]; view?: PreviewViewport }>;
  registerSend?: (sender: (input: PreviewChatInput) => Promise<unknown>) => () => void;
  /** The pins that just went out. */
  onSent?: (pins: string[]) => void;
}) {
  const workbench = usePreviewWorkbench(),
    sendRef = useRef<((input: PreviewChatInput) => Promise<unknown>) | undefined>(undefined);
  const { t, language } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [pending, setPending] = useState(false),
    [status, setStatus] = useState(''),
    [failed, setFailed] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    lock = useRef(false),
    attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const text = drafts[item.id] || '',
    outgoing = unsentPins(annotations),
    // Pins with words can go out on their own.
    pinsSay = outgoing.some((mark) => mark.text?.trim());
  useLayoutEffect(() => {
    const node = input.current;
    if (node) {
      node.style.height = '0px';
      node.style.height = Math.min(108, Math.max(28, node.scrollHeight)) + 'px';
    }
  }, [text, item.id]);
  useEffect(() => {
    setStatus('');
    setFailed(false);
    attempt.current = undefined;
  }, [item.id]);
  useEffect(() => {
    const node = wrapper.current,
      layer = panel.current?.closest<HTMLElement>('.fp-layer');
    if (!node || !layer) return;
    const update = () => layer.style.setProperty('--fp-feedback-height', node.getBoundingClientRect().height + 'px');
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
      layer.style.removeProperty('--fp-feedback-height');
    };
  }, [panel]);
  useEffect(() => {
    if (!status || failed) return;
    const timer = setTimeout(() => setStatus(''), 4000);
    return () => clearTimeout(timer);
  }, [status, failed]);
  const send = async (submittedText = text, extras?: PreviewChatInput) => {
    if (lock.current) return;
    const host = panel.current;
    if (!host) return;
    lock.current = true;
    setPending(true);
    setStatus('');
    setFailed(false);
    const layer = host.closest<HTMLElement>('.fp-layer');
    try {
      if (!window.aelion.sendPreviewFeedback) throw Error(t('此版本暂不支持截图反馈，请更新应用。'));
      if (!layer || !host.isConnected) throw Error(t('预览已关闭，请重新打开后发送。'));
      layer.dataset.feedbackCapture = 'true';
      // Closes any open bubble, which saves what was typed in it.
      onBusy(true);
      await paint();
      const snapshot = await captureState?.(),
        all = snapshot?.annotations || annotations,
        marks = unsentPins(all),
        message = submittedText.trim()
          ? submittedText
          : marks.some((mark) => mark.text?.trim())
            ? t('请按下面的评论修改。')
            : '';
      if (!message) return;
      const content = host.querySelector<HTMLElement>('.fp-content'),
        area =
          content?.querySelector<HTMLElement>('.web-preview-slot') ||
          content?.querySelector<HTMLElement>('.fp-pdf-viewport') ||
          content?.querySelector<HTMLElement>('.vp-stage') ||
          content?.querySelector<HTMLElement>('.vs-stage') ||
          content;
      if (!area || !area.isConnected) throw Error(t('预览内容已关闭'));
      const bounds = area.getBoundingClientRect(),
        x = Math.max(0, bounds.left),
        y = Math.max(0, bounds.top),
        width = Math.min(innerWidth, bounds.right) - x,
        height = Math.min(innerHeight, bounds.bottom) - y;
      if (width < 1 || height < 1) throw Error(t('预览区域不可见'));
      const page = Number(content?.querySelector<HTMLElement>('[data-preview-page]')?.dataset.previewPage) || undefined;
      const url = content?.querySelector<HTMLElement>('[data-preview-url]')?.dataset.previewUrl;
      const unbound = content?.querySelector<HTMLElement>('[data-preview-local-document=false]');
      const web = Boolean(content?.querySelector('.web-preview'));
      const file = {
        name: (unbound?.dataset.previewName || item.name).slice(0, 300),
        ...(url ? { url } : {}),
        ...(!unbound && item.id.startsWith('attachment:') ? { attachmentId: item.id.slice('attachment:'.length) } : {}),
        ...(!unbound && item.workspace
          ? { path: '/work/' + item.workspace.botId + '/' + item.workspace.path.replace(/^\/+/, '') }
          : {}),
        ...(page ? { page } : {}),
        ...(unsaved ? { unsaved: true } : {}),
      };
      const pinRects = web
        ? []
        : filePinRects(
            content,
            marks.map((mark) => mark.id),
          );
      const partial = {
        scope: extras?.scope || scope,
        text: message,
        file,
        language,
        annotations: marks,
        ...(snapshot?.view ? { view: snapshot.view } : {}),
        ...(pinRects.length ? { pinRects } : {}),
        ...(extras
          ? {
              attachmentIds: extras.attachmentIds,
              mentions: extras.mentions,
              replyToMessageId: extras.replyToMessageId,
              edits: extras.edits,
            }
          : {}),
        rect: { x, y, width, height },
        viewport: { width: innerWidth, height: innerHeight },
      };
      const key = JSON.stringify({ ...partial, scroll: [area.scrollLeft, area.scrollTop] });
      if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
      const request: PreviewFeedbackInput = {
        requestId: attempt.current.id,
        designSessionId: item.designSessionId,
        ...partial,
      };
      await window.aelion.sendPreviewFeedback(request);
      setDrafts((value) => ({ ...value, [item.id]: '' }));
      attempt.current = undefined;
      setStatus(t('已发送'));
      // The pins stay where they are, marked sent, until the Bot's reply says what happened to each.
      if (marks.length) {
        const sent = new Set(marks.map((mark) => mark.id));
        await Promise.resolve(
          onAnnotationsChange?.(all.map((mark) => (sent.has(mark.id) ? { ...mark, status: 'sent' as const } : mark))),
        ).catch(() => {});
        onSent?.([...sent]);
      }
    } catch (error) {
      setFailed(true);
      setStatus(previewErrorText(error));
      if (extras) throw error;
    } finally {
      if (layer) delete layer.dataset.feedbackCapture;
      lock.current = false;
      setPending(false);
      onBusy(false);
      if (composer) input.current?.focus({ preventScroll: true });
    }
  };
  sendRef.current = (input) => send(input.text, input);
  useEffect(() => {
    const sender = (input: PreviewChatInput) => sendRef.current!(input),
      a = workbench?.registerSender(sender),
      b = registerSend?.(sender);
    return () => {
      a?.();
      b?.();
    };
  }, [workbench?.registerSender, registerSend, scope.kind, scope.id, item.id]);
  return (
    <div className={`fp-feedback-wrap ${composer ? '' : 'is-captions'}`} ref={wrapper} hidden={!composer && !status}>
      {status && (
        <div className={`fp-feedback-status ${failed ? 'is-error' : ''}`} role={failed ? 'alert' : 'status'}>
          {status}
        </div>
      )}
      {composer && outgoing.length > 0 && (
        <div className="fp-feedback-pins">
          <PinChips
            marks={annotations}
            disabled={pending}
            onSelect={(id) => onSelectAnnotation?.(id)}
            onRemove={(id) => void onAnnotationsChange?.(annotations.filter((mark) => mark.id !== id))}
          />
        </div>
      )}
      {composer && (
        <form
          className="fp-feedback"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          aria-label={t('画布提问')}
        >
          <textarea
            ref={input}
            rows={1}
            maxLength={12000}
            value={text}
            readOnly={pending}
            aria-label={t('输入问题或修改意见')}
            placeholder={outgoing.length ? t('补充说明，或直接发送评论…') : t('输入问题或修改意见…')}
            onChange={(event) => setDrafts((value) => ({ ...value, [item.id]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            disabled={pending || (!text.trim() && !pinsSay)}
            aria-label={t('发送问题和截图')}
            title={t('发送问题和截图')}
          >
            {pending ? (
              <span className="fp-feedback-spinner" />
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 19V5m-6 6 6-6 6 6" />
              </svg>
            )}
          </button>
        </form>
      )}
    </div>
  );
}
