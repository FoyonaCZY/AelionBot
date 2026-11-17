// Brings the index of one knowledge base in step with its files: reads what is new or changed, drops what is gone.
// Runs on the indexing thread; tests run it in place.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { KnowledgeSource } from '../../../shared/types/knowledge-types';
import { AppError } from '../../../shared/errors';
import { extractSections, type PdfAssetReader } from './knowledge-extract';
import { scanSources, within } from './knowledge-scan';
import type { KnowledgeStore, NewChunk } from './knowledge-store';
import { chunkHash, chunkSections, indexTerms } from './knowledge-text';

export interface IndexJob {
  base: string;
  sources: KnowledgeSource[];
  fileLimit: number;
  /** Read every file again, not only those that changed. */
  full?: boolean;
}
export interface IndexProgress {
  done: number;
  total: number;
}
export interface IndexOutcome {
  files: number;
  /** Files read in this pass. */
  read: number;
  removed: number;
  truncated: boolean;
  missing: string[];
}
export interface IndexHooks {
  progress?: (progress: IndexProgress) => void;
  pdfAssets?: PdfAssetReader;
}
/** The stored reason a file is not in the index: the part of the error code after `knowledge.`. */
const reason = (error: unknown) => {
  const code = error instanceof AppError ? error.code : '';
  return code.startsWith('knowledge.') ? code.slice('knowledge.'.length) : 'unreadable';
};

export async function runIndexJob(
  store: KnowledgeStore,
  job: IndexJob,
  hooks: IndexHooks,
  signal: AbortSignal,
): Promise<IndexOutcome> {
  const scan = await scanSources(job.sources, job.fileLimit, signal),
    existing = store.files(job.base),
    wanted = new Set<string>([...scan.files.map((file) => file.path), ...scan.skipped.map((file) => file.path)]);
  let removed = 0,
    read = 0;
  for (const [path, file] of existing) {
    // A source that is away for now (a drive not plugged in) keeps what was read from it.
    if (wanted.has(path) || scan.missing.some((source) => within(source, path))) continue;
    // Beyond the limit nothing is known about a file; what is indexed stays until a pass sees the folder whole.
    if (scan.truncated && job.sources.some((source) => within(source.path, path))) continue;
    store.removeFile(file.id);
    removed++;
  }
  for (const issue of scan.skipped) {
    const known = existing.get(issue.path);
    if (known?.status === 'skipped' && known.error === issue.reason) continue;
    store.replaceFile(job.base, {
      path: issue.path,
      size: 0,
      mtime: 0,
      hash: '',
      status: 'skipped',
      error: issue.reason,
    });
  }
  let done = 0;
  hooks.progress?.({ done, total: scan.files.length });
  for (const file of scan.files) {
    signal.throwIfAborted();
    // A file that failed or had no text is not read again until it changes, or until everything is read again.
    const known = existing.get(file.path),
      same = known && known.size === file.size && known.mtime === file.mtime;
    if (!same || job.full) {
      const record = { path: file.path, size: file.size, mtime: file.mtime };
      try {
        const bytes = await readFile(file.path),
          hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
        if (known && known.status === 'ok' && known.hash === hash && !job.full)
          store.touchFile(known.id, file.size, file.mtime);
        else {
          read++;
          const title = basename(file.path, extname(file.path)),
            chunks: NewChunk[] = chunkSections(await extractSections(file.kind, bytes, { ...hooks, signal })).map(
              (chunk) => ({
                ...chunk,
                hash: chunkHash(chunk.heading, chunk.text),
                // The file's name and the headings are searched with the text they stand over.
                tokens: indexTerms(`${title}\n${chunk.heading}\n${chunk.text}`).join(' '),
              }),
            );
          if (chunks.length) store.replaceFile(job.base, { ...record, hash, status: 'ok' }, chunks);
          else store.replaceFile(job.base, { ...record, hash, status: 'skipped', error: 'no_text' });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        store.replaceFile(job.base, { ...record, hash: '', status: 'failed', error: reason(error) });
      }
    }
    hooks.progress?.({ done: ++done, total: scan.files.length });
  }
  const outcome: IndexOutcome = {
    files: scan.files.length,
    read,
    removed,
    truncated: scan.truncated,
    missing: scan.missing,
  };
  store.setStatus(job.base, {
    indexedAt: new Date().toISOString(),
    ...(scan.truncated ? { truncated: true } : {}),
    ...(scan.missing.length ? { missing: scan.missing } : {}),
  });
  return outcome;
}
