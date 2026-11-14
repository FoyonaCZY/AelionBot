// The list of Bots, like a messaging app: what each one is doing, requests waiting on top, groups below.
import { useState } from 'react';
import type { RemoteBot } from '../../../shared/remote/protocol';
import { Avatar } from '../../../src/ui/Avatar';
import { useI18n } from '../../../src/i18n';
import { connection, useConnection } from '../connection';
import { RequestCard } from '../requests';
import { chatPath, go } from '../router';
import { lastSeen } from '../storage';
import { I } from '../icons';
import { ConnectionBanner, Sheet, Spinner, timeLabel, toast } from '../ui';

const tint = (color: string) => ({ '--bot': color }) as React.CSSProperties;

function BotRow({ bot, unread }: { bot: RemoteBot; unread: boolean }) {
  const { t } = useI18n();
  const line =
    bot.state === 'waiting'
      ? t('等你批准')
      : bot.activity
        ? bot.activity.label + (bot.activity.detail ? ' ' + bot.activity.detail : '')
        : bot.last
          ? (bot.last.fromUser ? t('你：') : '') + bot.last.text
          : '';
  return (
    <li>
      <button className="h-row" style={tint(bot.color)} onClick={() => go(chatPath(bot.id, bot.sessionId))}>
        <Avatar
          bot={bot}
          size={54}
          activity={bot.state === 'working' ? 'working' : bot.state === 'thinking' ? 'thinking' : 'idle'}
        />
        <span className="h-row-text">
          <span className="h-row-top">
            <b>{bot.name}</b>
            <time>{timeLabel(bot.time)}</time>
          </span>
          <span className="h-row-bottom">
            <span className={'h-line' + (bot.state ? ' is-' + (bot.state === 'waiting' ? 'waiting' : 'working') : '')}>
              {line}
            </span>
            {unread && <i className="h-dot" />}
          </span>
        </span>
      </button>
    </li>
  );
}

export function Home() {
  const { t } = useI18n();
  const { home, status, computer, computers } = useConnection();
  const [sheet, setSheet] = useState<'computers' | 'new'>();
  const seen = lastSeen();
  const bots = home?.bots || [];
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  const startSession = async (botId: string) => {
    setSheet(undefined);
    try {
      const now = new Date();
      const session = await connection.call('session.create', {
        botId,
        name: t('手机上的会话 {time}', {
          time: `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        }),
      });
      go(chatPath(botId, session.id));
    } catch (error) {
      toast((error as Error).message);
    }
  };
  return (
    <div className="h-screen">
      <div className="h-nav">
        <button className="x-round" aria-label={t('设置')} onClick={() => go('#/settings')}>
          <I name="settings" size={22} />
        </button>
        <button
          className="x-round"
          aria-label={t('新会话')}
          disabled={status !== 'ready'}
          onClick={() => setSheet('new')}
        >
          <I name="compose" size={23} />
        </button>
      </div>
      <div className="h-title">
        <h1>AelionBot</h1>
        <button className={'h-pc is-' + status} onClick={() => setSheet('computers')}>
          <i />
          {computer?.name}
          {status === 'offline' && ' · ' + t('离线')}
          <I name="down" size={16} stroke={2} />
        </button>
      </div>
      <ConnectionBanner />
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
          <BotRow
            key={bot.id}
            bot={bot}
            unread={Boolean(
              !bot.state && bot.last && !bot.last.fromUser && bot.last.time > (seen['bot:' + bot.id] || ''),
            )}
          />
        ))}
        {(home?.groups || []).map((group) => (
          <li key={group.id}>
            <button className="h-row" onClick={() => go('#/group/' + group.id)}>
              <span className="h-group">
                {group.members.slice(0, 4).map((id) => {
                  const member = botsById.get(id);
                  return member ? <Avatar key={id} bot={member} size={25} /> : null;
                })}
              </span>
              <span className="h-row-text">
                <span className="h-row-top">
                  <b>{group.name}</b>
                  <time>{timeLabel(group.time)}</time>
                </span>
                <span className="h-row-bottom">
                  <span className={'h-line' + (group.active ? ' is-working' : '')}>{group.line}</span>
                  {group.unread > 0 && <em>{group.unread}</em>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {sheet === 'computers' && (
        <Sheet onClose={() => setSheet(undefined)}>
          <div className="s-title">{t('电脑')}</div>
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
                  <I name="computer" size={22} />
                  <span className="s-text">
                    <b>{item.name}</b>
                    <small>{item.room === computer?.room ? statusText(status, t) : t('点一下切换')}</small>
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
                <button className="s-row" onClick={() => void startSession(bot.id)}>
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
