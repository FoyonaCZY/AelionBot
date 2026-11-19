// Visual fences in a reply: data fences (```chart, ```table, …) drawn with the app's own blocks, and ```widget
// fences, HTML a Bot wrote, run in a sandboxed frame with no network and no way into the app.
import { useContext, useMemo, useState } from 'react';
import { inlineBlock } from '../../shared/chat/message-blocks';
import { extractWidgetTitle, widgetInScope } from '../../shared/types/widget-types';
import { MessageBlockCard } from './MessageBlocks';
import { WidgetSandboxFrame, WIDGET_PROMPT_EVENT } from './WidgetSandboxFrame';
import { WidgetHostContext, WidgetMessageContext } from './widget-context';
import { inlineWidgetKey, openPinnedWidget, setInlineWidgetState, useInlineWidgetState } from './pinned-widgets-state';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import './message-visual.css';

export { WIDGET_PROMPT_EVENT };

function InlineWidgetFrame({ html, widgetIndex }: { html: string; widgetIndex: number }) {
  const { t } = useI18n();
  const host = useContext(WidgetHostContext);
  const messageId = useContext(WidgetMessageContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const extractedTitle = useMemo(() => extractWidgetTitle(html), [html]);
  const pinned = useMemo(() => {
    if (!host || !messageId) return undefined;
    return host.pinnedWidgets.find(
      (widget) =>
        widgetInScope(widget, host.scope) &&
        widget.sourceMessageId === messageId &&
        (widget.sourceIndex ?? 0) === widgetIndex,
    );
  }, [host, messageId, widgetIndex]);

  const storageKey = host && messageId ? inlineWidgetKey(host.scope, messageId, widgetIndex) : undefined;
  const inlineState = useInlineWidgetState(storageKey);
  const currentState = pinned ? pinned.state : inlineState;
  const title = pinned ? pinned.title : extractedTitle;
  const canPin = Boolean(host && messageId);

  const togglePin = async () => {
    if (!host || !messageId || busy) return;
    setBusy(true);
    setError('');
    try {
      if (pinned) {
        await window.aelion.unpinWidget(pinned.id);
      } else {
        const created = await window.aelion.pinWidget({
          scope: host.scope,
          title: extractedTitle,
          html,
          ...(currentState ? { state: currentState } : {}),
          sourceMessageId: messageId,
          sourceIndex: widgetIndex,
        });
        openPinnedWidget(host.scope, created.id);
      }
    } catch (failure) {
      setError(ipcErrorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const handleStateChange = (next: Record<string, unknown>) => {
    if (storageKey) setInlineWidgetState(storageKey, next);
    if (pinned) {
      void window.aelion.updatePinnedWidget({ id: pinned.id, state: next }).catch((failure) => {
        setError(ipcErrorText(failure));
      });
    }
  };

  return (
    <div className={`message-widget ${canPin ? 'has-bar' : ''}`}>
      {canPin && (
        <div className="message-widget-bar">
          <span className="message-widget-title" title={title}>
            {title}
          </span>
          <button
            type="button"
            className={`message-widget-pin ${pinned ? 'is-pinned' : ''}`}
            disabled={busy}
            aria-pressed={Boolean(pinned)}
            title={pinned ? t('取消固定') : t('固定到侧栏')}
            onClick={() => void togglePin()}
          >
            <Icon name="pin" size={13} />
            <span>{pinned ? t('取消固定') : t('固定到侧栏')}</span>
          </button>
        </div>
      )}
      <WidgetSandboxFrame html={html} state={currentState} onStateChange={handleStateChange} title={title} />
      {error && (
        <p className="message-widget-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** A visual fence; `pending` while the reply is still writing it. */
export function MessageVisual({
  language,
  source,
  pending,
  widgetIndex = 0,
}: {
  language: string;
  source: string;
  pending: boolean;
  widgetIndex?: number;
}) {
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
  if (language === 'widget') return <InlineWidgetFrame html={source} widgetIndex={widgetIndex} />;
  if (parsed?.block) return <MessageBlockCard block={parsed.block} />;
  return (
    <div className="message-block message-block-failed">
      {t('这个图表没能显示：{reason}', { reason: parsed?.error || '' })}
    </div>
  );
}
