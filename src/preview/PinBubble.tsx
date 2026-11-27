import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pinNumber, pinTitle } from '../../shared/preview/preview-annotations';
import type { FeedbackOverlayState } from '../../shared/preview/preview-feedback-overlay';
import type { PreviewAnnotation } from '../../shared/types/preview-editor-types';
import type { WebPreviewControls } from './preview-runtime';
import { useI18n } from '../i18n';
import { formatPinTimecode } from './preview-utils';
import './pin-bubble.css';

export interface PinBubbleActions {
  /** Saves the text. A pin already sent goes out again when its text changes. */
  commit: (id: string, text: string) => void;
  close: () => void;
  remove: (id: string) => void;
  /** Element pins on an editable page: opens the style panel on that element. */
  tune?: (id: string) => void;
}
const WIDTH = 300,
  GAP = 12;
/** Where a bubble goes beside a pin: right of it, else left, else below; kept inside the bounds. */
function bubblePlace(
  pin: { x: number; y: number; width: number; height: number },
  bounds: { x: number; y: number; width: number; height: number },
  height: number,
) {
  const right = pin.x + pin.width + GAP,
    left = pin.x - GAP - WIDTH;
  let x: number, y: number;
  if (right + WIDTH <= bounds.x + bounds.width) {
    x = right;
    y = pin.y;
  } else if (left >= bounds.x) {
    x = left;
    y = pin.y;
  } else {
    x = Math.min(Math.max(bounds.x, pin.x), bounds.x + bounds.width - WIDTH);
    y = pin.y + pin.height + GAP;
    if (y + height > bounds.y + bounds.height) y = pin.y - GAP - height;
  }
  y = Math.max(bounds.y + 4, Math.min(y, bounds.y + bounds.height - height - 4));
  return { x: Math.max(bounds.x, x), y, width: WIDTH, height };
}
/** Words for a pin's header and its state, shared by both bubbles. */
function usePinWords() {
  const { t, language } = useI18n();
  return {
    language,
    title: (mark: PreviewAnnotation) => {
      const kind = t(pinTitle(mark)),
        text = mark.elementText?.replace(/\s+/g, ' ').trim();
      return text ? kind + ' · ' + (text.length > 40 ? text.slice(0, 40) + '…' : text) : kind;
    },
    state: (status?: PreviewAnnotation['status']) =>
      status === 'done'
        ? t('已改')
        : status === 'kept'
          ? t('没改')
          : status === 'working'
            ? t('正在改')
            : status === 'sent'
              ? t('已发送')
              : '',
    placeholder: (mark: PreviewAnnotation) =>
      mark.author === 'bot' ? t('回复这条说明…') : mark.status ? t('继续说…') : t('这里要怎么改？'),
    t,
  };
}
const pinClass = (mark: PreviewAnnotation) =>
  mark.author === 'bot' && !mark.status ? 'bot' : mark.status || (mark.author === 'bot' ? 'bot' : '');

/** The bubble over a file preview, placed beside its pin inside the preview content. */
export function PinBubble({
  mark,
  index,
  actions,
}: {
  mark: PreviewAnnotation;
  index: number;
  actions: PinBubbleActions;
}) {
  const words = usePinWords(),
    { t } = words;
  const [text, setText] = useState(mark.text || ''),
    [place, setPlace] = useState<{ x: number; y: number }>(),
    card = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    textRef = useRef(text),
    actionsRef = useRef(actions);
  textRef.current = text;
  actionsRef.current = actions;
  useEffect(() => setText(mark.text || ''), [mark.id]);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
    // Leaving the bubble any way other than 好了 still keeps what was typed.
    const id = mark.id;
    return () => actionsRef.current.commit(id, textRef.current);
  }, [mark.id]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = '0px';
    node.style.height = Math.min(132, Math.max(44, node.scrollHeight)) + 'px';
  }, [text]);
  // Follows the pin as the content scrolls or resizes.
  useEffect(() => {
    let frame = 0,
      last = '';
    const tick = () => {
      const node = card.current,
        content = node?.closest<HTMLElement>('.fp-content'),
        pin = content?.querySelector(`.file-annotation-layer [data-pin-id="${CSS.escape(mark.id)}"]`);
      if (node && content && pin) {
        const box = content.getBoundingClientRect(),
          r = pin.getBoundingClientRect(),
          next = bubblePlace(
            { x: r.x - box.x, y: r.y - box.y, width: r.width, height: r.height },
            { x: 8, y: 8, width: box.width - 16, height: box.height - 16 },
            node.offsetHeight,
          ),
          key = next.x + ',' + next.y;
        if (key !== last) {
          last = key;
          setPlace({ x: next.x, y: next.y });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [mark.id]);
  const done = () => {
    actions.commit(mark.id, text);
    actions.close();
  };
  const state = words.state(mark.status);
  return (
    <div
      ref={card}
      className="pin-bubble"
      role="dialog"
      aria-label={t('评论 {n}', { n: pinNumber(mark, index) })}
      style={place ? { left: place.x, top: place.y } : { visibility: 'hidden' }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          done();
        }
      }}
    >
      <header>
        <span className={`pin-dot ${pinClass(mark)}`}>{pinNumber(mark, index)}</span>
        <span className="pin-bubble-title">{words.title(mark)}</span>
        {mark.timestampSec !== undefined && (
          <span className="pin-bubble-time">{formatPinTimecode(mark.timestampSec)}</span>
        )}
        {state && <span className={`pin-bubble-state ${mark.status}`}>{state}</span>}
      </header>
      {mark.botNote && <div className="pin-bubble-note">{mark.botNote}</div>}
      <textarea
        ref={input}
        rows={2}
        maxLength={1000}
        value={text}
        aria-label={t('评论')}
        placeholder={words.placeholder(mark)}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            done();
          }
        }}
      />
      {mark.reply && (
        <div className="pin-bubble-reply">
          <i aria-hidden="true" />
          <div>
            <b>Bot</b>
            <span>{mark.reply}</span>
          </div>
        </div>
      )}
      <footer>
        <button
          type="button"
          className="pin-bubble-icon"
          aria-label={t('删除评论')}
          title={t('删除评论')}
          onClick={() => actions.remove(mark.id)}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </svg>
        </button>
        <span className="pin-bubble-hint">{t('Enter 完成')}</span>
        <button type="button" className="pin-bubble-done" onClick={done}>
          {t('好了')}
        </button>
      </footer>
    </div>
  );
}

