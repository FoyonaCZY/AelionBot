// One chat with a Bot: the header with the chat switcher, the timeline, and under it what the Bot is doing with the
// composer, or a request waiting on the user. A new session is only a screen until its first message creates it.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { conversationTimeline, liveBotStep, runSteps, type TimelineItem } from '../../../shared/chat/activity';
import type { RemoteBot } from '../../../shared/remote/protocol';
import type { ChatMessage, RunRecord } from '../../../shared/types/core';
import { Avatar } from '../../../src/ui/Avatar';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { RequestDock } from '../requests';
import { back, chatPath, go, newSessionPath, useEdgeBack } from '../router';
import { useChat } from '../use-chat';
import { I } from '../icons';
import { ConnectionBanner, Sheet, Spinner, dayLabel, elapsedLabel, timeLabel, toast, useNow } from '../ui';
import { Composer } from './Composer';
import { NoteView, RunView, UserBubble, type AnswerAction, type PressTarget } from './chat-parts';

const fallbackBot = (id: string): RemoteBot => ({ id, name: '', color: '#8b6bea', time: '' });
const tint = (color: string) => ({ '--bot': color }) as React.CSSProperties;
/** Scrolled further than this from the newest message: offer the way back. */
const AWAY_PX = 400;
/** A pause this long between messages gets a time above the next one. */
const GAP_MS = 60 * 60_000;

const itemTime = (item: TimelineItem) => (item.kind === 'message' ? item.message.time : item.messages[0]?.time);
/** Whether a time goes above this item: the first one, a new day, or after a long pause. */
function startsSpan(item: TimelineItem, previous?: TimelineItem) {
  const time = itemTime(item);
  if (!time) return false;
  const before = previous && itemTime(previous);
  if (!before) return true;
  return (
    new Date(time).toDateString() !== new Date(before).toDateString() || Date.parse(time) - Date.parse(before) > GAP_MS
  );
}

/** A new session's name: its first message, shortened. */
function sessionName(message: string) {
  const line = message.split('\n').find((item) => item.trim()) || '';
  const text = line.replace(/\s+/g, ' ').trim();
  return text.length > 30 ? text.slice(0, 30) + '…' : text;
}

