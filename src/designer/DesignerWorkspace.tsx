import { useConversationBottom } from '../app/use-conversation-bottom';
import studioFacade from './designer-facade.png';
import { DesignerProgress } from './DesignerProgress';
import { DesignFontsPanel } from './DesignFontsPanel';
import { designFailureText, designConversationMessages, designMessageTimeline } from './designer-feedback';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import type { DesignTaskKind } from '../../shared/types/designer-types';
import { DESIGN_TASK_KINDS } from '../../shared/types/designer-types';
import {
  deviceFrameKind,
  emptyCanvasHtml,
  pickDesignPreviewFiles,
  designPreviewSignature,
  type DesignWorkspaceFile,
} from '../../shared/preview/designer-canvas';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { Message } from '../ui/Message';
import { ipcErrorText } from '../ui/ipc-error';
import { PreviewPicker, previewMenuVisibility } from '../preview/PreviewPicker';
import { BotComposer, type ComposerDraft } from '../chat/BotComposer';
import { workspaceKey } from '../../shared/types/work-types';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { useFilePreview } from '../preview/FilePreviewContext';
import { workspacePreviewItem } from '../preview/workspace-preview';
import { translate as t, useI18n } from '../i18n';
import { ConversationInteractions } from '../chat/InteractionPrompts';
import { DesignSystemPicker } from './DesignSystemPicker';
import { DesignerTaskCard } from './DesignerTaskCard';
import { DesignerDelivery } from './DesignerDelivery';
import { DesignerRoundCard } from './DesignerRoundCard';
import { clampDesignerChatWidth } from './designer-round';
import './designer-workspace.css';
import './designer-bauhaus.css';
import './designer-preview.css';
import './designer-studio.css';
import './designer-layout.css';
import './designer-delivery.css';
const designerDrafts = new Map<string, Record<string, ComposerDraft>>();
type StudioLayout = 'chat' | 'split' | 'canvas';
const LAYOUT_KEY = 'aelion-designer-layout',
  WIDTH_KEY = 'aelion-designer-chat-width';
