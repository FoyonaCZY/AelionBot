import { GroupDecisionTrail } from './GroupDecisionTrail';
import { isEmptyGroupReply } from '../../shared/chat/group-empty-reply';
import { unanswered } from '../../shared/chat/group-answers';
import { GroupGames } from './GroupGames';
import { DesignerTaskCard } from '../designer/DesignerTaskCard';
import { activeDesignId } from '../designer/design-canvas-state';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { LiveWorkStrip } from '../chat/LiveWorkStrip';
import { previewFeedbackDisplay } from '../../shared/preview/preview-feedback';
import { ArtifactList } from '../files/ArtifactList';
import { isRunArtifact } from '../../shared/preview/workspace-files';
import { PreviewHistoryChips } from '../preview/PreviewHistoryChips';
import type { PreviewHistoryEntry } from '../../shared/preview/agent-preview-types';
import { ConversationTimeProvider, MessageTime } from '../chat/ConversationTime';
import { messageReply } from '../../shared/chat/message-replies';
import { MessageQuote } from '../chat/MessageQuote';
import { WorkItemsPanel } from '../chat/WorkItems';
import { workspaceKey } from '../../shared/types/work-types';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, Bot, InteractionRequest, Snapshot } from '../../shared/types/core';
import type { GroupDelivery, GroupMessage, GroupPage, GroupSummary } from '../../shared/types/group-types';
import type { DesignSession } from '../../shared/types/designer-types';
import type { PinInput } from '../../shared/chat/reactions';
import { share } from '../../shared/state-sync';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { MentionContent } from '../ui/MentionContent';
import type { FileItem } from '../ui/FileCard';
import { groupReplyContent } from '../../shared/chat/message-envelope';
import { botMentions } from '../../shared/chat/mentions';
import { DraftComposer } from '../chat/DraftComposer';
import type { Drafts } from '../app/use-drafts';
import { sameProps } from '../ui/equality';
import { useStableHandlers } from '../ui/use-stable-handlers';
import { ConversationInteractions } from '../chat/InteractionPrompts';
import { GroupAvatar } from './GroupAvatar';
import { ComputerCardToggle } from '../computer/ComputerCardToggle';
import { readScrollAnchor, restoreScrollAnchor, type ScrollAnchor } from '../app/scroll-anchor';
import { useFloatingComposer } from '../chat/use-floating-composer';
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
  drafts,
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
  drafts: Drafts;
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
    anchor = useRef<ScrollAnchor | undefined>(undefined),
    scroll = useRef<{ height: number; top: number } | undefined>(undefined),
    active = useRef(true),
    sendLock = useRef(false);
  const previewWorkbench = usePreviewWorkbench();
  const composerWrap = useFloatingComposer();
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
    if (anchor.current && element.clientWidth !== anchor.current.width) return;
    const gap = element.scrollHeight - element.scrollTop - element.clientHeight,
      grew = element.scrollHeight > paneHeight.current + 1;
    paneHeight.current = element.scrollHeight;
    if (grew && follow.current) {
      stickToBottom();
      return;
    }
    follow.current = gap < 90;
    anchor.current = readScrollAnchor(element);
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
          // Each change re-reads the page; keeping what did not change lets unchanged rows skip their render.
          setPage((current) =>
            current
              ? share(current, {
                  ...next,
                  messages: merge(current.messages, next.messages).map((message) =>
                    next.pins ? { ...message, pins: next.pins[message.id] || [] } : message,
                  ),
                  deliveries: merge(current.deliveries, next.deliveries),
                  before: current.before,
                })
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
      else if (anchor.current && element.clientWidth !== anchor.current.width) {
        stickLock.current++;
        restoreScrollAnchor(element, anchor.current);
        requestAnimationFrame(() => (stickLock.current = Math.max(0, stickLock.current - 1)));
      }
      anchor.current = follow.current ? undefined : readScrollAnchor(element);
      paneHeight.current = element.scrollHeight;
    };
    anchor.current = undefined;
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
    const draft = drafts.get(group.id);
    if (sendLock.current || (!draft.text.trim() && !draft.attachments?.length)) return;
    const saved = draft;
    sendLock.current = true;
    setSending(true);
    drafts.set(group.id, { text: '', mentions: [] });
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
          designSessionId: activeDesignId({ kind: 'group', id: group.id }),
        });
      if (active.current) setError('');
    } catch (error) {
      const current = drafts.get(group.id);
      if (!current.text && !current.attachments?.length && !current.reply) drafts.set(group.id, saved);
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
  const members = useMemo(
      () => state.bots.filter((bot) => group.members.some((member) => member.id === bot.id && !member.leftAt)),
      [state.bots, group.members],
    ),
    displayName = state.userProfile?.displayName || t('你'),
    requests = (state.interactions || []).filter((request) =>
      state.runs.some((run) => run.id === request.runId && run.groupOrigin?.groupId === group.id),
    ),
    owner = state.bots.find((bot) => bot.id === requests[0]?.botId);
  const previewEntries = useMemo(
    () => (state.previewHistory || []).filter((entry) => entry.scope.kind === 'group' && entry.scope.id === group.id),
    [state.previewHistory, group.id],
  );
  // What each row needs from the page, worked out once per page instead of once per row.
  const rows = useMemo(() => {
    const replyRuns = new Map<string, string | undefined>(),
      byMessage = new Map<string, GroupDelivery[]>();
    for (const delivery of page?.deliveries || []) {
      if (delivery.replyMessageId && !replyRuns.has(delivery.replyMessageId))
        replyRuns.set(delivery.replyMessageId, delivery.runId);
      const list = byMessage.get(delivery.messageId) || [];
      list.push(delivery);
      byMessage.set(delivery.messageId, list);
    }
    const quiet = new Set(
      (page?.messages || [])
        .filter((message) => page && unanswered(page.messages, page.deliveries, message))
        .map((message) => message.id),
    );
    return { replyRuns, byMessage, quiet };
  }, [page]);
  const actions = useStableHandlers<GroupRowActions>({
    reply: (message, content, author) =>
      drafts.set(group.id, {
        ...drafts.get(group.id),
        reply: messageReply({ ...message, content }, author, message.sender.id),
      }),
    pin: (input) => window.aelion.pinGroup({ ...input, groupId: group.id }),
    openFile: onOpenFile,
    saveFile: onSaveFile,
    openPreviewEntry: onOpenPreviewEntry,
  });
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
          <ComputerCardToggle />
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
          {page?.messages
            .filter(
              (message) =>
                !(
                  message.sender.kind === 'bot' &&
                  ['message', 'progress'].includes(message.kind) &&
                  !message.attachments?.length &&
                  isEmptyGroupReply(groupReplyContent(message.content, message.sender.id))
                ),
            )
            .map((message) => (
              <GroupMessageRow
                key={message.id}
                message={message}
                bots={state.bots}
                members={members}
                displayName={displayName}
                runId={rows.replyRuns.get(message.id)}
                artifacts={state.artifacts}
                previewEntries={previewEntries}
                unanswered={rows.quiet.has(message.id)}
                deliveries={rows.byMessage.get(message.id) || NO_DELIVERIES}
                laya={page.laya}
                sessions={state.designer?.sessions}
                vmReady={state.vm.status === 'ready'}
                actions={actions}
              />
            ))}
          {page &&
            !page.messages.some((message) => message.kind === 'message' || message.kind === 'progress') &&
            !group.activities?.length && <div className="group-empty">{t('暂无消息')}</div>}
        </section>
      </ConversationTimeProvider>
      <div ref={composerWrap} className={`composer-wrap floating-composer ${requests.length ? 'with-request' : ''}`}>
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
        {(group.round?.status === 'stopped' || group.round?.status === 'limited') && !group.pending && (
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
        <DraftComposer
          drafts={drafts}
          draftKey={group.id}
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
          running={group.pending > 0 || Boolean(group.activities?.length)}
          onSend={() => {
            if (!sending) void send();
          }}
          onStop={() => void window.aelion.stopGroup(group.id).catch((error) => setError(ipcErrorText(error)))}
        />
      </div>
    </>
  );
}

const NO_DELIVERIES: GroupDelivery[] = [];
/** What group rows can do; stable across renders, so rows skip renders their callbacks would otherwise cause. */
type GroupRowActions = {
  reply: (message: GroupMessage, content: string, author: string) => void;
  pin: (input: PinInput) => Promise<unknown>;
  openFile: (file: FileItem & { botId: string }) => void;
  saveFile: (file: FileItem & { botId: string }) => void;
  openPreviewEntry: (entry: PreviewHistoryEntry) => void;
};

/** One group message with its decisions, previews and files; it re-renders only when one of them changed. */
const GroupMessageRow = memo(function GroupMessageRow({
  message,
  bots,
  members,
  displayName,
  runId,
  artifacts,
  previewEntries,
  unanswered,
  deliveries,
  laya,
  sessions,
  vmReady,
  actions,
}: {
  message: GroupMessage;
  bots: Bot[];
  members: Bot[];
  displayName: string;
  runId?: string;
  artifacts: Artifact[];
  previewEntries: PreviewHistoryEntry[];
  unanswered: boolean;
  deliveries: GroupDelivery[];
  laya: GroupPage['laya'];
  sessions?: DesignSession[];
  vmReady: boolean;
  actions: GroupRowActions;
}) {
  const { t } = useI18n();
  if (message.scheduled)
    return (
      <>
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
      </>
    );
  if (message.kind === 'reaction') return null;
  if (message.kind === 'system' || message.kind === 'continue')
    return <div className="event-message group-system">{message.content}</div>;
  const bot =
      message.sender.kind === 'bot' ? bots.find((b) => b.id === message.sender.id) || message.sender : undefined,
    author = message.sender.kind === 'user' ? displayName : bot?.name || message.sender.name,
    files = artifacts.filter(
      (file) =>
        isRunArtifact(file.path) &&
        (file.runId === runId || message.runIds?.includes(file.runId)) &&
        !message.attachments?.some((attachment) => attachment.name === file.name && attachment.size === file.size),
    ),
    entries = previewEntries.filter((entry) => entry.runId === runId || message.runIds?.includes(entry.runId));
  const presentation = previewFeedbackDisplay(message),
    body = groupReplyContent(presentation.content, bot?.id),
    formatted =
      body === presentation.content
        ? { content: body, mentions: presentation.mentions }
        : botMentions(body, members, bot?.id, false);
  return (
    <>
      <MessageTime id={message.id} time={message.time} />
      <article
        className={`group-message ${message.sender.kind === 'user' ? 'from-user' : ''}`}
        data-group-message-id={message.id}
      >
        {bot && <Avatar bot={bot} size={31} />}
        <div className="group-message-copy">
          <div className="group-message-author">{author}</div>
          <MessageActions
            messageId={message.id}
            content={formatted.content || attachmentSummary(message.attachments)}
            pins={message.pins}
            bubbleClassName="group-message-bubble markdown"
            onReply={() => actions.reply(message, formatted.content, author)}
            onPin={actions.pin}
          >
            {message.reply && <MessageQuote reply={message.reply} />}
            <MentionContent content={formatted.content} mentions={formatted.mentions} markdown />
            <AttachmentList files={message.attachments} />
          </MessageActions>
          {unanswered && <div className="group-unanswered">{t('没有 Bot 回应，可以 @ 一个')}</div>}
          {message.sender.kind === 'user' && <GroupDecisionTrail deliveries={deliveries} laya={laya} bots={members} />}
          {message.sender.kind === 'bot' &&
            message.designSessionId &&
            sessions
              ?.filter((s) => s.id === message.designSessionId)
              .map((s) => <DesignerTaskCard key={s.id} session={s} />)}
          <PreviewHistoryChips
            entries={entries}
            runIds={[...(runId ? [runId] : []), ...(message.runIds || [])]}
            artifactNames={new Set(files.map((file) => file.path))}
            attachmentIds={new Set(message.attachments?.map((attachment) => attachment.id) || [])}
            onOpen={actions.openPreviewEntry}
          />
          <ArtifactList files={files} onOpen={actions.openFile} onSave={actions.saveFile} disabled={!vmReady} />
        </div>
      </article>
    </>
  );
}, sameProps);
