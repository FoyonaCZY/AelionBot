import type { Bot, Snapshot } from '../../shared/types/core';
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
import { conversationRows } from './conversation-list';
import { SidebarUpdate } from './SidebarUpdate';
import { useI18n } from '../i18n';

export function Sidebar({
  state,
  page,
  group,
  bot,
  query,
  onQuery,
  avatarActivities,
  botMenu,
  newMenu,
  newBotPalette,
  onToggleNewMenu,
  onNewBot,
  onNewGroup,
  onOpenGroup,
  onSelectBot,
  onBotMenu,
  onPlugins,
  onSettings,
}: {
  state: Snapshot;
  page: 'chat' | 'plugins';
  group?: GroupSummary;
  bot?: Bot;
  query: string;
  onQuery: (value: string) => void;
  avatarActivities: BotActivities;
  botMenu?: BotMenuAnchor;
  newMenu: boolean;
  newBotPalette: BotPalette;
  onToggleNewMenu: () => void;
  onNewBot: () => void;
  onNewGroup: () => void;
  onOpenGroup: (id: string) => void;
  onSelectBot: (id: string) => void;
  onBotMenu: (target: Bot, trigger: HTMLButtonElement, x?: number, y?: number) => void;
  onPlugins: () => void;
  onSettings: (tab?: SettingsTab) => void;
}) {
  const { t } = useI18n();
  const requests = state.interactions || [];
  const rows = conversationRows(state.bots, state.messages, state.groups?.rooms || [], state.runs);
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
          .filter((row) =>
            (row.kind === 'bot' ? row.bot.name : row.group.name).toLowerCase().includes(query.toLowerCase()),
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
            const active = state.runs.some((run) => run.botId === item.id && run.status === 'running'),
              introducing = state.greetingBotIds?.includes(item.id) || false;
            const pending = requests.find((request) => request.botId === item.id);
            const lastRun = last?.runId ? state.runs.find((run) => run.id === last.runId) : undefined;
            const preview = pending
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
            return (
              <button
                className={`bot-item ${page === 'chat' && !group && bot?.id === item.id ? 'selected' : ''}`}
                key={`bot:${item.id}`}
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
                  <span className="bot-preview">{preview}</span>
                </span>
                {(active || introducing) && <span className={`bot-working ${pending ? 'needs-user' : ''}`} />}
              </button>
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
