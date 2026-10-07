import { memo, useLayoutEffect, useMemo, type RefObject } from 'react';
import type {
  Artifact,
  Bot,
  ChatMessage,
  InteractionRequest,
  ModelConfig,
  RunRecord,
  Snapshot,
  StreamingReply,
  WorkSession,
} from '../../shared/types/core';
import type { GroupsView } from '../../shared/types/group-types';
import type { PeerView } from '../../shared/types/peer-types';
import type { TimelineItem } from '../../shared/chat/activity';
import { isRunArtifact } from '../../shared/preview/workspace-files';
import type { PreviewHistoryEntry } from '../../shared/preview/agent-preview-types';
import { workspaceKey } from '../../shared/types/work-types';
import { ConversationTimeProvider } from '../chat/ConversationTime';
import { RunMessage } from '../chat/RunMessage';
import { BotWorkingStatus } from '../chat/BotWorkingStatus';
import { StreamingReply as LiveReply } from '../chat/StreamingReply';
import { ConversationInteractions } from '../chat/InteractionPrompts';
import { WorkItemsPanel } from '../chat/WorkItems';
import { LiveWorkStrip } from '../chat/LiveWorkStrip';
import { DraftComposer } from '../chat/DraftComposer';
import { useFloatingComposer } from '../chat/use-floating-composer';
import { ArtifactList } from '../files/ArtifactList';
import { PreviewHistoryChips } from '../preview/PreviewHistoryChips';
import { PeerNotice, PeerTaskMessage, type PeerPanel } from '../group/PeerChats';
import { GroupTaskMessage } from '../group/GroupTaskMessage';
import { Icon } from '../ui/Icon';
import { Message } from '../ui/Message';
import { sameProps } from '../ui/equality';
import { useStableHandlers } from '../ui/use-stable-handlers';
import { useI18n } from '../i18n';
import type { BotConversationData } from './bot-conversation';
import { liveBotProgress as liveBotStep } from './live-bot-progress';
import { useStreamingReplies } from './streams';
import type { Drafts } from './use-drafts';
import { useTimelineWindow } from './use-timeline-window';
import type { TakeoverRequest } from './use-computer-control';
import type { PreviewFile } from './use-file-actions';

const NO_MESSAGES: ChatMessage[] = [],
  NO_FILES: Artifact[] = [];
const itemKey = (botId: string, item: TimelineItem) =>
  `${botId}:${item.kind}:${item.kind === 'run' ? item.segmentId : item.id}`;

/**
 * The selected bot's message timeline and composer: its main chat, or one of its work sessions (`session`), which
 * look and work the same. Each timeline row is memoized on props that keep their identity while unchanged, so a new
 * message, a streaming tick or a keystroke re-renders only what it changed.
 */
