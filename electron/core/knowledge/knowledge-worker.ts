// The indexing thread of the knowledge bases: reads documents (PDF and Office files among them) and writes their
// passages to the index, one knowledge base at a time. Built as its own bundle; see scripts/build.mjs.
import { parentPort, workerData } from 'node:worker_threads';
import { runIndexJob, type IndexJob } from './knowledge-indexer';
import { KnowledgeStore } from './knowledge-store';

export type WorkerRequest =
  | { type: 'index'; id: number; job: IndexJob }
  | { type: 'cancel'; id: number }
  | { type: 'asset'; request: number; data?: Uint8Array; error?: string };

const port = parentPort!,
  store = new KnowledgeStore((workerData as { dbPath: string }).dbPath);
let running: { id: number; controller: AbortController } | undefined,
  nextAsset = 1;
const assets = new Map<number, { resolve: (data: Uint8Array) => void; reject: (error: Error) => void }>();
/** The PDF reader's character maps and font metrics sit in the app archive; the main process reads them for us. */
const pdfAssets = (folder: string, name: string) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const request = nextAsset++;
    assets.set(request, { resolve, reject });
    port.postMessage({ type: 'asset', request, folder, name });
  });

port.on('message', async (message: WorkerRequest) => {
  if (message.type === 'asset') {
    const waiting = assets.get(message.request);
    assets.delete(message.request);
    if (message.data) waiting?.resolve(message.data);
    else waiting?.reject(new Error(message.error || 'unavailable'));
    return;
  }
  if (message.type === 'cancel') {
    if (running?.id === message.id) running.controller.abort();
    return;
  }
  const controller = new AbortController();
  running = { id: message.id, controller };
  let lastProgress = 0;
  try {
    const outcome = await runIndexJob(
      store,
      message.job,
      {
        pdfAssets,
        progress: (progress) => {
          const now = Date.now();
          if (now - lastProgress < 250 && progress.done < progress.total) return;
          lastProgress = now;
          port.postMessage({ type: 'progress', id: message.id, progress });
        },
      },
      controller.signal,
    );
    port.postMessage({ type: 'done', id: message.id, outcome });
  } catch (error) {
    port.postMessage({
      type: 'failed',
      id: message.id,
      cancelled: controller.signal.aborted,
      error: String((error as Error)?.message || error),
    });
  } finally {
    running = undefined;
  }
});
