import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DesignSystemSummary } from '../../shared/types/designer-types';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';

/**
 * A small poster of the system in its own surface, ink, accent, type and corner: a block of the accent, cut to the
 * system's corner radius (square for sharp systems, round for pill ones), with a second palette color over it.
 * Values are checked upstream.
 */
function Specimen({ system }: { system: DesignSystemSummary }) {
  const p = system.preview || {};
  const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
  const second = [...system.colors, p.fg].find(
    (color) => color && !same(color, p.accent) && !same(color, p.bg) && !same(color, p.surface),
  );
  const style = {
    '--sp-bg': p.bg,
    '--sp-fg': p.fg,
    '--sp-accent': p.accent,
    '--sp-second': second,
    '--sp-radius': p.radius,
    '--sp-display': p.display,
  } as CSSProperties;
  const dots = [
    ...new Set([p.fg, p.accent, p.muted, p.surface, ...system.colors].filter((c): c is string => Boolean(c))),
  ].slice(0, 5);
  return (
    <div className="design-specimen" style={style} aria-hidden="true">
      <span className="design-specimen-shape" />
      <span className="design-specimen-shape is-second" />
      <span className="design-specimen-glyph">Aa</span>
      <span className="design-specimen-dots">
        {dots.map((color) => (
          <i key={color} style={{ background: color }} />
        ))}
      </span>
    </div>
  );
}

export function DesignSystemsTab({
  systems,
  onNotify,
}: {
  systems: DesignSystemSummary[];
  onNotify: (text: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(''),
    [category, setCategory] = useState(''),
    [importing, setImporting] = useState(false),
    [error, setError] = useState('');
  const chips = useRef<HTMLDivElement>(null);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of systems) if (s.category) counts.set(s.category, (counts.get(s.category) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [systems]);
  const shown = useMemo(() => {
    const search = query.trim().toLowerCase();
    return systems
      .filter(
        (s) =>
          (!category || s.category === category) &&
          (!search || `${s.name} ${s.category} ${s.description}`.toLowerCase().includes(search)),
      )
      .sort((a, b) => Number(b.origin === 'custom') - Number(a.origin === 'custom'));
  }, [systems, query, category]);
  // A mouse wheel over the category row pans it sideways until an end is reached, then the page scrolls.
  useEffect(() => {
    const row = chips.current;
    if (!row) return;
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const room = row.scrollWidth - row.clientWidth;
      if (room <= 0) return;
      if ((event.deltaY < 0 && row.scrollLeft <= 0) || (event.deltaY > 0 && row.scrollLeft >= room - 1)) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };
    row.addEventListener('wheel', wheel, { passive: false });
    return () => row.removeEventListener('wheel', wheel);
  }, []);
  const importSystem = async () => {
    if (importing) return;
    setImporting(true);
    setError('');
    try {
      const imported = await window.aelion.importDesignSystem();
      if (imported) onNotify(t('已导入设计系统 {name}', { name: imported.name }));
    } catch (failure) {
      setError(ipcErrorText(failure));
    } finally {
      setImporting(false);
    }
  };
  return (
    <section className="design-pane">
      <div className="design-toolbar">
        <label className="design-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={query}
            placeholder={t('名称、风格或分类')}
            aria-label={t('搜索设计系统')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="button" className="design-action" disabled={importing} onClick={() => void importSystem()}>
          <Icon name="plus" size={15} />
          {importing ? t('正在导入…') : t('导入')}
        </button>
      </div>
      <div className="design-chips" ref={chips} role="group" aria-label={t('按分类筛选')}>
        <button type="button" aria-pressed={!category} onClick={() => setCategory('')}>
          {t('全部')}
          <small>{systems.length}</small>
        </button>
        {categories.map(([name, count]) => (
          <button key={name} type="button" aria-pressed={category === name} onClick={() => setCategory(name)}>
            {name}
            <small>{count}</small>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="provider-error">
          {error}
        </p>
      )}
      {shown.length ? (
        <ul className="design-system-grid">
          {shown.map((s) => (
            <li key={s.id} className="design-system-card" title={s.description || undefined}>
              <Specimen system={s} />
              <span className="design-caption">
                <strong>{s.name}</strong>
                {s.origin === 'custom' && <em>{t('已导入')}</em>}
              </span>
              <small className="design-caption-meta">{s.category}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="design-empty-line">{t('没有匹配的设计系统')}</p>
      )}
    </section>
  );
}
