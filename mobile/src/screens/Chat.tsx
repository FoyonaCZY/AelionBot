// One chat with a Bot: header with the chat switcher, the timeline, and the composer or a request waiting on the user.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { conversationTimeline } from '../../../shared/chat/activity';
import type { RemoteBot } from '../../../shared/remote/protocol';
import { Avatar } from '../../../src/ui/Avatar';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { RequestDock } from '../requests';
import { back, chatPath, go, useEdgeBack } from '../router';
import { useChat } from '../use-chat';
import { I } from '../icons';
import { ConnectionBanner, Sheet, Spinner, timeLabel, toast } from '../ui';
import { Composer } from './Composer';
import { NoteView, RunView, UserBubble, type PressTarget } from './chat-parts';

const fallbackBot = (id: string): RemoteBot => ({ id, name: '', color: '#8b6bea', time: '' });

export function Chat({ botId, sessionId }: { botId: string; sessionId?: string }) {
  const { t } = useI18n();
  const { home, queue } = useConnection();
  const { view, error, more, loadingMore } = useChat(botId, sessionId);
  const bot = home?.bots.find((item) => item.id === botId) || fallbackBot(botId);
  const session = sessionId ? home?.sessions.find((item) => item.id === sessionId) : undefined;
  const request = home?.requests.find(
    (item) => item.botId === botId && !item.groupId && (item.sessionId || undefined) === sessionId,
  );
  const [sheet, setSheet] = useState<'chats' | 'menu' | 'permission' | 'automations'>();
  const [press, setPress] = useState<PressTarget>();
  const [selecting, setSelecting] = useState<string>();
  const [reply, setReply] = useState<{ messageId: string; text: string }>();
  const timeline = useMemo(() => (view ? conversationTimeline(view.messages) : []), [view?.messages]);
  const runs = useMemo(() => new Map((view?.runs || []).map((run) => [run.id, run])), [view?.runs]);
  // A run that started but has written nothing yet still shows its live status.
  const silentRuns = useMemo(() => {
    const shown = new Set(timeline.filter((item) => item.kind === 'run').map((item) => item.id));
    return (view?.runs || []).filter((run) => run.status === 'running' && !shown.has(run.id));
  }, [timeline, view?.runs]);
  const running = Boolean(
    view?.runs.some((run) => run.status === 'running') ||
    view?.messages.some((message) => message.inputState === 'queued'),
  );
  const queued = queue.filter((item) => item.botId === botId && (item.sessionId || undefined) === sessionId);
  const scroller = useRef<HTMLDivElement>(null),
    stick = useRef(true),
    anchor = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    if (anchor.current !== undefined) {
      // Older messages were added above: keep what the user was reading in place.
      node.scrollTop = node.scrollHeight - anchor.current;
      anchor.current = undefined;
    } else if (stick.current) node.scrollTop = node.scrollHeight;
  });
  const edge = useEdgeBack(!press && !sheet);
  const loadMore = () => {
    if (!scroller.current || !view?.hasMore || loadingMore) return;
    anchor.current = scroller.current.scrollHeight - scroller.current.scrollTop;
    void more();
  };
  const sessions = (home?.sessions || []).filter((item) => item.botId === botId);
  const automations = (home?.automations || []).filter(
    (item) => item.target.kind === 'bot' && item.target.id === botId,
  );

  return (
    <div
      className={'c-screen' + (press ? ' is-pressed' : '')}
      {...edge.handlers}
      style={edge.offset ? { transform: `translateX(${edge.offset}px)` } : undefined}
    >
      <header className="c-nav">
        <button className="x-round" aria-label={t('返回')} onClick={back}>
          <I name="back" size={26} stroke={2.2} />
        </button>
        <button className="c-title" onClick={() => setSheet('chats')}>
          <b>{bot.name}</b>
          <small>
            {session?.name || t('主聊天')}
            <I name="down" size={14} stroke={2.2} />
          </small>
        </button>
        <button className="x-round" aria-label={t('更多')} onClick={() => setSheet('menu')}>
          <I name="more" size={24} />
        </button>
      </header>
      <ConnectionBanner />
      <div
        className={'c-scroll' + (request ? ' has-dock' : '')}
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          if (node.scrollTop < 160) loadMore();
        }}
      >
        {view?.hasMore && (
          <button className="c-more" onClick={loadMore}>
            {loadingMore ? <Spinner small /> : t('更早的消息')}
          </button>
        )}
        {!view && !error && (
          <div className="c-loading">
            <Spinner />
          </div>
        )}
        {error && <p className="c-error">{error}</p>}
        {view && !timeline.length && !silentRuns.length && (
          <div className="c-empty" style={{ '--bot': bot.color } as React.CSSProperties}>
            <Avatar bot={bot} size={64} />
            <p>{t('给 {name} 发消息，它会在电脑上开始工作。', { name: bot.name })}</p>
          </div>
        )}
        {timeline.map((item) =>
          item.kind === 'message' ? (
            item.message.role === 'user' ? (
              <UserBubble key={item.id} message={item.message} bot={bot} onPress={setPress} />
            ) : (
              <NoteView key={item.id} message={item.message} onPress={setPress} />
            )
          ) : (
            <RunView
              key={item.segmentId}
              messages={item.messages}
              run={runs.get(item.id)}
              isLast={item.isLast}
              bot={bot}
              streams={view!.streams}
              waiting={request?.runId === item.id ? request.kind : undefined}
              onPress={setPress}
              onComputer={() => go('#/computer/' + botId)}
            />
          ),
        )}
        {silentRuns.map((run) => (
          <RunView
            key={run.id}
            messages={[]}
            run={run}
            isLast
            bot={bot}
            streams={view!.streams}
            waiting={request?.runId === run.id ? request.kind : undefined}
            onPress={setPress}
          />
        ))}
        {queued.map((item) => (
          <div key={item.id} className="c-user is-queued" style={{ '--bot': bot.color } as React.CSSProperties}>
            <div className="c-bubble">{item.text}</div>
            <small className="c-user-note">
              {t('电脑上线后发送')} ·{' '}
              <button className="x-link" onClick={() => void connection.dequeue(item.id)}>
                {t('取消')}
              </button>
            </small>
          </div>
        ))}
      </div>
      {request ? (
        <div className="c-foot">
          <RequestDock request={request} onComputer={() => go('#/computer/' + botId)} />
        </div>
      ) : (
        <Composer
          scope={{ kind: 'bot', id: botId, ...(sessionId ? { sessionId } : {}) }}
          running={running}
          onStop={() =>
            void connection
              .call('chat.stop', { botId, ...(sessionId ? { sessionId } : {}) })
              .catch((failure: Error) => toast(failure.message))
          }
          reply={reply}
          onClearReply={() => setReply(undefined)}
          placeholder={t('发消息')}
        />
      )}

      {sheet === 'chats' && (
        <Sheet onClose={() => setSheet(undefined)}>
          <div className="s-head" style={{ '--bot': bot.color } as React.CSSProperties}>
            <Avatar bot={bot} size={44} activity={bot.state === 'working' ? 'working' : 'idle'} />
            <b>{bot.name}</b>
          </div>
          <ul className="s-list">
            <li>
              <button
                className={'s-row' + (!sessionId ? ' is-current' : '')}
                onClick={() => {
                  setSheet(undefined);
                  if (sessionId) go(chatPath(botId), true);
                }}
              >
                <span className="s-text">
                  <b>{t('主聊天')}</b>
                </span>
                {!sessionId && <I name="check" size={20} stroke={2.2} />}
              </button>
            </li>
            {sessions.map((item) => (
              <li key={item.id}>
                <button
                  className={'s-row' + (item.id === sessionId ? ' is-current' : '')}
                  onClick={() => {
                    setSheet(undefined);
                    if (item.id !== sessionId) go(chatPath(botId, item.id), true);
                  }}
                >
                  <span className="s-text">
                    <b>{item.name}</b>
                    <small className={item.working ? 'x-shimmer' : ''}>
                      {item.working ? t('正在工作…') : item.last?.text || ''}
                    </small>
                  </span>
                  {item.id === sessionId ? (
                    <I name="check" size={20} stroke={2.2} />
                  ) : (
                    <time>{timeLabel(item.time)}</time>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <button
            className="s-new"
            onClick={async () => {
              setSheet(undefined);
              try {
                const now = new Date();
                const created = await connection.call('session.create', {
                  botId,
                  name: t('手机上的会话 {time}', {
                    time: `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
                  }),
                });
                go(chatPath(botId, created.id), true);
              } catch (failure) {
                toast((failure as Error).message);
              }
            }}
          >
            <I name="plus" size={20} stroke={2} />
            {t('新会话')}
          </button>
        </Sheet>
      )}

      {sheet === 'menu' && (
        <Sheet onClose={() => setSheet(undefined)}>
          <ul className="s-menu">
            <li>
              <button onClick={() => go('#/computer/' + botId)}>
                <I name="computer" size={22} />
                {t('工作电脑')}
              </button>
            </li>
            <li>
              <button onClick={() => go('#/files/' + botId)}>
                <I name="folder" size={22} />
                {t('文件')}
              </button>
            </li>
            <li>
              <button onClick={() => setSheet('automations')}>
                <I name="clock" size={22} />
                {t('自动化')}
                {automations.length > 0 && <em>{automations.length}</em>}
              </button>
            </li>
            <li>
              <button onClick={() => setSheet('permission')}>
                <I name="shield" size={22} />
                {t('本机操作权限')}
                <em>
                  {view?.permission === 'ask'
                    ? t('每次询问')
                    : view?.permission === 'full'
                      ? t('完全放行')
                      : t('自动审批')}
                </em>
              </button>
            </li>
            {sessionId && (
              <li>
                <button
                  onClick={async () => {
                    setSheet(undefined);
                    try {
                      await connection.call('session.update', { id: sessionId, archived: true });
                      go('#/', true);
                    } catch (failure) {
                      toast((failure as Error).message);
                    }
                  }}
                >
                  <I name="trash" size={22} />
                  {t('归档这个会话')}
                </button>
              </li>
            )}
          </ul>
        </Sheet>
      )}

      {sheet === 'permission' && view && (
        <Sheet onClose={() => setSheet(undefined)}>
          <div className="s-title">{t('本机操作权限')}</div>
          <ul className="s-list">
            {(
              [
                ['ask', t('每次询问'), t('读写文件、运行命令前都问你')],
                ['auto', t('自动审批'), t('审核模型放行常规操作，高风险的才问你')],
              ] as const
            ).map(([mode, label, hint]) => (
              <li key={mode}>
                <button
                  className={'s-row' + (view.permission === mode ? ' is-current' : '')}
                  onClick={async () => {
                    try {
                      await connection.call('permission.set', { botId, ...(sessionId ? { sessionId } : {}), mode });
                      setSheet(undefined);
                    } catch (failure) {
                      toast((failure as Error).message);
                    }
                  }}
                >
                  <span className="s-text">
                    <b>{label}</b>
                    <small>{hint}</small>
                  </span>
                  {view.permission === mode && <I name="check" size={20} stroke={2.2} />}
                </button>
              </li>
            ))}
          </ul>
          <p className="s-note">{t('“完全放行”只能在电脑上开启。')}</p>
        </Sheet>
      )}

      {sheet === 'automations' && (
        <Sheet onClose={() => setSheet(undefined)}>
          <div className="s-title">{t('自动化')}</div>
          {automations.length ? (
            <ul className="s-list">
              {automations.map((item) => (
                <li key={item.id} className="s-row">
                  <span className="s-text">
                    <b>{item.title}</b>
                    <small>
                      {item.trigger}
                      {item.nextRunAt && item.status === 'enabled'
                        ? ' · ' + t('下次 {time}', { time: timeLabel(item.nextRunAt) })
                        : ''}
                      {item.needsReview ? ' · ' + t('需要先在电脑上查看') : ''}
                    </small>
                  </span>
                  <button
                    className="x-round is-small"
                    aria-label={t('立即运行')}
                    onClick={() =>
                      void connection.call('automation.run', { id: item.id }).then(
                        () => toast(t('已开始运行')),
                        (failure: Error) => toast(failure.message),
                      )
                    }
                  >
                    <I name="play" size={18} />
                  </button>
                  <button
                    role="switch"
                    aria-checked={item.status === 'enabled'}
                    aria-label={item.title}
                    className={'x-switch' + (item.status === 'enabled' ? ' is-on' : '')}
                    disabled={item.status === 'completed'}
                    onClick={() =>
                      void connection
                        .call('automation.setEnabled', { id: item.id, enabled: item.status !== 'enabled' })
                        .catch((failure: Error) => toast(failure.message))
                    }
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="s-note">{t('这个 Bot 还没有自动化。可以在对话里让它帮你建一个。')}</p>
          )}
        </Sheet>
      )}

      {press && (
        <div className="m-press" onClick={() => setPress(undefined)}>
          <div className="m-press-message">{press.text.slice(0, 600)}</div>
          <div className="m-press-menu" onClick={(event) => event.stopPropagation()}>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(press.text).then(() => toast(t('已复制')));
                setPress(undefined);
              }}
            >
              {t('复制')}
              <I name="copy" size={20} />
            </button>
            {home?.speech.output && (
              <button
                onClick={() => {
                  const text = press.text;
                  setPress(undefined);
                  void readAloud(text, botId).catch((failure: Error) => toast(failure.message));
                }}
              >
                {t('朗读')}
                <I name="speaker" size={20} />
              </button>
            )}
            <button
              onClick={() => {
                setReply({ messageId: press.messageId, text: press.text });
                setPress(undefined);
              }}
            >
              {t('引用回复')}
              <I name="quote" size={20} />
            </button>
            <button
              onClick={() => {
                setSelecting(press.text);
                setPress(undefined);
              }}
            >
              {t('选择文字')}
              <I name="select" size={20} />
            </button>
          </div>
        </div>
      )}
      {selecting !== undefined && (
        <Sheet onClose={() => setSelecting(undefined)} tall>
          <div className="s-select">{selecting}</div>
        </Sheet>
      )}
    </div>
  );
}

let playing: HTMLAudioElement | undefined;
async function readAloud(text: string, botId: string) {
  playing?.pause();
  const { audio, mime } = await connection.call('speech.synthesize', { text: text.slice(0, 20_000), botId });
  playing = new Audio(URL.createObjectURL(new Blob([audio as Uint8Array<ArrayBuffer>], { type: mime })));
  await playing.play();
}
