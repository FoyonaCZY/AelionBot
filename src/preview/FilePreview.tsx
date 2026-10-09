import { CanvasExportStatus, type CanvasExportState } from './CanvasExportStatus';
import { PreviewOpenMenu } from './PreviewOpenMenu';
import { previewOpenTarget, type PreviewOpenAction } from '../../shared/preview/preview-open';
import { previewHistoryShortcut, previewTextInput } from '../../shared/preview/preview-shortcuts';
import { FileAnnotationLayer } from './FileAnnotationLayer';
import { PreviewRuntimeContext, type WebPreviewControls } from './preview-runtime';
import type { AnnotationTool, PreviewAnnotation, PreviewMode } from '../../shared/types/preview-editor-types';
import { PreviewPicker } from './PreviewPicker';
import { PREVIEW_DEVICE_PRESETS, previewDevicePreset } from '../../shared/preview/preview-devices';
import { CanvasExportMenu } from './CanvasExportMenu';
import { canvasDesignSource, type CanvasExportFormat } from '../../shared/preview/canvas-export';
import type { PreviewChatInput } from './PreviewWorkbench';
import { usePreviewWorkbench } from './PreviewWorkbench';
import { PreviewToolbar } from './PreviewToolbar';
import { PreviewContent } from './PreviewContent';
import { PreviewFeedback, type FeedbackFocusRequest } from './PreviewFeedback';
import type { AttachmentScope } from '../../shared/types/attachment-types';
import { draftChanged, editedPreview, usePreviewEdits } from './use-preview-edits';
import { WorkspaceFileTree } from '../files/WorkspaceFileTree';
import { workspacePreviewItem } from './workspace-preview';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PreviewItem, RegisterPreviewGuard } from './FilePreviewContext';
import { fileSize } from '../files/FileAppearance';
import { PreviewLayoutContext } from './preview-layout';
import { previewErrorText, previewKind } from './preview-utils';
import { useI18n } from '../i18n';
import { PreviewIcon } from './PreviewIcon';
import { UnsavedDialog } from './UnsavedDialog';
import './file-preview.css';
import './file-preview-compact.css';
import './preview-workbench.css';
import './preview-editing-tools.css';
import './preview-shell.css';

