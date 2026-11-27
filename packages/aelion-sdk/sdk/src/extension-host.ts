import type { JsonValue } from '@aelionsdk/core';

export const AELION_EXTENSION_PROTOCOL = 'aelion.extension/1' as const;

export interface AelionExtensionManifest {
  readonly id: string;
  readonly version: string;
  readonly methods: readonly string[];
}

export type AelionExtensionHostMessage =
  | {
      readonly protocol: typeof AELION_EXTENSION_PROTOCOL;
      readonly type: 'initialize';
      readonly maxPayloadBytes: number;
    }
  | {
      readonly protocol: typeof AELION_EXTENSION_PROTOCOL;
      readonly type: 'invoke';
      readonly id: number;
      readonly method: string;
      readonly payload: JsonValue;
    }
  | {
      readonly protocol: typeof AELION_EXTENSION_PROTOCOL;
      readonly type: 'cancel';
      readonly id: number;
    };

export type AelionExtensionWorkerMessage =
  | {
      readonly protocol: typeof AELION_EXTENSION_PROTOCOL;
      readonly type: 'ready';
      readonly manifest: AelionExtensionManifest;
    }
  | {
      readonly protocol: typeof AELION_EXTENSION_PROTOCOL;
      readonly type: 'result';
      readonly id: number;
      readonly payload: JsonValue;
    }
  | {
      readonly protocol: typeof AELION_EXTENSION_PROTOCOL;
      readonly type: 'error';
      readonly id: number;
      readonly name: string;
      readonly message: string;
    };

export interface AelionExtensionTransport {
  postMessage(message: AelionExtensionHostMessage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export interface AelionExtensionHostOptions {
  readonly maxPendingCalls?: number;
  readonly maxPayloadBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly invocationTimeoutMs?: number;
}

export interface AelionExtensionInvokeOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface AelionExtensionHostSnapshot {
  readonly ready: boolean;
  readonly disposed: boolean;
  readonly pendingCalls: number;
  readonly nextRequestId: number;
  readonly manifest: AelionExtensionManifest | null;
}

interface PendingInvocation {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function payloadBytes(value: unknown): number {
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('Extension payload must be acyclic JSON');
  }
  if (typeof serialized !== 'string') throw new TypeError('Extension payload must be JSON');
  return new TextEncoder().encode(serialized).byteLength;
}

function clonePayload(value: JsonValue, maximum: number): JsonValue {
  if (payloadBytes(value) > maximum) {
    throw new RangeError(`Extension payload exceeds ${maximum.toString()} bytes`);
  }
  return structuredClone(value);
}

function validManifest(value: unknown): value is AelionExtensionManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Partial<AelionExtensionManifest>;
  return (
    typeof manifest.id === 'string' &&
    /^[A-Za-z][A-Za-z0-9._:-]*$/u.test(manifest.id) &&
    typeof manifest.version === 'string' &&
    manifest.version.length > 0 &&
    Array.isArray(manifest.methods) &&
    manifest.methods.length > 0 &&
    manifest.methods.every((method) => typeof method === 'string' && /^[A-Za-z][A-Za-z0-9._:-]*$/u.test(method)) &&
    new Set(manifest.methods).size === manifest.methods.length
  );
}

function asWorkerMessage(value: unknown): AelionExtensionWorkerMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Partial<AelionExtensionWorkerMessage>;
  if (message.protocol !== AELION_EXTENSION_PROTOCOL) return undefined;
  if (message.type === 'ready' && validManifest(message.manifest)) {
    return message as AelionExtensionWorkerMessage;
  }
  if (message.type === 'result' && Number.isSafeInteger(message.id) && (message.id ?? 0) > 0 && 'payload' in message) {
    return message as AelionExtensionWorkerMessage;
  }
  if (
    message.type === 'error' &&
    Number.isSafeInteger(message.id) &&
    (message.id ?? 0) > 0 &&
    typeof message.name === 'string' &&
    typeof message.message === 'string'
  ) {
    return message as AelionExtensionWorkerMessage;
  }
  return undefined;
}

function asHostMessage(value: unknown): AelionExtensionHostMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Readonly<Record<string, unknown>>;
  if (message.protocol !== AELION_EXTENSION_PROTOCOL) return undefined;
  if (
    message.type === 'initialize' &&
    Number.isSafeInteger(message.maxPayloadBytes) &&
    (message.maxPayloadBytes as number) > 0
  ) {
    return message as AelionExtensionHostMessage;
  }
  if (
    message.type === 'invoke' &&
    Number.isSafeInteger(message.id) &&
    (message.id as number) > 0 &&
    typeof message.method === 'string' &&
    /^[A-Za-z][A-Za-z0-9._:-]*$/u.test(message.method) &&
    'payload' in message
  ) {
    return message as AelionExtensionHostMessage;
  }
  if (message.type === 'cancel' && Number.isSafeInteger(message.id) && (message.id as number) > 0) {
    return message as AelionExtensionHostMessage;
  }
  return undefined;
}

