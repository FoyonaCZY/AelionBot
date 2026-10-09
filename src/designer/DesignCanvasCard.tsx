import { useEffect, useState } from 'react';
import type { RunRecord } from '../../shared/types/core';
import type { DesignSession } from '../../shared/types/designer-types';
import { pickDesignPreviewFiles, type DesignWorkspaceFile } from '../../shared/preview/designer-canvas';
import { useFilePreview } from '../preview/FilePreviewContext';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import { kindCardLabel, statusLabel } from './DesignerTaskCard';
import { closeActiveDesign, type CanvasScope } from './design-canvas-state';
import { openDesignCanvas, useDesignCanvasSync } from './design-canvas-preview';
import './design-styles';

/**
 * The first screen of a task page, rendered by the main process. `version` changes when the page file does; the
 * previous picture stays until the new one arrives, and a page without one (a PPTX, a failed render) shows none.
 */
function useDesignThumbnail(taskId: string, page: DesignWorkspaceFile | undefined) {
  const [image, setImage] = useState<string>();
  const path = page?.path,
    version = page ? page.size + ':' + (page.modifiedAt || '') : '';
  useEffect(() => {
    if (!path) {
      setImage(undefined);
      return;
    }
    let live = true;
    window.aelion
      .designThumbnail({ id: taskId, path })
      .then((result) => live && setImage(result?.dataUrl))
      .catch(() => live && setImage(undefined));
    return () => {
      live = false;
    };
  }, [taskId, path, version]);
  return image;
}

/**
 * The design card under the computer card: a picture of the home page, the title and one status line. A design is
 * one piece of work, so no file names: clicking the picture opens the home page beside the chat, other pages are
 * reached from inside it, and files are exported from the preview.
 */
export function DesignCanvasCard({
  scope,
  task,
  runs,
}: {
  scope: CanvasScope;
  task: DesignSession;
  runs: RunRecord[];
}) {
  const { t, language } = useI18n(),
    en = language === 'en';
  const open = useFilePreview(),
    workbench = usePreviewWorkbench();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const running = Boolean(
    task.activeRunId || runs.some((r) => r.status === 'running' && r.designSessionId === task.id),
  );
  const files = useDesignCanvasSync(task, running, workbench?.info?.itemId, open);
  const home = pickDesignPreviewFiles(task.kind, files, task.artifacts)[0];
  const thumbnail = useDesignThumbnail(task.id, home);
  const showing = Boolean(
    workbench?.info?.docked && workbench.info.itemId?.startsWith(`artifact:${task.botId}:${task.workspacePath}/`),
  );
  const canAccept =
    !running &&
    task.status === 'review' &&
    task.artifacts.length > 0 &&
    task.checks.find((check) => check.id === 'format')?.status === 'passed';
  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(ipcErrorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const show = () =>
    void act(async () => {
      if (!(await openDesignCanvas(task, open))) setError(t('还没有可以显示的页面，Bot 写入文件后会自动出现。'));
    });
  return (
    <section className="design-canvas-card" aria-label={t('设计画布：{title}', { title: task.title })}>
      <button
        type="button"
        className="design-canvas-stage"
        data-kind={task.kind}
        data-thumbnail={thumbnail ? '' : undefined}
        data-running={running || undefined}
        aria-label={showing ? t('画布已在右侧打开') : t('在右侧打开画布')}
        title={showing ? t('画布已在右侧打开') : t('在右侧打开画布')}
        disabled={busy}
        onClick={show}
      >
        {thumbnail ? (
          <img className="design-canvas-thumb" src={thumbnail} alt="" draggable={false} />
        ) : (
          <span className="design-canvas-empty" aria-hidden="true">
            <Icon name="canvas" size={20} />
          </span>
        )}
        <span className="design-canvas-expand" aria-hidden="true">
          <Icon name="expand" size={14} />
        </span>
      </button>
      <div className="design-canvas-foot">
        <div className="design-canvas-text">
          <strong title={task.title}>{task.title}</strong>
          <small>
            {kindCardLabel(task.kind, en)} · {statusLabel(task, en)}
          </small>
        </div>
        {canAccept && (
          <button
            type="button"
            className="design-canvas-accept"
            disabled={busy}
            onClick={() => void act(() => window.aelion.acceptDesignSession({ id: task.id, revision: task.revision }))}
          >
            {t('确认交付')}
          </button>
        )}
        <button
          type="button"
          className="design-canvas-close"
          aria-label={t('关闭设计任务（之后的消息不再关联它）')}
          title={t('关闭设计任务')}
          onClick={() => {
            if (showing) workbench?.close();
            closeActiveDesign(scope, runs);
          }}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {error && (
        <p className="design-canvas-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
