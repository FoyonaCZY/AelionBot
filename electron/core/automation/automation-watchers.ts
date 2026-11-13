// Folders that automations watch. Changes are collected for a few seconds after the last one, so saving a batch of
// files fires once, and handed on as paths relative to the folder.
import { watch, type FSWatcher } from 'node:fs';

/** Quiet time after the last change before the batch is reported. */
const SETTLE_MS = 3000;
/** Paths kept per batch; beyond this only the count grows. */
const PATHS = 200;

export interface WatchedFolder {
  id: string;
  path: string;
}

interface Watched {
  path: string;
  watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
  paths: Set<string>;
  /** Changes past the path limit. */
  extra: number;
}

export class AutomationWatchers {
  private watchers = new Map<string, Watched>();
  constructor(
    private report: (id: string, paths: string[]) => void,
    private failed: (id: string, error: string) => void = () => {},
  ) {}
  /** Watches exactly these folders, starting and stopping watchers as automations change. */
  sync(folders: WatchedFolder[]) {
    const wanted = new Map(folders.map((folder) => [folder.id, folder.path]));
    for (const [id, entry] of this.watchers)
      if (wanted.get(id) !== entry.path) {
        clearTimeout(entry.timer);
        entry.watcher?.close();
        this.watchers.delete(id);
      }
    for (const [id, path] of wanted) {
      if (this.watchers.has(id)) continue;
      try {
        const entry: Watched = { path, paths: new Set(), extra: 0 };
        const watcher = watch(path, { recursive: true, persistent: false }, (_event, name) => {
          const file = name ? String(name) : '';
          if (entry.paths.size < PATHS) entry.paths.add(file || '（文件夹本身）');
          else if (!entry.paths.has(file)) entry.extra++;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            const paths = [...entry.paths];
            if (entry.extra) paths.push(`……另有 ${entry.extra} 项`);
            entry.paths.clear();
            entry.extra = 0;
            this.report(id, paths);
          }, SETTLE_MS);
        });
        entry.watcher = watcher;
        watcher.on('error', (error) => {
          clearTimeout(entry.timer);
          watcher.close();
          this.watchers.delete(id);
          this.failed(id, `无法继续监视文件夹：${error.message}`);
        });
        this.watchers.set(id, entry);
      } catch (error) {
        this.failed(id, `无法监视文件夹：${(error as Error).message}`);
      }
    }
  }
  dispose() {
    for (const entry of this.watchers.values()) {
      clearTimeout(entry.timer);
      entry.watcher?.close();
    }
    this.watchers.clear();
  }
}
