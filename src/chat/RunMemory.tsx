import { memo, useState } from 'react';
import type { RunRecord } from '../../shared/types/core';
import { useI18n } from '../i18n';
import './run-memory.css';

/** Under a reply: what it was reminded of and what was learned from it, each one a click away from being wrong. */
export const RunMemory = memo(function RunMemory({ memory }: { memory: NonNullable<RunRecord['memory']> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [removed, setRemoved] = useState<string[]>([]),
    [failed, setFailed] = useState(false);
  const recalled = (memory.recalled || []).filter((item) => !removed.includes(item.id)),
    learned = (memory.learned || []).filter((item) => !removed.includes(item.id));
  if (!recalled.length && !learned.length) return null;
  const forget = (id: string) => {
    setFailed(false);
    void window.aelion.memoryForget(id).then(
      () => setRemoved((list) => [...list, id]),
      () => setFailed(true),
    );
  };
  const summary = [
    recalled.length ? t('想起了 {count} 条', { count: recalled.length }) : '',
    learned.length ? t('记住了 {count} 条', { count: learned.length }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="run-memory">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {summary}
      </button>
      {open && (
        <ul>
          {recalled.map((item) => (
            <li key={'r' + item.id}>
              <span>{item.text}</span>
              <button type="button" onClick={() => forget(item.id)}>
                {t('这条不对')}
              </button>
            </li>
          ))}
          {learned.map((item) => (
            <li key={'l' + item.id}>
              <span>{item.text}</span>
              <button type="button" onClick={() => forget(item.id)}>
                {t('撤销')}
              </button>
            </li>
          ))}
          {failed && <li role="alert">{t('操作失败，可以到设置的记忆页处理')}</li>}
        </ul>
      )}
    </div>
  );
});
