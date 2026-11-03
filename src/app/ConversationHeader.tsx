import type { Bot, WorkSession } from '../../shared/types/core';
import type { BotActivity } from '../bots/bot-activity';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { ChatSearch } from '../chat/ChatSearch';
import { ComputerCardToggle } from '../computer/ComputerCardToggle';
import { TerminalToggle } from '../terminal/TerminalToggle';
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
  return (
    <header className="chat-header drag">
      <div className="chat-heading">
        <button className="bot-heading no-drag" onClick={onProfile}>
          <Avatar bot={bot} size={28} activity={activity} />
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
        <TerminalToggle scope={{ kind: 'bot', id: bot.id, sessionId: session?.id }} />
        <ComputerCardToggle />
      </div>
    </header>
  );
}
