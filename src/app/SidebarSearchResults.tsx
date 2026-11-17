import { useEffect, useMemo, useState } from 'react';
import type { Snapshot } from '../../shared/types/core';
import {
  CONVERSATION_SEARCH_MAX,
  CONVERSATION_SEARCH_PAGE as PAGE,
  highlightParts,
  searchTerms,
  type ConversationSearchHit,
  type ConversationSearchResult,
} from '../../shared/chat/conversation-search';
import { formatConversationTime } from '../chat/conversation-time';
import { useI18n } from '../i18n';
import './sidebar-search.css';

/** How long typing rests before the search runs. */
const DEBOUNCE_MS = 200;

/**
 * Messages matching the sidebar's search in every chat (main chats, work sessions, groups), newest first, under
 * the chats whose names match. Choosing one opens its chat at that message.
 */
export function SidebarSearchResults({
  query,
  state,
  onOpen,
}: {
  query: string;
  state: Snapshot;
  onOpen: (hit: ConversationSearchHit) => void;
}) {
  const { t } = useI18n();
  const text = query.trim(),
    terms = useMemo(() => searchTerms(text), [text]);
  // 加载更多 raises the limit for the query it was pressed on; a new query starts from the first page again.
  const [more, setMore] = useState({ query: '', limit: PAGE }),
    limit = more.query === text ? more.limit : PAGE;
  const [found, setFound] = useState<ConversationSearchResult & { query: string }>();
  useEffect(() => {
    if (!text) {
      setFound(undefined);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      window.aelion.searchConversations({ query: text, limit }).then(
        (result) => live && setFound({ ...result, query: text }),
        () => live && setFound({ hits: [], total: 0, query: text }),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, limit]);
  const rows = useMemo(() => {
    const userName = state.userProfile?.displayName.trim() || t('你');
    return (found?.hits || []).flatMap((hit) => {
      const from = hit.sender,
        scope = hit.scope,
        sender = from.kind === 'user' ? userName : state.bots.find((bot) => bot.id === from.id)?.name || from.name;
      if (scope.kind === 'group') {
        const room = state.groups?.rooms.find((item) => item.id === scope.id);
        return room ? [{ hit, name: room.name, archived: false, sender }] : [];
      }
      const bot = state.bots.find((item) => item.id === scope.id),
        session = scope.sessionId ? state.workSessions?.find((item) => item.id === scope.sessionId) : undefined;
      // The chat was deleted since the search ran.
      if (!bot || (scope.sessionId && !session)) return [];
      const name = session ? `${bot.name} · ${session.name}` : bot.name;
      return [{ hit, name, archived: Boolean(session?.archivedAt), sender }];
    });
  }, [found, state.bots, state.groups?.rooms, state.workSessions, state.userProfile?.displayName, t]);
  // Nothing is shown for a query until its first answer arrives; the previous query's results stay meanwhile.
  if (!text || !found) return null;
  return (
    <div className="search-results" role="group" aria-label={t('聊天记录')}>
      <div className="search-results-title">
        <span>{t('聊天记录')}</span>
        {found.total > 0 && <small>{found.total}</small>}
      </div>
      {rows.map(({ hit, name, archived, sender }) => (
        <button key={hit.messageId} className="search-hit" onClick={() => onOpen(hit)}>
          <span className="search-hit-line">
            <strong>{name}</strong>
            {archived && <em>{t('已归档')}</em>}
            <small>{formatConversationTime(hit.time)}</small>
          </span>
          <span className="search-hit-text">
            <span className="search-hit-sender">{sender}</span>
            {highlightParts(hit.snippet, terms).map((part, index) =>
              part.hit ? <mark key={index}>{part.text}</mark> : part.text,
            )}
          </span>
        </button>
      ))}
      {!rows.length && <div className="search-results-empty">{t('没有匹配的消息')}</div>}
      {found.query === text && found.hits.length < Math.min(found.total, CONVERSATION_SEARCH_MAX) && (
        <button className="search-results-more" onClick={() => setMore({ query: text, limit: limit + PAGE })}>
          {t('加载更多')}
        </button>
      )}
    </div>
  );
}
