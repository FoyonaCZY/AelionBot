import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MemoryEmbeddingView } from '../../../shared/types/memory-types';
import { AppError } from '../../../shared/errors';
import type { CognitiveStore } from './cognitive-store';
import { botScope } from './memory-scope';
import { hashText } from './memory-store';

export interface Embedder {
  readonly model: string;
  ready(): boolean;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}
/** BAAI/bge-small-zh-v1.5 (MIT), the int8 ONNX export; 512 dimensions. Fixed to a revision and checked by hash. */
const MODEL = {
  id: 'bge-small-zh-v1.5-q8',
  name: 'bge-small-zh-v1.5',
  repo: 'Xenova/bge-small-zh-v1.5',
  revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
  sizeMB: 25,
  files: [
    {
      path: 'tokenizer_config.json',
      name: 'tokenizer_config.json',
      size: 367,
      sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
    },
    {
      path: 'tokenizer.json',
      name: 'tokenizer.json',
      size: 439125,
      sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
    },
    {
      path: 'onnx/model_quantized.onnx',
      name: 'model.onnx',
      size: 24010842,
      sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
    },
  ],
} as const;
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];
/** The model takes about 260 MB of memory; it leaves after this long without a request and returns in a moment. */
const IDLE_MS = 5 * 60000;

type DownloadFetch = (url: string, init?: RequestInit) => Promise<Response>;
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The small local model. Text never leaves this computer; only the model files are downloaded, once. */
export class LocalEmbedder implements Embedder {
  readonly model = MODEL.id;
  private worker?: Worker;
  private pending = new Map<number, { resolve: (value: Float32Array[]) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private idle?: ReturnType<typeof setTimeout>;
  private state: MemoryEmbeddingView['state'] = 'off';
  private progress?: number;
  private issue?: string;
  private downloading?: AbortController;
  private dir: string;
  constructor(
    dataDir: string,
    private workerPath: string,
    private download: DownloadFetch,
    private changed: () => void,
    private setting: { get: () => boolean; set: (enabled: boolean) => void },
  ) {
    this.dir = join(dataDir, 'models', MODEL.name);
    if (this.installed()) this.state = setting.get() ? 'ready' : 'off';
  }
  private installed() {
    return MODEL.files.every((file) => {
      const path = join(this.dir, file.name);
      return existsSync(path) && statSync(path).size === file.size;
    });
  }
  ready() {
    return this.state === 'ready';
  }
  view(counts: { indexed: number; pending: number }): MemoryEmbeddingView {
    return {
      state: this.state,
      ...(this.progress !== undefined ? { progress: this.progress } : {}),
      ...(this.issue ? { issue: this.issue } : {}),
      model: MODEL.name,
      sizeMB: MODEL.sizeMB,
      ...counts,
    };
  }
  /** Brings the model in when it is switched on: a download the first time. Failing leaves search by words. */
  async start() {
    if (!this.setting.get() || this.downloading) return;
    if (this.installed()) {
      this.state = 'ready';
      this.changed();
      return;
    }
    const controller = (this.downloading = new AbortController());
    this.state = 'downloading';
    this.progress = 0;
    this.issue = undefined;
    this.changed();
    try {
      await this.fetchFiles(controller.signal);
      this.state = 'ready';
    } catch (error) {
      if (controller.signal.aborted) this.state = 'off';
      else {
        this.state = 'failed';
        this.issue = (error as Error).message;
      }
    } finally {
      this.downloading = undefined;
      this.progress = undefined;
      this.changed();
    }
  }
  async setEnabled(enabled: boolean) {
    this.setting.set(enabled);
    if (enabled) return this.start();
    this.downloading?.abort();
    this.stopWorker();
    this.state = 'off';
    this.changed();
  }
  private async fetchFiles(signal: AbortSignal) {
    mkdirSync(this.dir, { recursive: true });
    const total = MODEL.files.reduce((sum, file) => sum + file.size, 0);
    let done = 0;
    for (const file of MODEL.files) {
      const path = join(this.dir, file.name);
      if (existsSync(path) && statSync(path).size === file.size && sha256(path) === file.sha256) {
        done += file.size;
        continue;
      }
      let lastError: Error | undefined;
      for (const host of HOSTS) {
        try {
          await this.fetchOne(
            `${host}/${MODEL.repo}/resolve/${MODEL.revision}/${file.path}`,
            path,
            file.sha256,
            signal,
            (bytes) => {
              this.progress = Math.min(1, (done + bytes) / total);
              this.changed();
            },
          );
          lastError = undefined;
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          lastError = error as Error;
        }
      }
      if (lastError) throw lastError;
      done += file.size;
    }
  }
  private async fetchOne(
    url: string,
    path: string,
    expected: string,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ) {
    const response = await this.download(url, { signal, redirect: 'follow' });
    if (!response.ok || !response.body)
      throw new AppError('memory.model_download_failed', `模型下载失败（HTTP ${response.status}）`);
    const temp = `${path}.${process.pid}.tmp`,
      hash = createHash('sha256'),
      out = createWriteStream(temp);
    let bytes = 0,
      reported = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        bytes += chunk.length;
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        if (bytes - reported > 1 << 20) {
          reported = bytes;
          progress(bytes);
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
      if (hash.digest('hex') !== expected) throw new AppError('memory.model_hash_mismatch', '模型文件校验失败，已丢弃');
      renameSync(temp, path);
    } catch (error) {
      out.destroy();
      rmSync(temp, { force: true });
      throw error;
    }
  }
  private startWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerPath, {
      workerData: { modelDir: this.dir },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.on('message', ({ id, vectors, error }: { id: number; vectors?: Float32Array[]; error?: string }) => {
      const call = this.pending.get(id);
      if (!call) return;
      this.pending.delete(id);
      // Waiting for a reply keeps the process alive; an idle model does not.
      if (!this.pending.size) worker.unref();
      if (error) call.reject(new Error(error));
      else call.resolve(vectors!);
    });
    const failed = (error: Error) => {
      if (this.worker === worker) this.worker = undefined;
      for (const call of this.pending.values()) call.reject(error);
      this.pending.clear();
    };
    worker.on('error', failed);
    worker.on('exit', () => failed(new Error('本地模型已停止')));
    worker.unref();
    return (this.worker = worker);
  }
  private stopWorker() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const worker = this.worker;
    this.worker = undefined;
    void worker?.terminate();
  }
  embed(texts: string[], signal?: AbortSignal) {
    if (!this.ready()) return Promise.reject(new Error('本地模型未就绪'));
    if (!texts.length) return Promise.resolve([]);
    return new Promise<Float32Array[]>((resolve, reject) => {
      const id = this.nextId++,
        worker = this.startWorker(),
        onAbort = () => {
          this.pending.delete(id);
          reject(new Error('已取消'));
        };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      worker.ref();
      worker.postMessage({ id, texts: texts.map((text) => text.slice(0, 2000)) });
      if (this.idle) clearTimeout(this.idle);
      this.idle = setTimeout(() => this.stopWorker(), IDLE_MS);
      this.idle.unref?.();
    });
  }
  close() {
    this.downloading?.abort();
    this.stopWorker();
  }
}

