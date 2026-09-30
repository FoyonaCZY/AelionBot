import { GroupDecisionTrail } from './GroupDecisionTrail';
import { GroupGames } from './GroupGames';
import { DesignerTaskCard } from '../designer/DesignerTaskCard';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { LiveWorkStrip } from '../chat/LiveWorkStrip';
import { previewFeedbackDisplay } from '../../shared/preview/preview-feedback';
import { ArtifactList } from '../files/ArtifactList';
import { isRunArtifact } from '../../shared/preview/workspace-files';
import { PreviewHistoryChips } from '../preview/PreviewHistoryChips';
import type { PreviewHistoryEntry } from '../../shared/preview/agent-preview-types';
import { Fragment } from 'react';
import { ConversationTimeProvider, MessageTime } from '../chat/ConversationTime';
import { messageReply } from '../../shared/chat/message-replies';
import { MessageQuote } from '../chat/MessageQuote';
import { WorkItemsPanel } from '../chat/WorkItems';
import { workspaceKey } from '../../shared/types/work-types';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InteractionRequest, Snapshot } from '../../shared/types/core';
import type { GroupPage, GroupSummary } from '../../shared/types/group-types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { MentionContent } from '../ui/MentionContent';
import type { FileItem } from '../ui/FileCard';
import { groupReplyContent } from '../../shared/chat/message-envelope';
import { botMentions } from '../../shared/chat/mentions';
import { BotComposer, type ComposerDraft } from '../chat/BotComposer';
import { ConversationInteractions } from '../chat/InteractionPrompts';
import { GroupAvatar } from './GroupAvatar';
import { ipcErrorText } from '../ui/ipc-error';
import './group-chats.css';
import { AttachmentList } from '../files/Attachments';
import { attachmentSummary } from '../../shared/types/attachment-types';
import { MessageActions } from '../chat/MessagePins';
import type { BotActivities } from '../bots/bot-activity';
import { useI18n } from '../i18n';

