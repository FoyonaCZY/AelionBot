import { memo, useState } from 'react';
import type { RunRecord } from '../../shared/types/core';
import { useI18n } from '../i18n';
import { Icon } from '../ui/Icon';
import './run-memory.css';

/** Keep one quiet disclosure under the reply, with new memories first and no repeated facts. */
export const RunMemory = memo(function RunMemory({ memory }: { memory: NonNullable<RunRecord['memory']> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [removed, setRemoved] = useState<string[]>([]),
    [forgetting, setForgetting] = useState<string[]>([]),
    [failed, setFailed] = useState(false);
  const learned = [...new Map((memory.learned || []).map((item) => [item.id, item])).values()].filter(
      (item) => !removed.includes(item.id),
    ),
    learnedIds = new Set(learned.map((item) => item.id)),
    recalled = [...new Map((memory.recalled || []).map((item) => [item.id, item])).values()].filter(
      (item) => !removed.includes(item.id) && !learnedIds.has(item.id),
    );
  if (!recalled.length && !learned.length) return null;
  const forget = (id: string) => {
    setFailed(false);
    setForgetting((list) => [...list, id]);
    void window.aelion.memoryForget(id).then(
      () => {
        setRemoved((list) => [...list, id]);
        setForgetting((list) => list.filter((item) => item !== id));
      },
      () => {
        setFailed(true);
        setForgetting((list) => list.filter((item) => item !== id));
      },
    );
  };
  const summary = learned.length
    ? t('记住了 {count} 条', { count: learned.length })
    : t('使用了 {count} 条记忆', { count: recalled.length });
  return (
    <div className="run-memory">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="memory" size={13} />
        <span>{summary}</span>
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <div className="run-memory-detail">
          {learned.length > 0 && (
            <>
              <p>{t('本次记住')}</p>
              <ul>
                {learned.map((item) => (
                  <li key={'l' + item.id}>
                    <span>{item.text}</span>
                    <button type="button" disabled={forgetting.includes(item.id)} onClick={() => forget(item.id)}>
                      {t('撤销')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {recalled.length > 0 && (
            <>
              <p>{t('本次用到')}</p>
              <ul>
                {recalled.map((item) => (
                  <li key={item.id}>
                    <span>{item.text}</span>
                    <button type="button" disabled={forgetting.includes(item.id)} onClick={() => forget(item.id)}>
                      {t('这条不对')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {failed && <p role="alert">{t('操作失败，可以到设置的记忆页处理')}</p>}
        </div>
      )}
    </div>
  );
});