function abortRejection(reason: unknown): Error {
  return reason instanceof Error ? reason : new DOMException('Extension call aborted', 'AbortError');
}

/**
 * Fault-isolated RPC host for extension module Workers. The Worker receives
 * cloned JSON only—never Session, media providers, DOM nodes or credentials.
 */
export class AelionExtensionHost {
  readonly #transport: AelionExtensionTransport;
  readonly #maxPendingCalls: number;
  readonly #maxPayloadBytes: number;
  readonly #invocationTimeoutMs: number;
  readonly #pending = new Map<number, PendingInvocation>();
  readonly #readyPromise: Promise<AelionExtensionManifest>;
  #resolveReady!: (manifest: AelionExtensionManifest) => void;
  #rejectReady!: (reason: unknown) => void;
  #handshakeTimer: ReturnType<typeof setTimeout>;
  #manifest: AelionExtensionManifest | undefined;
  #nextRequestId = 1;
  #disposed = false;

  public constructor(transport: AelionExtensionTransport, options: AelionExtensionHostOptions = {}) {
    this.#transport = transport;
    this.#maxPendingCalls = positiveInteger(options.maxPendingCalls, 8, 'maxPendingCalls');
    this.#maxPayloadBytes = positiveInteger(options.maxPayloadBytes, 1_048_576, 'maxPayloadBytes');
    this.#invocationTimeoutMs = positiveInteger(options.invocationTimeoutMs, 5_000, 'invocationTimeoutMs');
    const handshakeTimeoutMs = positiveInteger(options.handshakeTimeoutMs, 5_000, 'handshakeTimeoutMs');
    this.#readyPromise = new Promise<AelionExtensionManifest>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#transport.addEventListener('message', this.#handleMessage);
    this.#transport.addEventListener('error', this.#handleError);
    this.#handshakeTimer = setTimeout(() => {
      this.#fault(new DOMException('Extension handshake timed out', 'TimeoutError'));
    }, handshakeTimeoutMs);
    this.#transport.postMessage({
      protocol: AELION_EXTENSION_PROTOCOL,
      type: 'initialize',
      maxPayloadBytes: this.#maxPayloadBytes,
    });
  }

  public get ready(): Promise<AelionExtensionManifest> {
    return this.#readyPromise;
  }

  public snapshot(): AelionExtensionHostSnapshot {
    return {
      ready: this.#manifest !== undefined,
      disposed: this.#disposed,
      pendingCalls: this.#pending.size,
      nextRequestId: this.#nextRequestId,
      manifest: this.#manifest === undefined ? null : structuredClone(this.#manifest),
    };
  }

  public async invoke(
    method: string,
    payload: JsonValue,
    options: AelionExtensionInvokeOptions = {},
  ): Promise<JsonValue> {
    const manifest = await this.#readyPromise;
    if (this.#disposed) throw new ReferenceError('AelionExtensionHost is disposed');
    if (!manifest.methods.includes(method)) {
      throw new ReferenceError(`Extension ${manifest.id} does not expose ${method}`);
    }
    if (this.#pending.size >= this.#maxPendingCalls) {
      throw new RangeError(`Extension call queue reached its ${this.#maxPendingCalls.toString()} call limit`);
    }
    if (options.signal?.aborted === true) {
      throw options.signal.reason ?? new DOMException('Extension call aborted', 'AbortError');
    }
    const clonedPayload = clonePayload(payload, this.#maxPayloadBytes);
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    const timeoutMs = positiveInteger(options.timeoutMs, this.#invocationTimeoutMs, 'timeoutMs');
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fault(new DOMException(`Extension call ${method} timed out`, 'TimeoutError'));
      }, timeoutMs);
      const abort =
        options.signal === undefined
          ? undefined
          : () => {
              const pending = this.#pending.get(id);
              if (pending === undefined) return;
              this.#settle(id, () => {
                this.#transport.postMessage({
                  protocol: AELION_EXTENSION_PROTOCOL,
                  type: 'cancel',
                  id,
                });
                reject(abortRejection(options.signal?.reason));
              });
            };
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(abort === undefined ? {} : { abort }),
      });
      options.signal?.addEventListener('abort', abort as () => void, { once: true });
      try {
        this.#transport.postMessage({
          protocol: AELION_EXTENSION_PROTOCOL,
          type: 'invoke',
          id,
          method,
          payload: clonedPayload,
        });
      } catch (error) {
        this.#fault(error);
      }
    });
  }

  public dispose(reason: unknown = new DOMException('Extension host disposed', 'AbortError')): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#handshakeTimer);
    this.#transport.removeEventListener('message', this.#handleMessage);
    this.#transport.removeEventListener('error', this.#handleError);
    this.#transport.terminate();
    this.#rejectReady(reason);
    for (const [id, pending] of this.#pending) {
      this.#settle(id, () => pending.reject(reason));
    }
  }

  readonly #handleMessage = (event: MessageEvent<unknown>): void => {
    if (this.#disposed) return;
    const message = asWorkerMessage(event.data);
    if (message === undefined) {
      this.#fault(new TypeError('Extension emitted an invalid protocol message'));
      return;
    }
    if (message.type === 'ready') {
      if (this.#manifest !== undefined) {
        this.#fault(new TypeError('Extension emitted duplicate ready messages'));
        return;
      }
      try {
        if (payloadBytes(message.manifest) > this.#maxPayloadBytes) {
          throw new RangeError('Extension manifest exceeds the payload budget');
        }
      } catch (error) {
        this.#fault(error);
        return;
      }
      clearTimeout(this.#handshakeTimer);
      this.#manifest = structuredClone(message.manifest);
      this.#resolveReady(structuredClone(message.manifest));
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    if (message.type === 'result') {
      try {
        const payload = clonePayload(message.payload, this.#maxPayloadBytes);
        this.#settle(message.id, () => pending.resolve(payload));
      } catch (error) {
        this.#fault(error);
      }
      return;
    }
    this.#settle(message.id, () => {
      const error = new Error(message.message);
      error.name = message.name;
      pending.reject(error);
    });
  };

  readonly #handleError = (event: ErrorEvent): void => {
    this.#fault(event.error ?? new Error(event.message || 'Extension Worker failed'));
  };

  #settle(id: number, callback: () => void): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener('abort', pending.abort);
    }
    callback();
  }

  #fault(error: unknown): void {
    if (this.#disposed) return;
    const ready = this.#manifest !== undefined;
    this.dispose(error);
    if (ready) {
      // `dispose` rejects all invocations. The ready Promise is already settled.
      return;
    }
  }
}

