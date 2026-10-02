import { Fragment, type RefObject } from 'react';
import type { Bot, ChatMessage, InteractionRequest, Snapshot } from '../../shared/types/core';
import { firstDeliveryAttachments } from '../../shared/types/attachment-types';
import { isRunArtifact } from '../../shared/preview/workspace-files';
import type { PreviewHistoryEntry } from '../../shared/preview/agent-preview-types';
import { workspaceKey } from '../../shared/types/work-types';
import { ConversationTimeProvider } from '../chat/ConversationTime';
import { RunMessage } from '../chat/RunMessage';
import { BotWorkingStatus } from '../chat/BotWorkingStatus';
import { StreamingReply } from '../chat/StreamingReply';
import { ConversationInteractions } from '../chat/InteractionPrompts';
import { WorkItemsPanel } from '../chat/WorkItems';
import { LiveWorkStrip } from '../chat/LiveWorkStrip';
import { BotComposer, type ComposerDraft } from '../chat/BotComposer';
import { useFloatingComposer } from '../chat/use-floating-composer';
import { ArtifactList } from '../files/ArtifactList';
import { PreviewHistoryChips } from '../preview/PreviewHistoryChips';
import { PeerNotice, PeerTaskMessage, type PeerPanel } from '../group/PeerChats';
import { GroupTaskMessage } from '../group/GroupTaskMessage';
import { Icon } from '../ui/Icon';
import { Message } from '../ui/Message';
import { useI18n } from '../i18n';
import type { BotConversationData } from './bot-conversation';
import { liveBotProgress as liveBotStep } from './live-bot-progress';
import type { TakeoverRequest } from './use-computer-control';
import type { PreviewFile } from './use-file-actions';

