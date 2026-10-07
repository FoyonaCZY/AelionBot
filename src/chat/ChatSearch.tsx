import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '../../shared/types/core';
import { searchMessages } from '../../shared/chat/activity';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import { revealMessage } from './reveal-message';
import './chat-search.css';

const HIT_CLASS = 'is-search-hit';

/** Scrolls a message into view, first asking a folded run process or the timeline to render it. */
function reveal(id: string) {
  document.querySelectorAll('.' + HIT_CLASS).forEach((node) => node.classList.remove(HIT_CLASS));
  void revealMessage(id, () =>
    document.querySelector<HTMLElement>(`.messages [data-message-id="${CSS.escape(id)}"]`),
  ).then((target) => {
    if (!target) return;
    target.classList.add(HIT_CLASS);
    target.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  });
}

/** Search in the selected conversation: Ctrl/Cmd+F opens it, Enter and Shift+Enter step through matches. */
export function ChatSearch({ messages, scopeKey }: { messages: ChatMessage[]; scopeKey: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => (open ? searchMessages(messages, query) : []), [open, messages, query]);
  const close = () => {
    setOpen(false);
    setQuery('');
    document.querySelectorAll('.' + HIT_CLASS).forEach((node) => node.classList.remove(HIT_CLASS));
  };
  useEffect(close, [scopeKey]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        // Leave find shortcuts inside preview panels and dialogs to those surfaces.
        if ((event.target as HTMLElement | null)?.closest?.('.fp-panel, [role="dialog"]')) return;
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => input.current?.select());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Newest match first: a search usually looks for something recent.
  useEffect(() => {
    setIndex(hits.length ? hits.length - 1 : 0);
    if (hits.length) reveal(hits[hits.length - 1].id);
  }, [query]);
  const step = (delta: number) => {
    if (!hits.length) return;
    const next = (index + delta + hits.length) % hits.length;
    setIndex(next);
    reveal(hits[next].id);
  };
  if (!open)
    return (
      <button
        className="icon-button chat-search-open"
        aria-label={t('搜索聊天记录')}
        title={t('搜索聊天记录')}
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => input.current?.focus());
        }}
      >
        <Icon name="search" size={16} />
      </button>
    );
  return (
    <div className="chat-search" role="search">
      <Icon name="search" size={14} />
      <input
        ref={input}
        value={query}
        placeholder={t('搜索聊天记录')}
        aria-label={t('搜索聊天记录')}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            step(event.shiftKey ? 1 : -1);
          }
        }}
      />
      {query.trim() && (
        <span className="chat-search-count" aria-live="polite">
          {hits.length ? `${index + 1}/${hits.length}` : t('没有匹配的消息')}
        </span>
      )}
      <button
        className="chat-search-step is-prev"
        aria-label={t('上一个结果')}
        disabled={!hits.length}
        onClick={() => step(-1)}
      >
        <Icon name="down" size={13} />
      </button>
      <button
        className="chat-search-step is-next"
        aria-label={t('下一个结果')}
        disabled={!hits.length}
        onClick={() => step(1)}
      >
        <Icon name="down" size={13} />
      </button>
      <button className="chat-search-step" aria-label={t('关闭搜索')} onClick={close}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
