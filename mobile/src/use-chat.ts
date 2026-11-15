// One open chat: its window of messages and runs from the computer, kept current by the deltas it pushes, and
// reopened whenever the connection comes back.
import { useCallback, useEffect, useState } from 'react';
import { applyEntityDelta } from '../../shared/state-sync';
import { chatKey, type ChatDelta, type ChatView } from '../../shared/remote/protocol';
import type { GroupPage } from '../../shared/types/group-types';
import { connection } from './connection';
import { markSeen } from './storage';

function apply(view: ChatView, delta: ChatDelta): ChatView {
  return {
    ...view,
    ...(delta.messages ? { messages: applyEntityDelta(view.messages, delta.messages) } : {}),
    ...(delta.runs ? { runs: applyEntityDelta(view.runs, delta.runs) } : {}),
    ...(delta.streams ? { streams: delta.streams } : {}),
    ...(delta.permission ? { permission: delta.permission } : {}),
  };
}

/** With `open` false: a chat that does not exist yet (a new session before its first message). */
export function useChat(botId: string, sessionId?: string, open = true) {
  const key = chatKey(botId, sessionId);
  const [view, setView] = useState<ChatView>();
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setView(undefined);
    setError(undefined);
    const load = () =>
      connection.call('chat.open', { botId, ...(sessionId ? { sessionId } : {}) }).then(
        (opened) => alive && setView(opened),
        (failure: Error) => alive && setError(failure.message),
      );
    if (connection.state.status === 'ready') void load();
    const offReady = connection.on('ready', () => void load());
    const offChat = connection.on('chat', (data) => {
      const delta = data as ChatDelta;
      if (alive && delta.key === key) setView((current) => (current ? apply(current, delta) : current));
    });
    connection.presence(key);
    markSeen('bot:' + botId);
    markSeen('chat:' + key);
    return () => {
      alive = false;
      offReady();
      offChat();
      markSeen('bot:' + botId);
      markSeen('chat:' + key);
      connection.presence(null);
      if (connection.state.status === 'ready') void connection.call('chat.close').catch(() => {});
    };
  }, [key, open]);
  const more = useCallback(async () => {
    if (!view?.hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const older = await connection.call('chat.more', { key });
      setView((current) =>
        current
          ? {
              ...current,
              messages: [
                ...older.messages,
                ...current.messages.filter((m) => !older.messages.some((o) => o.id === m.id)),
              ],
              runs: [...older.runs.filter((run) => !current.runs.some((item) => item.id === run.id)), ...current.runs],
              hasMore: older.hasMore,
            }
          : current,
      );
    } finally {
      setLoadingMore(false);
    }
  }, [view?.hasMore, loadingMore, key]);
  return { view, error, more, loadingMore };
}

/** One open group: its latest page, replaced when the computer pushes a newer one. */
export function useGroup(id: string) {
  const [page, setPage] = useState<GroupPage>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    setPage(undefined);
    const open = () =>
      connection.call('group.open', { id }).then(
        (opened) => alive && setPage(opened),
        (failure: Error) => alive && setError(failure.message),
      );
    if (connection.state.status === 'ready') void open();
    const offReady = connection.on('ready', () => void open());
    const offGroup = connection.on('group', (data) => {
      const next = data as GroupPage;
      if (alive && next.group.id === id) setPage(next);
    });
    connection.presence('group:' + id);
    return () => {
      alive = false;
      offReady();
      offGroup();
      connection.presence(null);
      if (connection.state.status === 'ready') void connection.call('group.close').catch(() => {});
    };
  }, [id]);
  return { page, error };
}
