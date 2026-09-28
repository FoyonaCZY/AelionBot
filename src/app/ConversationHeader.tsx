import type { Bot } from '../../shared/types/core';
import type { BotActivity } from '../bots/bot-activity';
import { Avatar } from '../ui/Avatar';
import { useI18n } from '../i18n';
import type { BotConversationData } from './bot-conversation';

export function ConversationHeader({
  bot,
  activity,
  conversation,
  onProfile,
}: {
  bot: Bot;
  activity?: BotActivity;
  conversation: BotConversationData;
  onProfile: () => void;
}) {
  const { t } = useI18n();
  const { currentModel, running, greeting, waiting } = conversation;
  return (
    <header className="chat-header drag">
      <button className="bot-heading no-drag" onClick={onProfile}>
        <Avatar bot={bot} size={31} activity={activity} />
        <strong>{bot.name}</strong>
      </button>
      <div className="header-actions no-drag">
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
      </div>
    </header>
  );
}
