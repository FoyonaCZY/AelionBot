// Visual fences in a reply: data fences (```chart, ```table, …) drawn with the app's own blocks, and ```widget
// fences, HTML a Bot wrote, run in a sandboxed frame with no network and no way into the app.
import { useEffect, useMemo, useRef, useState } from 'react';
import { inlineBlock } from '../../shared/chat/message-blocks';
import { MessageBlockCard } from './MessageBlocks';
import { useI18n } from '../i18n';
import './message-visual.css';

/** Tallest a widget grows before it scrolls inside the reply. */
const MAX_HEIGHT = 2400;
const FRAME_URL = () => new URL('widget-frame.html', document.baseURI).href;

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

/** Puts a widget's suggested follow-up into the open conversation's composer. */
export const WIDGET_PROMPT_EVENT = 'aelion:widget-prompt';

function WidgetFrame({ html }: { html: string }) {
  const { t } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null),
    [height, setHeight] = useState(0),
    [failed, setFailed] = useState('');
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source) return;
      const data = event.data as { type?: string; height?: unknown; text?: unknown; message?: unknown };
      if (data?.type === 'aelion-widget-ready')
        source.postMessage({ type: 'aelion-widget-render', html, ...widgetTheme() }, '*');
      else if (data?.type === 'aelion-widget-height' && typeof data.height === 'number')
        setHeight(Math.max(0, Math.min(MAX_HEIGHT, Math.ceil(data.height))));
      else if (data?.type === 'aelion-widget-prompt' && typeof data.text === 'string' && data.text.trim())
        window.dispatchEvent(new CustomEvent(WIDGET_PROMPT_EVENT, { detail: data.text.trim().slice(0, 2000) }));
      else if (data?.type === 'aelion-widget-error' && typeof data.message === 'string') setFailed(data.message);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [html]);
  return (
    <div className="message-widget">
      <iframe
        ref={frame}
        src={FRAME_URL()}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={t('Bot 生成的交互内容')}
        style={{ height: height || 48 }}
        scrolling={height >= MAX_HEIGHT ? 'yes' : 'no'}
      />
      {failed && (
        <p className="message-widget-error" role="status">
          {t('这个图示运行出错：{message}', { message: failed.slice(0, 200) })}
        </p>
      )}
    </div>
  );
}

/** A visual fence; `pending` while the reply is still writing it. */
export function MessageVisual({ language, source, pending }: { language: string; source: string; pending: boolean }) {
  const { t } = useI18n();
  const parsed = useMemo(() => {
    if (pending || language === 'widget') return undefined;
    try {
      return { block: inlineBlock(language, source) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [language, source, pending]);
  if (pending)
    return (
      <div className="message-visual-pending" role="status">
        <span className="message-visual-spinner" aria-hidden="true" />
        {t('正在生成图示…')}
      </div>
    );
  if (language === 'widget') return <WidgetFrame html={source} />;
  if (parsed?.block) return <MessageBlockCard block={parsed.block} />;
  return (
    <div className="message-block message-block-failed">
      {t('这个图表没能显示：{reason}', { reason: parsed?.error || '' })}
    </div>
  );
}
