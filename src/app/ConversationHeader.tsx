import type { Bot, WorkSession } from '../../shared/types/core';
import type { BotActivity } from '../bots/bot-activity';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { ChatSearch } from '../chat/ChatSearch';
import { ComputerCardToggle } from '../computer/ComputerCardToggle';
import { useI18n } from '../i18n';
import type { BotConversationData } from './bot-conversation';

/** The head of a Bot's chat: its main chat, or one of its work sessions (`session`) shown after the Bot's name. */
export function ConversationHeader({
  bot,
  session,
  activity,
  conversation,
  onProfile,
  onSessionSettings,
  onNewSession,
}: {
  bot: Bot;
  session?: WorkSession;
  activity?: BotActivity;
  conversation: BotConversationData;
  onProfile: () => void;
  onSessionSettings?: () => void;
  onNewSession?: () => void;
}) {
  const { t } = useI18n();
  const { currentModel, running, greeting, waiting } = conversation;
  return (
    <header className="chat-header drag">
      <div className="chat-heading">
        <button className="bot-heading no-drag" onClick={onProfile}>
          <Avatar bot={bot} size={31} activity={activity} />
          <strong>{bot.name}</strong>
        </button>
        {session && (
          <>
            <span className="chat-heading-separator" aria-hidden="true">
              /
            </span>
            <button
              className="session-heading no-drag"
              aria-label={t('工作会话设置')}
              title={session.name}
              onClick={onSessionSettings}
            >
              <Icon name="folder" size={16} />
              <strong>{session.name}</strong>
            </button>
          </>
        )}
      </div>
      <div className="header-actions no-drag">
        <ChatSearch messages={conversation.messages} scopeKey={session ? 'session:' + session.id : bot.id} />
        <button className="bot-model-button" aria-label={t('选择 Bot 模型')} onClick={onProfile}>
          {currentModel?.model || t('选择模型')}
        </button>
        {(running || greeting || !currentModel?.model) && (
          <span className={`connection-status ${running || greeting ? 'working' : ''}`}>
            {running
              ? waiting?.kind === 'host_permission'
                ? waiting.approval?.phase === 'reviewing'
                  ? t('正在审核')
                  : t('等待许可')
                : waiting
                  ? t('等待接管')
                  : t('正在工作')
              : greeting
                ? t('正在打招呼…')
                : t('尚未连接模型')}
          </span>
        )}
        {onNewSession && (
          <button
            className="icon-button"
            aria-label={t('新建工作会话')}
            title={t('新建工作会话')}
            onClick={onNewSession}
          >
            <Icon name="folder" size={18} />
          </button>
        )}
        <ComputerCardToggle />
      </div>
    </header>
  );
}
