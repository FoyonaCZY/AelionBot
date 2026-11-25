import { useEffect, useState } from 'react';

/** Retain the last render while the same page updates, but never show another task's image. */
export function useDesignThumbnail(taskId: string, path: string | undefined, version: string) {
  const [result, setResult] = useState<{ taskId: string; path: string; image?: string }>();
  useEffect(() => {
    if (!path) return;
    let live = true;
    const finish = (image?: string) => {
      if (live) setResult({ taskId, path, image });
    };
    void window.aelion.designThumbnail({ id: taskId, path }).then(
      (value) => finish(value?.dataUrl),
      () => finish(),
    );
    return () => {
      live = false;
    };
  }, [taskId, path, version]);
  return result?.taskId === taskId && result.path === path ? result.image : undefined;
}
