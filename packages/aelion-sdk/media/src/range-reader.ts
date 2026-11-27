import { AelionError, throwIfAborted } from '@aelionsdk/core';

import type { ByteRange, RangeRead, RangeReader } from './types.js';

function assertRange(range: ByteRange): void {
  if (
    !Number.isSafeInteger(range.offset) ||
    !Number.isSafeInteger(range.length) ||
    range.offset < 0 ||
    range.length <= 0
  ) {
    throw new RangeError('Byte range offset must be non-negative and length must be positive');
  }
  if (!Number.isSafeInteger(range.offset + range.length)) {
    throw new RangeError('Byte range end exceeds the safe integer range');
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('RangeReader failed', { cause: value });
}

function mediaNetworkError(code: string, message: string, cause?: unknown): AelionError {
  return new AelionError([
    {
      code,
      severity: 'error',
      message,
      recoverable: true,
      ...(cause === undefined ? {} : { cause }),
    },
  ]);
}

export class MemoryRangeReader implements RangeReader {
  public readonly kind = 'memory' as const;
  readonly #bytes: Uint8Array;

  public constructor(
    public readonly id: string,
    bytes: Uint8Array,
  ) {
    this.#bytes = bytes.slice();
  }

  public size(signal?: AbortSignal): Promise<number> {
    try {
      throwIfAborted(signal, 'memory source size');
      return Promise.resolve(this.#bytes.byteLength);
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  public read(range: ByteRange, signal?: AbortSignal): Promise<RangeRead> {
    try {
      throwIfAborted(signal, 'memory range read');
      assertRange(range);
      if (range.offset + range.length > this.#bytes.byteLength) {
        throw new RangeError('Byte range exceeds source size');
      }
      return Promise.resolve({
        bytes: this.#bytes.slice(range.offset, range.offset + range.length),
        range,
        totalSize: this.#bytes.byteLength,
        source: 'memory',
      });
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }
}

export class BlobRangeReader implements RangeReader {
  public readonly kind = 'blob' as const;
  readonly #blob: Blob;

  public constructor(
    public readonly id: string,
    blob: Blob,
  ) {
    this.#blob = blob;
  }

  public size(signal?: AbortSignal): Promise<number> {
    try {
      throwIfAborted(signal, 'blob source size');
      return Promise.resolve(this.#blob.size);
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  public async read(range: ByteRange, signal?: AbortSignal): Promise<RangeRead> {
    throwIfAborted(signal, 'blob range read');
    assertRange(range);
    if (range.offset + range.length > this.#blob.size) {
      throw new RangeError('Byte range exceeds source size');
    }
    const buffer = await this.#blob.slice(range.offset, range.offset + range.length).arrayBuffer();
    throwIfAborted(signal, 'blob range read');
    return {
      bytes: new Uint8Array(buffer),
      range,
      totalSize: this.#blob.size,
      source: 'blob',
    };
  }
}

export interface FetchRangeReaderOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  /** Transient network/408/429/5xx retries after the first attempt. Defaults to 2. */
  readonly maxRetries?: number;
  /** Base delay for bounded exponential backoff. Defaults to 100 ms. */
  readonly retryDelayMs?: number;
}

export class FetchRangeReader implements RangeReader {
  public readonly kind = 'network' as const;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #maxRetries: number;
  readonly #retryDelayMs: number;
  #size?: number;

  public constructor(
    public readonly id: string,
    public readonly url: string,
    options: FetchRangeReaderOptions = {},
  ) {
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#headers = options.headers ?? {};
    this.#maxRetries = options.maxRetries ?? 2;
    this.#retryDelayMs = options.retryDelayMs ?? 100;
    if (!Number.isSafeInteger(this.#maxRetries) || this.#maxRetries < 0 || this.#maxRetries > 8) {
      throw new RangeError('maxRetries must be a safe integer from 0 through 8');
    }
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 0 || this.#retryDelayMs > 10_000) {
      throw new RangeError('retryDelayMs must be a safe integer from 0 through 10000');
    }
  }

  public async size(signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal, 'network source size');
    if (this.#size !== undefined) return this.#size;

    const response = await this.#request(
      {
        method: 'HEAD',
        headers: this.#headers,
        ...(signal === undefined ? {} : { signal }),
      },
      'Media HEAD request',
      signal,
    );
    if (!response.ok) {
      throw new Error(`HEAD request failed with HTTP ${response.status}`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength === null) return this.#probeSize(signal);
    const size = Number(contentLength);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error('Content-Length is missing or outside the safe integer range');
    }
    this.#size = size;
    return size;
  }

  public async read(range: ByteRange, signal?: AbortSignal): Promise<RangeRead> {
    throwIfAborted(signal, 'network range read');
    assertRange(range);
    const end = range.offset + range.length - 1;
    const response = await this.#request(
      {
        headers: { ...this.#headers, Range: `bytes=${range.offset}-${end}` },
        ...(signal === undefined ? {} : { signal }),
      },
      'Media Range request',
      signal,
    );
    if (response.status !== 206) {
      throw mediaNetworkError(
        response.status === 200 ? 'MEDIA_RANGE_UNSUPPORTED' : 'MEDIA_RANGE_REQUEST_FAILED',
        response.status === 200
          ? 'Server ignored Range and returned the full resource'
          : `Range request failed with HTTP ${response.status}`,
      );
    }
    const contentRange = response.headers.get('content-range');
    const parsed = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/u);
    if (parsed === undefined || parsed === null) {
      throw new Error('Range response is missing a valid Content-Range header');
    }
    const actualStart = Number(parsed[1]);
    const actualEnd = Number(parsed[2]);
    const totalSize = Number(parsed[3]);
    if (actualStart !== range.offset || actualEnd !== end || !Number.isSafeInteger(totalSize) || totalSize <= end) {
      throw new Error('Range response does not match the requested byte interval');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== range.length) {
      throw new Error('Range response body length does not match Content-Range');
    }
    this.#size = totalSize;
    return { bytes, range, totalSize, source: 'network' };
  }

  async #probeSize(signal?: AbortSignal): Promise<number> {
    const response = await this.#request(
      {
        headers: { ...this.#headers, Range: 'bytes=0-0' },
        ...(signal === undefined ? {} : { signal }),
      },
      'Media Range size probe',
      signal,
    );
    if (response.status !== 206) {
      throw mediaNetworkError(
        'MEDIA_RANGE_UNSUPPORTED',
        'Source size is unavailable and the server does not support byte ranges',
      );
    }
    const contentRange = response.headers.get('content-range');
    const parsed = contentRange?.match(/^bytes 0-0\/(\d+)$/u);
    const size = parsed === undefined || parsed === null ? Number.NaN : Number(parsed[1]);
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new Error('Range size probe returned an invalid Content-Range');
    }
    this.#size = size;
    return size;
  }

  async #request(init: RequestInit, operation: string, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      throwIfAborted(signal, operation);
      try {
        const fetchFn = this.#fetch;
        const response = await fetchFn(this.url, init);
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === this.#maxRetries) return response;
        await response.body?.cancel();
      } catch (cause) {
        throwIfAborted(signal, operation);
        if (attempt === this.#maxRetries) {
          throw mediaNetworkError(
            'MEDIA_NETWORK_OR_CORS_FAILED',
            `${operation} failed after ${(attempt + 1).toString()} attempt(s)`,
            cause,
          );
        }
      }
      await this.#waitBeforeRetry(attempt, operation, signal);
    }
    throw new Error(`${operation} retry loop exhausted unexpectedly`);
  }

  async #waitBeforeRetry(attempt: number, operation: string, signal?: AbortSignal): Promise<void> {
    const delayMs = this.#retryDelayMs * 2 ** attempt;
    if (delayMs === 0) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        try {
          throwIfAborted(signal, operation);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(`${operation} was aborted`, { cause: error }));
        }
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
