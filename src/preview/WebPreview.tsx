import { observePreviewModal, previewBlockedByModal } from './preview-modal';
import { WebElementInspector } from './WebElementInspector';
import { usePreviewRuntime } from './preview-runtime';
import type { EditorCommand, PreviewEditorState } from '../../shared/types/preview-editor-types';
import type { PreviewItem } from './FilePreviewContext';
import type { EditableText } from '../../shared/chat/editable-text';
import { createPortal, flushSync } from 'react-dom';
import { PreviewMenuTransition, previewSurfacePaint } from './preview-menu-transition';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PreviewIcon } from './PreviewIcon';
import { PreviewToolbar } from './PreviewToolbar';
import { PreviewPicker } from './PreviewPicker';
import { feedbackWebUrl, type WebPreviewSource, type WebPreviewState } from '../../shared/preview/web-preview';
import { useI18n } from '../i18n';
import './web-preview.css';
import {
  previewDeviceCaption,
  type PreviewDevice,
  type PreviewDevicePreset,
} from '../../shared/preview/preview-devices';

/** Device sizes as CSS variables; frames scale down together to fit the stage. */
const deviceStyle = (preset: PreviewDevicePreset) =>
  ({
    '--device-w': preset.primary.width,
    '--device-h': preset.primary.height,
    '--mirror-w': (preset.mirror || preset.primary).width,
    '--mirror-h': (preset.mirror || preset.primary).height,
    // Totals used to fit both frames at one scale: widths plus the gap, and the taller height.
    '--devices-w-num': preset.primary.width + (preset.mirror ? preset.mirror.width + 48 : 0),
    '--devices-h-num': Math.max(preset.primary.height, preset.mirror?.height || 0) + 38,
  }) as React.CSSProperties;

