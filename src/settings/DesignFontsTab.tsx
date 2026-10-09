import { useCallback, useEffect, useState } from 'react';
import type { DesignFontCatalogEntry, DesignLibraryFont } from '../../shared/types/design-font-types';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';

// Specimen text is type, not interface copy: the same in every language.
const LATIN = { glyph: 'Ag', line: 'The quick brown fox jumps over the lazy dog 0123' };
const CJK = { glyph: '永', line: '春眠不觉晓，处处闻啼鸟。' };

function bytesLabel(bytes: number) {
  return bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
    : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

/** Loads a library font into the document under a private family name, so the card shows the real glyphs. */
function useLibraryFace(font: DesignLibraryFont, text: string) {
  const family = 'aelion-library-' + font.id;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!font.available) return;
    let live = true;
    const faces: FontFace[] = [];
    void (async () => {
      try {
        const preview = await window.aelion.previewLibraryFont({ id: font.id, text });
        for (const face of preview.faces) {
          const item = new FontFace(family, new Uint8Array(face.data), {
            weight: face.weight,
            style: face.style,
            ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
          });
          await item.load();
          if (!live) return;
          document.fonts.add(item);
          faces.push(item);
        }
        if (live && faces.length) setLoaded(true);
      } catch {
        // An unreadable file leaves the card in the fallback face; the card already says the file is missing.
      }
    })();
    return () => {
      live = false;
      for (const face of faces) document.fonts.delete(face);
    };
  }, [family, font.id, font.available, text]);
  return { family, loaded };
}

function FontCard({
  font,
  onRemove,
}: {
  font: DesignLibraryFont;
  onRemove: (font: DesignLibraryFont) => Promise<void>;
}) {
  const { t } = useI18n();
  const sample = font.cjk ? CJK : LATIN;
  const { family, loaded } = useLibraryFace(font, sample.glyph + sample.line);
  const [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false);
  const range = font.files.find((file) => file.weightRange)?.weightRange;
  const weights = range ? range.join('–') : font.weights.join(' ');
  const remove = async () => {
    if (!confirming) return setConfirming(true);
    setBusy(true);
    try {
      await onRemove(font);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <li className="design-font-card" data-font-loaded={loaded || undefined}>
      <div
        className="design-font-specimen"
        style={{ fontFamily: `"${family}", system-ui, sans-serif` }}
        aria-hidden="true"
      >
        <span className="design-font-glyph">{sample.glyph}</span>
        <span className="design-font-line">{sample.line}</span>
      </div>
      <div className="design-font-caption">
        <span className="design-caption">
          <strong>{font.family}</strong>
          {!font.available && <em>{t('文件缺失')}</em>}
        </span>
        <small className="design-caption-meta">
          {[font.source === 'fontsource' ? 'Fontsource' : t('已导入'), weights, bytesLabel(font.bytes)].join(' · ')}
        </small>
        <button
          type="button"
          className="design-font-remove"
          data-confirming={confirming || undefined}
          disabled={busy}
          aria-label={confirming ? t('确认删除') : t('删除 {name}', { name: font.family })}
          title={confirming ? t('确认删除') : t('删除 {name}', { name: font.family })}
          onClick={() => void remove()}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? t('确认删除') : <Icon name="trash" size={15} />}
        </button>
      </div>
    </li>
  );
}

