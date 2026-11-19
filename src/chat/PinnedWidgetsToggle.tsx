import { useMemo } from 'react';
import { widgetInScope, type PinnedWidget, type WidgetScope } from '../../shared/types/widget-types';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import { openPinnedWidget, usePinnedWidgetsState } from './pinned-widgets-state';
import './pinned-widgets.css';

/** Shown in the conversation header when this conversation has pinned widgets and their card is hidden. */
export function PinnedWidgetsToggle({ scope, widgets }: { scope: WidgetScope; widgets: PinnedWidget[] | undefined }) {
  const { t } = useI18n();
  const scoped = useMemo(() => (widgets || []).filter((widget) => widgetInScope(widget, scope)), [widgets, scope]);
  const { open, activeWidget } = usePinnedWidgetsState(scope, scoped);
  if (!scoped.length || open) return null;
  const label = t('显示已固定的小工具（{count}）', { count: scoped.length });
  return (
    <button
      type="button"
      className="icon-button pinned-widgets-toggle"
      aria-label={label}
      title={label}
      onClick={() =>
        openPinnedWidget(
          scope,
          activeWidget?.id,
          scoped.map((widget) => widget.id),
        )
      }
    >
      <Icon name="pin" size={18} />
      <span className="pinned-widgets-toggle-count" aria-hidden="true">
        {scoped.length}
      </span>
    </button>
  );
}