/** The selected bot's message timeline and composer. */
export function BotConversation({
  bot,
  state,
  conversation,
  draft,
  busy,
  vmReady,
  messagesPane,
  onMessagesScroll,
  onDraft,
  onSend,
  onReply,
  onContinue,
  onSettings,
  onScreen,
  onReview,
  onTakeover,
  onOpenGroup,
  onOpenPrivateChat,
  onOpenFile,
  onSaveFile,
  onOpenPreviewEntry,
}: {
  bot: Bot;
  state: Snapshot;
  conversation: BotConversationData;
  draft: ComposerDraft;
  busy: boolean;
  vmReady: boolean;
  messagesPane: RefObject<HTMLElement | null>;
  onMessagesScroll: (pane: HTMLElement) => void;
  onDraft: (draft: ComposerDraft) => void;
  onSend: () => void;
  onReply: (message: ChatMessage) => void;
  onContinue: () => void;
  onSettings: (tab: 'model' | 'computer' | 'mcp') => void;
  onScreen: (url: string) => void;
  onReview: (request: InteractionRequest) => void;
  onTakeover: (request: TakeoverRequest) => Promise<void>;
  onOpenGroup: (id: string) => void;
  onOpenPrivateChat: (panel: PeerPanel) => void;
  onOpenFile: (file: PreviewFile) => void;
  onSaveFile: (file: PreviewFile) => void;
  onOpenPreviewEntry: (entry: PreviewHistoryEntry) => void;
}) {
  const { t } = useI18n();
  const composerWrap = useFloatingComposer();
  const {
    currentModel,
    messages,
    runMessages,
    timeline,
    liveReplies,
    lastContext,
    latestRun,
    running,
    greeting,
    requests,
    waiting,
  } = conversation;
  return (
    <>
      <ConversationTimeProvider messages={messages}>
        <section
          ref={messagesPane}
          key={bot.id}
          className="messages"
          onScroll={(event) => onMessagesScroll(event.currentTarget)}
        >
          {timeline.map((item) => {
            const key = `${bot.id}:${item.kind}:${item.kind === 'run' ? item.segmentId : item.id}`;
            if (item.kind === 'message')
              return item.message.groupTaskSource ? (
                <GroupTaskMessage key={key} message={item.message} view={state.groups} onOpen={onOpenGroup} />
              ) : item.message.groupLink ? (
                <div key={key} className="peer-notice">
                  <button
                    className="peer-notice-open"
                    disabled={!state.groups?.rooms.some((room) => room.id === item.message.groupLink?.groupId)}
                    onClick={() => onOpenGroup(item.message.groupLink!.groupId)}
                  >
                    <Icon name="message" size={16} />
                    {item.message.content}
                  </button>
                </div>
              ) : item.message.taskSource ? (
                <PeerTaskMessage key={key} message={item.message} view={state.peers} onOpen={onOpenPrivateChat} />
              ) : item.message.peer ? (
                <PeerNotice key={key} message={item.message} view={state.peers} onOpen={onOpenPrivateChat} />
              ) : (
                <Message
                  key={key}
                  message={{ ...item.message, attachments: firstDeliveryAttachments(item.message, messages) }}
                  onReply={onReply}
                  allowPins={!state.runs.find((run) => run.id === item.message.runId)?.groupOrigin}
                />
              );
            const run = state.runs.find((run) => run.id === item.id),
              allRunMessages = runMessages.get(item.id) || [],
              outputs =
                item.isLast && latestRun?.id === item.id
                  ? state.artifacts.filter(
                      (file) =>
                        file.botId === bot.id &&
                        file.runId === item.id &&
                        isRunArtifact(file.path) &&
                        !allRunMessages.some((message) =>
                          message.attachments?.some(
                            (attachment) => attachment.name === file.name && attachment.size === file.size,
                          ),
                        ),
                    )
                  : [];
            return (
              <Fragment key={key}>
                <RunMessage
                  onReply={onReply}
                  model={currentModel}
                  messages={item.messages.map((message) => ({
                    ...message,
                    attachments: firstDeliveryAttachments(message, messages),
                  }))}
                  allMessages={allRunMessages}
                  isLast={item.isLast}
                  run={run}
                  stream={
                    item.isLast
                      ? liveReplies.find((reply) => reply.runId === item.id && reply.purpose !== 'progress')
                      : undefined
                  }
                  waiting={item.isLast ? requests.find((request) => request.runId === item.id)?.kind : undefined}
                  latest={item.isLast && latestRun?.id === item.id}
                  canContinue={!running && !busy}
                  reviewing={
                    item.isLast &&
                    requests.some(
                      (request) =>
                        request.runId === item.id &&
                        request.kind === 'host_permission' &&
                        request.approval?.phase === 'reviewing',
                    )
                  }
                  onContinue={onContinue}
                  onSettings={onSettings}
                  onScreen={onScreen}
                />
                <PreviewHistoryChips
                  entries={(state.previewHistory || []).filter(
                    (entry) => entry.scope.kind === 'bot' && entry.scope.id === bot.id,
                  )}
                  runIds={[item.id]}
                  artifactNames={new Set(outputs.map((file) => file.path))}
                  attachmentIds={
                    new Set(
                      allRunMessages.flatMap(
                        (message) => message.attachments?.map((attachment) => attachment.id) || [],
                      ),
                    )
                  }
                  onOpen={onOpenPreviewEntry}
                />
                <ArtifactList files={outputs} onOpen={onOpenFile} onSave={onSaveFile} disabled={busy || !vmReady} />
              </Fragment>
            );
          })}
          {liveReplies
            .filter(
              (reply) =>
                reply.purpose === 'progress' ||
                !reply.runId ||
                !timeline.some((item) => item.kind === 'run' && item.id === reply.runId),
            )
            .map((reply) => (
              <StreamingReply key={reply.id} reply={reply} />
            ))}
          {(running || greeting) && (
            <BotWorkingStatus
              bot={bot}
              onStop={() => window.aelion.cancel(bot.id)}
              onReview={waiting ? () => onReview(waiting) : undefined}
              step={
                liveBotStep(
                  messages,
                  latestRun,
                  waiting?.kind,
                  waiting?.kind === 'host_permission' && waiting.approval?.phase === 'reviewing',
                ) || { phase: 'thinking', label: greeting ? t('正在准备打招呼') : t('正在准备处理') }
              }
            />
          )}
          <div />
        </section>
      </ConversationTimeProvider>
      <div ref={composerWrap} className={`composer-wrap floating-composer ${waiting ? 'with-request' : ''}`}>
        <ConversationInteractions
          requests={requests.filter((request) => !state.runs.find((run) => run.id === request.runId)?.groupOrigin)}
          botId={bot.id}
          onTakeover={onTakeover}
        />
        <WorkItemsPanel items={state.workItems} scope={{ kind: 'bot', id: bot.id }} bots={state.bots} />
        <LiveWorkStrip items={(state.liveWork || []).filter((item) => item.botId === bot.id)} />
        <BotComposer
          contextOverview={
            lastContext?.model === currentModel?.model &&
            lastContext?.providerId === currentModel?.providerId &&
            lastContext?.capacity === currentModel?.contextTokens
              ? lastContext
              : undefined
          }
          contextCapacity={currentModel?.contextTokens}
          permissionMode={state.hostPermissionModes?.[workspaceKey({ kind: 'bot', id: bot.id })]}
          workspaceDir={
            state.conversationWorkspaces?.[workspaceKey({ kind: 'bot', id: bot.id })] ||
            state.hostWorkspace?.workspaceDir
          }
          workspaceInherited={!state.conversationWorkspaces?.[workspaceKey({ kind: 'bot', id: bot.id })]}
          key={bot.id}
          bot={bot}
          bots={state.bots}
          draft={draft}
          running={running}
          onChange={onDraft}
          onSend={onSend}
          onStop={() => void window.aelion.cancel(bot.id)}
        />
      </div>
    </>
  );
}
