import { useEffect, useRef, useState } from 'react';
import { WIDGET_MAX_TITLE_CHARS, type PinnedWidget, type WidgetScope } from '../../shared/types/widget-types';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import { WidgetSandboxFrame } from './WidgetSandboxFrame';
import { closePinnedWidgetsCard, selectPinnedWidget } from './pinned-widgets-state';
import './pinned-widgets.css';

export function PinnedWidgetsCard({
  scope,
  widgets,
  active,
}: {
  scope: WidgetScope;
  widgets: PinnedWidget[];
  active: PinnedWidget;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(active.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditing(false);
    setDraftTitle(active.title);
    setError('');
  }, [active.id, active.title]);

  useEffect(() => {
    if (editing) {
      titleInput.current?.focus();
      titleInput.current?.select();
    }
  }, [editing]);

  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(ipcErrorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const commitTitle = () => {
    const trimmed = draftTitle.replace(/[\r\n\t]+/g, ' ').trim();
    setEditing(false);
    if (!trimmed || trimmed === active.title) {
      setDraftTitle(active.title);
      return;
    }
    void run(() =>
      window.aelion.updatePinnedWidget({
        id: active.id,
        title: trimmed.slice(0, WIDGET_MAX_TITLE_CHARS),
      }),
    );
  };

  const hasState = Object.keys(active.state || {}).length > 0;

  return (
    <section className="pinned-widgets-card" aria-label={t('固定小工具：{title}', { title: active.title })}>
      <header className="pinned-widgets-head">
        <span className="pinned-widgets-badge" aria-hidden="true">
          <Icon name="pin" size={14} />
        </span>
        {editing ? (
          <input
            ref={titleInput}
            type="text"
            className="pinned-widgets-title-input"
            value={draftTitle}
            maxLength={WIDGET_MAX_TITLE_CHARS}
            aria-label={t('重命名小工具')}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitTitle();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
                setDraftTitle(active.title);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="pinned-widgets-title"
            title={active.title}
            onClick={() => {
              setDraftTitle(active.title);
              setEditing(true);
            }}
          >
            {active.title}
          </button>
        )}
        <div className="pinned-widgets-actions">
          <button
            type="button"
            className="pinned-widgets-action"
            aria-label={t('重命名')}
            title={t('重命名')}
            disabled={busy}
            onClick={() => {
              setDraftTitle(active.title);
              setEditing(true);
            }}
          >
            <Icon name="edit" size={13} />
          </button>
          <button
            type="button"
            className="pinned-widgets-action"
            aria-label={t('重置状态')}
            title={t('重置状态')}
            disabled={busy || !hasState}
            onClick={() => void run(() => window.aelion.updatePinnedWidget({ id: active.id, resetState: true }))}
          >
            <Icon name="restart" size={13} />
          </button>
          <button
            type="button"
            className="pinned-widgets-action is-danger"
            aria-label={t('取消固定')}
            title={t('取消固定')}
            disabled={busy}
            onClick={() => void run(() => window.aelion.unpinWidget(active.id))}
          >
            <Icon name="trash" size={13} />
          </button>
          <button
            type="button"
            className="pinned-widgets-action"
            aria-label={t('隐藏小工具卡片')}
            title={t('隐藏小工具卡片')}
            onClick={() => closePinnedWidgetsCard(scope, widgets)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </header>
      {widgets.length > 1 && (
        <div className="pinned-widgets-tabs" role="tablist" aria-label={t('已固定的小工具')}>
          {widgets.map((widget) => {
            const selected = widget.id === active.id;
            return (
              <button
                key={widget.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`pinned-widgets-tab ${selected ? 'is-active' : ''}`}
                title={widget.title}
                onClick={() => selectPinnedWidget(scope, widget.id)}
              >
                {widget.title}
              </button>
            );
          })}
        </div>
      )}
      <div className="pinned-widgets-body">
        <WidgetSandboxFrame
          key={active.id}
          html={active.html}
          state={active.state}
          maxHeight={420}
          minHeight={64}
          title={active.title}
          onStateChange={(next) => {
            void window.aelion.updatePinnedWidget({ id: active.id, state: next }).catch((failure) => {
              setError(ipcErrorText(failure));
            });
          }}
        />
      </div>
      {error && (
        <p className="pinned-widgets-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
