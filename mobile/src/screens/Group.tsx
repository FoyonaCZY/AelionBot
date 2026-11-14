// A group chat: everyone's messages with who said them, and the composer. The computer pushes the latest page when
// the group changes; older pages load on scroll.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { GroupMessage } from '../../../shared/types/group-types';
import { readableContent } from '../../../shared/chat/activity';
import MessageMarkdown from '../../../src/chat/MessageMarkdown';
import { Avatar } from '../../../src/ui/Avatar';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { back, useEdgeBack } from '../router';
import { useGroup } from '../use-chat';
import { I } from '../icons';
import { ConnectionBanner, Spinner, toast } from '../ui';
import { Composer } from './Composer';
import { Files } from './chat-parts';

export function Group({ id }: { id: string }) {
  const { t } = useI18n();
  const { home, status } = useConnection();
  const { page, error } = useGroup(id);
  const [older, setOlder] = useState<{ messages: GroupMessage[]; before?: string; loading?: boolean }>({
    messages: [],
  });
  const scroller = useRef<HTMLDivElement>(null),
    stick = useRef(true);
  const edge = useEdgeBack();
  const room = home?.groups.find((item) => item.id === id);
  const messages = [...older.messages, ...(page?.messages || [])].filter(
    (message, index, list) =>
      (message.kind === 'message' || message.kind === 'system') &&
      list.findIndex((item) => item.id === message.id) === index,
  );
  useEffect(() => setOlder({ messages: [] }), [id]);
  useLayoutEffect(() => {
    if (stick.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  });
  // Read what is on screen.
  const lastSeq = page?.group.lastSeq;
  useEffect(() => {
    if (lastSeq && status === 'ready' && document.visibilityState === 'visible')
      void connection.call('group.read', { id, seq: lastSeq }).catch(() => {});
  }, [lastSeq, status, id]);
  const loadOlder = async () => {
    const before = older.before ?? page?.before;
    if (!before || older.loading) return;
    setOlder((current) => ({ ...current, loading: true }));
    try {
      const previous = await connection.call('group.more', { id, before });
      setOlder((current) => ({ messages: [...previous.messages, ...current.messages], before: previous.before }));
    } catch (failure) {
      toast((failure as Error).message);
      setOlder((current) => ({ ...current, loading: false }));
    }
  };
  const bots = new Map((home?.bots || []).map((bot) => [bot.id, bot]));
  return (
    <div
      className="c-screen"
      {...edge.handlers}
      style={edge.offset ? { transform: `translateX(${edge.offset}px)` } : undefined}
    >
      <header className="c-nav">
        <button className="x-round" aria-label={t('返回')} onClick={back}>
          <I name="back" size={26} stroke={2.2} />
        </button>
        <div className="c-title is-static">
          <b>{page?.group.name || room?.name}</b>
          <small>{t('{count} 个 Bot', { count: page?.group.members.length || room?.members.length || 0 })}</small>
        </div>
        <span className="x-round" />
      </header>
      <ConnectionBanner />
      <div
        className="c-scroll"
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
      >
        {(older.before ?? page?.before) && (
          <button className="c-more" onClick={() => void loadOlder()}>
            {older.loading ? <Spinner small /> : t('更早的消息')}
          </button>
        )}
        {!page && !error && (
          <div className="c-loading">
            <Spinner />
          </div>
        )}
        {error && <p className="c-error">{error}</p>}
        {messages.map((message) => {
          const sender = message.sender;
          if (message.kind === 'system' || sender.kind === 'system')
            return (
              <p key={message.id} className="c-note">
                {readableContent(message.content)}
              </p>
            );
          if (sender.kind === 'user')
            return (
              <div key={message.id} className="c-user" style={{ '--bot': '#8b6bea' } as React.CSSProperties}>
                <Files files={message.attachments} />
                {message.content.trim() && <div className="c-bubble">{message.content}</div>}
              </div>
            );
          const bot = bots.get(sender.id) || sender;
          return (
            <div key={message.id} className="g-message" style={{ '--bot': bot.color } as React.CSSProperties}>
              <Avatar bot={bot} size={30} />
              <div className="g-body">
                <b>{bot.name}</b>
                <div className="c-answer markdown">
                  <MessageMarkdown>{readableContent(message.content)}</MessageMarkdown>
                </div>
                <Files files={message.attachments} />
              </div>
            </div>
          );
        })}
      </div>
      <Composer
        scope={{ kind: 'group', id }}
        running={Boolean(room?.active)}
        onStop={() => void connection.call('group.stop', { id }).catch((failure: Error) => toast(failure.message))}
        placeholder={t('发到群里')}
      />
    </div>
  );
}