/** What the Bot is doing, above the composer and always in view: the step, how long, its computer, stop. */
function RunStrip({
  bot,
  run,
  messages,
  computer,
  onJump,
  onStop,
}: {
  bot: RemoteBot;
  run: RunRecord;
  messages: ChatMessage[];
  computer: boolean;
  onJump: () => void;
  onStop: () => void;
}) {
  const { t } = useI18n();
  const now = useNow();
  const step = liveBotStep(messages, run);
  const steps = runSteps(messages).length;
  if (!step) return null;
  return (
    <div className="c-strip" style={tint(bot.color)}>
      <button className="c-strip-main" onClick={onJump}>
        <Avatar bot={bot} size={26} activity={step.phase === 'working' ? 'working' : 'thinking'} />
        <span className="c-strip-text">
          <b className="x-shimmer">{step.label + (step.detail ? ' ' + step.detail : '')}</b>
          <small>
            {[steps ? t('第 {count} 步', { count: steps + 1 }) : '', elapsedLabel(run.startedAt, now)]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </span>
      </button>
      {computer && (
        <button className="c-strip-pc" aria-label={t('工作电脑')} onClick={() => go('#/computer/' + bot.id)}>
          <I name="computer" size={18} />
        </button>
      )}
      <button className="c-strip-stop" aria-label={t('停止')} onClick={onStop}>
        <I name="stop" size={18} />
      </button>
    </div>
  );
}

export function Chat({ botId, sessionId, fresh }: { botId: string; sessionId?: string; fresh?: boolean }) {
  const { t } = useI18n();
  const { home, queue } = useConnection();
  const { view, error, more, loadingMore } = useChat(botId, sessionId, !fresh);
  const bot = home?.bots.find((item) => item.id === botId) || fallbackBot(botId);
  const session = sessionId ? home?.sessions.find((item) => item.id === sessionId) : undefined;
  const request = fresh
    ? undefined
    : home?.requests.find(
        (item) => item.botId === botId && !item.groupId && (item.sessionId || undefined) === sessionId,
      );
  const [sheet, setSheet] = useState<'chats' | 'menu' | 'permission' | 'automations'>();
  const [press, setPress] = useState<PressTarget>();
  const [selecting, setSelecting] = useState<string>();
  const [reply, setReply] = useState<{ messageId: string; text: string }>();
  const [away, setAway] = useState(false);
  const timeline = useMemo(() => (view ? conversationTimeline(view.messages) : []), [view?.messages]);
  const runs = useMemo(() => new Map((view?.runs || []).map((run) => [run.id, run])), [view?.runs]);
  // A run that started but has written nothing yet still shows its live status.
  const silentRuns = useMemo(() => {
    const shown = new Set(timeline.filter((item) => item.kind === 'run').map((item) => item.id));
    return (view?.runs || []).filter((run) => run.status === 'running' && !shown.has(run.id));
  }, [timeline, view?.runs]);
  const liveRun = useMemo(
    () => [...(view?.runs || [])].reverse().find((run) => run.status === 'running'),
    [view?.runs],
  );
  const liveMessages = useMemo(
    () => (liveRun ? (view?.messages || []).filter((message) => message.runId === liveRun.id) : []),
    [liveRun, view?.messages],
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
  const jump = () => {
    const node = scroller.current;
    if (!node) return;
    stick.current = true;
    setAway(false);
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  };
  const stop = () =>
    void connection
      .call('chat.stop', { botId, ...(sessionId ? { sessionId } : {}) })
      .catch((failure: Error) => toast(failure.message));
  const sessions = (home?.sessions || []).filter((item) => item.botId === botId);
  const automations = (home?.automations || []).filter(
    (item) => item.target.kind === 'bot' && item.target.id === botId,
  );
  const desktop = home?.computer.desktops[botId]?.status;
  const usesComputer = desktop === 'ready' || desktop === 'starting';

  // A session started here is created once, even if sending its first message has to be tried again.
  const created = useRef<string | undefined>(undefined);
  const startSession = async (message: string, files: string[]) => {
    if (created.current) return created.current;
    const name = sessionName(message) || files[0] || t('新会话');
    const made = await connection.call('session.create', { botId, name: name.slice(0, 80) });
    created.current = made.id;
    return made.id;
  };

  const act = (action: AnswerAction, target: PressTarget) => {
    if (action === 'copy') void navigator.clipboard.writeText(target.text).then(() => toast(t('已复制')));
    else if (action === 'speak') void readAloud(target.text, botId).catch((failure: Error) => toast(failure.message));
    else if (action === 'quote') setReply(target);
    else setPress(target);
  };
  const empty = fresh || (view && !timeline.length && !silentRuns.length && !queued.length);
  const lastIndex = liveRun || request ? -1 : timeline.length - 1;

  return (
    <div
      className={'c-screen' + (press ? ' is-pressed' : '')}
      {...edge.handlers}
      style={edge.offset ? { transform: `translateX(${edge.offset}px)` } : undefined}
    >
      <header className="c-nav">
        <button className="x-round" aria-label={t('返回')} onClick={back}>
          <I name="back" size={25} stroke={2.2} />
        </button>
        <button className="c-who" style={tint(bot.color)} onClick={() => setSheet('chats')}>
          <Avatar bot={bot} size={30} activity={request ? 'waiting' : liveRun ? 'working' : 'idle'} />
          <span>
            <b>{bot.name}</b>
            <small>
              <span>{fresh ? t('新会话') : session?.name || t('主聊天')}</span>
              <I name="down" size={13} stroke={2.4} />
            </small>
          </span>
        </button>
        <button
          className="x-round"
          aria-label={t('新会话')}
          disabled={fresh}
          onClick={() => go(newSessionPath(botId), true)}
        >
          <I name="compose" size={21} />
        </button>
        <button className="x-round" aria-label={t('更多')} onClick={() => setSheet('menu')}>
          <I name="more" size={23} />
        </button>
      </header>
      <ConnectionBanner />
      <div
        className="c-scroll"
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
          stick.current = distance < 80;
          setAway(distance > AWAY_PX);
          if (node.scrollTop < 160) loadMore();
        }}
      >
        {view?.hasMore && (
          <button className="c-more" onClick={loadMore}>
            {loadingMore ? <Spinner small /> : t('更早的消息')}
          </button>
        )}
        {!fresh && !view && !error && (
          <div className="c-loading">
            <Spinner />
          </div>
        )}
        {error && <p className="c-error">{error}</p>}
        {empty && (
          <div className="c-empty" style={tint(bot.color)}>
            <Avatar bot={bot} size={64} />
            <b>{t('有什么要{name}做的？', { name: bot.name })}</b>
          </div>
        )}
        {timeline.map((item, index) => (
          <div key={item.kind === 'run' ? item.segmentId : item.id} className="c-item">
            {startsSpan(item, timeline[index - 1]) && <div className="c-day">{dayLabel(itemTime(item)!)}</div>}
            {item.kind === 'message' ? (
              item.message.role === 'user' ? (
                <UserBubble message={item.message} onPress={setPress} />
              ) : (
                <NoteView message={item.message} onPress={setPress} onAction={index === lastIndex ? act : undefined} />
              )
            ) : (
              <RunView
                messages={item.messages}
                run={runs.get(item.id)}
                isLast={item.isLast}
                bot={bot}
                streams={view!.streams}
                waiting={request?.runId === item.id ? request.kind : undefined}
                onPress={setPress}
                onAction={index === lastIndex ? act : undefined}
              />
            )}
          </div>
        ))}
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
          <div key={item.id} className="c-user is-queued">
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
          {away && (
            <button className="c-jump" aria-label={t('到最新')} onClick={jump}>
              <I name="arrowDown" size={18} stroke={2.2} />
            </button>
          )}
          <RequestDock key={request.id} request={request} onComputer={() => go('#/computer/' + botId)} />
        </div>
      ) : (
        <Composer
          scope={{ kind: 'bot', id: botId, ...(sessionId ? { sessionId } : {}) }}
          reply={reply}
          onClearReply={() => setReply(undefined)}
          placeholder={t('发消息')}
          startSession={fresh ? startSession : undefined}
          onSent={(id) => {
            if (fresh && id) go(chatPath(botId, id), true);
            else jump();
          }}
          above={
            <>
              {away && (
                <button className="c-jump" aria-label={t('到最新')} onClick={jump}>
                  <I name="arrowDown" size={18} stroke={2.2} />
                </button>
              )}
              {liveRun && (
                <RunStrip
                  bot={bot}
                  run={liveRun}
                  messages={liveMessages}
                  computer={usesComputer}
                  onJump={jump}
                  onStop={stop}
                />
              )}
            </>
          }
        />
      )}

      {sheet === 'chats' && (
        <Sheet onClose={() => setSheet(undefined)}>
          <div className="s-head" style={tint(bot.color)}>
            <Avatar bot={bot} size={40} activity={bot.state === 'working' ? 'working' : 'idle'} />
            <b>{bot.name}</b>
            <button
              className="s-new-chip"
              onClick={() => {
                setSheet(undefined);
                if (!fresh) go(newSessionPath(botId), true);
              }}
            >
              <I name="plus" size={17} stroke={2.2} />
              {t('新会话')}
            </button>
          </div>
          <ul className="s-list" style={tint(bot.color)}>
            <li>
              <button
                className={'s-row' + (!sessionId && !fresh ? ' is-current' : '')}
                onClick={() => {
                  setSheet(undefined);
                  if (sessionId || fresh) go(chatPath(botId), true);
                }}
              >
                <span className="s-text">
                  <b>{t('主聊天')}</b>
                  {bot.main?.last && <small>{bot.main.last.text}</small>}
                </span>
                {bot.main?.state && bot.main.state !== 'waiting' ? (
                  <span className="h-run">
                    <i />
                  </span>
                ) : (
                  !sessionId && !fresh && <I name="check" size={20} stroke={2.2} />
                )}
              </button>
            </li>
            {sessions.map((item) => {
              const working = (item.state && item.state !== 'waiting') || (!item.state && item.working);
              return (
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
                      <small className={working ? 'x-shimmer' : ''}>
                        {item.state === 'waiting'
                          ? t('等你批准')
                          : working
                            ? item.activity
                              ? item.activity.label + (item.activity.detail ? ' ' + item.activity.detail : '')
                              : t('正在工作…')
                            : item.last?.text || ''}
                      </small>
                    </span>
                    {working ? (
                      <span className="h-run">
                        <i />
                      </span>
                    ) : item.id === sessionId ? (
                      <I name="check" size={20} stroke={2.2} />
                    ) : (
                      <time>{timeLabel(item.time)}</time>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
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
            {view && (
              <li>
                <button onClick={() => setSheet('permission')}>
                  <I name="shield" size={22} />
                  {t('本机操作权限')}
                  <em>
                    {view.permission === 'ask'
                      ? t('每次询问')
                      : view.permission === 'full'
                        ? t('完全放行')
                        : t('自动审批')}
                  </em>
                </button>
              </li>
            )}
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
                act('copy', press);
                setPress(undefined);
              }}
            >
              {t('复制')}
              <I name="copy" size={20} />
            </button>
            {home?.speech.output && (
              <button
                onClick={() => {
                  act('speak', press);
                  setPress(undefined);
                }}
              >
                {t('朗读')}
                <I name="speaker" size={20} />
              </button>
            )}
            <button
              onClick={() => {
                act('quote', press);
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
