import { useEffect, useRef, useState } from 'react';
import type { DesignSession } from '../../shared/types/designer-types';
import type { AttachmentScope } from '../../shared/types/attachment-types';
import {
  deviceFrameKind,
  designPreviewSignature,
  pickDesignPreviewFiles,
  type DesignWorkspaceFile,
} from '../../shared/preview/designer-canvas';
import { workspacePreviewItem } from '../preview/workspace-preview';
import type { PreviewItem } from '../preview/FilePreviewContext';

/** The conversation a task's canvas and feedback belong to. */
const designPreviewScope = (task: DesignSession): AttachmentScope =>
  task.origin.kind === 'group' ? { kind: 'group', id: task.origin.id } : { kind: 'bot', id: task.botId };

/** The task's home page for the docked canvas. A project is one experience; internal pages stay inside its preview. */
function designCanvasItems(task: DesignSession, files: DesignWorkspaceFile[], focus?: string) {
  const picked = pickDesignPreviewFiles(task.kind, files, task.artifacts);
  const fallback = task.artifacts.find((a) => /\.html?$/i.test(a.path)) || task.artifacts[0];
  const home = picked[0] || (fallback && { name: fallback.name, path: fallback.path, size: fallback.bytes });
  const items: PreviewItem[] = (home ? [home] : []).map((file) => ({
    ...workspacePreviewItem(task.botId, file),
    designSessionId: task.id,
    deviceFrame: deviceFrameKind(task.kind),
  }));
  // A deck opens on its HTML companion, which the canvas can show; the PPTX is exported from the preview.
  const stem = focus?.replace(/\.[^./]+$/, '');
  const index = Math.max(
    0,
    items.findIndex((item) => item.workspace?.path === focus || item.workspace?.path.replace(/\.[^./]+$/, '') === stem),
  );
  return { items, index };
}

/** Opens the task on the canvas, half the window beside the chat. Resolves false when it has no page yet. */
export async function openDesignCanvas(
  task: DesignSession,
  open: ((items: PreviewItem[], index?: number, options?: { scope?: AttachmentScope | null }) => void) | undefined,
  focus?: string,
) {
  if (!open) return false;
  let files: DesignWorkspaceFile[] = [];
  try {
    files = await window.aelion.listDesignWorkspace(task.id);
  } catch {
    /* published files still open */
  }
  const { items, index } = designCanvasItems(task, files, focus);
  if (!items.length) return false;
  open(items, index, { scope: designPreviewScope(task) });
  return true;
}

/**
 * The task's files, refreshed while the Bot works on it. When the canvas already shows this task and the set of
 * pages changes (a new page, a rewritten one), the canvas is reopened on the same page.
 */
export function useDesignCanvasSync(
  task: DesignSession | undefined,
  running: boolean,
  shownItemId: string | undefined,
  open: ((items: PreviewItem[], index?: number, options?: { scope?: AttachmentScope | null }) => void) | undefined,
) {
  const [files, setFiles] = useState<DesignWorkspaceFile[]>([]);
  const signature = useRef('');
  useEffect(() => {
    if (!task) {
      setFiles([]);
      return;
    }
    let live = true;
    const tick = async () => {
      try {
        const next = await window.aelion.listDesignWorkspace(task.id);
        if (live) setFiles(next);
      } catch {
        if (live) setFiles([]);
      }
    };
    void tick();
    if (!running)
      return () => {
        live = false;
      };
    const timer = setInterval(() => void tick(), 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [task?.id, task?.revision, running]);
  useEffect(() => {
    if (!task || !open) return;
    const picked = pickDesignPreviewFiles(task.kind, files, task.artifacts),
      next = task.id + '|' + designPreviewSignature(picked);
    const previous = signature.current;
    signature.current = next;
    const showing = Boolean(
      shownItemId && picked.some((file) => shownItemId === `artifact:${task.botId}:${file.path}`),
    );
    if (!previous || previous === next || !showing) return;
    const { items } = designCanvasItems(task, files);
    const index = Math.max(
      0,
      items.findIndex((item) => item.id === shownItemId),
    );
    open(items, index, { scope: designPreviewScope(task) });
  }, [task?.id, files, task?.artifacts, shownItemId, open]);
  return files;
}
