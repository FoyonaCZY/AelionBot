import type { Diagnostic } from '@aelionsdk/core';

/** Whether the codec operation is a decode or an encode. */
export type CodecOperation = 'decode' | 'encode';
/** Whether the codec path is video or audio. */
export type CodecClass = 'video' | 'audio';

/** The codec execution the SDK is being asked to perform. */
export interface CodecIdentity {
  readonly class: CodecClass;
  readonly operation: CodecOperation;
  /** WebCodecs codec string, e.g. `avc1.64001f` or `mp4a.40.2`. */
  readonly codec: string;
}

/**
 * Capability descriptor for a host-owned software codec implementation.
 *
 * This descriptor does not execute decode or encode work. Aelion's media and
 * export pipelines do not invoke registered descriptors in 1.2; hosts must
 * wire their codec implementation separately. The distinction prevents a
 * capability declaration from being mistaken for an operational fallback.
 */
export interface CodecFallbackDescriptor {
  /** Stable provider id, e.g. `wasm-h264`. */
  readonly id: string;
  /** True when the backend is loaded and ready to accept work. */
  readonly ready: boolean;
  /** Whether this provider can execute the requested codec path. */
  supports(identity: CodecIdentity): boolean;
}

/** @deprecated Use CodecFallbackDescriptor; this contract describes capability, not execution. */
export type CodecFallbackProvider = CodecFallbackDescriptor;

/** Negotiated execution path for a single codec operation. */
export type CodecExecutionPath =
  | { readonly path: 'hardware' }
  | { readonly path: 'fallback'; readonly providerId: string }
  | { readonly path: 'unavailable' };

/**
 * Negotiated execution path for a single codec operation plus any diagnostics
 * the negotiation produced (for example a `CAPABILITY_CODEC_FALLBACK_USED`
 * warning or a `CAPABILITY_CODEC_NO_BACKEND` error).
 */
export type CodecExecutionDecision = CodecExecutionPath & {
  readonly diagnostics: readonly Diagnostic[];
};

function decisionDiagnostic(code: string, message: string, recoverable: boolean): Diagnostic {
  return {
    code,
    severity: recoverable ? 'warning' : 'error',
    message,
    recoverable,
  };
}

/**
 * Negotiate how to execute a codec operation: hardware when the platform
 * reports it, otherwise the first ready provider that supports the identity,
 * otherwise fail closed with a diagnostic.
 */
export function selectCodecAvailability(
  identity: CodecIdentity,
  hardwareSupported: boolean,
  providers: readonly CodecFallbackDescriptor[],
): CodecExecutionDecision {
  if (hardwareSupported) {
    return { path: 'hardware', diagnostics: [] };
  }
  const provider = providers.find((candidate) => candidate.ready && candidate.supports(identity));
  if (provider !== undefined) {
    return {
      path: 'fallback',
      providerId: provider.id,
      diagnostics: [
        decisionDiagnostic(
          'CAPABILITY_CODEC_FALLBACK_USED',
          `${identity.class} ${identity.operation} for ${identity.codec} has a declared ${provider.id} software fallback; the host must wire its execution path`,
          true,
        ),
      ],
    };
  }
  return {
    path: 'unavailable',
    diagnostics: [
      decisionDiagnostic(
        'CAPABILITY_CODEC_NO_BACKEND',
        `${identity.class} ${identity.operation} for ${identity.codec} has no hardware support and no registered software fallback`,
        false,
      ),
    ],
  };
}

/**
 * @deprecated This selects a declared capability only; it does not route codec
 * work. Use selectCodecAvailability and wire the chosen backend explicitly.
 */
export function selectCodecExecution(
  identity: CodecIdentity,
  hardwareSupported: boolean,
  providers: readonly CodecFallbackDescriptor[],
): CodecExecutionDecision {
  return selectCodecAvailability(identity, hardwareSupported, providers);
}

/** Bounded registry of host-owned software codec capability descriptors. */
export class CodecFallbackRegistry {
  readonly #providers: CodecFallbackDescriptor[] = [];

  public register(provider: CodecFallbackDescriptor): void {
    if (this.#providers.some((existing) => existing.id === provider.id)) {
      throw new TypeError(`Codec fallback ${provider.id} is already registered`);
    }
    this.#providers.push(provider);
  }

  public unregister(id: string): void {
    const index = this.#providers.findIndex((provider) => provider.id === id);
    if (index !== -1) this.#providers.splice(index, 1);
  }

  public clear(): void {
    this.#providers.length = 0;
  }

  public providers(): readonly CodecFallbackDescriptor[] {
    return [...this.#providers];
  }
}

/** The default process-wide registry used when no application instance is passed. */
export const codecFallbackRegistry = new CodecFallbackRegistry();