export function DesignFontsTab({ onNotify }: { onNotify: (text: string) => void }) {
  const { t } = useI18n();
  const [fonts, setFonts] = useState<DesignLibraryFont[] | null>(null),
    [query, setQuery] = useState(''),
    [results, setResults] = useState<DesignFontCatalogEntry[]>([]),
    [searching, setSearching] = useState(false),
    [downloading, setDownloading] = useState<string[]>([]),
    [importing, setImporting] = useState(false),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setFonts(await window.aelion.listLibraryFonts());
    } catch (failure) {
      setFonts([]);
      setError(ipcErrorText(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // Fontsource search, after typing pauses.
  useEffect(() => {
    const text = query.trim();
    if (!text) return setResults([]);
    let live = true;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const found = await window.aelion.searchLibraryFonts({ query: text });
        if (live) setResults(found.slice(0, 8));
      } catch (failure) {
        if (live) setError(ipcErrorText(failure));
      } finally {
        if (live) setSearching(false);
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  const download = async (entry: DesignFontCatalogEntry) => {
    setDownloading((ids) => [...ids, entry.id]);
    setError('');
    // Regular and bold for Latin families; Chinese families are large, so regular only.
    const cjk = entry.subsets.some((subset) => /^(chinese|japanese|korean)/.test(subset));
    const preferred = (cjk ? [400] : [400, 700]).filter((weight) => entry.weights.includes(weight));
    try {
      const font = await window.aelion.downloadLibraryFont({
        fontId: entry.id,
        weights: preferred.length ? preferred : entry.weights.slice(0, 1),
        styles: ['normal'],
      });
      await load();
      setResults((items) => items.map((item) => (item.id === entry.id ? { ...item, inLibrary: true } : item)));
      onNotify(t('已下载 {name}', { name: font.family }));
    } catch (failure) {
      setError(ipcErrorText(failure));
    } finally {
      setDownloading((ids) => ids.filter((id) => id !== entry.id));
    }
  };
  const importFonts = async () => {
    if (importing) return;
    setImporting(true);
    setError('');
    try {
      const imported = await window.aelion.importLibraryFonts();
      if (imported?.length) {
        await load();
        onNotify(t('已导入 {count} 款字体', { count: imported.length }));
      }
    } catch (failure) {
      setError(ipcErrorText(failure));
    } finally {
      setImporting(false);
    }
  };
  const remove = async (font: DesignLibraryFont) => {
    setError('');
    try {
      await window.aelion.removeLibraryFont(font.id);
      await load();
      if (font.fontsourceId)
        setResults((items) =>
          items.map((item) => (item.id === font.fontsourceId ? { ...item, inLibrary: false } : item)),
        );
    } catch (failure) {
      setError(ipcErrorText(failure));
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
            placeholder={t('搜索 Fontsource 开源字体')}
            aria-label={t('搜索 Fontsource 开源字体')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="button" className="design-action" disabled={importing} onClick={() => void importFonts()}>
          <Icon name="plus" size={15} />
          {importing ? t('正在导入…') : t('导入字体')}
        </button>
      </div>
      {error && (
        <p role="alert" className="provider-error">
          {error}
        </p>
      )}
      {query.trim() && (
        <ul className="design-font-results" aria-busy={searching}>
          {results.map((entry) => {
            const busy = downloading.includes(entry.id);
            return (
              <li key={entry.id}>
                <span className="design-font-result-name">
                  <strong>{entry.family}</strong>
                  <small>
                    {[entry.category, `${entry.weights.length} ${t('个字重')}`].filter(Boolean).join(' · ')}
                  </small>
                  {entry.subsets.some((subset) => subset.startsWith('chinese')) && <em>{t('中文')}</em>}
                </span>
                {entry.inLibrary ? (
                  <span className="design-font-result-done">
                    <Icon name="check" size={14} />
                    {t('已在字体库')}
                  </span>
                ) : (
                  <button type="button" className="design-action" disabled={busy} onClick={() => void download(entry)}>
                    <Icon name="download" size={14} />
                    {busy ? t('正在下载…') : t('下载')}
                  </button>
                )}
              </li>
            );
          })}
          {!searching && !results.length && <li className="design-empty-line">{t('没有匹配的字体')}</li>}
        </ul>
      )}
      <h4 className="design-subhead">
        {t('我的字体')}
        {fonts && <small>{fonts.length}</small>}
      </h4>
      {fonts && fonts.length > 0 && (
        <ul className="design-font-grid">
          {fonts.map((font) => (
            <FontCard key={font.id} font={font} onRemove={remove} />
          ))}
        </ul>
      )}
      {fonts && fonts.length === 0 && (
        <div className="design-font-empty">
          <span aria-hidden="true">Aa</span>
          <p>{t('还没有字体')}</p>
        </div>
      )}
    </section>
  );
}
