import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DesignPluginSummary } from '../../shared/types/designer-types';
import { designPluginCopy, filterDesignPlugins } from './designer-plugin-copy';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';

export function DesignPluginPicker({
  plugins,
  selected,
  onChange,
  onClose,
}: {
  plugins: DesignPluginSummary[];
  selected: string[];
  onChange: (ids: string[]) => void;
  onClose: () => void;
}) {
  const { language } = useI18n(),
    en = language === 'en';
  const [query, setQuery] = useState('');
  const list = useMemo(() => filterDesignPlugins(plugins, query, en), [plugins, query, en]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [onClose]);
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  return createPortal(
    <div
      className="modal-backdrop designer-system-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={en ? 'Optional checks' : '可选检查'}
        className="designer-system-dialog designer-plugin-dialog"
      >
        <header>
          <div>
            <h2>{en ? 'Optional checks' : '可选检查'}</h2>
          </div>
          <button className="icon-button" aria-label={en ? 'Close' : '关闭'} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="designer-system-search">
          <Icon name="search" size={17} />
          <input
            autoFocus
            aria-label={en ? 'Search checks' : '搜索检查'}
            placeholder={en ? 'Name or purpose' : '名称或用途'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="designer-plugin-list">
          {list.map((plugin) => {
            const copy = designPluginCopy(plugin, en),
              on = selected.includes(plugin.id);
            return (
              <button
                type="button"
                key={plugin.id}
                className={`designer-plugin-row ${on ? 'selected' : ''}`}
                aria-pressed={on}
                onClick={() => toggle(plugin.id)}
              >
                <span className="designer-plugin-check" aria-hidden="true">
                  {on ? '✓' : ''}
                </span>
                <span>
                  <strong>{copy.name}</strong>
                  <small>{copy.description}</small>
                </span>
              </button>
            );
          })}
          {!list.length && <p className="designer-plugin-empty">{en ? 'No matching checks' : '没有匹配的检查'}</p>}
        </div>
        <footer>
          <button
            type="button"
            className="designer-import-system"
            disabled={!selected.length}
            onClick={() => onChange([])}
          >
            {en ? 'Clear selection' : '全部取消'}
          </button>
          <button className="primary-button" onClick={onClose}>
            {en ? 'Done' : '完成'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