const SourceEditor = lazy(() => import('./SourceEditor'));
export function FilePreview({
  items: initialItems,
  initialIndex = 0,
  initialExpanded = false,
  feedbackScope,
  onClose,
  registerGuard,
  onSessionChange,
  initialAnnotations,
}: {
  initialAnnotations?: Record<string, PreviewAnnotation[]>;
  items: PreviewItem[];
  feedbackScope?: AttachmentScope;
  initialIndex?: number;
  initialExpanded?: boolean;
  onClose: () => void;
  registerGuard?: RegisterPreviewGuard;
  onSessionChange?: (value: {
    annotationCache?: Record<string, PreviewAnnotation[]>;
    items: PreviewItem[];
    index: number;
    expanded: boolean;
  }) => void;
}) {
  const { t, language } = useI18n(),
    l = (cn: string, en: string) => (language === 'en' ? en : t(cn)),
    workbench = usePreviewWorkbench();
  const [items, setItems] = useState(() =>
      initialItems.map((item) =>
        item.editor || !item.workspace
          ? item
          : {
              ...item,
              editor: workspacePreviewItem(item.workspace.botId, {
                name: item.name,
                path: item.workspace.path,
                size: item.size,
              }).editor,
            },
      ),
    ),
    [directoryOpen, setDirectoryOpen] = useState(false);
  const [index, setIndex] = useState(initialIndex),
    [expanded, setExpanded] = useState(initialExpanded),
    [wide, setWide] = useState(() => matchMedia('(min-width:1000px)').matches),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [retry, setRetry] = useState(0);
  const [exportState, setExportState] = useState<CanvasExportState>(),
    exportInFlight = useRef(false);
  const [chatWidth, setChatWidth] = useState(() => {
    try {
      return Math.max(260, Math.min(420, Number(localStorage.getItem('aelion-preview-chat-width')) || 340));
    } catch {
      return 340;
    }
  });
  const [deviceId, setDeviceId] = useState(() => {
    try {
      return localStorage.getItem('aelion-preview-device') || 'pixel';
    } catch {
      return 'pixel';
    }
  });
  const devicePreset = previewDevicePreset(deviceId);
  const chooseDevice = (id: string) => {
    setDeviceId(id);
    try {
      localStorage.setItem('aelion-preview-device', id);
    } catch {}
  };
  const [mode, setMode] = useState<PreviewMode>('browse'),
    [tool, setTool] = useState<AnnotationTool>('rect'),
    [web, setWeb] = useState<WebPreviewControls>(),
    webItems = useRef(new Set<string>()),
    [fileAnnotations, setFileAnnotations] = useState<PreviewAnnotation[]>([]),
    [domPending, setDomPending] = useState<(() => void) | undefined>(undefined),
    [domGuardError, setDomGuardError] = useState(''),
    [domSaving, setDomSaving] = useState(false);
  const annotationCache = useRef(initialAnnotations || {}),
    sourceRevision = useRef(0),
    previousSource = useRef<string | undefined>(undefined);
  const webRef = useRef(web);
  webRef.current = web;
  const fileAnnotationSetter = useRef<(value: PreviewAnnotation[]) => void>(() => {}),
    feedbackSubmit = useRef<((input: PreviewChatInput) => Promise<unknown>) | undefined>(undefined);
  const registerFileAnnotations = useCallback((fn: (value: PreviewAnnotation[]) => void) => {
    fileAnnotationSetter.current = fn;
    return () => {
      fileAnnotationSetter.current = () => {};
    };
  }, []);
  const registerFeedbackSend = useCallback((fn: (input: PreviewChatInput) => Promise<unknown>) => {
    feedbackSubmit.current = fn;
    return () => {
      if (feedbackSubmit.current === fn) feedbackSubmit.current = undefined;
    };
  }, []);
  const edits = usePreviewEdits(Boolean(web?.state.dirty));
  const request = (proceed: () => void, ids?: string[]) => {
    if (webRef.current?.busy || domSaving) {
      setNotice(t('正在保存，请稍候'));
      return;
    }
    if (webRef.current?.state.dirty) {
      setDomGuardError('');
      setDomPending(() => () => edits.request(proceed, ids));
    } else edits.request(proceed, ids);
  };
  const annotations = web ? (mode === 'edit' ? [] : web.state.annotations) : fileAnnotations;
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string>(),
    [feedbackFocus, setFeedbackFocus] = useState<FeedbackFocusRequest>({ sequence: 0 });
  const seenAnnotations = useRef(new Set<string>());
  const setAnnotations = async (value: PreviewAnnotation[]) => {
    if (webRef.current) await webRef.current.command({ type: 'annotations', annotations: value });
    else fileAnnotationSetter.current(value);
  };
  const selectAnnotation = (id: string) => {
    setSelectedAnnotationId(id);
    if (webRef.current)
      void webRef.current.command({ type: 'annotation-select', id }).catch((error) => setNotice(error.message));
  };
  useEffect(() => {
    const selected = web?.state.selectedAnnotationId;
    if (selected) setSelectedAnnotationId(selected);
  }, [web?.state.selectedAnnotationId]);
  useEffect(() => {
    const added = annotations.filter((mark) => !seenAnnotations.current.has(mark.id));
    seenAnnotations.current = new Set(annotations.map((mark) => mark.id));
    if (added.length && mode === 'annotate') {
      const mark = added.at(-1)!;
      setSelectedAnnotationId(mark.id);
      if (tool === 'rect' || tool === 'element' || tool === 'text') {
        setMode('browse');
        setFeedbackFocus((value) => ({ sequence: value.sequence + 1, note: tool === 'text' }));
      }
    } else if (selectedAnnotationId && !annotations.some((mark) => mark.id === selectedAnnotationId))
      setSelectedAnnotationId(annotations.at(-1)?.id);
  }, [annotations, mode, tool]);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  useEffect(
    () =>
      workbench?.registerAnnotations({
        remove: (id) => void setAnnotations(annotationsRef.current.filter((mark) => mark.id !== id)),
        select: (id) => selectAnnotation(id),
      }),
    [workbench?.registerAnnotations, web],
  );
  const captureAnnotations = async () => {
    const view = webRef.current;
    if (!view) return { annotations: fileAnnotations };
    const result = await view.command({ type: 'feedback-state' });
    return { annotations: result.state.annotations, view: result.state.viewport };
  };
  useEffect(() => {
    setMode('browse');
    setFileAnnotations([]);
    setSelectedAnnotationId(undefined);
    seenAnnotations.current = new Set();
  }, [index]);
  const [feedbackSending, setFeedbackSending] = useState(false),
    feedbackLock = useRef(false),
    afterFeedback = useRef<(() => void) | undefined>(undefined);
  const panel = useRef<HTMLElement>(null),
    previous = useRef<HTMLElement | null>(null),
    item = items[index],
    // A design canvas is an ordinary docked preview: half the window beside the chat, or expanded over it.
    modal = expanded || !wide;
  useEffect(() => {
    document.body.style.setProperty('--preview-chat-width', chatWidth + 'px');
    try {
      localStorage.setItem('aelion-preview-chat-width', String(chatWidth));
    } catch {}
  }, [chatWidth]);
  useEffect(() => {
    onSessionChange?.({ items, index, expanded: modal });
    workbench?.update({
      scope: feedbackScope,
      itemId: item.id,
      name: item.name,
      docked: !modal,
      annotations,
    });
  }, [items, index, modal, feedbackScope?.kind, feedbackScope?.id, onSessionChange, workbench?.update, annotations]);
  const draft = edits.drafts[item.id],
    dirty = Boolean(draft && draftChanged(draft));
  if (previousSource.current !== draft?.content) {
    previousSource.current = draft?.content;
    sourceRevision.current++;
  }
  const sessionState = useRef({ items, index, expanded: modal });
  sessionState.current = { items, index, expanded: modal };
  const rememberAnnotations = useCallback(
    (value: Record<string, PreviewAnnotation[]>) => {
      annotationCache.current = { ...annotationCache.current, ...value };
      onSessionChange?.({ ...sessionState.current, annotationCache: annotationCache.current });
    },
    [onSessionChange],
  );
  // One segmented control replaces the old preview/edit/source buttons spread over two rows.
  // The page view unmounts while its source is open, which clears `web`. The item is still a page, so remember it:
  // otherwise the segments fall back to the plain-file set, which drops 源码 and relabels it 编辑.
  if (web) webItems.current.add(item.id);
  const page = Boolean(web) || webItems.current.has(item.id);
  const segments = [
    { key: 'preview', label: t('预览') },
    ...(page && item.editor ? [{ key: 'source', label: t('源码') }] : []),
    ...(page ? [{ key: 'edit', label: t('编辑') }] : item.editor ? [{ key: 'source', label: t('编辑') }] : []),
    { key: 'annotate', label: t('标注') },
  ];
  const segment = draft?.editing ? 'source' : mode === 'edit' ? 'edit' : mode === 'annotate' ? 'annotate' : 'preview';
  const toolsOpen = !draft?.editing && (mode === 'annotate' || (Boolean(web) && mode === 'edit'));
  const chooseSegment = (key: string) => {
    if (key === segment) return;
    if (key === 'source') {
      setMode('browse');
      request(() => void edits.edit(item));
      return;
    }
    if (draft?.editing) void edits.edit(item);
    setMode(key === 'edit' ? 'edit' : key === 'annotate' ? 'annotate' : 'browse');
    if (key === 'annotate' && !page && tool === 'element') setTool('rect');
  };
  const previewKindLabel = t(previewKind(item.name)),
    directoryBotId = item.workspace?.botId || item.directoryBotId;
  useEffect(
    () =>
      registerGuard?.((proceed) => {
        if (feedbackLock.current) afterFeedback.current = proceed;
        else request(proceed);
      }),
    [registerGuard, edits.request],
  );
  useEffect(() => {
    const media = matchMedia('(min-width:1000px)'),
      update = () => setWide(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      queueMicrotask(() => {
        if (!document.querySelector('.fp-panel') && previous.current?.isConnected)
          previous.current.focus({ preventScroll: true });
      });
    };
  }, []);
  useLayoutEffect(() => {
    if (modal && !panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
  }, [modal]);
  useLayoutEffect(() => {
    if (!modal && !edits.pending && !domPending) return;
    const root = document.getElementById('root'),
      current = panel.current;
    if (!root || !current) return;
    const changed = new Map<HTMLElement, boolean>(),
      disable = (node: HTMLElement) => {
        if (changed.has(node)) return;
        changed.set(node, node.inert);
        node.inert = true;
      };
    if (root.contains(current)) {
      let branch: HTMLElement | null = current;
      while (branch && branch !== root) {
        const parent: HTMLElement | null = branch.parentElement;
        if (!parent) break;
        for (const sibling of parent.children)
          if (sibling !== branch && sibling instanceof HTMLElement) disable(sibling);
        branch = parent;
      }
    } else disable(root);
    return () => {
      for (const [node, inert] of changed) node.inert = inert;
    };
  }, [modal, Boolean(edits.pending), Boolean(domPending)]);
  useEffect(() => {
    let live = true;
    const key = (event: KeyboardEvent) => {
      if (!(modal || panel.current?.contains(document.activeElement))) return;
      const historyAction = previewHistoryShortcut(event),
        editor = webRef.current;
      if (historyAction && editor?.state.mode === 'edit' && !previewTextInput(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!feedbackLock.current && !editor.busy && !domSaving && !domPending && !edits.pending)
          void editor.command({ type: historyAction }).catch((error) => setNotice(error.message));
        return;
      }
      if (
        feedbackLock.current &&
        (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.isComposing &&
        event.key.toLowerCase() === 's' &&
        editor?.state.mode === 'edit'
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || domPending || edits.pending || domSaving || feedbackLock.current) return;
        if (previewTextInput(event)) (document.activeElement as HTMLElement)?.blur();
        void (async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          for (let i = 0; i < 160 && live && webRef.current?.busy; i++)
            await new Promise((resolve) => setTimeout(resolve, 50));
          const latest = webRef.current;
          if (!live || latest === undefined || latest.state.mode !== 'edit' || latest.busy || feedbackLock.current)
            return;
          await latest.save();
        })();
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.isComposing &&
        event.key.toLowerCase() === 's' &&
        draft
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!edits.pending) void edits.save(item.id);
        return;
      }
      if (event.key === 'Escape') {
        if (
          document.querySelector(
            '.fp-export-menu:popover-open,.fp-open-menu:popover-open,.preview-picker-popover:popover-open',
          )
        )
          return;
        if (domPending) {
          event.preventDefault();
          if (!domSaving && !webRef.current?.busy) setDomPending(undefined);
          return;
        }
        if (document.querySelector('.fp-file-select:open')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (edits.pending) {
          if (!edits.saving) edits.cancel();
        } else if (mode === 'annotate') setMode('browse');
        else if (expanded && wide) setExpanded(false);
        else request(onClose);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      live = false;
      window.removeEventListener('keydown', key, true);
    };
  }, [modal, expanded, wide, mode, onClose, edits.pending, edits.saving, draft, domPending, domSaving, item.id]);
  const act = async (task: () => Promise<unknown>, success = '') => {
    setBusy(true);
    setNotice('');
    try {
      const result = await task();
      if (result !== null) setNotice(success);
    } catch (error) {
      setNotice(previewErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  const exportCanvas = async (format: CanvasExportFormat | 'original') => {
    if (exportInFlight.current) return;
    exportInFlight.current = true;
    const job = { format, name: item.name, itemId: item.id };
    setBusy(true);
    setNotice('');
    setExportState({ ...job, phase: 'running' });
    try {
      if (format === 'original') {
        if (!item.save) throw Error(l('当前文件无法导出', 'This file cannot be exported'));
        const result = await item.save();
        setExportState({
          ...job,
          phase: result === null ? 'cancelled' : 'success',
          detail: typeof result === 'string' ? result : undefined,
        });
        return;
      }
      const source = canvasDesignSource(item);
      if (!source) throw Error(l('此格式需要 HTML 设计作品', 'This format requires an HTML design'));
      const bounds =
        panel.current?.querySelector('.web-preview-slot')?.getBoundingClientRect() ||
        panel.current?.querySelector('.fp-content')?.getBoundingClientRect();
      const viewport = web?.state.viewport
        ? { width: web.state.viewport.width, height: web.state.viewport.height }
        : bounds
          ? { width: bounds.width, height: bounds.height }
          : undefined;
      const result = await window.aelion.exportDesignFile({ ...source, format, viewport });
      setExportState(
        result
          ? {
              ...job,
              phase: 'success',
              detail: result.path + (result.warnings.length ? ' · ' + result.warnings.join('；') : ''),
            }
          : { ...job, phase: 'cancelled' },
      );
    } catch (error) {
      setExportState({ ...job, phase: 'error', detail: previewErrorText(error) });
    } finally {
      exportInFlight.current = false;
      setBusy(false);
    }
  };
  const openPreviewFile = async (action: PreviewOpenAction | 'save') => {
    if (action === 'save') {
      await act(() => item.save!(), t('已保存'));
      return;
    }
    const target = previewOpenTarget(item);
    if (target) await act(() => window.aelion.openPreviewFile({ target, action }));
  };
  const select = (next: number) => {
    setIndex(next);
    setNotice('');
    if (!exportInFlight.current) setExportState(undefined);
    setRetry(0);
  };
  // Previous / next among the opened files, shown over images. Goes through `request` so unsaved edits are kept.
  const browsing = items.length > 1 && previewKind(item.name) === '图片' && !draft?.editing,
    step = (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < items.length) request(() => select(next));
    };
  return createPortal(
    <PreviewRuntimeContext.Provider
      value={{
        device: item.deviceFrame === 'phone' ? devicePreset : undefined,
        request,
        initialAnnotations: annotationCache.current['web:' + item.id],
        rememberAnnotations: (value) => rememberAnnotations({ ['web:' + item.id]: value }),
        mode,
        tool,
        setMode,
        setTool,
        web,
        setWeb,
        annotations,
        setFileAnnotations,
        sendEdits: async (changes) => {
          if (!feedbackSubmit.current) throw Error(t('请从会话中打开预览后发送修改'));
          await feedbackSubmit.current({
            text: t('请将预览中的修改应用到项目源码，保留原有功能并验证结果。'),
            edits: changes,
          });
          return true;
        },
        saved: (value) => edits.saved(item, value),
      }}
    >
      <PreviewLayoutContext.Provider value={true}>
        <div
          className={`fp-layer is-immersive ${modal ? 'is-expanded' : 'is-docked'} ${feedbackScope ? 'has-feedback' : ''} ${exportState ? 'has-export-status' : ''}`}
          data-device={item.deviceFrame || undefined}
          data-tools={toolsOpen ? 'on' : undefined}
          data-pair={item.deviceFrame === 'phone' && devicePreset.mirror ? 'on' : undefined}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && modal && !feedbackLock.current) request(onClose);
          }}
        >
          <section
            ref={panel}
            className="fp-panel"
            data-layout={modal ? 'expanded' : 'docked'}
            role={modal ? 'dialog' : 'region'}
            aria-modal={modal || undefined}
            aria-label={t('预览 {name}', { name: item.name })}
            tabIndex={-1}
            onKeyDown={(event) => {
              const target = event.target as HTMLElement;
              if (
                browsing &&
                (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
                !event.defaultPrevented &&
                !event.altKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !target.closest(
                  'input,textarea,select,[contenteditable],.cm-editor,[role="listbox"],[role="radiogroup"]',
                )
              ) {
                // A zoomed image that still scrolls sideways keeps the arrows for panning.
                const stage = target.closest<HTMLElement>('.fp-image-stage');
                const pans =
                  stage &&
                  (event.key === 'ArrowLeft'
                    ? stage.scrollLeft > 0
                    : stage.scrollLeft + stage.clientWidth < stage.scrollWidth - 1);
                if (!pans) {
                  event.preventDefault();
                  step(event.key === 'ArrowLeft' ? -1 : 1);
                  return;
                }
              }
              if (
                event.key !== 'Tab' ||
                !modal ||
                event.defaultPrevented ||
                (event.target as HTMLElement).closest('.cm-editor')
              )
                return;
              const controls = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),iframe,select:not(:disabled),[tabindex="0"],a[href]',
                ),
              ).filter((el) => el.getClientRects().length > 0);
              const at = controls.indexOf(document.activeElement as HTMLElement);
              if (event.shiftKey && at <= 0) {
                event.preventDefault();
                controls.at(-1)?.focus();
              } else if (!event.shiftKey && (at < 0 || at === controls.length - 1)) {
                event.preventDefault();
                controls[0]?.focus();
              }
            }}
          >
            {!modal && (
              <button
                className="fp-resize-handle"
                aria-label={t('调整对话宽度')}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    setChatWidth(Math.max(260, Math.min(innerWidth - 440, event.clientX)));
                }}
                onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    setChatWidth((width) =>
                      Math.max(260, Math.min(innerWidth - 440, width + (event.key === 'ArrowRight' ? 12 : -12))),
                    );
                  }
                }}
              />
            )}
            <header className="fp-header" inert={Boolean(edits.pending) || Boolean(domPending) || feedbackSending}>
              <div className="fp-title" title={previewKindLabel + ' · ' + fileSize(draft?.bytes ?? item.size)}>
                {items.length > 1 ? (
                  <PreviewPicker
                    className="fp-file-select"
                    label={t('选择预览文件')}
                    value={String(index)}
                    onChange={(value) => request(() => select(Number(value)))}
                    options={items.map((file, i) => ({
                      value: String(i),
                      label: file.name + (edits.drafts[file.id] && draftChanged(edits.drafts[file.id]) ? ' •' : ''),
                    }))}
                  />
                ) : (
                  <h2 title={item.name}>
                    {item.name}
                    {dirty && <span className="fp-edit-dirty" aria-label={t('未保存')} />}
                  </h2>
                )}
              </div>
              <div className="fp-web-navigation-slot" />
              <div className="fp-file-controls-slot" />
              {item.deviceFrame === 'phone' && (
                <PreviewPicker
                  className="fp-device-select"
                  label={t('预览设备')}
                  value={devicePreset.id}
                  onChange={chooseDevice}
                  options={PREVIEW_DEVICE_PRESETS.map((preset) => ({ value: preset.id, label: t(preset.label) }))}
                />
              )}
              <div className="fp-mode" role="radiogroup" aria-label={t('预览方式')}>
                {segments.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="radio"
                    aria-checked={segment === option.key}
                    disabled={option.key === 'source' && (draft?.loading || edits.saving)}
                    onClick={() => chooseSegment(option.key)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="fp-tools fp-actions">
                <button
                  aria-label={directoryOpen ? t('收起文件目录') : t('显示文件目录')}
                  title={t('文件目录')}
                  aria-pressed={directoryOpen}
                  onClick={() => setDirectoryOpen((v) => !v)}
                >
                  <PreviewIcon name="pages" />
                </button>
                <button
                  className="fp-reload"
                  onClick={() =>
                    request(() => {
                      edits.drop(item.id);
                      setRetry((value) => value + 1);
                    }, [item.id])
                  }
                  disabled={busy || edits.saving}
                  aria-label={t('重新加载')}
                  title={t('重新加载')}
                >
                  <PreviewIcon name="refresh" />
                </button>
                {item.designSessionId && canvasDesignSource(item) ? (
                  <CanvasExportMenu
                    name={item.name}
                    rich
                    exporting={exportState?.phase === 'running'}
                    disabled={busy || edits.saving || Boolean(web?.busy) || domSaving}
                    onExport={(format) => request(() => void exportCanvas(format))}
                  />
                ) : (
                  (item.save || previewOpenTarget(item)) && (
                    <PreviewOpenMenu
                      canOpen={Boolean(previewOpenTarget(item))}
                      canSave={Boolean(item.save)}
                      disabled={busy || edits.saving || Boolean(web?.busy) || domSaving}
                      onAction={(action) => request(() => void openPreviewFile(action))}
                    />
                  )
                )}
                <span className="fp-action-divider" />
                {wide && (
                  <button
                    aria-label={expanded ? t('收回侧栏') : t('展开画布')}
                    title={expanded ? t('收回侧栏') : t('展开画布')}
                    onClick={() => setExpanded(!expanded)}
                  >
                    <PreviewIcon name={expanded ? 'dock' : 'expand'} />
                  </button>
                )}
                <button aria-label={t('关闭预览')} title={t('关闭预览')} onClick={() => request(onClose)}>
                  <PreviewIcon name="close" />
                </button>
              </div>
            </header>

            {toolsOpen && (
              <div
                className="fp-workbench-tools"
                data-tools={mode}
                inert={Boolean(edits.pending) || Boolean(domPending) || feedbackSending}
              >
                {mode === 'annotate' && (
                  <div className="fp-tool-group">
                    {(['rect', ...(web ? ['element'] : [])] as AnnotationTool[]).map((type) => (
                      <button
                        key={type}
                        aria-pressed={mode === 'annotate' && tool === type}
                        onClick={() => {
                          setMode('annotate');
                          setTool(type);
                        }}
                      >
                        <PreviewIcon name={type === 'rect' ? 'rect' : 'comment'} />
                        {type === 'rect' ? l('圈选', 'Region') : l('元素', 'Element')}
                      </button>
                    ))}
                  </div>
                )}
                {mode === 'annotate' && (
                  <div className="fp-tool-group" role="group" aria-label={l('标记工具', 'Markup tools')}>
                    {(['arrow', 'pen', 'text'] as const).map((type) => (
                      <button
                        key={type}
                        aria-pressed={mode === 'annotate' && tool === type}
                        title={l(
                          { arrow: '箭头', pen: '画笔', text: '文字标注' }[type],
                          { arrow: 'Arrow', pen: 'Pen', text: 'Text note' }[type],
                        )}
                        aria-label={l(
                          { arrow: '箭头', pen: '画笔', text: '文字标注' }[type],
                          { arrow: 'Arrow', pen: 'Pen', text: 'Text note' }[type],
                        )}
                        onClick={() => {
                          setMode('annotate');
                          setTool(type);
                        }}
                      >
                        <PreviewIcon name={{ arrow: 'arrow', pen: 'edit', text: 'text' }[type]} />
                      </button>
                    ))}
                  </div>
                )}
                {mode === 'annotate' && (
                  <div className="fp-tool-group">
                    <button
                      disabled={web ? !web.state.annotationCanUndo : !annotations.length}
                      title={t('撤销标注')}
                      aria-label={t('撤销标注')}
                      onClick={() => {
                        if (web)
                          void web.command({ type: 'annotation-undo' }).catch((error) => setNotice(error.message));
                        else void setAnnotations(annotations.slice(0, -1));
                      }}
                    >
                      <PreviewIcon name="left" />
                    </button>
                    {web && (
                      <button
                        disabled={!web.state.annotationCanRedo}
                        title={l('重做标注', 'Redo annotation')}
                        aria-label={l('重做标注', 'Redo annotation')}
                        onClick={() =>
                          void web.command({ type: 'annotation-redo' }).catch((error) => setNotice(error.message))
                        }
                      >
                        <PreviewIcon name="right" />
                      </button>
                    )}
                  </div>
                )}
                {web && mode === 'edit' && (
                  <div className="fp-tool-group">
                    <button onClick={() => web.inspect()}>
                      <PreviewIcon name="pages" />
                      {t('结构')}
                    </button>
                    <button
                      disabled={web.busy || !web.state.canUndo}
                      title={t('撤销') + ' (Ctrl+Z)'}
                      aria-label={t('撤销')}
                      onClick={() => void web.command({ type: 'undo' }).catch((e) => setNotice(e.message))}
                    >
                      <PreviewIcon name="left" />
                    </button>
                    <button
                      disabled={web.busy || !web.state.canRedo}
                      title={t('重做') + ' (Ctrl+Shift+Z)'}
                      aria-label={t('重做')}
                      onClick={() => void web.command({ type: 'redo' }).catch((e) => setNotice(e.message))}
                    >
                      <PreviewIcon name="right" />
                    </button>
                    <button
                      className="fp-save-dom"
                      title={web.primaryLabel + ' (Ctrl+S)'}
                      disabled={!web.state.dirty || web.busy}
                      onClick={() => void web.save()}
                    >
                      {web.primaryLabel}
                    </button>
                  </div>
                )}
              </div>
            )}
            {exportState && (
              <CanvasExportStatus
                state={exportState}
                onDismiss={() => setExportState(undefined)}
                onRetry={
                  exportState.itemId === item.id
                    ? () => request(() => void exportCanvas(exportState.format))
                    : undefined
                }
              />
            )}
            <div className="fp-workspace" inert={Boolean(edits.pending) || Boolean(domPending) || feedbackSending}>
              {directoryOpen && (
                <aside className="fp-directory" aria-label={t('文件目录')}>
                  {directoryBotId ? (
                    <WorkspaceFileTree
                      botId={directoryBotId}
                      activePath={item.workspace?.path || ''}
                      onOpen={(file) => {
                        const root = item.workspace?.path.match(/^(designers\/[^/]+\/[^/]+)\//)?.[1],
                          next = {
                            ...workspacePreviewItem(directoryBotId, file),
                            ...(root && file.path.startsWith(root + '/')
                              ? { designSessionId: item.designSessionId }
                              : {}),
                          },
                          existing = items.findIndex((value) => value.id === next.id);
                        if (existing >= 0) select(existing);
                        else {
                          setItems([...items, next]);
                          select(items.length);
                        }
                        if (!matchMedia('(min-width:700px)').matches) setDirectoryOpen(false);
                      }}
                    />
                  ) : (
                    <>
                      <div className="wft-state">{t('本次文件')}</div>
                      {items.map((file, i) => (
                        <button
                          key={file.id}
                          className="fp-session-file"
                          aria-current={i === index ? 'page' : undefined}
                          onClick={() => select(i)}
                        >
                          {file.name}
                        </button>
                      ))}
                    </>
                  )}
                </aside>
              )}
              <div className={`fp-content ${draft ? 'has-editor-session' : ''}`}>
                {draft?.editing ? (
                  draft.loading ? (
                    <div className="fp-state" role="status">
                      {t('正在读取完整文件…')}
                    </div>
                  ) : draft.revision ? (
                    <Suspense fallback={<div className="fp-state">{t('正在打开编辑器…')}</div>}>
                      <SourceEditor
                        key={item.id}
                        name={item.name}
                        content={draft.content}
                        lineSeparator={draft.lineSeparator}
                        readOnly={draft.saving}
                        onChange={(text) => edits.change(item.id, text)}
                        onSave={() => void edits.save(item.id)}
                      />
                    </Suspense>
                  ) : (
                    <div className="fp-state" role="alert">
                      {draft.error}
                    </div>
                  )
                ) : (
                  <PreviewContent
                    key={item.id}
                    item={item}
                    retry={retry}
                    override={draft ? editedPreview(item.name, draft) : undefined}
                  />
                )}
                {browsing && (
                  <div className="fp-gallery" inert={Boolean(edits.pending) || feedbackSending}>
                    <button
                      type="button"
                      className="fp-gallery-step is-previous"
                      aria-label={t('上一张')}
                      title={t('上一张') + ' (←)'}
                      disabled={index === 0}
                      onClick={() => step(-1)}
                    >
                      <PreviewIcon name="left" />
                    </button>
                    <button
                      type="button"
                      className="fp-gallery-step is-next"
                      aria-label={t('下一张')}
                      title={t('下一张') + ' (→)'}
                      disabled={index === items.length - 1}
                      onClick={() => step(1)}
                    >
                      <PreviewIcon name="right" />
                    </button>
                    <span className="fp-gallery-count" aria-live="polite">
                      {index + 1} / {items.length}
                    </span>
                  </div>
                )}
                <FileAnnotationLayer
                  initialCache={annotationCache.current}
                  onCacheChange={rememberAnnotations}
                  itemId={item.id}
                  revision={String(retry) + ':' + sourceRevision.current}
                  mode={mode}
                  tool={tool}
                  onChange={setFileAnnotations}
                  register={registerFileAnnotations}
                  selectedAnnotationId={selectedAnnotationId}
                  onSelectAnnotation={selectAnnotation}
                />
                {/* Source-editing controls. A page saved from 编辑 also leaves a clean draft behind; it needs no
                    second save button in the header, so the group shows only with the source open or unsaved. */}
                {draft && !draft.loading && draft.revision && (draft.editing || dirty) && (
                  <PreviewToolbar editing>
                    <span className="fp-edit-indicator">
                      {draft.saving ? t('保存中…') : dirty ? t('未保存修改') : t('已保存')}
                    </span>
                    <button disabled={draft.saving} onClick={() => void edits.save(item.id, true)}>
                      {t('另存为')}
                    </button>
                    {item.editor?.write && (
                      <button
                        className="fp-edit-save"
                        disabled={!dirty || draft.saving}
                        onClick={() => void edits.save(item.id)}
                      >
                        {t('保存修改')}
                      </button>
                    )}
                  </PreviewToolbar>
                )}
                {draft?.error && draft.revision && (
                  <div className="fp-edit-banner" role="alert">
                    {draft.error}
                  </div>
                )}
              </div>
            </div>
            {(notice || edits.notice) && (
              <div className="fp-notice" role="status">
                {notice || edits.notice}
              </div>
            )}
            {feedbackScope && (
              <div inert={Boolean(edits.pending)}>
                <PreviewFeedback
                  scope={feedbackScope}
                  item={item}
                  panel={panel}
                  unsaved={dirty || Boolean(web?.state.dirty)}
                  annotations={annotations}
                  selectedAnnotationId={selectedAnnotationId}
                  onSelectAnnotation={selectAnnotation}
                  onAnnotationsChange={setAnnotations}
                  focusRequest={feedbackFocus}
                  captureState={captureAnnotations}
                  registerSend={registerFeedbackSend}
                  composer={modal}
                  onBusy={(value) => {
                    feedbackLock.current = value;
                    setFeedbackSending(value);
                    if (!value && afterFeedback.current) {
                      const next = afterFeedback.current;
                      afterFeedback.current = undefined;
                      request(next);
                    }
                  }}
                />
              </div>
            )}
            {domPending && (
              <UnsavedDialog
                saveLabel={web?.saveLabel}
                count={1}
                saving={domSaving || Boolean(web?.busy)}
                error={domGuardError}
                onCancel={() => setDomPending(undefined)}
                onDiscard={() => {
                  void webRef.current
                    ?.discard()
                    .then(() => {
                      const proceed = domPending;
                      setDomPending(undefined);
                      proceed();
                    })
                    .catch((e) => setDomGuardError(e.message));
                }}
                onSave={() => {
                  setDomSaving(true);
                  void webRef.current
                    ?.save()
                    .then((saved) => {
                      if (saved) {
                        const proceed = domPending;
                        setDomPending(undefined);
                        proceed();
                      } else setDomGuardError(t('修改尚未保存，可以继续编辑或发送给 Bot。'));
                    })
                    .catch((e) => setDomGuardError(e.message))
                    .finally(() => setDomSaving(false));
                }}
              />
            )}
            {edits.pending && (
              <UnsavedDialog
                count={edits.pending.ids.length}
                saving={edits.saving}
                error={edits.guardError}
                onCancel={edits.cancel}
                onDiscard={edits.discardAndContinue}
                onSave={() => void edits.saveAndContinue()}
              />
            )}
          </section>
        </div>
      </PreviewLayoutContext.Provider>
    </PreviewRuntimeContext.Provider>,
    document.body,
  );
}
