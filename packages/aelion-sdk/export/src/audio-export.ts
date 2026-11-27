import { AelionError, throwIfAborted } from '@aelionsdk/core';
import type { StreamTargetChunk } from 'mediabunny';

import type { OfflineAudioRequest } from './webm-export.js';

export interface WavExportOptions {
  readonly durationUs: number;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly sampleFormat?: 's16' | 'f32';
  readonly sink: WritableStream<StreamTargetChunk>;
  readonly cleanupSink?: (reason: unknown) => void | Promise<void>;
  readonly renderAudio: (request: OfflineAudioRequest, signal?: AbortSignal) => Promise<Float32Array>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
  readonly blockFrames?: number;
}

export interface WavExportResult {
  readonly mimeType: 'audio/wav';
  readonly audioFrames: number;
  readonly durationUs: number;
  readonly bytesWritten: number;
  readonly rf64: boolean;
}

function ascii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function wavHeader(
  frames: number,
  sampleRate: number,
  channelCount: number,
  bytesPerSample: number,
  floatingPoint: boolean,
): { readonly bytes: Uint8Array; readonly rf64: boolean } {
  const dataBytes = frames * channelCount * bytesPerSample;
  const rf64 = dataBytes + 36 > 0xffff_ffff;
  const header = new Uint8Array(rf64 ? 80 : 44);
  const view = new DataView(header.buffer);
  ascii(view, 0, rf64 ? 'RF64' : 'RIFF');
  view.setUint32(4, rf64 ? 0xffff_ffff : dataBytes + 36, true);
  ascii(view, 8, 'WAVE');
  let offset = 12;
  if (rf64) {
    ascii(view, offset, 'ds64');
    view.setUint32(offset + 4, 28, true);
    view.setBigUint64(offset + 8, BigInt(dataBytes + header.byteLength - 8), true);
    view.setBigUint64(offset + 16, BigInt(dataBytes), true);
    view.setBigUint64(offset + 24, BigInt(frames), true);
    view.setUint32(offset + 32, 0, true);
    offset += 36;
  }
  ascii(view, offset, 'fmt ');
  view.setUint32(offset + 4, 16, true);
  view.setUint16(offset + 8, floatingPoint ? 3 : 1, true);
  view.setUint16(offset + 10, channelCount, true);
  view.setUint32(offset + 12, sampleRate, true);
  view.setUint32(offset + 16, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(offset + 20, channelCount * bytesPerSample, true);
  view.setUint16(offset + 22, bytesPerSample * 8, true);
  ascii(view, offset + 24, 'data');
  view.setUint32(offset + 28, rf64 ? 0xffff_ffff : dataBytes, true);
  return { bytes: header, rf64 };
}

function encodePcm(pcm: Float32Array, sampleFormat: 's16' | 'f32'): Uint8Array {
  const bytesPerSample = sampleFormat === 's16' ? 2 : 4;
  const bytes = new Uint8Array(pcm.length * bytesPerSample);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0));
    if (sampleFormat === 's16') {
      view.setInt16(index * 2, sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767), true);
    } else {
      view.setFloat32(index * 4, sample, true);
    }
  }
  return bytes;
}

export async function exportWav(options: WavExportOptions): Promise<WavExportResult> {
  if (!Number.isSafeInteger(options.durationUs) || options.durationUs <= 0) {
    throw new RangeError('durationUs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.sampleRate) || options.sampleRate <= 0) {
    throw new RangeError('sampleRate must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.channelCount) || options.channelCount <= 0) {
    throw new RangeError('channelCount must be a positive safe integer');
  }
  const sampleFormat = options.sampleFormat ?? 's16';
  const bytesPerSample = sampleFormat === 's16' ? 2 : 4;
  const totalFrames = Math.floor((options.durationUs * options.sampleRate) / 1_000_000);
  const header = wavHeader(
    totalFrames,
    options.sampleRate,
    options.channelCount,
    bytesPerSample,
    sampleFormat === 'f32',
  );
  const writer = options.sink.getWriter();
  let audioFrames = 0;
  let position = header.bytes.byteLength;
  try {
    throwIfAborted(options.signal, 'WAV export');
    await writer.write({ type: 'write', data: header.bytes as Uint8Array<ArrayBuffer>, position: 0 });
    const blockFrames = options.blockFrames ?? 4_096;
    if (!Number.isSafeInteger(blockFrames) || blockFrames <= 0) {
      throw new RangeError('blockFrames must be a positive safe integer');
    }
    while (audioFrames < totalFrames) {
      throwIfAborted(options.signal, 'WAV export');
      const frameCount = Math.min(blockFrames, totalFrames - audioFrames);
      const pcm = await options.renderAudio(
        {
          startFrame: audioFrames,
          frameCount,
          sampleRate: options.sampleRate,
          channelCount: options.channelCount,
        },
        options.signal,
      );
      if (pcm.length !== frameCount * options.channelCount) {
        throw new RangeError('renderAudio returned an unexpected interleaved PCM length');
      }
      const data = encodePcm(pcm, sampleFormat);
      await writer.write({ type: 'write', data: data as Uint8Array<ArrayBuffer>, position });
      position += data.byteLength;
      audioFrames += frameCount;
      options.onProgress?.(audioFrames / totalFrames);
    }
    await writer.close();
    if (totalFrames === 0) options.onProgress?.(1);
    return {
      mimeType: 'audio/wav',
      audioFrames,
      durationUs: options.durationUs,
      bytesWritten: position,
      rf64: header.rf64,
    };
  } catch (cause) {
    await writer.abort(cause).catch(() => undefined);
    await Promise.resolve(options.cleanupSink?.(cause)).catch(() => undefined);
    if (cause instanceof AelionError || cause instanceof RangeError) throw cause;
    throw new AelionError([
      {
        code: 'EXPORT_AUDIO_WRITE_FAILED',
        severity: 'error',
        message: cause instanceof Error ? cause.message : 'Audio export failed',
        recoverable: true,
        cause,
      },
    ]);
  }
}
