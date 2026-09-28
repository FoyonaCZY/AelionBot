import { useConversationBottom } from '../app/use-conversation-bottom';
import studioFacade from './designer-facade.png';
import { DesignerProgress } from './DesignerProgress';
import { DesignFontsPanel } from './DesignFontsPanel';
import { designFailureText, designConversationMessages, designMessageTimeline } from './designer-feedback';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bot, Snapshot } from '../../shared/types/core';
import type { DesignTaskKind } from '../../shared/types/designer-types';
import { DESIGN_TASK_KINDS } from '../../shared/types/designer-types';
import { designPluginCopy, designPluginTriggerLabel } from './designer-plugin-copy';
import {
  emptyCanvasHtml,
  pickDesignPreviewFiles,
  designPreviewSignature,
  type DesignWorkspaceFile,
} from '../../shared/preview/designer-canvas';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { Message } from '../ui/Message';
import { ipcErrorText } from '../ui/ipc-error';
import { PreviewPicker } from '../preview/PreviewPicker';
import { BotComposer, type ComposerDraft } from '../chat/BotComposer';
import { workspaceKey } from '../../shared/types/work-types';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { useFilePreview } from '../preview/FilePreviewContext';
import { workspacePreviewItem } from '../preview/workspace-preview';
import { translate as t, useI18n } from '../i18n';
import { ConversationInteractions } from '../chat/InteractionPrompts';
import { DesignSystemPicker } from './DesignSystemPicker';
import { DesignPluginPicker } from './DesignPluginPicker';
import { DesignerTaskCard } from './DesignerTaskCard';
import { DesignerDelivery } from './DesignerDelivery';
import './designer-workspace.css';
import './designer-bauhaus.css';
import './designer-preview.css';
import './designer-studio.css';
const designerDrafts = new Map<string, Record<string, ComposerDraft>>();
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
    [pluginIds, setPluginIds] = useState<string[]>([]),
    [picker, setPicker] = useState(false),
    [pluginPicker, setPluginPicker] = useState(false),
    [fontPicker, setFontPicker] = useState(false),
    [fontTarget, setFontTarget] = useState<string>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [drafts, setDrafts] = useState<Record<string, ComposerDraft>>(() => designerDrafts.get(draftCacheKey) || {}),
    [workspaceFiles, setWorkspaceFiles] = useState<DesignWorkspaceFile[]>([]);
  const task = sessions.find((s) => s.id === activeId),
    key = task?.id || 'new',
    draft = drafts[key] || { text: '', mentions: [] },
    systems = state.designer?.systems || [],
    plugins = state.designer?.plugins || [],
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
        }))
      : [
          {
            id: 'canvas:' + task.id,
            name: task.title || kindLabel(task.kind),
            size: 0,
            designSessionId: task.id,
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
      setPluginPicker(false);
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
      (file) => ({ ...workspacePreviewItem(task.botId, file), designSessionId: task.id }),
    );
    if (!files.length) return;
    const target = artifacts[next]?.path;
    const fileIndex = Math.max(
      0,
      files.findIndex((item) => item.workspace?.path === target),
    );
    open(files, fileIndex, { scope: previewScope });
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
        plugins: pluginIds,
      });
      setActiveId(created.id);
      setSystemId(bot.defaultDesignSystemId || null);
      setPluginIds([]);
      setPluginPicker(false);
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
      setPluginPicker(false);
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
          setPluginPicker(false);
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
  const openFonts = () => {
    const show = () => {
      setFontTarget(fontPath);
      setPicker(false);
      setPluginPicker(false);
      setFontPicker(true);
    };
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
  const pluginNames = pluginIds.map(
    (id) => designPluginCopy(plugins.find((plugin) => plugin.id === id) || { id, name: id, description: '' }, en).name,
  );
  const pluginControl = plugins.length ? (
    <div className="composer-workspace designer-plugin-control" title={t('可选检查')}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={pluginPicker}
        aria-label={t('可选检查：') + (pluginIds.length ? pluginNames.join('、') : t('未选用'))}
        onClick={() => {
          setPicker(false);
          setPluginPicker((open) => !open);
        }}
      >
        <Icon name="sliders" size={15} />
        <span>{designPluginTriggerLabel(pluginIds.length, pluginNames, en)}</span>
        <Icon name="down" size={12} />
      </button>
    </div>
  ) : null;
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
  const designFindings = (task?.findings || [])
    .flatMap((entry) => entry.findings.map((finding) => ({ ...finding, path: entry.path })))
    .sort((a, b) => a.level.localeCompare(b.level));
  const blockingCount = designFindings.filter((finding) => finding.level === 'P0').length;
  const openComments = (task?.comments || []).filter((comment) => comment.status === 'open');
  const enabledPlugins = plugins.filter((plugin) => (task?.plugins || pluginIds).includes(plugin.id));

  return (
    <div className={`designer-workspace ${task ? 'has-task is-studio is-preview-docked' : ''}`}>
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
              contextControl={
                <>
                  {systemControl}
                  {pluginControl}
                </>
              }
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
                {enabledPlugins.length > 0 && (
                  <p className="designer-plugin-note">
                    {t('本次检查：')}
                    {enabledPlugins.map((plugin) => designPluginCopy(plugin, en).name).join(' · ')}
                  </p>
                )}
                {designMessageTimeline(visible, live).map(({ message, streaming }) => (
                  <div
                    key={message.id}
                    className={`designer-message${streaming ? ' is-streaming' : ''}`}
                    data-design-message={message.id}
                    aria-busy={streaming || undefined}
                  >
                    <Message message={message} allowPins={false} />
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
            <footer className="designer-task-footer">
              <DesignerDelivery
                task={task}
                findings={designFindings}
                blocking={blockingCount}
                comments={openComments}
                busy={busy || running}
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
          onClose={() => setFontPicker(false)}
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
      {pluginPicker && (
        <DesignPluginPicker
          plugins={plugins}
          selected={pluginIds}
          onChange={setPluginIds}
          onClose={() => setPluginPicker(false)}
        />
      )}
    </div>
  );
}
