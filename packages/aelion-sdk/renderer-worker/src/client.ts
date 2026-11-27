import { AelionError, type Disposable } from '@aelionsdk/core';
import type { JsonValue } from '@aelionsdk/core';
import type { WebGl2MaterialProgram } from '@aelionsdk/material-compiler';

import type {
  ComposeFailure,
  ComposeFrameGraphRequest,
  ComposeRequest,
  ComposeSuccess,
  FrameGraphNode,
  RendererWorkerResponse,
} from './protocol.js';

export interface ComposeOptions {
  readonly inputs: Readonly<Record<string, VideoFrame>>;
  readonly program: WebGl2MaterialProgram;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly systems?: Readonly<Record<string, number>>;
  readonly width: number;
  readonly height: number;
  readonly preferredBackend?: 'webgpu' | 'webgl2';
  readonly allowFallback?: boolean;
  readonly signal?: AbortSignal;
  /** @internal Used only by backend loss conformance tests. */
  readonly debugSimulateLoss?: 'webgpu-device' | 'webgl2-context';
}

export interface ComposeFrameGraphOptions {
  readonly inputs: Readonly<Record<string, VideoFrame>>;
  readonly nodes: readonly FrameGraphNode[];
  readonly outputNodeId: string;
  readonly width: number;
  readonly height: number;
  readonly preferredBackend?: 'webgpu' | 'webgl2';
  readonly allowFallback?: boolean;
  readonly signal?: AbortSignal;
}

export interface WorkerCompositorSnapshot {
  readonly disposed: boolean;
  /** All client-admitted requests awaiting a terminal Worker response. */
  readonly pendingRequests: number;
  /** Admitted requests that have not been cancelled by their caller. */
  readonly activeRequests: number;
  /** Cancellation tombstones retained until the Worker acknowledges cleanup. */
  readonly cancelledRequests: number;
  readonly maxPendingRequests: number;
}

export interface WorkerCompositorOptions {
  readonly maxPendingRequests?: number;
  /** Host-resolved Worker URL for standard ESM/CDN deployments. */
  readonly workerUrl?: string | URL;
  /** Advanced host integration and deterministic tests. */
  readonly workerFactory?: () => Worker;
}

