import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DesignSystemSummary } from '../../shared/types/designer-types';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';

export function DesignSystemPicker({
  systems,
  value,
  onSelect,
  onClose,
  onImport,
}: {
  systems: DesignSystemSummary[];
  value: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  onImport?: () => Promise<void>;
}) {
  const { language } = useI18n(),
    en = language === 'en';
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [selected, setSelected] = useState(value),
    [importing, setImporting] = useState(false),
    [importError, setImportError] = useState('');
  // The catalog already carries 20+ categories; without facets the only way through 150+ packages is scrolling.
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of systems) if (item.category) counts.set(item.category, (counts.get(item.category) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [systems]);
  const list = useMemo(
    () =>
      systems.filter(
        (s) =>
          (!category || s.category === category) &&
          (s.name + ' ' + s.category + ' ' + s.description + (s.origin === 'custom' ? ' custom local' : ''))
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [systems, query, category],
  );
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
        aria-label={en ? 'Design systems' : '设计系统'}
        className="designer-system-dialog"
      >
        <header>
          <div>
            <h2>{en ? 'Choose a design system' : '选择设计系统'}</h2>
          </div>
          <button className="icon-button" aria-label={en ? 'Close' : '关闭'} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="designer-system-search">
          <Icon name="search" size={17} />
          <input
            autoFocus
            aria-label={en ? 'Search design systems' : '搜索设计系统'}
            placeholder={en ? 'Name, style or category' : '名称、风格或分类'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="designer-system-facets" role="group" aria-label={en ? 'Filter by category' : '按分类筛选'}>
          <button
            type="button"
            aria-pressed={!category}
            className={category ? '' : 'selected'}
            onClick={() => setCategory('')}
          >
            {en ? 'All' : '全部'}
            <em>{systems.length}</em>
          </button>
          {categories.map(([name, count]) => (
            <button
              type="button"
              key={name}
              aria-pressed={category === name}
              className={category === name ? 'selected' : ''}
              onClick={() => setCategory(category === name ? '' : name)}
            >
              {name}
              <em>{count}</em>
            </button>
          ))}
        </div>
        <div className="designer-system-grid">
          <button
            className={`designer-system-card ${selected === null ? 'selected' : ''}`}
            onClick={() => setSelected(null)}
            aria-pressed={selected === null}
          >
            <div className="designer-system-specimen is-neutral">Aa.</div>
            <strong>{en ? 'Unspecified' : '未指定'}</strong>
          </button>
          {list.map((s) => (
            <button
              key={s.id}
              className={`designer-system-card ${selected === s.id ? 'selected' : ''}`}
              aria-pressed={selected === s.id}
              onClick={() => setSelected(s.id)}
            >
              <div className="designer-system-specimen" style={s.display ? { fontFamily: s.display } : undefined}>
                <span>Aa.</span>
                <div>
                  {s.colors.map((color, i) => (
                    <i key={i} style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(color) ? color : undefined }} />
                  ))}
                </div>
              </div>
              <strong>
                {s.name}
                {s.origin === 'custom' && <em className="designer-system-origin">{en ? 'Local' : '本机'}</em>}
              </strong>
              <small className="designer-system-description">
                <span>{s.description || s.category}</span>
              </small>
            </button>
          ))}
          {!list.length && (
            <p className="designer-plugin-empty">{en ? 'No matching design system' : '没有匹配的设计系统'}</p>
          )}
        </div>
        <footer>
          {onImport && (
            <button
              type="button"
              className="designer-import-system"
              disabled={importing}
              onClick={() => {
                setImportError('');
                setImporting(true);
                void onImport()
                  .catch((error) => setImportError(ipcErrorText(error)))
                  .finally(() => setImporting(false));
              }}
            >
              {importing ? (en ? 'Importing…' : '正在导入…') : en ? 'Import DESIGN.md folder' : '导入 DESIGN.md 文件夹'}
            </button>
          )}
          <button className="primary-button" onClick={() => onSelect(selected)}>
            {en ? 'Apply' : '应用'}
          </button>
        </footer>
        {importError && (
          <p className="designer-error" role="alert">
            {importError}
          </p>
        )}
      </section>
    </div>,
    document.body,
  );
}
