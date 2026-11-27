import { throwIfAborted } from '@aelionsdk/core';

import type { RangeReader } from './types.js';

export interface DecodedStillImage {
  readonly frame: VideoFrame;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: VideoColorSpaceInit;
  close(): void;
}

export async function decodeStillImage(blob: Blob, signal?: AbortSignal): Promise<DecodedStillImage> {
  throwIfAborted(signal, 'Still image decode');
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  });
  try {
    throwIfAborted(signal, 'Still image decode');
    const frame = new VideoFrame(bitmap, { timestamp: 0 });
    return {
      frame,
      width: frame.displayWidth,
      height: frame.displayHeight,
      colorSpace: {
        primaries: frame.colorSpace.primaries,
        transfer: frame.colorSpace.transfer,
        matrix: frame.colorSpace.matrix,
        fullRange: frame.colorSpace.fullRange,
      },
      close: () => frame.close(),
    };
  } finally {
    bitmap.close();
  }
}

export interface DecodeStillImageFromReaderOptions {
  readonly mimeType?: string;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

/** Decode a bounded still image from any registered range-backed source. */
export async function decodeStillImageFromReader(
  reader: RangeReader,
  options: DecodeStillImageFromReaderOptions = {},
): Promise<DecodedStillImage> {
  const maxBytes = options.maxBytes ?? 64 * 1_024 * 1_024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  throwIfAborted(options.signal, 'Still image range decode');
  const size = await reader.size(options.signal);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError('Still image source must have a positive safe integer size');
  }
  if (size > maxBytes) {
    throw new RangeError(`Still image exceeds the ${maxBytes.toString()} byte decode limit`);
  }
  const read = await reader.read({ offset: 0, length: size }, options.signal);
  throwIfAborted(options.signal, 'Still image range decode');
  return decodeStillImage(
    new Blob([read.bytes as Uint8Array<ArrayBuffer>], {
      type: options.mimeType ?? 'application/octet-stream',
    }),
    options.signal,
  );
}

export interface AnimatedImageInfo {
  readonly mimeType: string;
  readonly frameCount: number;
  readonly repetitionCount: number;
  readonly durationUs: number;
  readonly frameDurationsUs: readonly number[];
}

export class AnimatedImageSource {
  readonly #decoder: ImageDecoder;
  readonly #info: AnimatedImageInfo;
  #disposed = false;

  private constructor(decoder: ImageDecoder, info: AnimatedImageInfo) {
    this.#decoder = decoder;
    this.#info = info;
  }

  public static async open(
    blob: Blob,
    options: { readonly maxFrames?: number; readonly signal?: AbortSignal } = {},
  ): Promise<AnimatedImageSource> {
    throwIfAborted(options.signal, 'Animated image open');
    if (typeof ImageDecoder !== 'function') {
      throw new DOMException('WebCodecs ImageDecoder is unavailable', 'NotSupportedError');
    }
    const supported = await ImageDecoder.isTypeSupported(blob.type);
    if (!supported) throw new DOMException(`Unsupported image type ${blob.type}`, 'NotSupportedError');
    const decoder = new ImageDecoder({ type: blob.type, data: blob.stream() });
    try {
      await decoder.tracks.ready;
      throwIfAborted(options.signal, 'Animated image open');
      const track = decoder.tracks.selectedTrack;
      if (track === null) throw new Error('Animated image has no selected track');
      const maxFrames = options.maxFrames ?? 10_000;
      if (track.frameCount > maxFrames) {
        throw new RangeError(`Animated image exceeds the ${maxFrames.toString()} frame limit`);
      }
      const frameDurationsUs: number[] = [];
      for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex += 1) {
        throwIfAborted(options.signal, 'Animated image indexing');
        const decoded = await decoder.decode({ frameIndex, completeFramesOnly: true });
        try {
          frameDurationsUs.push(Math.max(1, decoded.image.duration ?? 1));
        } finally {
          decoded.image.close();
        }
      }
      return new AnimatedImageSource(decoder, {
        mimeType: blob.type,
        frameCount: track.frameCount,
        repetitionCount: track.repetitionCount,
        durationUs: frameDurationsUs.reduce((sum, value) => sum + value, 0),
        frameDurationsUs,
      });
    } catch (error) {
      decoder.close();
      throw error;
    }
  }

  public get info(): AnimatedImageInfo {
    return this.#info;
  }

  public async frameAt(timeUs: number, signal?: AbortSignal): Promise<VideoFrame> {
    if (this.#disposed) throw new ReferenceError('AnimatedImageSource is disposed');
    if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
      throw new RangeError('timeUs must be a non-negative safe integer');
    }
    throwIfAborted(signal, 'Animated image decode');
    const loopDurationUs = this.#info.durationUs;
    const localUs =
      this.#info.repetitionCount === 0
        ? timeUs % loopDurationUs
        : Math.min(timeUs, loopDurationUs * (this.#info.repetitionCount + 1) - 1) % loopDurationUs;
    let accumulatedUs = 0;
    let frameIndex = this.#info.frameCount - 1;
    for (let index = 0; index < this.#info.frameDurationsUs.length; index += 1) {
      accumulatedUs += this.#info.frameDurationsUs[index] ?? 0;
      if (localUs < accumulatedUs) {
        frameIndex = index;
        break;
      }
    }
    const decoded = await this.#decoder.decode({ frameIndex, completeFramesOnly: true });
    try {
      throwIfAborted(signal, 'Animated image decode');
      return decoded.image.clone();
    } finally {
      decoded.image.close();
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#decoder.close();
  }
}