const stored = <T,>(key: string, read: (value: string | null) => T): T => {
  try {
    return read(localStorage.getItem(key));
  } catch {
    return read(null);
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};
const lastDesign = (botId: string) => {
  try {
    return localStorage.getItem('aelion-last-design:' + botId) || '';
  } catch {
    return '';
  }
};
const kindLabel = (kind: DesignTaskKind) =>
  ({
    prototype: t('原型设计'),
    ppt: t('PPT 演示'),
    clone: t('网站复刻'),
    mobile: t('移动端'),
    document: t('多页文档'),
  })[kind];
const KIND_ICONS: Record<DesignTaskKind, ReactNode> = {
  prototype: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01M9 9v11" />
    </>
  ),
  ppt: (
    <>
      <rect x="3" y="3" width="18" height="13" rx="1.5" />
      <path d="M12 16v5M8 21h8M7 8h6M7 11h10" />
    </>
  ),
  clone: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" />
    </>
  ),
  mobile: (
    <>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M12 18h.01" />
    </>
  ),
  document: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
};
export function DesignerWorkspace({
  bot,
  state,
  onProfile,
  onTakeover,
  initialSessionId,
  onClose,
}: {
  bot: Bot;
  state: Snapshot;
  onProfile: () => void;
  onTakeover: Parameters<typeof ConversationInteractions>[0]['onTakeover'];
  initialSessionId?: string;
  onClose?: () => void;
}) {
  const { language } = useI18n(),
    en = language === 'en',
    open = useFilePreview()!,
    preview = usePreviewWorkbench(),
    actionLock = useRef(false),
    canvasSig = useRef('');
  const sessions = (state.designer?.sessions || []).filter(
    (s) => s.botId === bot.id && (initialSessionId ? s.id === initialSessionId : s.origin.kind === 'bot'),
  );
  const draftCacheKey = bot.id + ':' + (bot.contextResetAt || 'initial') + ':' + (initialSessionId || 'main');
  const [activeId, setActiveId] = useState(initialSessionId || lastDesign(bot.id)),
    [kind, setKind] = useState<DesignTaskKind>('prototype'),
    [systemId, setSystemId] = useState<string | null>(bot.defaultDesignSystemId || null),
    [picker, setPicker] = useState(false),
    [fontPicker, setFontPicker] = useState(false),
    [fontTarget, setFontTarget] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [drafts, setDrafts] = useState<Record<string, ComposerDraft>>(() => designerDrafts.get(draftCacheKey) || {}),
    [workspaceFiles, setWorkspaceFiles] = useState<DesignWorkspaceFile[]>([]),
    [layout, setLayout] = useState<StudioLayout>(() =>
      stored(LAYOUT_KEY, (v) => (v === 'chat' || v === 'canvas' ? v : 'split')),
    ),
    [chatWidth, setChatWidth] = useState(() => stored(WIDTH_KEY, (v) => clampDesignerChatWidth(Number(v) || 452)));
  const studioRoot = useRef<HTMLDivElement>(null),
    studioFooter = useRef<HTMLElement>(null);
  const chooseLayout = (next: StudioLayout) => {
    setLayout(next);
    remember(LAYOUT_KEY, next);
  };
  const resizeChat = (width: number) => {
    const next = clampDesignerChatWidth(width, studioRoot.current?.clientWidth);
    setChatWidth(next);
    remember(WIDTH_KEY, String(next));
  };
  // In the canvas layout the composer floats under the canvas; the canvas ends above it.
  useEffect(() => {
    const node = studioFooter.current,
      root = studioRoot.current;
    if (!node || !root || layout !== 'canvas') {
      root?.style.removeProperty('--designer-dock-height');
      return;
    }
    const update = () => root.style.setProperty('--designer-dock-height', node.getBoundingClientRect().height + 'px');
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [layout, activeId]);
  const task = sessions.find((s) => s.id === activeId),
    key = task?.id || 'new',
    draft = drafts[key] || { text: '', mentions: [] },
    systems = state.designer?.systems || [],
    system = systems.find((s) => s.id === (task ? task.systemId : systemId));
  const conversationScroll = useConversationBottom(bot.id + ':' + key);
  const permissionMode = state.hostPermissionModes?.[workspaceKey({ kind: 'bot', id: bot.id })];
  const botRunning = state.runs.some((r) => r.botId === bot.id && r.status === 'running');
  const running = Boolean(
    task &&
    (task.activeRunId ||
      state.runs.some(
        (r) =>
          r.botId === bot.id && r.status === 'running' && (r.designSessionId === task.id || task.runIds.includes(r.id)),
      )),
  );
  const requests = task
    ? (state.interactions || []).filter(
        (r) =>
          r.botId === bot.id &&
          state.runs.some(
            (run) => run.id === r.runId && (run.designSessionId === task.id || task.runIds.includes(run.id)),
          ),
      )
    : [];
  const previewScope = task
    ? {
        kind: task.origin.kind === 'group' ? ('group' as const) : ('bot' as const),
        id: task.origin.kind === 'group' ? task.origin.id : task.botId,
      }
    : undefined;
  useEffect(() => {
    setActiveId(initialSessionId || lastDesign(bot.id));
  }, [bot.id, initialSessionId]);
  useEffect(() => {
    designerDrafts.set(draftCacheKey, drafts);
  }, [draftCacheKey, drafts]);
  useEffect(() => {
    if (!initialSessionId)
      try {
        localStorage.setItem('aelion-last-design:' + bot.id, activeId);
      } catch {}
  }, [bot.id, initialSessionId, activeId]);
  useEffect(() => {
    if (!task) {
      setWorkspaceFiles([]);
      return;
    }
    let live = true;
    const tick = async () => {
      try {
        const files = await window.aelion.listDesignWorkspace(task.id);
        if (live) setWorkspaceFiles(files);
      } catch {
        if (live) setWorkspaceFiles([]);
      }
    };
    void tick();
    if (!running)
      return () => {
        live = false;
      };
    const timer = setInterval(() => void tick(), 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [task?.id, task?.revision, running]);
  useEffect(() => {
    if (!task || !open || !previewScope) {
      if (canvasSig.current) {
        preview?.close();
        canvasSig.current = '';
      }
      return;
    }
    const picked = pickDesignPreviewFiles(task.kind, workspaceFiles, task.artifacts);
    const sig = task.id + '|' + designPreviewSignature(picked) + '|' + task.kind;
    if (canvasSig.current === sig) return;
    canvasSig.current = sig;
    const items = picked.length
      ? picked.map((file) => ({
          ...workspacePreviewItem(task.botId, { name: file.name, path: file.path, size: file.size }),
          designSessionId: task.id,
          deviceFrame: deviceFrameKind(task.kind),
        }))
      : [
          {
            id: 'canvas:' + task.id,
            name: task.title || kindLabel(task.kind),
            size: 0,
            designSessionId: task.id,
            deviceFrame: deviceFrameKind(task.kind),
            load: async () => ({ kind: 'html' as const, content: emptyCanvasHtml() }),
          },
        ];
    const selected = Math.max(
      0,
      items.findIndex((item) => item.id === preview?.info?.itemId),
    );
    open(items, selected, { scope: previewScope });
  }, [
    task?.id,
    task?.kind,
    task?.title,
    workspaceFiles,
    task?.artifacts,
    open,
    previewScope?.kind,
    previewScope?.id,
    en,
  ]);
  const act = async (action: () => Promise<unknown>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setError(ipcErrorText(error));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const select = (id: string) =>
    preview?.navigate(() => {
      preview.close();
      canvasSig.current = '';
      setPicker(false);
      setFontPicker(false);
      setActiveId(id);
    }) ||
    (!preview && setActiveId(id));
  const showArtifact = (index = 0) => {
    if (!task) return;
    const picked = pickDesignPreviewFiles(task.kind, workspaceFiles, task.artifacts);
    const artifacts = task.artifacts;
    let next = index;
    const current = artifacts[index];
    if (current?.kind === 'pptx') {
      const stem = current.name.replace(/\.[^.]+$/, '');
      const html = artifacts.findIndex((a) => a.kind === 'html' && a.name.replace(/\.[^.]+$/, '') === stem);
      if (html >= 0) next = html;
    }
    const files = (picked.length ? picked : artifacts.map((a) => ({ name: a.name, path: a.path, size: a.bytes }))).map(
      (file) => ({
        ...workspacePreviewItem(task.botId, file),
        designSessionId: task.id,
        deviceFrame: deviceFrameKind(task.kind),
      }),
    );
    if (!files.length) return;
    const target = artifacts[next]?.path;
    const fileIndex = Math.max(
      0,
      files.findIndex((item) => item.workspace?.path === target),
    );
    open(files, fileIndex, { scope: previewScope });
  };
  // Rounds are numbered by the task's runs, so a resumed run keeps its number.
  const roundOf = (runId?: string) => {
    const index = runId && task ? task.runIds.indexOf(runId) : -1;
    return index >= 0 ? index + 1 : (task?.runIds.length || 0) + 1;
  };
  const openDelivered = (file: { name: string }) => {
    if (!task) return;
    const base = (path: string) => path.split(/[\\/]/).pop();
    const artifact = task.artifacts.findIndex((item) => item.name === file.name || base(item.path) === file.name);
    if (artifact >= 0) return showArtifact(artifact);
    const workspace = workspaceFiles.find((item) => base(item.path) === file.name);
    if (workspace)
      open(
        [
          {
            ...workspacePreviewItem(task.botId, workspace),
            designSessionId: task.id,
            deviceFrame: deviceFrameKind(task.kind),
          },
        ],
        0,
        { scope: previewScope },
      );
  };
  const send = async () => {
    if (!draft.text.trim() && !draft.attachments?.length) return;
    conversationScroll.followLatest();
    if (task) {
      if (
        !(await preview?.send(previewScope!, {
          text: draft.text,
          attachmentIds: draft.attachments?.map((a) => a.id),
          mentions: draft.mentions,
        }))
      )
        await window.aelion.sendDesignMessage({
          id: task.id,
          message: draft.text,
          attachmentIds: draft.attachments?.map((a) => a.id),
        });
    } else {
      const created = await window.aelion.createDesignSession({
        botId: bot.id,
        kind,
        brief: draft.text || t('根据附件进行设计'),
        systemId,
      });
      setActiveId(created.id);
      setSystemId(bot.defaultDesignSystemId || null);
      await window.aelion.sendDesignMessage({
        id: created.id,
        message: draft.text || created.brief,
        attachmentIds: draft.attachments?.map((a) => a.id),
      });
    }
    setDrafts((old) => ({ ...old, [key]: { text: '', mentions: [] } }));
  };
  const systemLocked = running || Boolean(task?.activeRunId) || busy;
  useEffect(() => {
    if (running || task?.activeRunId) {
      setPicker(false);
    }
  }, [running, task?.activeRunId]);
  const systemControl = (
    <div
      className="composer-workspace designer-system-control"
      title={systemLocked ? t('停止任务后可更改设计系统') : t('设计系统')}
    >
      <button
        type="button"
        disabled={systemLocked}
        aria-label={t('设计系统：') + (system?.name || t('未指定'))}
        aria-haspopup="dialog"
        onClick={() => {
          setPicker(true);
        }}
      >
        <Icon name="layers" size={15} />
        <span>{system?.name || t('未指定')}</span>
        <Icon name="down" size={12} />
      </button>
    </div>
  );
  const fontPath = [
    ...workspaceFiles,
    ...(task?.artifacts || []).map((item) => ({ name: item.name, path: item.path, size: item.bytes })),
  ].find(
    (file) => /\.html?$/i.test(file.path) && workspacePreviewItem(bot.id, file).id === preview?.info?.itemId,
  )?.path;
  // The web preview is a native view above the page: freeze it to a screenshot before the dialog opens,
  // otherwise the dialog first shows behind it and then the canvas flashes blank.
  const openFonts = () => {
    const show = () =>
      void previewMenuVisibility(true).then(() => {
        setFontTarget(fontPath);
        setPicker(false);
        setFontPicker(true);
      });
    if (preview) preview.navigate(show);
    else show();
  };
  const refreshFonts = () => {
    if (!task) return;
    canvasSig.current = '';
    void window.aelion
      .listDesignWorkspace(task.id)
      .then(setWorkspaceFiles)
      .catch((cause) => setError(ipcErrorText(cause)));
  };
  const taskRuns = task
      ? state.runs.filter((r) => r.botId === bot.id && (r.designSessionId === task.id || task.runIds.includes(r.id)))
      : [],
    lastRun = taskRuns.at(-1);
  const failure =
    task && ['failed', 'paused'].includes(task.status) && (task.lastError || lastRun?.error)
      ? designFailureText(task.lastError || lastRun!.error!, en)
      : undefined;
  const canContinue = Boolean(
    lastRun &&
    ['failed', 'cancelled', 'interrupted'].includes(lastRun.status) &&
    !lastRun.inputUpdated &&
    !lastRun.groupUpdated &&
    task?.origin.kind !== 'peer',
  );
  const continueTask = async () => {
    if (!lastRun) return;
    conversationScroll.followLatest();
    await window.aelion.resumeChat({ botId: bot.id, runId: lastRun.id });
  };
  const activeRun = taskRuns.find((r) => r.status === 'running'),
    live = activeRun
      ? (state.streamingReplies || []).filter(
          (r) => r.botId === bot.id && r.runId === activeRun.id && r.main && !r.groupId && !r.peerThreadId,
        )
      : [];
  const currentRequest = activeRun ? requests.find((r) => r.runId === activeRun.id) : undefined;
  const visible = task ? designConversationMessages(state.messages, state.runs, bot.id, task.id, task.runIds) : [];
  const latestReply = [...designMessageTimeline(visible, live)]
    .reverse()
    .map(({ message }) => message)
    .find((message) => message.role === 'assistant' && message.content.trim())
    ?.content.replace(/[#*_`>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  const designFindings = (task?.findings || [])
    .flatMap((entry) => entry.findings.map((finding) => ({ ...finding, path: entry.path })))
    .sort((a, b) => a.level.localeCompare(b.level));
  const blockingCount = designFindings.filter((finding) => finding.level === 'P0').length;
  const openComments = (task?.comments || []).filter((comment) => comment.status === 'open');

  return (
    <div
      ref={studioRoot}
      className={`designer-workspace ${task ? 'has-task is-studio is-preview-docked' : ''}`}
      data-layout={task ? layout : undefined}
      style={task ? ({ '--designer-chat-width': chatWidth + 'px' } as React.CSSProperties) : undefined}
    >
      <header className="designer-header chat-header drag">
        <button className="designer-identity no-drag" onClick={onProfile}>
          <Avatar bot={bot} size={31} />
          <strong>{bot.name}</strong>
          <small>{t('设计师')}</small>
        </button>
        {task && (
          <div className="designer-task-top">
            <PreviewPicker
              label={t('设计任务')}
              value={task.id}
              options={sessions.map((s) => ({ value: s.id, label: s.title }))}
              onChange={select}
            />
            {!initialSessionId && (
              <button
                className="designer-new-task"
                aria-label={t('新任务')}
                title={t('新任务')}
                onClick={() => select('')}
              >
                <Icon name="plus" size={15} />
                <span>{t('新任务')}</span>
              </button>
            )}
          </div>
        )}
        {task && (
          <div className="designer-layout-switch no-drag" role="radiogroup" aria-label={t('布局')}>
            {(['chat', 'split', 'canvas'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={layout === value}
                onClick={() => chooseLayout(value)}
              >
                {t({ chat: '对话', split: '分栏', canvas: '画布' }[value])}
              </button>
            ))}
          </div>
        )}
        {task && (
          <button type="button" className="designer-font-trigger no-drag" aria-haspopup="dialog" onClick={openFonts}>
            <span aria-hidden="true">Aa</span>
            {t('字体')}
          </button>
        )}
        {onClose && (
          <button className="icon-button no-drag" onClick={onClose} aria-label={t('关闭')}>
            <Icon name="close" />
          </button>
        )}
      </header>
      {!task ? (
        <div className="designer-home">
          <div className="designer-bauhaus-hero">
            <div>
              <h1>
                {en ? (
                  <>
                    Design
                    <br />
                    studio<span>.</span>
                  </>
                ) : (
                  <>
                    设计
                    <br />
                    工作室<span>.</span>
                  </>
                )}
              </h1>
            </div>
            <figure>
              <img src={studioFacade} alt="" />
              <i />
              <b />
            </figure>
          </div>
          <div className="designer-task-kinds" role="group" aria-label={t('设计任务类型')}>
            {DESIGN_TASK_KINDS.map((value) => (
              <button type="button" key={value} onClick={() => setKind(value)} aria-pressed={kind === value}>
                <svg
                  className="designer-kind-icon"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {KIND_ICONS[value]}
                </svg>
                <div>
                  <strong>{kindLabel(value)}</strong>
                </div>
              </button>
            ))}
          </div>
          <div className="designer-home-composer">
            <BotComposer
              placeholder={t('输入设计需求…')}
              permissionMode={permissionMode}
              fixedDesignWorkspace
              contextOverview={activeRun?.contextOverview}
              contextCapacity={(state.botModels?.[bot.id] || state.model).contextTokens}
              contextControl={<>{systemControl}</>}
              bot={bot}
              bots={state.bots}
              draft={draft}
              onChange={(v) => setDrafts((old) => ({ ...old, [key]: v }))}
              running={running}
              onSend={() => {
                if (!busy) void act(send);
              }}
              onStop={() => void window.aelion.cancel(bot.id)}
            />
          </div>
          {sessions.length > 0 && (
            <div className="designer-recent">
              <h3>{t('最近设计')}</h3>
              {sessions
                .slice()
                .reverse()
                .map((s) => (
                  <DesignerTaskCard key={s.id} session={s} onOpen={select} />
                ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {layout === 'canvas' && (
            <nav className="designer-rail" aria-label={t('对话')}>
              <button
                type="button"
                className="designer-rail-avatar"
                title={t('展开对话')}
                onClick={() => chooseLayout('split')}
              >
                <Avatar bot={bot} size={30} activity={running ? 'working' : 'idle'} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={t('展开对话')}
                onClick={() => chooseLayout('split')}
              >
                <Icon name="message" size={17} />
              </button>
              {running && <span className="designer-rail-status">{t('生成中')}</span>}
            </nav>
          )}
          <div className="designer-studio-chat">
            <div
              ref={conversationScroll.pane}
              className="designer-thread"
              onScroll={conversationScroll.onScroll}
              onWheel={conversationScroll.onWheel}
            >
              <div ref={conversationScroll.content} className="designer-conversation-sheet">
                {task.designSpec && (
                  <details key={task.id} className="designer-spec">
                    <summary>{t('设计要求')}</summary>
                    <p>{task.designSpec}</p>
                    {task.constraints.map((c, i) => (
                      <p key={i}>• {c}</p>
                    ))}
                  </details>
                )}
                {designMessageTimeline(visible, live).map(({ message, streaming }) => (
                  <div
                    key={message.id}
                    className={`designer-message${streaming ? ' is-streaming' : ''}`}
                    data-design-message={message.id}
                    aria-busy={streaming || undefined}
                  >
                    {message.role === 'assistant' && message.attachments?.length ? (
                      <>
                        <Message message={{ ...message, attachments: undefined }} allowPins={false} />
                        <DesignerRoundCard
                          round={roundOf(message.runId)}
                          attachments={message.attachments}
                          changes={message.runId ? task.changes?.[message.runId] : undefined}
                          onOpen={openDelivered}
                        />
                      </>
                    ) : (
                      <Message message={message} allowPins={false} />
                    )}
                  </div>
                ))}
                {activeRun && (
                  <DesignerProgress
                    task={task}
                    run={activeRun}
                    messages={state.messages}
                    waiting={currentRequest?.kind}
                    reviewing={
                      currentRequest?.kind === 'host_permission' && currentRequest.approval?.phase === 'reviewing'
                    }
                  />
                )}{' '}
                {failure && (
                  <div className="designer-failure" role="alert">
                    <div className="designer-failure-heading">
                      <strong>{failure.title}</strong>
                      {canContinue && (
                        <button type="button" disabled={busy || botRunning} onClick={() => void act(continueTask)}>
                          {busy ? t('正在处理…') : t('继续任务')}
                        </button>
                      )}
                    </div>
                    <details className="designer-failure-details" open>
                      <summary>{t('查看详情')}</summary>
                      <p>{failure.detail}</p>
                    </details>
                  </div>
                )}
              </div>
            </div>
            <footer className="designer-task-footer" ref={studioFooter}>
              {layout === 'canvas' && latestReply && (
                <div className="designer-peek">
                  <Avatar bot={bot} size={20} />
                  <span>
                    <b>{bot.name}</b>
                    {latestReply}
                  </span>
                  <button type="button" onClick={() => chooseLayout('split')}>
                    {t('展开对话')}
                  </button>
                </div>
              )}
              <DesignerDelivery
                task={task}
                findings={designFindings}
                blocking={blockingCount}
                comments={openComments}
                busy={busy || running}
                running={running}
                onStop={() => void window.aelion.cancel(bot.id)}
                onShow={showArtifact}
                onAccept={() =>
                  void act(() => window.aelion.acceptDesignSession({ id: task.id, revision: task.revision }))
                }
              />
              <div className="designer-task-composer">
                {task.origin.kind === 'peer' ? (
                  <>
                    <p className="designer-collaboration-note">{t('请在发起会话中发送修改意见。')}</p>
                    {systemControl}
                  </>
                ) : (
                  <>
                    <ConversationInteractions requests={requests} botId={bot.id} onTakeover={onTakeover} />
                    <BotComposer
                      placeholder={t('输入修改意见…')}
                      permissionMode={permissionMode}
                      fixedDesignWorkspace
                      designSessionId={task?.id}
                      contextControl={systemControl}
                      bot={bot}
                      bots={state.bots}
                      attachmentScope={{
                        kind: task.origin.kind === 'group' ? 'group' : 'bot',
                        id: task.origin.kind === 'group' ? task.origin.id : bot.id,
                      }}
                      draft={draft}
                      running={running}
                      onChange={(v) => setDrafts((old) => ({ ...old, [key]: v }))}
                      onSend={() => {
                        if (!busy) void act(send);
                      }}
                      onStop={() => void window.aelion.cancel(bot.id)}
                    />
                  </>
                )}
              </div>
            </footer>
          </div>
          {layout === 'split' && (
            <div
              className="designer-divider"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('调整对话宽度')}
              aria-valuemin={360}
              aria-valuemax={640}
              aria-valuenow={chatWidth}
              tabIndex={0}
              onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const left = studioRoot.current?.getBoundingClientRect().left || 0;
                resizeChat(event.clientX - left);
              }}
              onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  resizeChat(chatWidth + (event.key === 'ArrowRight' ? 16 : -16));
                }
              }}
            />
          )}
          <aside className="designer-canvas" data-designer-canvas={task.id} aria-label={t('实时设计画布')} />
        </>
      )}
      {fontPicker && task && (
        <DesignFontsPanel
          key={task.id}
          sessionId={task.id}
          path={fontTarget}
          en={en}
          busy={systemLocked}
          api={window.aelion}
          onClose={() => {
            setFontPicker(false);
            void previewMenuVisibility(false);
          }}
          onChanged={refreshFonts}
        />
      )}
      {error && (
        <p className="designer-error" role="alert">
          {error}
        </p>
      )}
      {picker && (
        <DesignSystemPicker
          systems={systems}
          value={task ? task.systemId : systemId}
          onClose={() => setPicker(false)}
          onImport={
            systemLocked
              ? undefined
              : async () => {
                  const imported = await window.aelion.importDesignSystem();
                  if (!imported) return;
                  if (task)
                    await window.aelion.updateDesignSession({
                      id: task.id,
                      revision: task.revision,
                      systemId: imported.id,
                    });
                  else setSystemId(imported.id);
                  setPicker(false);
                }
          }
          onSelect={(id) => {
            if (systemLocked) return;
            if (task)
              void act(async () => {
                await window.aelion.updateDesignSession({ id: task.id, revision: task.revision, systemId: id });
                setPicker(false);
              });
            else {
              setSystemId(id);
              setPicker(false);
            }
          }}
        />
      )}
    </div>
  );
}