const merge = <T extends { id: string }>(older: T[], newer: T[]) => [
  ...new Map([...older, ...newer].map((item) => [item.id, item])).values(),
];
export function GroupConversation({
  group,
  state,
  avatarActivities,
  draft,
  onDraft,
  onManage,
  onTakeover,
  onOpenFile,
  onSaveFile,
  onOpenPreviewEntry,
  visible,
}: {
  group: GroupSummary;
  state: Snapshot;
  avatarActivities?: BotActivities;
  draft: ComposerDraft;
  onDraft: (draft: ComposerDraft) => void;
  onManage: () => void;
  onTakeover: (request: Extract<InteractionRequest, { kind: 'vm_takeover' }>) => Promise<void>;
  onOpenFile: (file: FileItem & { botId: string }) => void;
  onSaveFile: (file: FileItem & { botId: string }) => void;
  onOpenPreviewEntry: (entry: PreviewHistoryEntry) => void;
  visible: boolean;
}) {
  const { t } = useI18n();
  const [page, setPage] = useState<GroupPage>(),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false),
    [loading, setLoading] = useState(false);
  const body = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    stickLock = useRef(0),
    paneHeight = useRef(0),
    scroll = useRef<{ height: number; top: number } | undefined>(undefined),
    active = useRef(true),
    sendLock = useRef(false),
    draftRef = useRef(draft);
  draftRef.current = draft;
  const previewWorkbench = usePreviewWorkbench();
  const stickToBottom = () => {
    const element = body.current;
    if (!element) return;
    stickLock.current++;
    element.scrollTop = element.scrollHeight;
    paneHeight.current = element.scrollHeight;
    requestAnimationFrame(() => {
      const live = body.current;
      if (live && follow.current) {
        live.scrollTop = live.scrollHeight;
        paneHeight.current = live.scrollHeight;
      }
      requestAnimationFrame(() => {
        stickLock.current = Math.max(0, stickLock.current - 1);
      });
    });
  };
  const onMessagesScroll = (element: HTMLElement) => {
    if (stickLock.current) return;
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight,
      grew = element.scrollHeight > paneHeight.current + 1;
    paneHeight.current = element.scrollHeight;
    if (grew && follow.current) {
      stickToBottom();
      return;
    }
    follow.current = gap < 90;
  };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    window.aelion
      .readGroup({ id: group.id })
      .then((next) => {
        if (live)
          setPage((current) =>
            current
              ? {
                  ...next,
                  messages: merge(current.messages, next.messages).map((message) =>
                    next.pins ? { ...message, pins: next.pins[message.id] || [] } : message,
                  ),
                  deliveries: merge(current.deliveries, next.deliveries),
                  before: current.before,
                }
              : next,
          );
      })
      .catch((error) => {
        if (live) setError(ipcErrorText(error));
      });
    return () => {
      live = false;
    };
  }, [group.id, state.groups?.revision]);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    if (scroll.current) {
      element.scrollTop = scroll.current.top + element.scrollHeight - scroll.current.height;
      scroll.current = undefined;
      return;
    }
    if (follow.current) stickToBottom();
  }, [page, group.activities]);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const onResize = () => {
      if (follow.current) stickToBottom();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(element);
    window.addEventListener('resize', onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [group.id]);
  useEffect(() => {
    if (!visible || !page || !document.hasFocus()) return;
    void window.aelion.markGroupRead({ id: group.id, seq: page.messages.at(-1)?.seq || 0 }).catch(() => {});
  }, [page?.messages.at(-1)?.seq, visible]);
  useEffect(() => {
    const read = () => {
      if (visible) void window.aelion.markGroupRead({ id: group.id, seq: group.lastSeq }).catch(() => {});
    };
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, [visible, group.lastSeq]);
  const send = async () => {
    if (sendLock.current || (!draft.text.trim() && !draft.attachments?.length)) return;
    const saved = draft;
    sendLock.current = true;
    setSending(true);
    onDraft({ text: '', mentions: [] });
    follow.current = true;
    try {
      if (
        !(await previewWorkbench?.send(
          { kind: 'group', id: group.id },
          {
            text: saved.text,
            mentions: saved.mentions,
            replyToMessageId: saved.reply?.messageId,
            attachmentIds: saved.attachments?.map((f) => f.id),
          },
        ))
      )
        await window.aelion.sendGroup({
          id: group.id,
          message: saved.text,
          mentions: saved.mentions,
          replyToMessageId: saved.reply?.messageId,
          attachmentIds: saved.attachments?.map((file) => file.id),
        });
      if (active.current) setError('');
    } catch (error) {
      if (!draftRef.current.text && !draftRef.current.attachments?.length && !draftRef.current.reply) onDraft(saved);
      if (active.current) setError(ipcErrorText(error));
    } finally {
      sendLock.current = false;
      if (active.current) setSending(false);
    }
  };
  const older = async () => {
    if (!page?.before || loading) return;
    setLoading(true);
    try {
      const result = await window.aelion.readGroup({ id: group.id, before: page.before });
      if (body.current) scroll.current = { height: body.current.scrollHeight, top: body.current.scrollTop };
      follow.current = false;
      setPage((current) =>
        current
          ? {
              ...current,
              messages: merge(result.messages, current.messages),
              deliveries: merge(result.deliveries, current.deliveries),
              before: result.before,
            }
          : result,
      );
    } catch (error) {
      setError(ipcErrorText(error));
    } finally {
      setLoading(false);
    }
  };
  const members = state.bots.filter((bot) => group.members.some((member) => member.id === bot.id && !member.leftAt)),
    displayName = state.userProfile?.displayName || t('你'),
    requests = (state.interactions || []).filter((request) =>
      state.runs.some((run) => run.id === request.runId && run.groupOrigin?.groupId === group.id),
    ),
    owner = state.bots.find((bot) => bot.id === requests[0]?.botId);
  return (
    <>
      <header className="chat-header drag">
        <button className="bot-heading no-drag" onClick={onManage}>
          <GroupAvatar group={group} activities={avatarActivities} />
          <strong>{group.name}</strong>
          <span className="group-member-count">{t('{count} 人', { count: members.length + 1 })}</span>
        </button>
        <div className="header-actions no-drag">
          <button className="icon-button" aria-label={t('群聊设置')} onClick={onManage}>
            <Icon name="settings" />
          </button>
        </div>
      </header>
      <div className="group-design-tasks">
        {state.designer?.sessions
          .filter(
            (s) =>
              s.origin.kind === 'group' &&
              s.origin.id === group.id &&
              ['draft', 'running', 'awaiting-input', 'paused'].includes(s.status),
          )
          .map((s) => (
            <DesignerTaskCard key={s.id} session={s} />
          ))}
      </div>
      <ConversationTimeProvider messages={page?.messages || []}>
        <section
          ref={body}
          className="messages group-messages"
          onScroll={(event) => onMessagesScroll(event.currentTarget)}
        >
          {page?.before && (
            <button className="peer-chat-load" disabled={loading} onClick={() => void older()}>
              {t('加载更早消息')}
            </button>
          )}
          {page?.messages.map((message) => {
            if (message.scheduled)
              return (
                <Fragment key={message.id}>
                  <MessageTime id={message.id} time={message.time} />
                  <div className="scheduled-trigger" data-group-message-id={message.id}>
                    <div>
                      <Icon name="clock" size={15} />
                      <span>
                        {t('定时任务')} · {message.scheduled.title}
                      </span>
                    </div>
                    <p>{message.content}</p>
                  </div>
                </Fragment>
              );
            if (message.kind === 'reaction') return null;
            if (message.kind === 'system' || message.kind === 'continue')
              return (
                <div key={message.id} className="event-message group-system">
                  {message.content}
                </div>
              );
            const bot =
                message.sender.kind === 'bot'
                  ? state.bots.find((b) => b.id === message.sender.id) || message.sender
                  : undefined,
              runId = page.deliveries.find((d) => d.replyMessageId === message.id)?.runId,
              artifacts = state.artifacts.filter(
                (file) =>
                  isRunArtifact(file.path) &&
                  (file.runId === runId || message.runIds?.includes(file.runId)) &&
                  !message.attachments?.some(
                    (attachment) => attachment.name === file.name && attachment.size === file.size,
                  ),
              ),
              previewEntries = (state.previewHistory || []).filter(
                (entry) =>
                  entry.scope.kind === 'group' &&
                  entry.scope.id === group.id &&
                  (entry.runId === runId || message.runIds?.includes(entry.runId)),
              );
            const presentation = previewFeedbackDisplay(message),
              body = groupReplyContent(presentation.content, bot?.id),
              formatted =
                body === presentation.content
                  ? { content: body, mentions: presentation.mentions }
                  : botMentions(body, members, bot?.id, false);
            return (
              <Fragment key={message.id}>
                <MessageTime id={message.id} time={message.time} />
                <article
                  className={`group-message ${message.sender.kind === 'user' ? 'from-user' : ''}`}
                  data-group-message-id={message.id}
                >
                  {bot && <Avatar bot={bot} size={31} />}
                  <div className="group-message-copy">
                    <div className="group-message-author">
                      {message.sender.kind === 'user' ? displayName : bot?.name || message.sender.name}
                    </div>
                    <MessageActions
                      messageId={message.id}
                      content={formatted.content || attachmentSummary(message.attachments)}
                      pins={message.pins}
                      bubbleClassName="group-message-bubble markdown"
                      onReply={() =>
                        onDraft({
                          ...draftRef.current,
                          reply: messageReply(
                            { ...message, content: formatted.content },
                            message.sender.kind === 'user' ? displayName : bot?.name || message.sender.name,
                            message.sender.id,
                          ),
                        })
                      }
                      onPin={(input) => window.aelion.pinGroup({ ...input, groupId: group.id })}
                    >
                      {message.reply && <MessageQuote reply={message.reply} />}
                      <MentionContent content={formatted.content} mentions={formatted.mentions} markdown />
                      <AttachmentList files={message.attachments} />
                    </MessageActions>
                    {message.sender.kind === 'user' && page && (
                      <GroupDecisionTrail
                        deliveries={page.deliveries.filter((item) => item.messageId === message.id)}
                        page={page}
                        bots={members}
                      />
                    )}
                    {message.sender.kind === 'bot' &&
                      message.designSessionId &&
                      state.designer?.sessions
                        .filter((s) => s.id === message.designSessionId)
                        .map((s) => <DesignerTaskCard key={s.id} session={s} />)}
                    <PreviewHistoryChips
                      entries={previewEntries}
                      runIds={[...(runId ? [runId] : []), ...(message.runIds || [])]}
                      artifactNames={new Set(artifacts.map((file) => file.path))}
                      attachmentIds={new Set(message.attachments?.map((attachment) => attachment.id) || [])}
                      onOpen={onOpenPreviewEntry}
                    />
                    <ArtifactList
                      files={artifacts}
                      onOpen={onOpenFile}
                      onSave={onSaveFile}
                      disabled={state.vm.status !== 'ready'}
                    />
                  </div>
                </article>
              </Fragment>
            );
          })}
          {page &&
            !page.messages.some((message) => message.kind === 'message' || message.kind === 'progress') &&
            !group.activities?.length && <div className="group-empty">{t('暂无消息')}</div>}
        </section>
      </ConversationTimeProvider>
      <div className={`composer-wrap ${requests.length ? 'with-request' : ''}`}>
        {error && (
          <div className="group-error" role="alert">
            {error}
          </div>
        )}
        {owner && (
          <div className="group-permission">
            <div className="group-request-owner">
              <Avatar bot={owner} size={19} />
              {owner.name}
              {requests.length > 1 && <span>{t(' · 共 {count} 项请求', { count: requests.length })}</span>}
            </div>
            <ConversationInteractions requests={requests} botId={owner.id} onTakeover={onTakeover} />
          </div>
        )}
        <WorkItemsPanel items={state.workItems} scope={{ kind: 'group', id: group.id }} bots={state.bots} />
        <LiveWorkStrip items={(state.liveWork || []).filter((item) => members.some((bot) => bot.id === item.botId))} />
        {group.round?.status === 'stopped' && !group.pending && (
          <div className="group-round-stopped">
            <span>{group.round.reason || t('本轮讨论已停止')}</span>
            <button
              type="button"
              onClick={() => void window.aelion.continueGroup(group.id).catch((error) => setError(ipcErrorText(error)))}
            >
              {t('继续本轮讨论')}
            </button>
          </div>
        )}
        <BotComposer
          extraTools={
            <GroupGames
              key={group.id}
              groupId={group.id}
              groupName={group.name}
              members={members}
              providers={state.providers}
              defaultModel={state.defaultModel}
              cardContainer={body.current}
            />
          }
          workspaceDir={
            state.conversationWorkspaces?.[workspaceKey({ kind: 'group', id: group.id })] ||
            state.hostWorkspace?.workspaceDir
          }
          workspaceInherited={!state.conversationWorkspaces?.[workspaceKey({ kind: 'group', id: group.id })]}
          attachmentScope={{ kind: 'group', id: group.id }}
          bot={group}
          bots={members}
          draft={draft}
          running={group.pending > 0 || Boolean(group.activities?.length)}
          onChange={onDraft}
          onSend={() => {
            if (!sending) void send();
          }}
          onStop={() => void window.aelion.stopGroup(group.id).catch((error) => setError(ipcErrorText(error)))}
        />
      </div>
    </>
  );
}
