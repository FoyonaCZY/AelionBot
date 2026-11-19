// Sandboxed iframe host shared by inline ```widget fences and docked pinned widgets.
import { useEffect, useMemo, useRef, useState } from 'react';
import { WIDGET_MAX_STATE_BYTES, isPlainObject } from '../../shared/types/widget-types';
import { useI18n } from '../i18n';

/** Default tallest a widget grows before it scrolls inside its frame. */
const DEFAULT_MAX_HEIGHT = 2400;
const FRAME_URL = () => new URL('widget-frame.html', document.baseURI).href;
const encoder = new TextEncoder();

/** Puts a widget's suggested follow-up into the open conversation's composer. */
export const WIDGET_PROMPT_EVENT = 'aelion:widget-prompt';

/** The app's theme as resolved colors, read through a probe so light-dark() values are already decided. */
function widgetTheme() {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.append(probe);
  const resolve = (value: string, property: 'color' | 'fontFamily' = 'color') => {
    probe.style[property] = value;
    return getComputedStyle(probe)[property];
  };
  const theme = {
    '--aelion-text': resolve('var(--text-ink, #2a2a2a)'),
    '--aelion-muted': resolve('var(--text-muted, #7a7a7a)'),
    '--aelion-surface': resolve('var(--surface-float, #fff)'),
    '--aelion-border': resolve('var(--surface-line, #ececec)'),
    '--aelion-accent': resolve('light-dark(#4f7fc2, #9dbbe6)'),
    '--aelion-font': resolve('var(--font-ui, sans-serif)', 'fontFamily'),
  };
  // light-dark() picks by the scheme the app is in, which is what the widget should follow.
  const dark = resolve('light-dark(rgb(0, 0, 0), rgb(255, 255, 255))') === 'rgb(255, 255, 255)';
  probe.remove();
  return { theme, scheme: dark ? 'dark' : 'light' };
}

function sanitizeIncomingState(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || encoder.encode(text).length > WIDGET_MAX_STATE_BYTES) return undefined;
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function WidgetSandboxFrame({
  html,
  state,
  onStateChange,
  maxHeight = DEFAULT_MAX_HEIGHT,
  minHeight = 48,
  title,
  className,
}: {
  html: string;
  state?: Record<string, unknown>;
  onStateChange?: (next: Record<string, unknown>) => void;
  maxHeight?: number;
  minHeight?: number;
  title?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const [height, setHeight] = useState(0);
  const [failed, setFailed] = useState('');

  const stateJson = useMemo(() => {
    try {
      return JSON.stringify(state && isPlainObject(state) ? state : {});
    } catch {
      return '{}';
    }
  }, [state]);

  const stateRef = useRef<Record<string, unknown>>(state && isPlainObject(state) ? state : {});
  stateRef.current = state && isPlainObject(state) ? state : {};
  const lastEmittedJsonRef = useRef<string>(stateJson);
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // Remount iframe whenever HTML changes so scripts execute in a fresh sandboxed document.
  const htmlVersionRef = useRef({ html, version: 0 });
  if (htmlVersionRef.current.html !== html) {
    htmlVersionRef.current = { html, version: htmlVersionRef.current.version + 1 };
  }
  const frameKey = htmlVersionRef.current.version;

  useEffect(() => {
    readyRef.current = false;
    setFailed('');
    setHeight(0);
  }, [frameKey]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source) return;
      const data = event.data as {
        type?: string;
        height?: unknown;
        text?: unknown;
        message?: unknown;
        state?: unknown;
      };
      if (data?.type === 'aelion-widget-ready') {
        readyRef.current = true;
        lastEmittedJsonRef.current = stateJson;
        source.postMessage({ type: 'aelion-widget-render', html, state: stateRef.current, ...widgetTheme() }, '*');
      } else if (data?.type === 'aelion-widget-height' && typeof data.height === 'number') {
        setHeight(Math.max(0, Math.min(maxHeight, Math.ceil(data.height))));
      } else if (data?.type === 'aelion-widget-state') {
        const clean = sanitizeIncomingState(data.state);
        if (!clean) return;
        const json = JSON.stringify(clean);
        if (json === lastEmittedJsonRef.current) return;
        lastEmittedJsonRef.current = json;
        onStateChangeRef.current?.(clean);
      } else if (data?.type === 'aelion-widget-prompt' && typeof data.text === 'string' && data.text.trim()) {
        window.dispatchEvent(new CustomEvent(WIDGET_PROMPT_EVENT, { detail: data.text.trim().slice(0, 2000) }));
      } else if (data?.type === 'aelion-widget-error' && typeof data.message === 'string') {
        setFailed(data.message);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [html, maxHeight, frameKey]);

  // Push external state updates (from Bot `widget_save`, reset, or synced views) into the running iframe.
  useEffect(() => {
    if (!readyRef.current) return;
    if (stateJson === lastEmittedJsonRef.current) return;
    const source = frame.current?.contentWindow;
    if (!source) return;
    lastEmittedJsonRef.current = stateJson;
    source.postMessage({ type: 'aelion-widget-state-sync', state: stateRef.current }, '*');
  }, [stateJson]);

  // Keep iframe theme variables synced when the app switches light/dark or appearance settings.
  useEffect(() => {
    const pushTheme = () => {
      if (!readyRef.current) return;
      const source = frame.current?.contentWindow;
      if (!source) return;
      source.postMessage({ type: 'aelion-widget-theme', ...widgetTheme() }, '*');
    };
    const observer = new MutationObserver(pushTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', pushTheme);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', pushTheme);
    };
  }, [frameKey]);

  const frameHeight = Math.max(minHeight, height || minHeight);
  return (
    <div className={className ? `widget-sandbox ${className}` : 'widget-sandbox'}>
      <iframe
        key={frameKey}
        ref={frame}
        src={FRAME_URL()}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={title || t('Bot 生成的交互内容')}
        style={{ height: frameHeight }}
        scrolling={height >= maxHeight ? 'yes' : 'no'}
      />
      {failed && (
        <p className="message-widget-error" role="status">
          {t('这个图示运行出错：{message}', { message: failed.slice(0, 200) })}
        </p>
      )}
    </div>
  );
}
