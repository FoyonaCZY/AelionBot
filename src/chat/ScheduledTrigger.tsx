import { useLayoutEffect, useRef, useState } from 'react';
import { clockTime } from './conversation-time';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import type { AutomationSignal } from '../../shared/types/scheduled-types';
import './scheduled-trigger.css';

const SOURCES: Record<AutomationSignal['kind'], string> = {
  webhook: 'Webhook',
  file: '文件夹变化',
  message: 'IM 消息',
  automation: '前一个自动化',
  script: '检查脚本',
};

/**
 * An automation firing in a conversation: its name, what set it off and when, with the instruction it sent and the
 * trigger details folded to two lines. The caller wraps it in `.scheduled-trigger`, which carries the message id.
 */
export function ScheduledTriggerCard({
  title,
  content,
  time,
  signal,
}: {
  title: string;
  content: string;
  time: string;
  signal?: AutomationSignal;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [long, setLong] = useState(false);
  const prompt = useRef<HTMLParagraphElement>(null);
  // Only a folded instruction can tell whether it has more to show.
  useLayoutEffect(() => {
    const element = prompt.current;
    if (!element || open) return;
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, signal?.detail, open]);
  const clock = clockTime(time);
  return (
    <article className={`scheduled-card ${open ? 'is-open' : ''}`}>
      <header>
        <span className="scheduled-card-icon" aria-hidden="true">
          <Icon name="clock" size={16} />
        </span>
        <span className="scheduled-card-heading">
          <strong>{title}</strong>
          <small>
            {t('自动化')}
            {signal && ` · ${t(SOURCES[signal.kind])}`}
            {signal?.count && signal.count > 1 ? ` ×${signal.count}` : ''}
            {clock && (
              <>
                {' · '}
                <time dateTime={time}>{clock}</time>
              </>
            )}
          </small>
        </span>
      </header>
      {(content || signal) && (
        <p ref={prompt} className="scheduled-card-prompt">
          {content}
          {signal && (
            <span className="scheduled-card-signal">
              {'\n'}
              {signal.detail}
            </span>
          )}
        </p>
      )}
      {(long || open) && (
        <button
          type="button"
          className="scheduled-card-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t('收起') : t('展开全文')}
          <Icon name="down" size={12} />
        </button>
      )}
    </article>
  );
}
