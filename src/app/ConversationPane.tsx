import { DesignerWorkspace } from '../designer/DesignerWorkspace';
import type { RefObject } from 'react';
import type { Bot, InteractionRequest, Snapshot } from '../../shared/types/core';
import type { GroupSummary } from '../../shared/types/group-types';
import type { BotActivities } from '../bots/bot-activity';
import { GroupConversation } from '../group/GroupConversation';
import type { PeerPanel } from '../group/PeerChats';
import { PreviewBotSwitcher } from '../preview/PreviewBotSwitcher';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import type { SettingsTab } from '../settings/SettingsWindow';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import type { BotConversationData } from './bot-conversation';
import { BotConversation } from './BotConversation';
import { ConversationHeader } from './ConversationHeader';
import type { useBotChat } from './use-bot-chat';
import type { TakeoverRequest } from './use-computer-control';
import type { Drafts } from './use-drafts';
import type { useFileActions } from './use-file-actions';

/** The centre column: a group chat, a designer workspace or a bot conversation, whichever is selected. */
export function ConversationPane({
  state,
  group,
  bot,
  visible,
  busy,
  vmReady,
  avatarActivities,
  conversation,
  chat,
  drafts,
  groupDrafts,
  files,
  messagesPane,
  follow,
  onMessagesScroll,
  followLive,
  onSwitch,
  onManageGroup,
  onProfile,
  onSettings,
  onPlugins,
  onNewBot,
  onScreen,
  onReview,
  onTakeover,
  onOpenGroup,
  onOpenPrivateChat,
}: {
  state: Snapshot;
  group?: GroupSummary;
  bot?: Bot;
  visible: boolean;
  busy: boolean;
  vmReady: boolean;
  avatarActivities: BotActivities;
  conversation: BotConversationData;
  chat: ReturnType<typeof useBotChat>;
  drafts: Drafts;
  groupDrafts: Drafts;
  files: ReturnType<typeof useFileActions>;
  messagesPane: RefObject<HTMLElement | null>;
  follow: RefObject<boolean>;
  onMessagesScroll: (pane: HTMLElement) => void;
  followLive: () => void;
  onSwitch: (kind: string, id: string) => void;
  onManageGroup: (id: string) => void;
  onProfile: (bot: Bot) => void;
  onSettings: (tab?: SettingsTab | 'mcp') => void;
  onPlugins: () => void;
  onNewBot: () => void;
  onScreen: (url: string) => void;
  onReview: (request: InteractionRequest) => void;
  onTakeover: (request: TakeoverRequest) => Promise<void>;
  onOpenGroup: (id: string) => void;
  onOpenPrivateChat: (panel: PeerPanel) => void;
}) {
  const { t } = useI18n(),
    previewWorkbench = usePreviewWorkbench();
  return (
    <main className="conversation">
      {previewWorkbench?.info?.docked && (
        <PreviewBotSwitcher
          bots={state.bots}
          groups={state.groups?.rooms || []}
          value={group ? 'group:' + group.id : 'bot:' + bot?.id}
          onChange={(value) =>
            previewWorkbench.navigate(() => {
              const [kind, id] = value.split(':');
              onSwitch(kind, id);
            })
          }
          onSettings={() => onSettings()}
          onPlugins={() => previewWorkbench.navigate(onPlugins)}
          onNew={() => previewWorkbench.navigate(onNewBot)}
        />
      )}
      {group ? (
        <GroupConversation
          key={group.id}
          group={group}
          state={state}
          avatarActivities={avatarActivities}
          drafts={groupDrafts}
          onManage={() => onManageGroup(group.id)}
          onTakeover={onTakeover}
          onOpenFile={(file) => void files.openPreview(file)}
          onSaveFile={(file) => void files.saveFile(file)}
          onOpenPreviewEntry={files.openHistoryEntry}
          visible={visible}
        />
      ) : bot?.type === 'designer' ? (
        <DesignerWorkspace
          key={bot.id}
          bot={bot}
          state={state}
          onProfile={() => onProfile(bot)}
          onTakeover={onTakeover}
        />
      ) : bot ? (
        <>
          <ConversationHeader
            bot={bot}
            activity={avatarActivities[bot.id]}
            conversation={conversation}
            onProfile={() => onProfile(bot)}
          />
          <BotConversation
            bot={bot}
            state={state}
            conversation={conversation}
            drafts={drafts}
            busy={busy}
            vmReady={vmReady}
            messagesPane={messagesPane}
            follow={follow}
            onMessagesScroll={onMessagesScroll}
            followLive={followLive}
            onSend={() => void chat.send()}
            onReply={chat.replyTo}
            onContinue={chat.continueWork}
            onSettings={(tab) => (tab === 'model' && bot.model ? onProfile(bot) : onSettings(tab))}
            onScreen={onScreen}
            onReview={onReview}
            onTakeover={onTakeover}
            onOpenGroup={onOpenGroup}
            onOpenPrivateChat={onOpenPrivateChat}
            onOpenFile={(file) => void files.openPreview(file)}
            onSaveFile={(file) => void files.saveFile(file)}
            onOpenPreviewEntry={files.openHistoryEntry}
          />
        </>
      ) : (
        <div className="empty-workspace">
          <Icon name="bot" size={38} />
          <h2>{t('还没有 Bot')}</h2>
          <button className="primary-button" onClick={onNewBot}>
            {t('创建 Bot')}
          </button>
        </div>
      )}
    </main>
  );
}