/**
 * The bubble over a web page. The page is a native view that covers the app, so the bubble is a trusted view the
 * main process places above it; this hook keeps it beside the pin and turns what is typed there into pin text.
 */
export function useWebPinBubble({
  web,
  mark,
  index,
  slot,
  zoom,
  hidden,
  actions,
}: {
  web?: WebPreviewControls;
  mark?: PreviewAnnotation;
  index: number;
  slot: () => HTMLElement | null | undefined;
  zoom: number;
  hidden: boolean;
  actions: PinBubbleActions;
}) {
  const words = usePinWords(),
    draft = useRef<{ id: string; text: string; version: number }>(undefined),
    actionsRef = useRef(actions);
  actionsRef.current = actions;
  const open = Boolean(web && mark),
    rect = web?.state.selectedAnnotationId === mark?.id ? web?.state.selectedRect : undefined;
  if (mark && draft.current?.id !== mark.id) draft.current = { id: mark.id, text: mark.text || '', version: 0 };
  useEffect(() => {
    if (!open || !window.aelion.onPreviewFeedbackInput) return;
    return window.aelion.onPreviewFeedbackInput((input) => {
      const current = draft.current;
      if (!current || input.id !== current.id) return;
      current.version = Math.max(current.version, input.editVersion);
      if (input.kind === 'change') current.text = input.text;
      else if (input.kind === 'done' || input.kind === 'escape') {
        actionsRef.current.commit(current.id, input.text);
        actionsRef.current.close();
      } else if (input.kind === 'delete') actionsRef.current.remove(current.id);
      else if (input.kind === 'tune') {
        actionsRef.current.commit(current.id, current.text);
        actionsRef.current.tune?.(current.id);
      }
    });
  }, [open]);
  // Closing or switching pins keeps what was typed.
  useEffect(() => {
    if (!mark) return;
    const id = mark.id;
    return () => {
      if (draft.current?.id === id) actionsRef.current.commit(id, draft.current.text);
    };
  }, [mark?.id]);
  const dark = document.documentElement.dataset.theme === 'dark';
  const body = getComputedStyle(document.body);
  const state: FeedbackOverlayState | undefined = mark && {
    id: mark.id,
    editVersion: draft.current?.version || 0,
    text: draft.current?.text ?? mark.text ?? '',
    number: String(pinNumber(mark, index)),
    title: words.title(mark),
    ...(mark.botNote ? { botNote: mark.botNote } : {}),
    ...(mark.reply ? { reply: mark.reply, replyBy: 'Bot' } : {}),
    ...(mark.status ? { status: mark.status } : {}),
    tunable: Boolean(actions.tune) && mark.type === 'element',
    language: words.language,
    fontFamily: body.fontFamily,
    fontSize: body.fontSize,
    fontWeight: body.fontWeight,
    dark,
  };
  const key = JSON.stringify([state, rect, zoom, hidden]);
  useEffect(() => {
    if (!window.aelion.updatePreviewFeedbackOverlay) return;
    const node = slot();
    if (!state || !node || !rect || hidden) {
      void window.aelion.updatePreviewFeedbackOverlay(null).catch(() => {});
      return;
    }
    const bounds = node.getBoundingClientRect(),
      pin = {
        x: bounds.x + rect.x * zoom,
        y: bounds.y + rect.y * zoom,
        width: rect.width * zoom,
        height: rect.height * zoom,
      },
      visible =
        pin.x + pin.width > bounds.x && pin.x < bounds.right && pin.y + pin.height > bounds.y && pin.y < bounds.bottom;
    void window.aelion
      .updatePreviewFeedbackOverlay({
        state,
        rect: bubblePlace(pin, { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, 170),
        visible,
      })
      .catch(() => {});
  }, [key]);
  useEffect(
    () => () => {
      void window.aelion.updatePreviewFeedbackOverlay?.(null).catch(() => {});
    },
    [],
  );
}