interface PendingComposition {
  readonly state: 'pending';
  readonly resolve: (value: ComposeSuccess) => void;
  readonly reject: (reason: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface CancelledComposition {
  readonly state: 'cancelled';
}

type AdmittedComposition = PendingComposition | CancelledComposition;

function failureError(response: ComposeFailure): AelionError {
  return new AelionError([
    {
      code: response.code,
      severity: 'error',
      message: response.message,
      recoverable: true,
    },
  ]);
}

export class WorkerCompositor implements Disposable {
  readonly #worker: Worker;
  readonly #pending = new Map<number, AdmittedComposition>();
  #nextId = 1;
  #disposed = false;
  readonly #maxPendingRequests: number;

  public constructor(options: WorkerCompositorOptions = {}) {
    const maxPendingRequests = options.maxPendingRequests ?? 8;
    if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests <= 0) {
      throw new RangeError('maxPendingRequests must be a positive safe integer');
    }
    this.#maxPendingRequests = maxPendingRequests;
    this.#worker =
      options.workerFactory?.() ??
      new Worker(options.workerUrl ?? new URL('./webgl2-worker.js', import.meta.url), {
        type: 'module',
        name: 'aelion-renderer-webgl2',
      });
    this.#worker.addEventListener('message', this.#handleMessage);
    this.#worker.addEventListener('error', this.#handleWorkerError);
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public snapshot(): WorkerCompositorSnapshot {
    let activeRequests = 0;
    let cancelledRequests = 0;
    for (const request of this.#pending.values()) {
      if (request.state === 'pending') activeRequests += 1;
      else cancelledRequests += 1;
    }
    return {
      disposed: this.#disposed,
      pendingRequests: this.#pending.size,
      activeRequests,
      cancelledRequests,
      maxPendingRequests: this.#maxPendingRequests,
    };
  }

  public compose(options: ComposeOptions): Promise<ComposeSuccess> {
    if (this.#disposed) return Promise.reject(new ReferenceError('WorkerCompositor is disposed'));
    if (options.signal?.aborted) {
      Object.values(options.inputs).forEach((frame) => frame.close());
      return Promise.reject(new DOMException('Composition aborted', 'AbortError'));
    }
    if (this.#pending.size >= this.#maxPendingRequests) {
      Object.values(options.inputs).forEach((frame) => frame.close());
      return Promise.reject(
        new AelionError([
          {
            code: 'RENDERER_QUEUE_FULL',
            severity: 'error',
            message: `Worker compositor queue reached its ${this.#maxPendingRequests.toString()} request limit`,
            recoverable: true,
          },
        ]),
      );
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const request: ComposeRequest = {
      type: 'compose',
      id,
      inputs: options.inputs,
      program: options.program,
      parameters: options.parameters ?? {},
      systems: options.systems ?? {},
      width: options.width,
      height: options.height,
      preferredBackend: options.preferredBackend ?? 'webgpu',
      allowFallback: options.allowFallback ?? true,
      ...(options.debugSimulateLoss === undefined ? {} : { debugSimulateLoss: options.debugSimulateLoss }),
    };
    return new Promise<ComposeSuccess>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined || pending.state === 'cancelled') return;
        pending.signal?.removeEventListener('abort', onAbort);
        // Keep a lightweight tombstone in the admission map until the Worker
        // confirms that the transferred frames/GPU work reached a terminal
        // state. Otherwise cancel/retry loops can bypass maxPendingRequests.
        this.#pending.set(id, { state: 'cancelled' });
        try {
          this.#worker.postMessage({ type: 'cancel', id });
        } catch {
          // A failed cancel post means no acknowledgement can arrive. Terminate
          // the Worker so its in-flight resources are reclaimed, then drain all
          // client admission state through the shared fatal-error path.
          this.#failAll(new Error('Renderer Worker cancellation failed'));
        }
        pending.reject(new DOMException('Composition aborted', 'AbortError'));
      };
      this.#pending.set(id, {
        state: 'pending',
        resolve,
        reject,
        ...(options.signal === undefined ? {} : { signal: options.signal, onAbort }),
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.#worker.postMessage(request, Object.values(options.inputs));
      } catch (error) {
        this.#pending.delete(id);
        options.signal?.removeEventListener('abort', onAbort);
        Object.values(options.inputs).forEach((frame) => frame.close());
        this.#failAll(error instanceof Error ? error : new Error('Renderer Worker request failed'));
        reject(error instanceof Error ? error : new Error('Renderer Worker request failed'));
      }
    });
  }

  public composeFrameGraph(options: ComposeFrameGraphOptions): Promise<ComposeSuccess> {
    if (this.#disposed) return Promise.reject(new ReferenceError('WorkerCompositor is disposed'));
    if (options.signal?.aborted) {
      Object.values(options.inputs).forEach((frame) => frame.close());
      return Promise.reject(new DOMException('Frame graph aborted', 'AbortError'));
    }
    if (options.nodes.length === 0) {
      Object.values(options.inputs).forEach((frame) => frame.close());
      return Promise.reject(new RangeError('Frame graph must contain at least one node'));
    }
    if (this.#pending.size >= this.#maxPendingRequests) {
      Object.values(options.inputs).forEach((frame) => frame.close());
      return Promise.reject(
        new AelionError([
          {
            code: 'RENDERER_QUEUE_FULL',
            severity: 'error',
            message: `Worker compositor queue reached its ${this.#maxPendingRequests.toString()} request limit`,
            recoverable: true,
          },
        ]),
      );
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const request: ComposeFrameGraphRequest = {
      type: 'compose-frame-graph',
      id,
      inputs: options.inputs,
      nodes: options.nodes,
      outputNodeId: options.outputNodeId,
      width: options.width,
      height: options.height,
      preferredBackend: options.preferredBackend ?? 'webgl2',
      allowFallback: options.allowFallback ?? true,
    };
    return new Promise<ComposeSuccess>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.#pending.get(id);
        if (pending === undefined || pending.state === 'cancelled') return;
        pending.signal?.removeEventListener('abort', onAbort);
        this.#pending.set(id, { state: 'cancelled' });
        try {
          this.#worker.postMessage({ type: 'cancel', id });
        } catch {
          this.#failAll(new Error('Renderer Worker cancellation failed'));
        }
        pending.reject(new DOMException('Frame graph aborted', 'AbortError'));
      };
      this.#pending.set(id, {
        state: 'pending',
        resolve,
        reject,
        ...(options.signal === undefined ? {} : { signal: options.signal, onAbort }),
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.#worker.postMessage(request, Object.values(options.inputs));
      } catch (error) {
        this.#pending.delete(id);
        options.signal?.removeEventListener('abort', onAbort);
        Object.values(options.inputs).forEach((frame) => frame.close());
        this.#failAll(error instanceof Error ? error : new Error('Renderer Worker request failed'));
        reject(error instanceof Error ? error : new Error('Renderer Worker request failed'));
      }
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#worker.postMessage({ type: 'dispose' });
    } catch {
      // Termination below is the authoritative cleanup path.
    }
    this.#worker.terminate();
    this.#detachWorkerListeners();
    for (const pending of this.#pending.values()) {
      if (pending.state === 'pending' && pending.onAbort !== undefined) {
        pending.signal?.removeEventListener('abort', pending.onAbort);
      }
      if (pending.state === 'pending') {
        pending.reject(new ReferenceError('WorkerCompositor was disposed'));
      }
    }
    this.#pending.clear();
  }

  readonly #handleMessage = (event: MessageEvent<RendererWorkerResponse>): void => {
    const response = event.data;
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      if (response.type === 'composed') response.bitmap.close();
      return;
    }
    this.#pending.delete(response.id);
    if (pending.state === 'cancelled') {
      if (response.type === 'composed') response.bitmap.close();
      return;
    }
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.onAbort);
    }
    if (response.type === 'failed') pending.reject(failureError(response));
    else if (response.type === 'cancelled') {
      pending.reject(new DOMException('Composition cancelled by Worker', 'AbortError'));
    } else pending.resolve(response);
  };

  readonly #handleWorkerError = (event: ErrorEvent): void => {
    this.#failAll(new Error(event.message));
  };

  #failAll(error: Error): void {
    this.#disposed = true;
    this.#worker.terminate();
    this.#detachWorkerListeners();
    for (const pending of this.#pending.values()) {
      if (pending.state === 'pending' && pending.onAbort !== undefined) {
        pending.signal?.removeEventListener('abort', pending.onAbort);
      }
      if (pending.state === 'pending') pending.reject(error);
    }
    this.#pending.clear();
  }

  #detachWorkerListeners(): void {
    this.#worker.removeEventListener('message', this.#handleMessage);
    this.#worker.removeEventListener('error', this.#handleWorkerError);
  }
}
