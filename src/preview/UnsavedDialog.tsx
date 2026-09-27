import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';

export function UnsavedDialog({
  count,
  saving,
  error,
  onCancel,
  onDiscard,
  onSave,
  saveLabel,
}: {
  saveLabel?: string;
  count: number;
  saving: boolean;
  error: string;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="fp-unsaved-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <section
        ref={dialog}
        className="fp-unsaved-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('未保存的修改')}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          if (!buttons.length) {
            e.preventDefault();
            return;
          }
          const first = buttons[0],
            last = buttons.at(-1)!;
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
          e.stopPropagation();
        }}
      >
        <h2>{t('要保存修改吗？')}</h2>
        <p>{count === 1 ? t('当前文件有未保存的修改。') : t('{count} 个文件有未保存的修改。', { count })}</p>
        {error && <p role="alert">{error}</p>}
        <footer>
          <button disabled={saving} onClick={onCancel}>
            {t('继续编辑')}
          </button>
          <button disabled={saving} onClick={onDiscard}>
            {t('放弃修改')}
          </button>
          <button disabled={saving} onClick={onSave}>
            {saving ? t('保存中…') : saveLabel || t('保存并继续')}
          </button>
        </footer>
      </section>
    </div>
  );
}
