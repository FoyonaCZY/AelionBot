// The list of Bots, like a messaging app: the computer in use on top, requests waiting first, each Bot with today's
// work sessions under it, groups below.
import { useState } from 'react';
import { chatKey, type RemoteBot, type RemoteLane, type RemoteSessionRow } from '../../../shared/remote/protocol';
import { Avatar } from '../../../src/ui/Avatar';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { RequestCard } from '../requests';
import { chatPath, go, newSessionPath } from '../router';
import { lastSeen } from '../storage';
import { I } from '../icons';
import { Sheet, Spinner, elapsedLabel, timeLabel, useNow } from '../ui';

type T = (key: string, values?: Record<string, string | number>) => string;
const tint = (color: string) => ({ '--bot': color }) as React.CSSProperties;
/** Sessions shown under a Bot at most; the rest are in the chat's switcher. */
const SESSIONS_SHOWN = 4;

/** When the user last read a chat; before per-chat marks existed, any chat of the Bot counted. */
function seenAt(seen: Record<string, string>, botId: string, sessionId?: string) {
  return seen['chat:' + chatKey(botId, sessionId)] || seen['bot:' + botId] || '';
}
const unreadLane = (lane: RemoteLane, seen: string) =>
  Boolean(!lane.state && lane.last && !lane.last.fromUser && lane.last.time > seen);

/** A chat's line: what it waits for or is doing, otherwise its last message. */
function laneLine(lane: RemoteLane, t: T) {
  if (lane.state === 'waiting') return { text: t('等你批准'), className: 'is-waiting' };
  if (lane.state)
    return {
      text: lane.activity
        ? lane.activity.label + (lane.activity.detail ? ' ' + lane.activity.detail : '')
        : t('正在工作…'),
      className: 'x-shimmer',
    };
  return { text: lane.last ? (lane.last.fromUser ? t('你：') : '') + lane.last.text : '', className: '' };
}

function Running({ since, now }: { since?: string; now: number }) {
  return (
    <span className="h-run">
      <i />
      {since && elapsedLabel(since, now)}
    </span>
  );
}

function SessionRow({ session, unread, now }: { session: RemoteSessionRow; unread: boolean; now: number }) {
  const { t } = useI18n();
  // Older desktops only say whether a session works.
  const lane: RemoteLane = session.working && !session.state ? { ...session, state: 'thinking' } : session;
  const line = laneLine(lane, t);
  return (
    <li>
      <button className="h-session" onClick={() => go(chatPath(session.botId, session.id))}>
        <i className="h-branch" />
        <span className="h-session-text">
          <b>{session.name}</b>
          <span className={line.className}>{line.text}</span>
        </span>
        {lane.state && lane.state !== 'waiting' ? (
          <Running since={lane.since} now={now} />
        ) : (
          <>
            <time>{timeLabel(session.time)}</time>
            {unread && <i className="h-dot" />}
          </>
        )}
      </button>
    </li>
  );
}

