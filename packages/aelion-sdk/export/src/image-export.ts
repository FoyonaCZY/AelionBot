import { AelionError, frameDurationUs, frameStartUs, throwIfAborted, type Rational } from '@aelionsdk/core';
import type { StreamTargetChunk } from 'mediabunny';

import type { OfflineFrameRequest } from './webm-export.js';

export interface StillImageExportOptions {
  readonly timeUs: number;
  readonly width: number;
  readonly height: number;
  readonly format: 'png' | 'jpeg' | 'webp';
  readonly quality?: number;
  readonly sink: WritableStream<StreamTargetChunk>;
  readonly cleanupSink?: (reason: unknown) => void | Promise<void>;
  readonly renderFrame: (request: OfflineFrameRequest, signal?: AbortSignal) => Promise<VideoFrame>;
  readonly signal?: AbortSignal;
}

export interface StillImageExportResult {
  readonly mimeType: `image/${'png' | 'jpeg' | 'webp'}`;
  readonly bytesWritten: number;
  readonly timeUs: number;
}

export interface GifExportOptions {
  readonly durationUs: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly loopCount?: number;
  readonly sink: WritableStream<StreamTargetChunk>;
  readonly cleanupSink?: (reason: unknown) => void | Promise<void>;
  readonly renderFrame: (request: OfflineFrameRequest, signal?: AbortSignal) => Promise<VideoFrame>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}

export interface GifExportResult {
  readonly mimeType: 'image/gif';
  readonly videoFrames: number;
  readonly durationUs: number;
  readonly bytesWritten: number;
}

function assertDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 65_535 ||
    height > 65_535
  ) {
    throw new RangeError('Image dimensions must be integers between 1 and 65535');
  }
}

async function cleanupFailure(
  writer: WritableStreamDefaultWriter<StreamTargetChunk>,
  cleanupSink: StillImageExportOptions['cleanupSink'],
  cause: unknown,
): Promise<never> {
  await writer.abort(cause).catch(() => undefined);
  await Promise.resolve(cleanupSink?.(cause)).catch(() => undefined);
  if (cause instanceof AelionError || cause instanceof RangeError) throw cause;
  throw new AelionError([
    {
      code: 'EXPORT_IMAGE_WRITE_FAILED',
      severity: 'error',
      message: cause instanceof Error ? cause.message : 'Image export failed',
      recoverable: true,
      cause,
    },
  ]);
}