export function BotConversation({
  bot,
  session,
  state,
  conversation,
  drafts,
  busy,
  vmReady,
  messagesPane,
  follow,
  onMessagesScroll,
  followLive,
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
  session?: WorkSession;
  state: Snapshot;
  conversation: BotConversationData;
  drafts: Drafts;
  busy: boolean;
  vmReady: boolean;
  messagesPane: RefObject<HTMLElement | null>;
  follow: RefObject<boolean>;
  onMessagesScroll: (pane: HTMLElement) => void;
  followLive: () => void;
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
  const sessionId = session?.id,
    chatKey = sessionId ? 'session:' + sessionId : bot.id;
  const composerWrap = useFloatingComposer();
  const actions = useStableHandlers<Actions>({
    reply: onReply,
    continueWork: onContinue,
    settings: onSettings,
    screen: onScreen,
    openGroup: onOpenGroup,
    openPrivateChat: onOpenPrivateChat,
    openFile: onOpenFile,
    saveFile: onSaveFile,
    openPreviewEntry: onOpenPreviewEntry,
    send: onSend,
    stop: () => (sessionId ? window.aelion.cancel(bot.id, sessionId) : window.aelion.cancel(bot.id)),
  });
  const {
    currentModel,
    messages,
    runMessages,
    runsById,
    shown,
    timeline,
    lastContext,
    latestRun,
    running,
    greeting,
    requests,
    ownRequests,
    waiting,
  } = conversation;
  const liveReplies = useStreamingReplies(
    'bot:' + chatKey,
    (reply) => Boolean(reply.main) && reply.botId === bot.id && reply.sessionId === sessionId,
  );
  const liveSignature = liveReplies.map((reply) => reply.id + ':' + reply.content).join('|');
  useLayoutEffect(followLive, [liveSignature]);
  const keys = useMemo(() => timeline.map((item) => itemKey(chatKey, item)), [timeline, chatKey]);
  const timelineWindow = useTimelineWindow({ botId: chatKey, timeline, keys, pane: messagesPane, follow });
  const previewEntries = useMemo(
    () => (state.previewHistory || []).filter((entry) => entry.scope.kind === 'bot' && entry.scope.id === bot.id),
    [state.previewHistory, bot.id],
  );
  const attachmentScope = useMemo(
      () => ({ kind: 'bot' as const, id: bot.id, ...(sessionId ? { sessionId } : {}) }),
      [bot.id, sessionId],
    ),
    scope = workspaceKey(attachmentScope),
    botScope = workspaceKey({ kind: 'bot', id: bot.id });
  return (
    <>
      <ConversationTimeProvider messages={messages}>
        <section
          ref={messagesPane}
          key={chatKey}
          className="messages"
          onScroll={(event) => {
            onMessagesScroll(event.currentTarget);
            timelineWindow.onScroll(event.currentTarget);
          }}
        >
          {timeline.slice(timelineWindow.start).map((item, index) => {
            const key = keys[timelineWindow.start + index];
            if (item.kind === 'message') {
              const message = item.message;
              return (
                <TimelineMessage
                  key={key}
                  message={message}
                  shown={shown.get(message)}
                  groups={message.groupTaskSource || message.groupLink ? state.groups : undefined}
                  peers={message.taskSource || message.peer ? state.peers : undefined}
                  allowPins={!runsById.get(message.runId || '')?.groupOrigin}
                  actions={actions}
                />
              );
            }
            const latest = item.isLast && latestRun?.id === item.id,
              allRunMessages = runMessages.get(item.id) || NO_MESSAGES;
            return (
              <TimelineRun
                key={key}
                runId={item.id}
                run={runsById.get(item.id)}
                messages={item.messages.map((message) => shown.get(message) || message)}
                allRunMessages={allRunMessages}
                isLast={item.isLast}
                latest={latest}
                model={currentModel}
                stream={
                  item.isLast
                    ? liveReplies.find((reply) => reply.runId === item.id && reply.purpose !== 'progress')
                    : undefined
                }
                waiting={item.isLast ? requests.find((request) => request.runId === item.id)?.kind : undefined}
                reviewing={
                  item.isLast &&
                  requests.some(
                    (request) =>
                      request.runId === item.id &&
                      request.kind === 'host_permission' &&
                      request.approval?.phase === 'reviewing',
                  )
                }
                canContinue={!running && !busy}
                outputs={
                  latest
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
                    : NO_FILES
                }
                previewEntries={previewEntries}
                filesDisabled={busy || !vmReady}
                actions={actions}
              />
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
              <LiveReply key={reply.id} reply={reply} />
            ))}
          {(running || greeting) && (
            <BotWorkingStatus
              bot={bot}
              onStop={actions.stop}
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
        <ConversationInteractions requests={ownRequests} botId={bot.id} onTakeover={onTakeover} />
        <WorkItemsPanel items={state.workItems} scope={attachmentScope} bots={state.bots} />
        <LiveWorkStrip
          items={(state.liveWork || []).filter(
            (item) => item.botId === bot.id && runsById.get(item.runId)?.sessionId === sessionId,
          )}
        />
        <DraftComposer
          key={chatKey}
          drafts={drafts}
          draftKey={chatKey}
          attachmentScope={attachmentScope}
          contextOverview={
            lastContext?.model === currentModel?.model &&
            lastContext?.providerId === currentModel?.providerId &&
            lastContext?.capacity === currentModel?.contextTokens
              ? lastContext
              : undefined
          }
          contextCapacity={currentModel?.contextTokens}
          permissionMode={state.hostPermissionModes?.[scope] ?? state.hostPermissionModes?.[botScope]}
          workspaceDir={state.conversationWorkspaces?.[scope] || state.hostWorkspace?.workspaceDir}
          workspaceInherited={!state.conversationWorkspaces?.[scope]}
          bot={bot}
          bots={state.bots}
          running={running}
          onSend={actions.send}
          onStop={actions.stop}
        />
      </div>
    </>
  );
}

/** What timeline rows can do; stable across renders, so rows skip renders their callbacks would otherwise cause. */
type Actions = {
  reply: (message: ChatMessage) => void;
  continueWork: () => void;
  settings: (tab: 'model' | 'computer' | 'mcp') => void;
  screen: (url: string) => void;
  openGroup: (id: string) => void;
  openPrivateChat: (panel: PeerPanel) => void;
  openFile: (file: PreviewFile) => void;
  saveFile: (file: PreviewFile) => void;
  openPreviewEntry: (entry: PreviewHistoryEntry) => void;
  send: () => void;
  stop: () => Promise<unknown>;
};

/** A message row; `shown` is the copy without files an earlier message already delivered. */
const TimelineMessage = memo(function TimelineMessage({
  message,
  shown,
  groups,
  peers,
  allowPins,
  actions,
}: {
  message: ChatMessage;
  shown?: ChatMessage;
  groups?: GroupsView;
  peers?: PeerView;
  allowPins: boolean;
  actions: Actions;
}) {
  if (message.groupTaskSource) return <GroupTaskMessage message={message} view={groups} onOpen={actions.openGroup} />;
  if (message.groupLink)
    return (
      <div className="peer-notice">
        <button
          className="peer-notice-open"
          disabled={!groups?.rooms.some((room) => room.id === message.groupLink?.groupId)}
          onClick={() => actions.openGroup(message.groupLink!.groupId)}
        >
          <Icon name="message" size={16} />
          {message.content}
        </button>
      </div>
    );
  if (message.taskSource) return <PeerTaskMessage message={message} view={peers} onOpen={actions.openPrivateChat} />;
  if (message.peer) return <PeerNotice message={message} view={peers} onOpen={actions.openPrivateChat} />;
  return <Message message={shown || message} onReply={actions.reply} allowPins={allowPins} />;
}, sameProps);

/** A run's work and answer, with the previews and files it produced. */
const TimelineRun = memo(function TimelineRun({
  runId,
  run,
  messages,
  allRunMessages,
  isLast,
  latest,
  model,
  stream,
  waiting,
  reviewing,
  canContinue,
  outputs,
  previewEntries,
  filesDisabled,
  actions,
}: {
  runId: string;
  run?: RunRecord;
  messages: ChatMessage[];
  allRunMessages: ChatMessage[];
  isLast: boolean;
  latest: boolean;
  model?: ModelConfig;
  stream?: StreamingReply;
  waiting?: InteractionRequest['kind'];
  reviewing: boolean;
  canContinue: boolean;
  outputs: Artifact[];
  previewEntries: PreviewHistoryEntry[];
  filesDisabled: boolean;
  actions: Actions;
}) {
  return (
    <>
      <RunMessage
        onReply={actions.reply}
        model={model}
        messages={messages}
        allMessages={allRunMessages}
        isLast={isLast}
        run={run}
        stream={stream}
        waiting={waiting}
        latest={latest}
        canContinue={canContinue}
        reviewing={reviewing}
        onContinue={actions.continueWork}
        onSettings={actions.settings}
        onScreen={actions.screen}
      />
      <PreviewHistoryChips
        entries={previewEntries}
        runIds={[runId]}
        artifactNames={new Set(outputs.map((file) => file.path))}
        attachmentIds={
          new Set(allRunMessages.flatMap((message) => message.attachments?.map((attachment) => attachment.id) || []))
        }
        onOpen={actions.openPreviewEntry}
      />
      <ArtifactList files={outputs} onOpen={actions.openFile} onSave={actions.saveFile} disabled={filesDisabled} />
    </>
  );
}, sameProps);