/** Keeps vectors of facts, episodes and what people said in step with the text, a batch at a time while idle. */
export class MemoryVectors {
  constructor(
    private storage: CognitiveStore,
    private embedder: Embedder,
  ) {}
  private wanted() {
    const items = this.storage.items,
      list: Array<{ owner: string; kind: 'item' | 'episode' | 'message'; scope: string; text: string }> = [];
    for (const item of items.list({ statuses: ['active', 'candidate'] }))
      list.push({ owner: item.id, kind: 'item', scope: item.scope, text: item.text });
    for (const row of this.storage.db.prepare('SELECT id,scope,title,summary FROM mem_episodes').all() as Array<{
      id: string;
      scope: string;
      title: string;
      summary: string;
    }>)
      list.push({ owner: row.id, kind: 'episode', scope: row.scope, text: `${row.title}\n${row.summary}` });
    for (const message of this.storage.store.data.messages)
      if (message.role === 'user' && message.content.length >= 8 && !message.scheduled && !message.reaction)
        list.push({
          owner: message.id,
          kind: 'message',
          scope: botScope(message.botId),
          text: message.content.slice(0, 800),
        });
    return list;
  }
  counts() {
    const known = this.storage.items.vectorHashes(this.embedder.model),
      wanted = this.wanted();
    return {
      indexed: wanted.filter((entry) => known.get(entry.owner) === hashText(entry.text)).length,
      pending: wanted.filter((entry) => known.get(entry.owner) !== hashText(entry.text)).length,
    };
  }
  /** Embeds up to a batch of what is missing. Returns how many; nothing left when it returns 0. */
  async indexBatch(signal: AbortSignal, size = 16) {
    if (!this.embedder.ready()) return 0;
    const items = this.storage.items,
      known = items.vectorHashes(this.embedder.model),
      batch = this.wanted()
        .filter((entry) => known.get(entry.owner) !== hashText(entry.text))
        .slice(0, size);
    if (!batch.length) return 0;
    const vectors = await this.embedder.embed(
      batch.map((entry) => entry.text),
      signal,
    );
    if (signal.aborted) return 0;
    batch.forEach((entry, index) =>
      items.setVector(entry.owner, entry.kind, entry.scope, this.embedder.model, hashText(entry.text), vectors[index]),
    );
    return batch.length;
  }
  /** Similarity of the query to what the scopes hold. Waits only briefly: a request never queues behind the model. */
  async similar(query: string, scopes: string[], kinds: Array<'item' | 'episode' | 'message'>, waitMs = 400) {
    const result = new Map<string, number>();
    if (!this.embedder.ready() || !query.trim()) return result;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), waitMs);
    try {
      const [vector] = await this.embedder.embed([query.slice(0, 1000)], controller.signal);
      for (const entry of this.storage.items.vectors(scopes, this.embedder.model, kinds)) {
        if (entry.vec.length !== vector.length) continue;
        let score = 0;
        for (let i = 0; i < vector.length; i++) score += vector[i] * entry.vec[i];
        result.set(entry.owner, score);
      }
    } catch {
      /* Without it, search goes by words. */
    } finally {
      clearTimeout(timer);
    }
    return result;
  }
}