function BotRow({
  bot,
  sessions,
  seen,
  now,
}: {
  bot: RemoteBot;
  sessions: RemoteSessionRow[];
  seen: Record<string, string>;
  now: number;
}) {
  const { t } = useI18n();
  // The row is the main chat when the desktop says what it does; older desktops describe the Bot's newest chat.
  const lane: RemoteLane = bot.main || bot;
  const line = laneLine(lane, t);
  const unread = unreadLane(lane, seenAt(seen, bot.id, bot.main ? undefined : bot.sessionId));
  return (
    <li className="h-item" style={tint(bot.color)}>
      <button className="h-row" onClick={() => go(chatPath(bot.id, bot.main ? undefined : bot.sessionId))}>
        <Avatar
          bot={bot}
          size={48}
          activity={
            bot.state === 'working'
              ? 'working'
              : bot.state === 'thinking'
                ? 'thinking'
                : bot.state === 'waiting'
                  ? 'waiting'
                  : 'idle'
          }
        />
        <span className="h-row-text">
          <span className="h-row-top">
            <b>{bot.name}</b>
            {bot.main && lane.state && lane.state !== 'waiting' ? (
              <Running since={lane.since} now={now} />
            ) : (
              lane.last && <time>{timeLabel(lane.time)}</time>
            )}
          </span>
          <span className="h-row-bottom">
            <span className={'h-line ' + line.className}>{line.text}</span>
            {unread && <i className="h-dot" />}
          </span>
        </span>
      </button>
      {sessions.length > 0 && (
        <ul className="h-sessions">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              unread={unreadLane(session, seenAt(seen, bot.id, session.id))}
              now={now}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Home() {
  const { t } = useI18n();
  const { home, status, since, direct, computer, computers } = useConnection();
  const [sheet, setSheet] = useState<'computers' | 'new'>();
  const seen = lastSeen();
  const bots = home?.bots || [];
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  // Under each Bot: sessions that work, wait or were active today.
  const today = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const shown = (botId: string) =>
    (home?.sessions || [])
      .filter(
        (session) =>
          session.botId === botId &&
          (session.state ||
            session.working ||
            session.time >= today ||
            unreadLane(session, seenAt(seen, botId, session.id))),
      )
      .slice(0, SESSIONS_SHOWN);
  const running = Boolean(
    bots.some((bot) => bot.main?.since) || home?.sessions.some((session) => session.since && session.state),
  );
  const now = useNow(running);
  const line =
    status === 'ready'
      ? t('已连接') + (direct ? ' · ' + t('同一网络直连') : '')
      : status === 'offline' && since
        ? t('离线 · 最后在线 {time}', { time: timeLabel(since) })
        : status === 'error'
          ? t('连不上中继，正在重试…')
          : statusText(status, t);
  return (
    <div className="h-screen">
      <header className="h-bar">
        <button className="x-round" aria-label={t('设置')} onClick={() => go('#/settings')}>
          <I name="settings" size={22} stroke={1.7} />
        </button>
        <button className={'h-pc is-' + status} onClick={() => setSheet('computers')}>
          <b>
            <span>{computer?.name}</span>
            <I name="down" size={15} stroke={2.4} />
          </b>
          <small>
            <i />
            {line}
          </small>
        </button>
        <button
          className="x-round"
          aria-label={t('新会话')}
          disabled={status !== 'ready' || !bots.length}
          onClick={() => (bots.length === 1 ? go(newSessionPath(bots[0].id)) : setSheet('new'))}
        >
          <I name="compose" size={22} />
        </button>
      </header>
      {status === 'connecting' && !home && (
        <div className="h-loading">
          <Spinner />
        </div>
      )}
      {(home?.requests || []).map((request) => (
        <RequestCard
          key={request.id}
          request={request}
          bot={botsById.get(request.botId)}
          onOpen={() => go(request.groupId ? '#/group/' + request.groupId : chatPath(request.botId, request.sessionId))}
        />
      ))}
      <ul className="h-list">
        {bots.map((bot) => (
          <BotRow key={bot.id} bot={bot} sessions={shown(bot.id)} seen={seen} now={now} />
        ))}
        {(home?.groups || []).map((group) => (
          <li key={group.id} className="h-item">
            <button className="h-row" onClick={() => go('#/group/' + group.id)}>
              <span className="h-group">
                {group.members.slice(0, 4).map((id) => {
                  const member = botsById.get(id);
                  return member ? <Avatar key={id} bot={member} size={22} /> : null;
                })}
              </span>
              <span className="h-row-text">
                <span className="h-row-top">
                  <b>{group.name}</b>
                  <time>{timeLabel(group.time)}</time>
                </span>
                <span className="h-row-bottom">
                  <span className={'h-line' + (group.active ? ' x-shimmer' : '')}>{group.line}</span>
                  {group.unread > 0 && <em>{group.unread}</em>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {sheet === 'computers' && (
        <Sheet onClose={() => setSheet(undefined)}>
          <ul className="s-list">
            {computers.map((item) => (
              <li key={item.room}>
                <button
                  className={'s-row' + (item.room === computer?.room ? ' is-current' : '')}
                  onClick={() => {
                    setSheet(undefined);
                    if (item.room !== computer?.room) void connection.select(item.room);
                  }}
                >
                  <span className="s-icon">
                    <I name="computer" size={20} />
                  </span>
                  <span className="s-text">
                    <b>{item.name}</b>
                    <small>{item.room === computer?.room ? line : t('点一下切换')}</small>
                  </span>
                  {item.room === computer?.room && <I name="check" size={20} stroke={2.2} />}
                </button>
              </li>
            ))}
          </ul>
          <button className="s-new" onClick={() => go('#/pair')}>
            <I name="plus" size={20} stroke={2} />
            {t('添加电脑')}
          </button>
        </Sheet>
      )}
      {sheet === 'new' && (
        <Sheet onClose={() => setSheet(undefined)}>
          <div className="s-title">{t('和谁开始新会话')}</div>
          <ul className="s-list">
            {bots.map((bot) => (
              <li key={bot.id}>
                <button
                  className="s-row"
                  onClick={() => {
                    setSheet(undefined);
                    go(newSessionPath(bot.id));
                  }}
                >
                  <Avatar bot={bot} size={36} />
                  <span className="s-text">
                    <b>{bot.name}</b>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}
    </div>
  );
}

export function statusText(status: string, t: (key: string) => string) {
  return status === 'ready'
    ? t('已连接')
    : status === 'offline'
      ? t('电脑离线')
      : status === 'pending'
        ? t('等待电脑允许')
        : status === 'locked'
          ? t('需要验证身份')
          : status === 'rejected'
            ? t('已断开')
            : t('正在连接…');
}
