import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  DECISION_MODELS,
  isLayaVariant,
  type LayaPrediction,
  type LayaVariant,
} from '../../../shared/types/laya-types';

type Question = { type: 'choice'; instructions: string; criteria: Record<string, string> };
type Pending = {
  resolve: (value: LayaPrediction | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
  started: number;
  signal?: AbortSignal;
  onAbort?: () => void;
};
/** Manages the opt-in local inference process; domain policies live with their callers. */
export class LayaRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private line = '';
  private ready = false;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, Pending>();
  private disabled = false;
  private runtime: LayaVariant | undefined;
  private python: string | undefined;
  private model: string;
  private loadTimeoutMs = 120_000;
  private readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  constructor(
    private script: string,
    private changed: () => void = () => {},
    options?: { runtime?: LayaVariant; python?: string },
  ) {
    const runtime = options ? options.runtime : process.env.AELION_LAYA_RUNTIME;
    this.runtime = isLayaVariant(runtime) ? runtime : undefined;
    this.python = options ? options.python : process.env.AELION_LAYA_PYTHON;
    this.model =
      (!options && process.env.AELION_LAYA_MODEL) ||
      DECISION_MODELS.find((model) => model.id === this.runtime)?.modelId ||
      DECISION_MODELS[0].modelId;
  }
  get enabled() {
    return Boolean(this.runtime) && !this.disabled;
  }
  get runtimeName() {
    return this.runtime;
  }
  get isReady() {
    return this.ready && !this.disabled;
  }
  warmup() {
    this.start();
  }
  configure(runtime?: LayaVariant, python?: string, loadTimeoutMs = 120_000) {
    this.stop();
    this.runtime = runtime;
    this.python = python;
    this.model = DECISION_MODELS.find((model) => model.id === runtime)?.modelId || DECISION_MODELS[0].modelId;
    this.loadTimeoutMs = loadTimeoutMs;
    this.disabled = false;
    this.changed();
    if (runtime) this.warmup();
  }
  waitReady(): Promise<void> {
    if (this.isReady) return Promise.resolve();
    if (!this.enabled) return Promise.reject(new Error('Laya 未启用'));
    return new Promise((resolve, reject) => this.readyWaiters.add({ resolve, reject }));
  }
  private takePending(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
    return pending;
  }
  private start() {
    if (this.child || !this.enabled) return;
    const python = this.python || 'python3';
    const child = spawn(python, ['-u', this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AELION_LAYA_RUNTIME: this.runtime,
        AELION_LAYA_MODEL: this.model,
        TOKENIZERS_PARALLELISM: 'false',
        OMP_NUM_THREADS: '2',
        OPENBLAS_NUM_THREADS: '2',
      },
    });
    this.child = child;
    this.startupTimer = setTimeout(() => this.fail(), this.loadTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      this.line += part;
      if (this.line.length > 1_000_000) {
        this.fail();
        return;
      }
      let end: number;
      while ((end = this.line.indexOf('\n')) >= 0) {
        const line = this.line.slice(0, end);
        this.line = this.line.slice(end + 1);
        this.receive(line);
      }
    });
    child.stderr.on('data', (part: Buffer) => {
      console.warn('Laya:', part.toString().slice(0, 500));
    });
    child.on('error', () => this.fail());
    child.on('exit', () => this.fail());
  }
  private receive(line: string) {
    try {
      const response = JSON.parse(line) as {
        ready?: boolean;
        loadMs?: number;
        inferenceMs?: number;
        activeMemoryBytes?: number;
        cacheMemoryBytes?: number;
        id?: string;
        error?: string;
        result?: {
          answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
        };
      };
      if (response.ready) {
        clearTimeout(this.startupTimer);
        this.ready = true;
        console.info(
          'Laya ready:',
          JSON.stringify({
            loadMs: response.loadMs,
            activeMemoryBytes: response.activeMemoryBytes,
            cacheMemoryBytes: response.cacheMemoryBytes,
          }),
        );
        for (const waiter of this.readyWaiters) waiter.resolve();
        this.readyWaiters.clear();
        this.changed();
        return;
      }
      const pending = response.id ? this.takePending(response.id) : undefined;
      if (!pending) return;
      const answer = response.result?.answers?.decision;
      if (response.error) console.warn('Laya prediction:', response.error.slice(0, 300));
      pending.resolve(
        answer?.choice
          ? {
              choice: answer.choice,
              confidence: answer.confidence,
              probabilities: answer.probabilities,
              model: this.model,
              runtime: this.runtime!,
              elapsedMs: Date.now() - pending.started,
              inferenceMs: response.inferenceMs,
              activeMemoryBytes: response.activeMemoryBytes,
              cacheMemoryBytes: response.cacheMemoryBytes,
            }
          : undefined,
      );
    } catch {
      this.fail();
    }
  }
  private fail() {
    if (this.disabled) return;
    this.disabled = true;
    clearTimeout(this.startupTimer);
    this.ready = false;
    for (const waiter of this.readyWaiters) waiter.reject(new Error('Laya 模型加载失败或超时'));
    this.readyWaiters.clear();
    for (const id of this.pending.keys()) this.takePending(id)?.resolve(undefined);
    this.child?.kill();
    this.child = undefined;
    this.changed();
  }
  private stop() {
    clearTimeout(this.startupTimer);
    this.ready = false;
    for (const waiter of this.readyWaiters) waiter.reject(new Error('Laya 已停止'));
    this.readyWaiters.clear();
    for (const id of this.pending.keys()) this.takePending(id)?.resolve(undefined);
    this.child?.stdout.removeAllListeners();
    this.child?.stderr.removeAllListeners();
    this.child?.removeAllListeners();
    this.child?.kill();
    this.child = undefined;
    this.line = '';
  }
  predict(state: unknown, question: Question, signal?: AbortSignal): Promise<LayaPrediction | undefined> {
    if (!this.enabled || signal?.aborted) return Promise.resolve(undefined);
    this.start();
    if (!this.child || !this.isReady || this.pending.size >= 3) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.takePending(id)?.resolve(undefined);
        this.fail();
      }, 5_000);
      const onAbort = () => this.takePending(id)?.resolve(undefined);
      this.pending.set(id, { resolve, timer, started: Date.now(), signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      this.child!.stdin.write(JSON.stringify({ id, state, questions: { decision: question } }) + '\n', (error) => {
        if (error) this.fail();
      });
    });
  }
  dispose() {
    this.stop();
    this.disabled = true;
  }
}