export async function exportStillImage(options: StillImageExportOptions): Promise<StillImageExportResult> {
  assertDimensions(options.width, options.height);
  if (!Number.isSafeInteger(options.timeUs) || options.timeUs < 0) {
    throw new RangeError('timeUs must be a non-negative safe integer');
  }
  if (options.quality !== undefined && (options.quality < 0 || options.quality > 1)) {
    throw new RangeError('quality must be between 0 and 1');
  }
  const writer = options.sink.getWriter();
  try {
    throwIfAborted(options.signal, 'Still image export');
    const frame = await options.renderFrame(
      {
        frameIndex: 0,
        timestampUs: options.timeUs,
        durationUs: 1,
        width: options.width,
        height: options.height,
      },
      options.signal,
    );
    const canvas = new OffscreenCanvas(options.width, options.height);
    try {
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('2D canvas is unavailable');
      context.drawImage(frame, 0, 0, options.width, options.height);
    } finally {
      frame.close();
    }
    throwIfAborted(options.signal, 'Still image export');
    const mimeType = `image/${options.format}` as const;
    const blob = await canvas.convertToBlob({
      type: mimeType,
      ...(options.quality === undefined ? {} : { quality: options.quality }),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writer.write({ type: 'write', data: bytes, position: 0 });
    await writer.close();
    return { mimeType, bytesWritten: bytes.byteLength, timeUs: options.timeUs };
  } catch (cause) {
    return cleanupFailure(writer, options.cleanupSink, cause);
  }
}

function littleEndian16(value: number): readonly [number, number] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function gifPalette(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  for (let index = 0; index < 256; index += 1) {
    palette[index * 3] = Math.round((((index >>> 5) & 7) * 255) / 7);
    palette[index * 3 + 1] = Math.round((((index >>> 2) & 7) * 255) / 7);
    palette[index * 3 + 2] = Math.round(((index & 3) * 255) / 3);
  }
  return palette;
}

function quantize(image: ImageData): Uint8Array {
  const pixels = new Uint8Array(image.width * image.height);
  for (let index = 0; index < pixels.length; index += 1) {
    const offset = index * 4;
    pixels[index] =
      (((image.data[offset] ?? 0) >>> 5) << 5) |
      (((image.data[offset + 1] ?? 0) >>> 5) << 2) |
      ((image.data[offset + 2] ?? 0) >>> 6);
  }
  return pixels;
}

function lzwData(pixels: Uint8Array): Uint8Array {
  const codes: number[] = [256];
  let literalsSinceClear = 0;
  for (const pixel of pixels) {
    if (literalsSinceClear >= 250) {
      codes.push(256);
      literalsSinceClear = 0;
    }
    codes.push(pixel);
    literalsSinceClear += 1;
  }
  codes.push(257);
  const packed = new Uint8Array(Math.ceil((codes.length * 9) / 8));
  let bitOffset = 0;
  for (const code of codes) {
    for (let bit = 0; bit < 9; bit += 1) {
      if ((code & (1 << bit)) !== 0) {
        const byteIndex = bitOffset >>> 3;
        packed[byteIndex] = (packed[byteIndex] ?? 0) | (1 << (bitOffset & 7));
      }
      bitOffset += 1;
    }
  }
  const blocks: number[] = [8];
  for (let offset = 0; offset < packed.length; offset += 255) {
    const size = Math.min(255, packed.length - offset);
    blocks.push(size, ...packed.subarray(offset, offset + size));
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

function gifHeader(width: number, height: number, loopCount: number): Uint8Array {
  const [widthLow, widthHigh] = littleEndian16(width);
  const [heightLow, heightHigh] = littleEndian16(height);
  const [loopLow, loopHigh] = littleEndian16(loopCount);
  return Uint8Array.from([
    ...new TextEncoder().encode('GIF89a'),
    widthLow,
    widthHigh,
    heightLow,
    heightHigh,
    0xf7,
    0,
    0,
    ...gifPalette(),
    0x21,
    0xff,
    0x0b,
    ...new TextEncoder().encode('NETSCAPE2.0'),
    3,
    1,
    loopLow,
    loopHigh,
    0,
  ]);
}

function gifFrame(width: number, height: number, delayCs: number, pixels: Uint8Array): Uint8Array {
  const [widthLow, widthHigh] = littleEndian16(width);
  const [heightLow, heightHigh] = littleEndian16(height);
  const [delayLow, delayHigh] = littleEndian16(Math.max(1, Math.min(65_535, delayCs)));
  const control = Uint8Array.from([0x21, 0xf9, 4, 0, delayLow, delayHigh, 0, 0]);
  const descriptor = Uint8Array.from([0x2c, 0, 0, 0, 0, widthLow, widthHigh, heightLow, heightHigh, 0]);
  const image = lzwData(pixels);
  const result = new Uint8Array(control.length + descriptor.length + image.length);
  result.set(control, 0);
  result.set(descriptor, control.length);
  result.set(image, control.length + descriptor.length);
  return result;
}

export async function exportGif(options: GifExportOptions): Promise<GifExportResult> {
  assertDimensions(options.width, options.height);
  if (!Number.isSafeInteger(options.durationUs) || options.durationUs <= 0) {
    throw new RangeError('durationUs must be a positive safe integer');
  }
  const loopCount = options.loopCount ?? 0;
  if (!Number.isSafeInteger(loopCount) || loopCount < 0 || loopCount > 65_535) {
    throw new RangeError('loopCount must be an integer between 0 and 65535');
  }
  const frameCount = Math.ceil(
    (options.durationUs * options.frameRate.numerator) / (1_000_000 * options.frameRate.denominator),
  );
  const writer = options.sink.getWriter();
  let position = 0;
  let videoFrames = 0;
  try {
    const header = gifHeader(options.width, options.height, loopCount);
    await writer.write({ type: 'write', data: header as Uint8Array<ArrayBuffer>, position });
    position += header.byteLength;
    const canvas = new OffscreenCanvas(options.width, options.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('2D canvas is unavailable');
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      throwIfAborted(options.signal, 'GIF export');
      const timestampUs = frameStartUs(frameIndex, options.frameRate);
      const durationUs = Math.min(frameDurationUs(frameIndex, options.frameRate), options.durationUs - timestampUs);
      if (durationUs <= 0) break;
      const frame = await options.renderFrame(
        {
          frameIndex,
          timestampUs,
          durationUs,
          width: options.width,
          height: options.height,
        },
        options.signal,
      );
      try {
        context.clearRect(0, 0, options.width, options.height);
        context.drawImage(frame, 0, 0, options.width, options.height);
      } finally {
        frame.close();
      }
      const data = gifFrame(
        options.width,
        options.height,
        Math.round(durationUs / 10_000),
        quantize(context.getImageData(0, 0, options.width, options.height)),
      );
      await writer.write({ type: 'write', data: data as Uint8Array<ArrayBuffer>, position });
      position += data.byteLength;
      videoFrames += 1;
      options.onProgress?.(videoFrames / frameCount);
    }
    const trailer = Uint8Array.of(0x3b);
    await writer.write({ type: 'write', data: trailer, position });
    position += 1;
    await writer.close();
    return {
      mimeType: 'image/gif',
      videoFrames,
      durationUs: options.durationUs,
      bytesWritten: position,
    };
  } catch (cause) {
    return cleanupFailure(writer, options.cleanupSink, cause);
  }
}