export interface AelionExtensionCallContext {
  readonly signal: AbortSignal;
}

export type AelionExtensionHandler = (
  payload: JsonValue,
  context: AelionExtensionCallContext,
) => JsonValue | Promise<JsonValue>;

export interface AelionExtensionRuntimeEndpoint {
  postMessage(message: AelionExtensionWorkerMessage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

/**
 * Worker-side counterpart. It exposes an explicit method table and supports
 * cooperative cancellation without importing or receiving the editor Session.
 */
export function exposeAelionExtension(
  endpoint: AelionExtensionRuntimeEndpoint,
  manifest: AelionExtensionManifest,
  handlers: Readonly<Record<string, AelionExtensionHandler>>,
): () => void {
  if (!validManifest(manifest)) throw new TypeError('Invalid Aelion extension manifest');
  for (const method of manifest.methods) {
    if (handlers[method] === undefined) {
      throw new ReferenceError(`Missing extension handler ${method}`);
    }
  }
  const active = new Map<number, AbortController>();
  let maximumPayloadBytes: number | undefined;
  const listener = (event: MessageEvent<unknown>): void => {
    const message = asHostMessage(event.data);
    if (message === undefined) return;
    if (message.type === 'initialize') {
      if (maximumPayloadBytes !== undefined) return;
      maximumPayloadBytes = message.maxPayloadBytes;
      endpoint.postMessage({
        protocol: AELION_EXTENSION_PROTOCOL,
        type: 'ready',
        manifest: structuredClone(manifest),
      });
      return;
    }
    if (message.type === 'cancel') {
      active.get(message.id)?.abort(new DOMException('Extension call aborted', 'AbortError'));
      return;
    }
    if (maximumPayloadBytes === undefined || active.has(message.id)) return;
    const maximum = maximumPayloadBytes;
    const handler = handlers[message.method];
    if (handler === undefined) {
      endpoint.postMessage({
        protocol: AELION_EXTENSION_PROTOCOL,
        type: 'error',
        id: message.id,
        name: 'ReferenceError',
        message: `Unknown extension method ${message.method}`,
      });
      return;
    }
    const controller = new AbortController();
    active.set(message.id, controller);
    void Promise.resolve()
      .then(() => handler(clonePayload(message.payload, maximum), { signal: controller.signal }))
      .then((payload) => {
        if (controller.signal.aborted) return;
        endpoint.postMessage({
          protocol: AELION_EXTENSION_PROTOCOL,
          type: 'result',
          id: message.id,
          payload: clonePayload(payload, maximum),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        endpoint.postMessage({
          protocol: AELION_EXTENSION_PROTOCOL,
          type: 'error',
          id: message.id,
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => active.delete(message.id));
  };
  endpoint.addEventListener('message', listener);
  return () => {
    endpoint.removeEventListener('message', listener);
    for (const controller of active.values()) {
      controller.abort(new DOMException('Extension runtime disposed', 'AbortError'));
    }
    active.clear();
  };
}
