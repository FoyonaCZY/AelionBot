import { useMemo, useState } from 'react';
import type { Bot, Snapshot, WorkSession } from '../../shared/types/core';
import type { GroupSummary } from '../../shared/types/group-types';
import type { BotPalette } from '../../shared/chat/bot-colors';
import { previewFeedbackDisplay } from '../../shared/preview/preview-feedback';
import { attachmentSummary } from '../../shared/types/attachment-types';
import { friendlyError, readableContent } from '../../shared/chat/activity';
import type { BotActivities } from '../bots/bot-activity';
import type { BotMenuAnchor } from '../bots/BotContextMenu';
import { GroupAvatar } from '../group/GroupAvatar';
import type { SettingsTab } from '../settings/SettingsWindow';
import { Avatar } from '../ui/Avatar';
import { time } from '../ui/format';
import { Icon } from '../ui/Icon';
import { conversationRows, type SessionRow } from './conversation-list';
import { SidebarUpdate } from './SidebarUpdate';
import { useI18n } from '../i18n';
import './work-sessions.css';

const COLLAPSED_KEY = 'aelion-folded-sessions';
const readCollapsed = () => {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return new Set<string>(Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set<string>();
  }
};

export function Sidebar({
  state,
  page,
  group,
  bot,
  session,
  query,
  onQuery,
  avatarActivities,
  botMenu,
  newMenu,
  newBotPalette,
  onToggleNewMenu,
  onNewBot,
  onNewGroup,
  onNewSession,
  onOpenGroup,
  onSelectBot,
  onSelectSession,
  onSessionSettings,
  onBotMenu,
  onPlugins,
  onSettings,
}: {
  state: Snapshot;
  page: 'chat' | 'plugins';
  group?: GroupSummary;
  bot?: Bot;
  /** The open work session of `bot`; absent while its main chat is open. */
  session?: WorkSession;
  query: string;
  onQuery: (value: string) => void;
  avatarActivities: BotActivities;
  botMenu?: BotMenuAnchor;
  newMenu: boolean;
  newBotPalette: BotPalette;
  onToggleNewMenu: () => void;
  onNewBot: () => void;
  onNewGroup: () => void;
  /** Absent while no Bot can have work sessions. */
  onNewSession?: () => void;
  onOpenGroup: (id: string) => void;
  onSelectBot: (id: string) => void;
  onSelectSession: (session: WorkSession) => void;
  onSessionSettings: (session: WorkSession) => void;
  onBotMenu: (target: Bot, trigger: HTMLButtonElement, x?: number, y?: number) => void;
  onPlugins: () => void;
  onSettings: (tab?: SettingsTab) => void;
}) {
  const { t } = useI18n();
  const requests = state.interactions || [];
  // Scans every message: recomputed only when the bots, messages, runs, groups or sessions changed.
  const rows = useMemo(
    () => conversationRows(state.bots, state.messages, state.groups?.rooms || [], state.runs, state.workSessions || []),
    [state.bots, state.messages, state.groups?.rooms, state.runs, state.workSessions],
  );
  const runSession = (runId: string) => state.runs.find((run) => run.id === runId)?.sessionId;
  // Bots whose sessions are folded away; remembered on this computer only.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleSessions = (botId: string) =>
    setCollapsed((value) => {
      const next = new Set(value);
      if (!next.delete(botId)) next.add(botId);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  const search = query.trim().toLowerCase();
  // What a chat's row says under its name: what waits on the user, what it is doing, or its last message.
  const preview = (botId: string, sessionId: string | undefined, last: SessionRow['last']) => {
    const pending = requests.find((request) => request.botId === botId && runSession(request.runId) === sessionId);
    const active = state.runs.some(
      (run) => run.botId === botId && run.status === 'running' && run.sessionId === sessionId,
    );
    const introducing = (!sessionId && state.greetingBotIds?.includes(botId)) || false;
    const lastRun = last?.runId ? state.runs.find((run) => run.id === last.runId) : undefined;
    const text = pending
      ? pending.kind === 'host_permission'
        ? pending.approval?.phase === 'reviewing'
          ? t('审核模型正在审核操作')
          : t('等待你的本机操作许可')
        : t('等待人工接管')
      : active
        ? t('正在工作…')
        : introducing
          ? t('正在打招呼…')
          : lastRun?.status === 'failed' || lastRun?.status === 'interrupted'
            ? friendlyError(lastRun.error || '').title
            : lastRun?.groupUpdated
              ? t('已接收新的群消息')
              : lastRun?.status === 'cancelled'
                ? t('已停止，工作记录已保留')
                : readableContent(
                    (last ? previewFeedbackDisplay(last).content : '') || attachmentSummary(last?.attachments),
                  ).replace(/[#*`]/g, '');
    return { text, pending: Boolean(pending), active: active || introducing };
  };
  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="brand">
          Aelion<span>Bot</span>
        </span>
        <div className="new-menu-anchor no-drag">
          <button
            className="icon-button"
            aria-label={t('新建')}
            aria-haspopup="menu"
            aria-expanded={newMenu}
            onClick={onToggleNewMenu}
          >
            <Icon name="plus" />
          </button>
          {newMenu && (
            <div className="new-conversation-menu" role="menu">
              <button role="menuitem" onClick={onNewBot}>
                <span className="new-bot-icon" aria-hidden="true">
                  <Avatar bot={{ name: t('新 Bot'), ...newBotPalette }} size={20} />
                </span>
                {t('新建 Bot')}
              </button>
              <button role="menuitem" onClick={onNewGroup}>
                <Icon name="message" size={20} />
                {t('创建群聊')}
              </button>
              {onNewSession && (
                <button role="menuitem" onClick={onNewSession}>
                  <Icon name="folder" size={20} />
                  {t('新建工作会话')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <label className="search">
        <Icon name="search" size={18} />
        <input placeholder={t('搜索')} value={query} onChange={(event) => onQuery(event.target.value)} />
      </label>
      <div className="bot-list conversation-list" role="region" aria-label={t('会话列表')}>
        {rows
          .filter(
            (row) =>
              (row.kind === 'bot' ? row.bot.name : row.group.name).toLowerCase().includes(search) ||
              (row.kind === 'bot' && row.sessions.some((item) => item.session.name.toLowerCase().includes(search))),
          )
          .map((row) => {
            if (row.kind === 'group') {
              const room = row.group;
              return (
                <button
                  key={`group:${room.id}`}
                  className={`bot-item group-item ${page === 'chat' && group?.id === room.id ? 'selected' : ''}`}
                  data-group-id={room.id}
                  onClick={() => onOpenGroup(room.id)}
                >
                  <GroupAvatar group={room} activities={avatarActivities} />
                  <span className="bot-copy">
                    <span className="bot-line">
                      <strong>{room.name}</strong>
                      <small>{time(row.time)}</small>
                    </span>
                    <span className="bot-preview">
                      {room.activities?.length
                        ? t('{count} 位成员正在处理…', { count: room.activities.length })
                        : room.preview}
                    </span>
                  </span>
                  {room.unread > 0 && <span className="group-unread">{room.unread > 99 ? '99+' : room.unread}</span>}
                </button>
              );
            }
            const { bot: item, last } = row;
            const main = preview(item.id, undefined, last);
            // The avatar shows the Bot busy wherever it works; the row's text is about its main chat.
            const busy = main.active || state.runs.some((run) => run.botId === item.id && run.status === 'running'),
              needsUser = requests.some((request) => request.botId === item.id);
            // Archived sessions stay out of the list until searched for.
            const sessions = row.sessions.filter((entry) =>
              search ? entry.session.name.toLowerCase().includes(search) : !entry.session.archivedAt,
            );
            // A folded Bot still shows the session that is open, so the selection never hides.
            const folded = !search && collapsed.has(item.id),
              shown = folded ? sessions.filter((entry) => session?.id === entry.session.id) : sessions,
              states = new Map(
                sessions.map((entry) => [entry.session.id, preview(item.id, entry.session.id, entry.last)]),
              ),
              hiddenStates = sessions
                .filter((entry) => !shown.includes(entry))
                .map((entry) => states.get(entry.session.id)!),
              hiddenBusy = hiddenStates.some((value) => value.active),
              hiddenNeedsUser = hiddenStates.some((value) => value.pending);
            return (
              <div className={`bot-entry ${sessions.length ? 'has-sessions' : ''}`} key={`bot:${item.id}`}>
                <div className="bot-head">
                  <button
                    className={`bot-item ${page === 'chat' && !group && !session && bot?.id === item.id ? 'selected' : ''}`}
                    data-bot-id={item.id}
                    aria-haspopup="menu"
                    aria-expanded={botMenu?.id === item.id}
                    onClick={() => onSelectBot(item.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onBotMenu(item, event.currentTarget, event.clientX || undefined, event.clientY || undefined);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        onBotMenu(item, event.currentTarget);
                      }
                    }}
                  >
                    <Avatar bot={item} activity={avatarActivities[item.id]} />
                    <span className="bot-copy">
                      <span className="bot-line">
                        <strong>{item.name}</strong>
                        <small>{last ? time(last.time) : ''}</small>
                      </span>
                      <span className="bot-preview">{main.text}</span>
                    </span>
                    {busy && <span className={`bot-working ${needsUser ? 'needs-user' : ''}`} />}
                  </button>
                  {sessions.length > 0 && (
                    <button
                      className={`session-toggle ${folded ? '' : 'is-open'}`}
                      aria-expanded={!folded}
                      aria-label={t('{name} 的工作会话', { name: item.name })}
                      title={t('{name} 的工作会话', { name: item.name })}
                      disabled={Boolean(search)}
                      onClick={() => {
                        // Folding away the open session goes to the Bot's main chat.
                        if (!folded && page === 'chat' && !group && session?.botId === item.id) onSelectBot(item.id);
                        toggleSessions(item.id);
                      }}
                    >
                      <Icon name="folder" size={13} />
                      <span>{sessions.length}</span>
                      {(hiddenBusy || hiddenNeedsUser) && (
                        <span className={`session-working ${hiddenNeedsUser ? 'needs-user' : ''}`} />
                      )}
                      <Icon name="chevron" size={12} />
                    </button>
                  )}
                </div>
                {shown.length > 0 && (
                  <div className="session-list" role="group" aria-label={t('{name} 的工作会话', { name: item.name })}>
                    {shown.map(({ session: entry, time: entryTime }) => {
                      const status = states.get(entry.id)!;
                      return (
                        <button
                          key={entry.id}
                          className={`session-item ${page === 'chat' && !group && session?.id === entry.id ? 'selected' : ''} ${entry.archivedAt ? 'is-archived' : ''}`}
                          data-session-id={entry.id}
                          title={entry.name}
                          onClick={() => onSelectSession(entry)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            onSessionSettings(entry);
                          }}
                        >
                          <Icon name="folder" size={14} />
                          <span className="session-name">{entry.name}</span>
                          {status.active || status.pending ? (
                            <span
                              className={`session-working ${status.pending ? 'needs-user' : ''}`}
                              role="img"
                              aria-label={status.text}
                              title={status.text}
                            />
                          ) : (
                            <small>{time(entryTime)}</small>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
      </div>
      <div className="sidebar-bottom">
        <button className="sidebar-link" aria-current={page === 'plugins' ? 'page' : undefined} onClick={onPlugins}>
          <Icon name="plugin" />
          <span>{t('插件')}</span>
        </button>
        <button className="sidebar-link" onClick={() => onSettings()}>
          <Icon name="settings" />
          <span>{t('设置')}</span>
        </button>
        <SidebarUpdate update={state.updates} onOpen={() => onSettings('about')} />
      </div>
    </aside>
  );
}
