import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import type { DesignSession, DesignTaskKind, DesignThumbnail } from '../../../shared/types/designer-types';
import type { DesignerFiles } from './designer-files';

/** What one render needs: the task, its page relative to the task folder, and a reader for that folder only. */
export interface DesignThumbnailJob {
  kind: DesignTaskKind;
  /** The page, relative to the task folder, with forward slashes. */
  page: string;
  /** Reads a file relative to the task folder; anything outside the task is refused. */
  read: (path: string, maxBytes: number) => Promise<Buffer>;
}
/** Renders the first screen of a page and returns JPEG bytes. */
export type DesignThumbnailRenderer = (job: DesignThumbnailJob) => Promise<Buffer>;

const LIMIT = 24;

/**
 * Thumbnails of design pages for the canvas card. One render runs at a time; each result (or failure) is kept per
 * file revision (size and modification time), so polling the same unchanged page costs a stat and nothing more.
 */
export class DesignThumbnails {
  private cache = new Map<string, string | null>();
  private pending = new Map<string, Promise<string | null>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private files: DesignerFiles,
    private render: DesignThumbnailRenderer,
  ) {}

  async get(session: DesignSession, path: string): Promise<DesignThumbnail | null> {
    // Legacy VM tasks have no folder on this computer; only HTML pages have a picture to take.
    if (session.location !== 'host' || !session.workspaceDir || !/\.html?$/i.test(path)) return null;
    const file = this.files.absolute(session, path),
      stat = statSync(file);
    if (!stat.isFile()) return null;
    const page = relative(session.workspaceDir, file).replaceAll('\\', '/');
    const key = [session.id, page, stat.size, stat.mtimeMs].join('|');
    let dataUrl: string | null;
    if (this.cache.has(key)) {
      dataUrl = this.cache.get(key)!;
      this.remember(key, dataUrl);
    } else {
      let job = this.pending.get(key);
      if (!job) {
        job = this.enqueue({
          kind: session.kind,
          page,
          read: async (resource, maxBytes) => {
            const target = this.files.absolute(session, resource),
              info = statSync(target);
            if (!info.isFile() || info.size > maxBytes) throw Error('设计资源不存在或过大');
            return readFile(target);
          },
        }).then(
          (url) => {
            this.remember(key, url);
            return url;
          },
          () => {
            // A page that cannot render is not retried until the file changes.
            this.remember(key, null);
            return null;
          },
        );
        this.pending.set(key, job);
        void job.finally(() => this.pending.delete(key));
      }
      dataUrl = await job;
    }
    return dataUrl ? { path: this.files.virtual(session, file), dataUrl } : null;
  }

  private enqueue(job: DesignThumbnailJob) {
    const run = this.queue.then(async () => {
      const bytes = await this.render(job);
      if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
        throw Error('缩略图不是 JPEG');
      return 'data:image/jpeg;base64,' + bytes.toString('base64');
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private remember(key: string, value: string | null) {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }
}
