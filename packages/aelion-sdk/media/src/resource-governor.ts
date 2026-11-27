import { throwIfAborted, type Disposable } from '@aelionsdk/core';

export interface MediaResourceBudget {
  readonly decoderSlots: number;
  readonly gpuBytes: number;
  readonly cacheBytes: number;
}

export type MediaResourcePriority = 'export' | 'preview' | 'background';

export interface MediaResourceRequest extends MediaResourceBudget {
  readonly ownerId: string;
  readonly priority: MediaResourcePriority;
}

export interface MediaResourceGovernorSnapshot {
  readonly budget: MediaResourceBudget;
  readonly used: MediaResourceBudget;
  readonly activeLeases: number;
  readonly pendingRequests: number;
  readonly disposed: boolean;
}

export interface MediaResourceLease extends Disposable {
  readonly ownerId: string;
  readonly allocation: MediaResourceBudget;
}

interface PendingRequest {
  readonly sequence: number;
  readonly request: MediaResourceRequest;
  readonly resolve: (lease: MediaResourceLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

const PRIORITY: Readonly<Record<MediaResourcePriority, number>> = {
  export: 0,
  preview: 1,
  background: 2,
};

function validateBudget(value: MediaResourceBudget, allowZero: boolean): void {
  for (const [name, amount] of [
    ['decoderSlots', value.decoderSlots],
    ['gpuBytes', value.gpuBytes],
    ['cacheBytes', value.cacheBytes],
  ] as const) {
    if (!Number.isSafeInteger(amount) || amount < 0 || (!allowZero && amount === 0)) {
      throw new RangeError(`MEDIA_RESOURCE_BUDGET_INVALID: ${name}`);
    }
  }
}

/** Shared page-level admission controller for decoder, GPU and cache allocations. */
export class PageMediaResourceGovernor implements Disposable {
  readonly #budget: MediaResourceBudget;
  readonly #used = { decoderSlots: 0, gpuBytes: 0, cacheBytes: 0 };
  readonly #leases = new Set<MediaResourceLease>();
  readonly #pending: PendingRequest[] = [];
  readonly #maxPending: number;
  #sequence = 0;
  #disposed = false;

  public constructor(budget: MediaResourceBudget, maxPending = 128) {
    validateBudget(budget, false);
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
      throw new RangeError('MEDIA_RESOURCE_PENDING_LIMIT_INVALID');
    }
    this.#budget = { ...budget };
    this.#maxPending = maxPending;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public snapshot(): MediaResourceGovernorSnapshot {
    return {
      budget: { ...this.#budget },
      used: { ...this.#used },
      activeLeases: this.#leases.size,
      pendingRequests: this.#pending.length,
      disposed: this.#disposed,
    };
  }

  public acquire(request: MediaResourceRequest, signal?: AbortSignal): Promise<MediaResourceLease> {
    if (this.#disposed) return Promise.reject(new ReferenceError('Media resource governor is disposed'));
    validateBudget(request, true);
    if (request.ownerId.length === 0) return Promise.reject(new TypeError('MEDIA_RESOURCE_OWNER_INVALID'));
    if (
      request.decoderSlots > this.#budget.decoderSlots ||
      request.gpuBytes > this.#budget.gpuBytes ||
      request.cacheBytes > this.#budget.cacheBytes
    ) {
      return Promise.reject(new RangeError('MEDIA_RESOURCE_REQUEST_EXCEEDS_PAGE_BUDGET'));
    }
    try {
      throwIfAborted(signal, 'Media resource admission');
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Media admission failed'));
    }
    if (this.#pending.length === 0 && this.#fits(request)) {
      return Promise.resolve(this.#grant(request));
    }
    if (this.#pending.length >= this.#maxPending) {
      return Promise.reject(new RangeError('MEDIA_RESOURCE_QUEUE_FULL'));
    }
    return new Promise((resolve, reject) => {
      const sequence = ++this.#sequence;
      const onAbort = (): void => {
        const index = this.#pending.findIndex((value) => value.sequence === sequence);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        reject(new DOMException('Media resource admission aborted', 'AbortError'));
      };
      this.#pending.push({ sequence, request, resolve, reject, signal, onAbort });
      this.#sortPending();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#drain();
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.splice(0)) {
      pending.signal?.removeEventListener('abort', pending.onAbort);
      pending.reject(new ReferenceError('Media resource governor was disposed'));
    }
    for (const lease of [...this.#leases]) void lease.dispose();
  }

  #fits(request: MediaResourceBudget): boolean {
    return (
      this.#used.decoderSlots + request.decoderSlots <= this.#budget.decoderSlots &&
      this.#used.gpuBytes + request.gpuBytes <= this.#budget.gpuBytes &&
      this.#used.cacheBytes + request.cacheBytes <= this.#budget.cacheBytes
    );
  }

  #grant(request: MediaResourceRequest): MediaResourceLease {
    this.#used.decoderSlots += request.decoderSlots;
    this.#used.gpuBytes += request.gpuBytes;
    this.#used.cacheBytes += request.cacheBytes;
    let disposed = false;
    const lease: MediaResourceLease = {
      ownerId: request.ownerId,
      allocation: {
        decoderSlots: request.decoderSlots,
        gpuBytes: request.gpuBytes,
        cacheBytes: request.cacheBytes,
      },
      get disposed() {
        return disposed;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#leases.delete(lease);
        this.#used.decoderSlots -= request.decoderSlots;
        this.#used.gpuBytes -= request.gpuBytes;
        this.#used.cacheBytes -= request.cacheBytes;
        this.#drain();
      },
    };
    this.#leases.add(lease);
    return lease;
  }

  #sortPending(): void {
    this.#pending.sort(
      (left, right) =>
        PRIORITY[left.request.priority] - PRIORITY[right.request.priority] || left.sequence - right.sequence,
    );
  }

  #drain(): void {
    if (this.#disposed) return;
    for (;;) {
      const index = this.#pending.findIndex((value) => this.#fits(value.request));
      if (index < 0) break;
      const pending = this.#pending[index];
      if (pending === undefined) break;
      this.#pending.splice(index, 1);
      pending.signal?.removeEventListener('abort', pending.onAbort);
      pending.resolve(this.#grant(pending.request));
    }
  }
}