/** The slot is a native browser surface. Keep app controls outside its rectangle. */
export function WebPreview({
  source,
  onSource,
  fileEditor,
  editorContent,
}: {
  source: WebPreviewSource;
  onSource?: () => void;
  fileEditor?: PreviewItem['editor'];
  editorContent?: string;
}) {
  const { t } = useI18n();
  const runtime = usePreviewRuntime(),
    runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const [editorState, setEditorState] = useState<PreviewEditorState>(),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [inspecting, setInspecting] = useState(false),
    [frozen, setFrozen] = useState<string>();
  const saveLock = useRef(false),
    restoredMarks = useRef(false),
    restoringMarks = useRef(false);
  const [inspectorTab, setInspectorTab] = useState<'style' | 'attrs' | 'html' | 'tree'>('style');
  const stateRef = useRef(editorState),
    base = useRef<EditableText | undefined>(undefined);
  stateRef.current = editorState;
  const id = useRef(crypto.randomUUID()),
    slot = useRef<HTMLDivElement>(null),
    mirrorSlot = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<WebPreviewState>(),
    [error, setError] = useState(''),
    [address, setAddress] = useState('');
  const sourceKey = JSON.stringify(source),
    isUrl = source.kind === 'url' || Boolean(state?.url.match(/^https?:/)),
    pageEditor = state?.localDocument === false ? undefined : fileEditor;
  const [navigationHost, setNavigationHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setNavigationHost(
      slot.current?.closest('.fp-panel')?.querySelector<HTMLElement>('.fp-web-navigation-slot') || null,
    );
  }, []);
  useEffect(() => {
    let disposed = false,
      ready = false,
      frame = 0;
    const currentId = crypto.randomUUID();
    id.current = currentId;
    setError('');
    setState(undefined);
    setEditorState(undefined);
    setReady(false);
    setInspecting(false);
    setFrozen(undefined);
    base.current = undefined;
    restoredMarks.current = false;
    restoringMarks.current = false;
    const update = (next: WebPreviewState) => {
      if (!disposed && next.id === currentId) {
        if (next.loading) {
          base.current = undefined;
          setEditorState(undefined);
          stateRef.current = undefined;
        }
        setState(next);
      }
    };
    const offSave = window.aelion.onPreviewSave?.((value) => {
      if (value === currentId && !disposed && runtimeRef.current?.mode === 'edit' && !runtimeRef.current.web?.busy)
        void runtimeRef.current.web?.save();
    });
    const offEditor = window.aelion.onPreviewEditor?.((event) => {
      if (event.id === currentId && !disposed) {
        setEditorState((current) => (current && current.revision > event.state.revision ? current : event.state));
        if (event.state.error) setError(event.state.error);
      }
    });
    const off = window.aelion.onWebPreview(update),
      escape = window.aelion.onWebPreviewEscape((value) => {
        if (value === currentId) {
          slot.current?.closest<HTMLElement>('.fp-panel')?.focus();
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
      });
    let mirrorShown = false,
      schemeKey = '';
    const observed = new Set<Element>();
    const layout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const node = slot.current;
        if (!node || !ready || disposed) return;
        const rect = node.getBoundingClientRect(),
          layer = node.closest<HTMLElement>('.fp-layer');
        const capture = layer?.dataset.feedbackCapture === 'true';
        const externalModal = previewBlockedByModal();
        const blocked =
          externalModal ||
          Boolean(layer?.querySelector('.fp-unsaved-backdrop')) ||
          (innerWidth <= 700 && Boolean(layer?.querySelector('.fp-directory'))) ||
          (Boolean(node.closest('[inert]')) && !capture);
        const shown = !blocked && document.visibilityState !== 'hidden';
        void window.aelion
          .layoutWebPreview({
            id: currentId,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            visible: shown,
          })
          .catch(() => {});
        // The second device is a separate read-only view placed over its own slot.
        const mirrorNode = mirrorSlot.current;
        if (mirrorNode) {
          if (!observed.has(mirrorNode)) {
            observed.add(mirrorNode);
            resize.observe(mirrorNode);
          }
          const m = mirrorNode.getBoundingClientRect();
          mirrorShown = true;
          void window.aelion
            .layoutWebPreviewMirror({
              id: currentId,
              rect: { x: m.x, y: m.y, width: m.width, height: m.height },
              visible: shown,
            })
            .catch(() => {});
        } else if (mirrorShown) {
          mirrorShown = false;
          void window.aelion.layoutWebPreviewMirror({ id: currentId, rect: null, visible: false }).catch(() => {});
        }
        const device = runtimeRef.current?.device,
          key = [device?.primary.scheme || '', device?.mirror?.scheme || '', mirrorNode ? 1 : 0].join('|');
        if (key !== schemeKey) {
          schemeKey = key;
          void window.aelion
            .webPreviewAppearance({ id: currentId, primary: device?.primary.scheme, mirror: device?.mirror?.scheme })
            .catch(() => {});
        }
      });
    };
    const resize = new ResizeObserver(layout),
      mutations = new MutationObserver(layout),
      node = slot.current;
    if (node) {
      resize.observe(node);
      const layer = node.closest('.fp-layer');
      if (layer)
        mutations.observe(layer, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'inert', 'data-feedback-capture', 'data-pair'],
        });
    }
    const stopObservingModal = observePreviewModal(layout);
    window.addEventListener('resize', layout);
    document.addEventListener('visibilitychange', layout);
    void window.aelion
      .openWebPreview({ id: currentId, source: JSON.parse(sourceKey) })
      .then((next) => {
        if (!disposed) {
          ready = true;
          setReady(true);
          update(next);
          layout();
        }
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason.message || reason));
      });
    return () => {
      disposed = true;
      offSave?.();
      offEditor?.();
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      stopObservingModal();
      off();
      escape();
      window.removeEventListener('resize', layout);
      document.removeEventListener('visibilitychange', layout);
      void window.aelion.closeWebPreview(currentId).catch(() => {});
    };
  }, [sourceKey]);
  useEffect(() => {
    setAddress(state?.url || (source.kind === 'url' ? source.url : source.name));
  }, [state?.url, sourceKey]);
  const action = async (action: 'back' | 'forward' | 'reload' | 'navigate', url?: string) => {
    setError('');
    try {
      setState(await window.aelion.webPreviewAction({ id: id.current, action, url }));
    } catch (reason) {
      setError(String((reason as Error).message));
    }
  };

  const command = useCallback(async (value: EditorCommand) => {
    const targetId = stateRef.current?.selected?.id;
    const result = await window.aelion.previewEditorCommand({
      id: id.current,
      command: {
        ...value,
        ...(['style', 'css', 'attributes', 'text', 'html'].includes(value.type) ? { targetId } : {}),
      },
    });
    setEditorState((current) => (current && current.revision > result.state.revision ? current : result.state));
    return result;
  }, []);
  const readBase = async () => {
    if (!pageEditor) return undefined;
    if (!base.current) {
      const value = await pageEditor.read();
      base.current = { ...value, ...(editorContent !== undefined ? { content: editorContent } : {}) };
    }
    return base.current;
  };
  const sendChanges = async () => {
    if (saveLock.current) return false;
    saveLock.current = true;
    setBusy(true);
    try {
      await command({ type: 'lock', locked: true });
      const result = await command({ type: 'export' });
      if (!result.edits?.length) return true;
      const sent = await runtimeRef.current?.sendEdits(result.edits);
      if (sent) await command({ type: 'commit' });
      return Boolean(sent);
    } catch (error) {
      setError((error as Error).message);
      return false;
    } finally {
      await command({ type: 'lock', locked: false }).catch(() => {});
      setBusy(false);
      saveLock.current = false;
    }
  };
  const save = async () => {
    if (!pageEditor) return sendChanges();
    if (saveLock.current) return false;
    saveLock.current = true;
    setBusy(true);
    try {
      await command({ type: 'lock', locked: true });
      const original = await readBase();
      if (!original) throw Error(t('源文件不可用'));
      const result = await command({ type: 'export' });
      if (!result.edits?.length) return true;
      const content = await window.aelion.patchPreviewHtml({ content: original.content, edits: result.edits });
      if (pageEditor.write) {
        const saved = await pageEditor.write({ content, revision: original.revision });
        base.current = saved;
        await command({ type: 'commit' });
        runtimeRef.current?.saved(saved);
      } else {
        const path = await window.aelion.exportEditedText({
          name: source.kind === 'document' ? source.name : 'page.html',
          content,
        });
        if (!path) return false;
        base.current = { ...original, content };
        await command({ type: 'commit' });
      }
      setError('');
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    } finally {
      await command({ type: 'lock', locked: false }).catch(() => {});
      setBusy(false);
      saveLock.current = false;
    }
  };
  useEffect(() => {
    if (!ready || state?.loading || !runtime) return;
    let disposed = false;
    void (async () => {
      if (runtime.mode === 'edit') {
        await readBase();
        if (disposed) return;
      } else setInspecting(false);
      await command({ type: 'mode', mode: runtime.mode, tool: runtime.tool });
    })().catch((error) => setError(error.message));
    return () => {
      disposed = true;
    };
  }, [ready, state?.loading, runtime?.mode, runtime?.tool, command]);
  useEffect(() => {
    if (!ready || state?.loading || !editorState || !runtime) return;
    runtime.setWeb({
      state: editorState,
      command,
      save,
      discard: async () => {
        if (saveLock.current) throw Error(t('正在保存，请稍候'));
        try {
          await command({ type: 'cancel' });
        } catch {
          await command({ type: 'reset' });
          restoredMarks.current = false;
          restoringMarks.current = false;
          await window.aelion.webPreviewAction({ id: id.current, action: 'reload' });
        }
        runtimeRef.current?.setMode('browse');
      },
      sendChanges,
      busy,
      canWrite: Boolean(pageEditor?.write),
      inspect: () => {
        setInspectorTab('tree');
        setInspecting(true);
        if (runtimeRef.current?.mode === 'edit' && stateRef.current?.mode !== 'edit')
          void readBase()
            .then(() => command({ type: 'mode', mode: 'edit' }))
            .catch((e) => setError(e.message));
      },
      primaryLabel: pageEditor ? (pageEditor.write ? t('保存修改') : t('另存为')) : t('发送修改'),
      saveLabel: pageEditor ? (pageEditor.write ? t('保存并继续') : t('另存为并继续')) : t('发送修改并继续'),
    });
    return () => runtime.setWeb(undefined);
  }, [ready, state?.loading, state?.localDocument, editorState, command, fileEditor, busy]);
  useEffect(() => {
    const currentId = id.current;
    const transition = new PreviewMenuTransition({
      capture: () => window.aelion.captureWebPreviewMenu({ id: currentId }),
      present: async (image, current) => {
        const decoded = new Image();
        decoded.src = image;
        await decoded.decode();
        if (!current()) return;
        flushSync(() => setFrozen(image));
        await previewSurfacePaint();
      },
      hide: (revision) => window.aelion.freezeWebPreview({ id: currentId, frozen: true, revision }),
      restore: () => window.aelion.freezeWebPreview({ id: currentId, frozen: false }),
      painted: previewSurfacePaint,
      clear: () => setFrozen(undefined),
    });
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!ready || !window.aelion.captureWebPreviewMenu) {
        detail.done();
        return;
      }
      void transition
        .change(detail.open)
        .then(() => detail.done())
        .catch(() => detail.done());
    };
    window.addEventListener('aelion-preview-menu', listener);
    return () => {
      transition.dispose();
      window.removeEventListener('aelion-preview-menu', listener);
    };
  }, [ready, sourceKey]);

  useEffect(() => {
    if (runtime?.mode === 'edit' && editorState?.selected) {
      if (!inspecting) setInspectorTab('style');
      setInspecting(true);
    }
  }, [editorState?.selected?.id, runtime?.mode]);
  useEffect(() => {
    if (!ready || state?.loading || !editorState || restoredMarks.current || restoringMarks.current) return;
    let live = true;
    restoringMarks.current = true;
    const initial = runtimeRef.current?.initialAnnotations || [];
    void command({ type: 'annotations', annotations: initial })
      .then((result) => {
        if (!live) return;
        restoringMarks.current = false;
        restoredMarks.current = true;
        runtimeRef.current?.rememberAnnotations(result.state.annotations);
        setEditorState(result.state);
      })
      .catch((error) => {
        if (live) {
          restoringMarks.current = false;
          setError(error.message);
        }
      });
    return () => {
      live = false;
    };
  }, [ready, state?.loading, Boolean(editorState)]);
  useEffect(() => {
    if (restoredMarks.current && !restoringMarks.current && editorState)
      runtimeRef.current?.rememberAnnotations(editorState.annotations);
  }, [editorState?.annotations]);
  useEffect(() => {
    if (error && (editorState?.dirty || runtime?.mode === 'edit')) setInspecting(true);
  }, [error, editorState?.dirty, runtime?.mode]);
  const navigation = (
    <form
      className="web-preview-nav"
      onSubmit={(event) => {
        event.preventDefault();
        if (isUrl) void action('navigate', address);
      }}
    >
      <button type="button" disabled={!state?.canBack} onClick={() => void action('back')} aria-label={t('后退')}>
        <PreviewIcon name="left" />
      </button>
      <button type="button" disabled={!state?.canForward} onClick={() => void action('forward')} aria-label={t('前进')}>
        <PreviewIcon name="right" />
      </button>
      <button type="button" disabled={!state} onClick={() => void action('reload')} aria-label={t('刷新网页')}>
        <PreviewIcon name="refresh" />
      </button>
      {isUrl ? (
        <input
          aria-label={t('网页地址')}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          spellCheck={false}
          onFocus={(event) => event.target.select()}
        />
      ) : (
        <span className="web-preview-document">{state?.url || (source.kind === 'document' ? source.name : '')}</span>
      )}
      {error && state && (
        <output className="web-preview-error" role="alert" title={error}>
          {error}
        </output>
      )}
      {state?.loading && <span className="web-preview-loading" role="status" aria-label={t('正在加载')} />}
      {onSource && (
        <button
          type="button"
          onClick={() => (runtime ? runtime.request(onSource) : onSource())}
          aria-label={t('查看源码')}
        >
          <PreviewIcon name="code" />
        </button>
      )}
    </form>
  );
  const device = runtime?.device;
  const framed = (node: React.ReactNode, spec?: PreviewDevice) =>
    spec ? (
      <div className="web-preview-device">
        {node}
        <span className="web-preview-device-caption">{previewDeviceCaption(spec, t('深色'), t('浅色'))}</span>
      </div>
    ) : (
      node
    );
  return (
    <div
      className="web-preview"
      data-preview-local-document={state?.localDocument === false ? 'false' : undefined}
      data-preview-name={state?.localDocument === false ? state.title || state.url : undefined}
      data-preview-url={
        /^https?:/.test(state?.url || '')
          ? feedbackWebUrl(state!.url)
          : source.kind === 'url'
            ? feedbackWebUrl(source.url)
            : undefined
      }
    >
      <PreviewToolbar>
        <div className="fp-tools">
          <button
            type="button"
            disabled={!state || (state.zoomFactor || 1) <= 0.25}
            aria-label={t('缩小画布')}
            onClick={() =>
              void window.aelion
                .webPreviewAction({
                  id: id.current,
                  action: 'zoom',
                  factor: Math.max(0.25, (state?.zoomFactor || 1) - 0.25),
                })
                .then(setState)
                .catch((error) => setError(error.message))
            }
          >
            <PreviewIcon name="minus" />
          </button>
          <PreviewPicker
            className="fp-zoom-picker"
            label={t('画布显示比例')}
            value={String(Math.round((state?.zoomFactor || 1) * 100))}
            disabled={!state}
            options={[25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300].map((value) => ({
              value: String(value),
              label: value + '%' + (value === 100 ? ' · ' + t('默认') : ''),
            }))}
            onChange={(value) =>
              void window.aelion
                .webPreviewAction({ id: id.current, action: 'zoom', factor: Number(value) / 100 })
                .then(setState)
                .catch((error) => setError(error.message))
            }
          />
          <button
            type="button"
            disabled={!state || (state.zoomFactor || 1) >= 3}
            aria-label={t('放大画布')}
            onClick={() =>
              void window.aelion
                .webPreviewAction({
                  id: id.current,
                  action: 'zoom',
                  factor: Math.min(3, (state?.zoomFactor || 1) + 0.25),
                })
                .then(setState)
                .catch((error) => setError(error.message))
            }
          >
            <PreviewIcon name="plus" />
          </button>
        </div>
      </PreviewToolbar>
      {navigationHost ? createPortal(navigation, navigationHost) : navigation}
      <div
        className="web-preview-surface"
        data-devices={device ? (device.mirror ? 2 : 1) : undefined}
        style={device ? deviceStyle(device) : undefined}
      >
        {framed(
          <div ref={slot} className="web-preview-slot" tabIndex={0} aria-label={t('网页预览')}>
            {frozen && <img className="web-preview-frozen" src={frozen} alt="" />}
            {error || state?.error ? (
              <div className="fp-state" role="alert">
                <strong>{t('暂时无法打开网页')}</strong>
                <p>{error || state?.error}</p>
              </div>
            ) : (
              !state && (
                <div className="fp-state" role="status">
                  <span className="fp-loading" />
                  <strong>{t('正在连接')}</strong>
                </div>
              )
            )}
          </div>,
          device?.primary,
        )}
        {device?.mirror &&
          framed(
            <div ref={mirrorSlot} className="web-preview-slot web-preview-mirror" aria-hidden="true" />,
            device.mirror,
          )}
        {inspecting && (
          <WebElementInspector
            errorMessage={error}
            onSendChanges={editorState?.dirty ? () => void sendChanges() : undefined}
            initialTab={inspectorTab}
            selected={editorState?.selected}
            command={async (value) => {
              setBusy(true);
              try {
                return await command(value);
              } finally {
                setBusy(false);
              }
            }}
            busy={busy}
            onClose={() => setInspecting(false)}
          />
        )}
      </div>
    </div>
  );
}
