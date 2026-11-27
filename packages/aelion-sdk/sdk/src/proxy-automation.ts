import { throwIfAborted } from '@aelionsdk/core';
import type { RangeReader } from '@aelionsdk/media';

import type { ProductionMediaProvider } from './production-media-provider.js';

/** Input to a proxy encoder: the original bytes to downscale. */
export interface ProxyEncodeInput {
  /** Original bytes of the source representation to proxy. */
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
  readonly maxDimension: number;
  readonly signal?: AbortSignal;
}

/** Encoded proxy output. */
export interface ProxyEncodeResult {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
}

/**
 * Contract for a proxy encoder. The SDK ships no encoder; a browser host
 * supplies one (e.g. decoding the first frame to an OffscreenCanvas and
 * encoding a downscaled WebP/JPEG) so the automatic-proxy flow stays
 * testable in Node. Encoding must honor `signal` and `maxDimension`.
 */
export type ProxyEncoder = (input: ProxyEncodeInput) => Promise<ProxyEncodeResult>;

/** Streaming/range-reader input for encoders that must not buffer the source in memory. */
export interface ProxyReaderEncodeInput {
  readonly reader: RangeReader;
  readonly byteLength: number;
  readonly mimeType?: string;
  readonly maxDimension: number;
  readonly signal?: AbortSignal;
}

/** Preferred encoder contract for large source media. */
export type ProxyReaderEncoder = (input: ProxyReaderEncodeInput) => Promise<ProxyEncodeResult>;

/** Default ceiling for the legacy whole-buffer proxy encoder input. */
export const DEFAULT_MAX_IN_MEMORY_PROXY_INPUT_BYTES = 64 * 1024 * 1024;

/** Options for generating and registering an automatic proxy. */
export interface RegisterAutomaticProxyOptions {
  /** Original asset id to proxy. */
  readonly assetId: string;
  /** Range reader for the original bytes. */
  readonly originalReader: RangeReader;
  /** Largest proxy dimension (width or height) in pixels. */
  readonly maxDimension: number;
  /** Legacy in-memory encoder. Inputs above maxInputBytes fail before reading. */
  readonly encode?: ProxyEncoder;
  /** Range-reader encoder for large inputs; preferred when available. */
  readonly encodeReader?: ProxyReaderEncoder;
  readonly mimeType?: string;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

/** Result of a successful automatic proxy registration. */
export interface AutomaticProxyResult {
  readonly representationId: string;
  readonly role: 'proxy';
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
  readonly byteLength: number;
}

/**
 * Generate and register a low-resolution proxy for an original asset through
 * an injected encoder, and return the registered representation. The provider
 * then serves the proxy for preview and keeps the original for export via
 * `selectAssetRepresentation`. Fails closed on an unknown asset or encoder
 * error without mutating the provider.
 */
export async function registerAutomaticProxy(
  provider: ProductionMediaProvider,
  options: RegisterAutomaticProxyOptions,
): Promise<AutomaticProxyResult> {
  if (!Number.isSafeInteger(options.maxDimension) || options.maxDimension <= 0) {
    throw new RangeError('maxDimension must be a positive safe integer');
  }
  if (options.encode === undefined && options.encodeReader === undefined) {
    throw new TypeError('A proxy encode or encodeReader implementation is required');
  }
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_IN_MEMORY_PROXY_INPUT_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_IN_MEMORY_PROXY_INPUT_BYTES;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0) {
    throw new RangeError('maxInputBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new RangeError('maxOutputBytes must be a positive safe integer');
  }
  throwIfAborted(options.signal, 'Automatic proxy generation');
  // Fails closed with ReferenceError when the asset (or its original) is unknown.
  provider.representationFor(options.assetId, { purpose: 'export' });
  const size = await options.originalReader.size(options.signal);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError('Original representation must have a positive byte size');
  }
  const common = {
    maxDimension: options.maxDimension,
    ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const encode = options.encode;
  const encoded =
    options.encodeReader === undefined
      ? await (async () => {
          if (encode === undefined) {
            throw new TypeError('A proxy encode implementation is required without encodeReader');
          }
          if (size > maxInputBytes) {
            throw new RangeError(
              `Original representation exceeds the ${maxInputBytes.toString()} byte in-memory proxy limit; supply encodeReader`,
            );
          }
          const read = await options.originalReader.read({ offset: 0, length: size }, options.signal);
          if (read.bytes.byteLength !== size) {
            throw new RangeError('Original representation returned an incomplete read');
          }
          return encode({ bytes: read.bytes, ...common });
        })()
      : await options.encodeReader({
          reader: options.originalReader,
          byteLength: size,
          ...common,
        });
  throwIfAborted(options.signal, 'Automatic proxy generation');
  if (encoded.bytes.byteLength === 0) {
    throw new TypeError('Proxy encoder produced empty bytes');
  }
  if (encoded.bytes.byteLength > maxOutputBytes) {
    throw new RangeError('Proxy encoder output exceeds maxOutputBytes');
  }
  if (
    !Number.isSafeInteger(encoded.width) ||
    !Number.isSafeInteger(encoded.height) ||
    encoded.width <= 0 ||
    encoded.height <= 0 ||
    Math.max(encoded.width, encoded.height) > options.maxDimension
  ) {
    throw new RangeError('Proxy encoder dimensions must be positive and within maxDimension');
  }
  if (typeof encoded.mimeType !== 'string' || encoded.mimeType.trim().length === 0) {
    throw new TypeError('Proxy encoder must return a non-empty mimeType');
  }
  const blob = new Blob([encoded.bytes as Uint8Array<ArrayBuffer>], { type: encoded.mimeType });
  const representationId = `${options.assetId}:proxy`;
  provider.registerBlob(options.assetId, blob, {
    id: representationId,
    role: 'proxy',
    width: encoded.width,
    height: encoded.height,
    mimeType: encoded.mimeType,
  });
  return {
    representationId,
    role: 'proxy',
    width: encoded.width,
    height: encoded.height,
    mimeType: encoded.mimeType,
    byteLength: encoded.bytes.byteLength,
  };
}
