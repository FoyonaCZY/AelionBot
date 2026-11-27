import { throwIfAborted, type Diagnostic } from '@aelionsdk/core';
import {
  ALL_FORMATS,
  AudioSampleSink,
  BufferSource,
  CustomSource,
  EncodedPacketSink,
  Input,
  MATROSKA,
  MP4,
  MPEG_TS,
  QTFF,
  VideoSampleSink,
  WEBM,
  type EncodedPacket,
  type InputTrack,
  type InputVideoTrack,
  type VideoSample,
} from 'mediabunny';

import type {
  AudioTrackInfo,
  MediaProbeOptions,
  SampleEntry,
  SampleIndex,
  TrackInfo,
  VideoTrackInfo,
  RangeReader,
} from './types.js';
import { resolveVideoSeek } from './seek.js';

const MICROSECONDS_PER_SECOND = 1_000_000;
let activeVideoDecoders = 0;
let retainedVideoFrames = 0;

function inputFromReader(reader: RangeReader, signal?: AbortSignal): Input {
  return new Input({
    source: new CustomSource({
      getSize: () => reader.size(signal),
      read: async (start, end) => {
        const result = await reader.read({ offset: start, length: end - start }, signal);
        return result.bytes;
      },
      maxCacheSize: 8 * 1_024 * 1_024,
      prefetchProfile: reader.kind === 'network' ? 'network' : 'fileSystem',
    }),
    formats: ALL_FORMATS,
  });
}

export function videoDecoderResourceSnapshot(): {
  readonly activeDecoders: number;
  readonly retainedFrames: number;
} {
  return { activeDecoders: activeVideoDecoders, retainedFrames: retainedVideoFrames };
}

function secondsToUs(value: number, context: string): number {
  const microseconds = Math.round(value * MICROSECONDS_PER_SECOND);
  if (!Number.isSafeInteger(microseconds)) {
    throw new RangeError(`${context} is outside the safe microsecond range`);
  }
  return microseconds;
}

function diagnostic(code: string, message: string): Diagnostic {
  return {
    code,
    severity: 'warning',
    message,
    recoverable: true,
  };
}

function adapterLimitDiagnostics(): readonly Diagnostic[] {
  return [
    diagnostic(
      'MEDIA_RAW_DTS_UNAVAILABLE',
      'The container adapter exposes decode order and PTS, but not raw container DTS.',
    ),
    diagnostic(
      'MEDIA_SAMPLE_OFFSET_UNAVAILABLE',
      'The container adapter exposes encoded sample size, but not a stable physical byte offset.',
    ),
  ];
}

function codecFamily(codec: string | null): string {
  return codec ?? 'unknown';
}

function description(config: VideoDecoderConfig | AudioDecoderConfig | null): Uint8Array | undefined {
  const source = config?.description;
  if (source === undefined) return undefined;
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
  }
  return new Uint8Array(source.slice(0));
}

function copyVideoDecoderConfig(config: VideoDecoderConfig): VideoDecoderConfig {
  const configDescription = description(config);
  return {
    ...config,
    ...(configDescription === undefined ? {} : { description: configDescription }),
  };
}

async function videoTrackInfo(track: InputVideoTrack): Promise<VideoTrackInfo> {
  const [
    codec,
    codecString,
    width,
    height,
    rotation,
    colorSpace,
    highDynamicRange,
    canBeTransparent,
    timeResolution,
    config,
  ] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getCodedWidth(),
    track.getCodedHeight(),
    track.getRotation(),
    track.getColorSpace(),
    track.hasHighDynamicRange(),
    track.canBeTransparent(),
    track.getTimeResolution(),
    track.getDecoderConfig(),
  ]);
  const configDescription = description(config);
  return {
    kind: 'video',
    id: track.id,
    codec: codecString ?? codec ?? 'unknown',
    codecFamily: codecFamily(codec),
    codedWidth: width,
    codedHeight: height,
    rotation,
    color: {
      primaries: colorSpace.primaries ?? null,
      transfer: colorSpace.transfer ?? null,
      matrix: colorSpace.matrix ?? null,
      fullRange: colorSpace.fullRange ?? null,
      highDynamicRange,
      canBeTransparent,
    },
    timeBase: { numerator: 1, denominator: timeResolution },
    ...(configDescription === undefined ? {} : { description: configDescription }),
  };
}

async function audioTrackInfo(track: InputTrack): Promise<AudioTrackInfo> {
  if (!track.isAudioTrack()) throw new TypeError('Track is not audio');
  const [codec, codecString, sampleRate, channelCount, timeResolution, config] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getSampleRate(),
    track.getNumberOfChannels(),
    track.getTimeResolution(),
    track.getDecoderConfig(),
  ]);
  const configDescription = description(config);
  return {
    kind: 'audio',
    id: track.id,
    codec: codecString ?? codec ?? 'unknown',
    codecFamily: codecFamily(codec),
    sampleRate,
    channelCount,
    timeBase: { numerator: 1, denominator: timeResolution },
    ...(configDescription === undefined ? {} : { description: configDescription }),
  };
}

function packetEntry(
  track: InputTrack,
  packet: EncodedPacket,
  decodeOrder: number,
  normalizedDecodeTimeUs: number,
): SampleEntry {
  return {
    trackId: track.id,
    sampleIndex: decodeOrder,
    kind: track.isVideoTrack() ? 'video' : 'audio',
    decodeOrder,
    presentationOrder: -1,
    sourceSequenceNumber: packet.sequenceNumber,
    presentationTimestampUs: packet.microsecondTimestamp,
    durationUs: packet.microsecondDuration,
    // Normalize the decode timeline to zero and accumulate durations in
    // strict decode order. Raw container DTS origin remains adapter-private.
    normalizedDecodeTimeUs,
    isSync: packet.type === 'key',
    byteLength: packet.byteLength,
  };
}

function assignPresentationOrder(samples: readonly SampleEntry[]): {
  readonly samples: readonly SampleEntry[];
  readonly presentationOrder: readonly number[];
} {
  const order = samples
    .map((_, index) => index)
    .sort((left, right) => {
      const leftSample = samples[left];
      const rightSample = samples[right];
      return (leftSample?.presentationTimestampUs ?? 0) - (rightSample?.presentationTimestampUs ?? 0) || left - right;
    });
  const position = new Map(order.map((sampleIndex, presentationOrder) => [sampleIndex, presentationOrder]));
  return {
    samples: samples.map((sample) => ({
      ...sample,
      presentationOrder: position.get(sample.sampleIndex) ?? -1,
    })),
    presentationOrder: order,
  };
}

async function indexTrack(
  track: InputTrack,
  signal: AbortSignal | undefined,
): Promise<{
  readonly samples: readonly SampleEntry[];
  readonly presentationOrder: readonly number[];
}> {
  const sink = new EncodedPacketSink(track);
  const samples: SampleEntry[] = [];
  let normalizedDecodeTimeUs = 0;
  for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
    throwIfAborted(signal, 'media sample indexing');
    samples.push(packetEntry(track, packet, samples.length, normalizedDecodeTimeUs));
    normalizedDecodeTimeUs += packet.microsecondDuration;
  }
  return assignPresentationOrder(samples);
}

export async function createSampleIndex(bytes: Uint8Array, options: MediaProbeOptions = {}): Promise<SampleIndex> {
  throwIfAborted(options.signal, 'media probe');
  const input = new Input({
    source: new BufferSource(bytes),
    formats: ALL_FORMATS,
  });

  try {
    const [format, durationSeconds, tracks] = await Promise.all([
      input.getFormat(),
      input.computeDuration(),
      input.getTracks(),
    ]);
    throwIfAborted(options.signal, 'media probe');
    const trackInfos = await Promise.all<TrackInfo>(
      tracks.map((track) => (track.isVideoTrack() ? videoTrackInfo(track) : audioTrackInfo(track))),
    );
    const diagnostics: Diagnostic[] = [...adapterLimitDiagnostics()];
    const samples: Record<number, readonly SampleEntry[]> = {};
    const presentationOrder: Record<number, readonly number[]> = {};

    if (options.includeSamples ?? true) {
      for (const track of tracks) {
        const indexed = await indexTrack(track, options.signal);
        samples[track.id] = indexed.samples;
        presentationOrder[track.id] = indexed.presentationOrder;
      }
    }

    return {
      schemaVersion: '1.0.0',
      container:
        format === MP4
          ? 'mp4'
          : format === QTFF
            ? 'mov'
            : format === MATROSKA
              ? 'mkv'
              : format === MPEG_TS
                ? 'ts'
                : format === WEBM
                  ? 'webm'
                  : 'unknown',
      durationUs: secondsToUs(durationSeconds, 'media duration'),
      tracks: trackInfos,
      capabilities: {
        timingAndSize: true,
        rawDecodeTimestamps: false,
        byteOffsets: false,
      },
      samples,
      presentationOrder,
      diagnostics,
    };
  } finally {
    input.dispose();
  }
}

export async function createSampleIndexFromReader(
  reader: RangeReader,
  options: MediaProbeOptions = {},
): Promise<SampleIndex> {
  throwIfAborted(options.signal, 'media range probe');
  const input = inputFromReader(reader, options.signal);
  try {
    const [format, durationSeconds, tracks] = await Promise.all([
      input.getFormat(),
      input.computeDuration(),
      input.getTracks(),
    ]);
    const trackInfos = await Promise.all<TrackInfo>(
      tracks.map((track) => (track.isVideoTrack() ? videoTrackInfo(track) : audioTrackInfo(track))),
    );
    const samples: Record<number, readonly SampleEntry[]> = {};
    const presentationOrder: Record<number, readonly number[]> = {};
    if (options.includeSamples ?? true) {
      for (const track of tracks) {
        const indexed = await indexTrack(track, options.signal);
        samples[track.id] = indexed.samples;
        presentationOrder[track.id] = indexed.presentationOrder;
      }
    }
    return {
      schemaVersion: '1.0.0',
      container:
        format === MP4
          ? 'mp4'
          : format === QTFF
            ? 'mov'
            : format === MATROSKA
              ? 'mkv'
              : format === MPEG_TS
                ? 'ts'
                : format === WEBM
                  ? 'webm'
                  : 'unknown',
      durationUs: secondsToUs(durationSeconds, 'media duration'),
      tracks: trackInfos,
      capabilities: {
        timingAndSize: true,
        rawDecodeTimestamps: false,
        byteOffsets: false,
      },
      samples,
      presentationOrder,
      diagnostics: adapterLimitDiagnostics(),
    };
  } finally {
    input.dispose();
  }
}

export async function probeSampleIndex(
  bytes: Uint8Array,
  options: MediaProbeOptions = {},
): Promise<
  | { readonly ok: true; readonly index: SampleIndex }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
> {
  try {
    return { ok: true, index: await createSampleIndex(bytes, options) };
  } catch (cause) {
    return {
      ok: false,
      diagnostics: [
        {
          code: 'MEDIA_INPUT_INVALID',
          severity: 'error',
          message: cause instanceof Error ? cause.message : 'Input media is unsupported or corrupt',
          recoverable: false,
          cause,
        },
      ],
    };
  }
}

export interface VideoDecodeResult {
  readonly frame: VideoFrame;
  readonly timestampUs: number;
  readonly durationUs: number;
  readonly decodedPackets: number;
  readonly plannedPackets: number;
  readonly decodeStartUs: number;
  readonly targetUs: number;
  close(): void;
}

export interface VideoDecodeOptions {
  readonly signal?: AbortSignal;
  readonly maxDecodeQueueSize?: number;
  /** Zero-based index within the container's video tracks. */
  readonly streamIndex?: number;
  /** A caller-owned immutable index may be reused to avoid cold re-indexing on warm seeks. */
  readonly sampleIndex?: SampleIndex;
}

export interface VideoFrameDecodeSessionOptions {
  /** Zero-based index within the container's video tracks. */
  readonly streamIndex?: number;
  /** Maximum decoded frames retained by this session. */
  readonly maxCachedFrames?: number;
  /** Maximum decoded frame bytes retained by this session. */
  readonly maxCachedBytes?: number;
  /**
   * Forward jumps larger than this restart at the nearest GOP instead of
   * decoding every intervening frame.
   */
  readonly maxSequentialGapUs?: number;
}

export interface VideoFrameDecodeSessionSnapshot {
  readonly streamIndex: number;
  readonly cachedFrames: number;
  readonly cachedBytes: number;
  readonly maxCachedFrames: number;
  readonly maxCachedBytes: number;
  readonly maxSequentialGapUs: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly seeks: number;
  readonly sequentialFrames: number;
  readonly resets: number;
  readonly active: boolean;
  readonly disposed: boolean;
}

interface CachedVideoFrame {
  readonly frame: VideoFrame;
  readonly byteLength: number;
  access: number;
}

export interface AudioPcmBlock {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly startUs: number;
  readonly durationUs: number;
  readonly frameCount: number;
  readonly interleaved: Float32Array;
}

export interface AudioDecodeOptions {
  readonly signal?: AbortSignal;
  readonly streamIndex?: number;
}

/** Options for {@link AudioPcmDecodeSession}. */
export interface AudioPcmDecodeSessionOptions {
  /**
   * Which audio stream of the container to decode, counted across audio tracks
   * only. Defaults to the first.
   */
  readonly streamIndex?: number;
}

export async function decodeAudioPcmRange(
  bytes: Uint8Array,
  startUs: number,
  durationUs: number,
  options: AudioDecodeOptions = {},
): Promise<AudioPcmBlock> {
  return decodeAudioPcmRangeFromInput(
    new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS }),
    startUs,
    durationUs,
    options,
  );
}

/** Decode an audio interval without first loading the complete media resource. */
export async function decodeAudioPcmRangeFromReader(
  reader: RangeReader,
  startUs: number,
  durationUs: number,
  options: AudioDecodeOptions = {},
): Promise<AudioPcmBlock> {
  return decodeAudioPcmRangeFromInput(inputFromReader(reader, options.signal), startUs, durationUs, options);
}

function assertAudioDecodeRange(startUs: number, durationUs: number): void {
  if (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(durationUs) || startUs < 0 || durationUs <= 0) {
    throw new RangeError('Audio decode range must use non-negative safe integer microseconds');
  }
}

async function readPcmFromSink(
  sink: AudioSampleSink,
  sampleRate: number,
  channelCount: number,
  startUs: number,
  durationUs: number,
  signal?: AbortSignal,
): Promise<AudioPcmBlock> {
  throwIfAborted(signal, 'audio PCM decode');
  const frameCount = Math.ceil((durationUs * sampleRate) / MICROSECONDS_PER_SECOND);
  const output = new Float32Array(frameCount * channelCount);
  const endUs = startUs + durationUs;
  for await (const sample of sink.samples(startUs / MICROSECONDS_PER_SECOND, endUs / MICROSECONDS_PER_SECOND)) {
    throwIfAborted(signal, 'audio PCM decode');
    try {
      const sampleStartFrame = Math.round(
        ((sample.microsecondTimestamp - startUs) * sampleRate) / MICROSECONDS_PER_SECOND,
      );
      const sourceOffset = Math.max(0, -sampleStartFrame);
      const destinationOffset = Math.max(0, sampleStartFrame);
      const frames = Math.min(sample.numberOfFrames - sourceOffset, frameCount - destinationOffset);
      if (frames <= 0) continue;
      const copied = new Float32Array(frames * channelCount);
      sample.copyTo(copied, {
        planeIndex: 0,
        format: 'f32',
        frameOffset: sourceOffset,
        frameCount: frames,
      });
      output.set(copied, destinationOffset * channelCount);
    } finally {
      sample.close();
    }
  }
  return {
    sampleRate,
    channelCount,
    startUs,
    durationUs,
    frameCount,
    interleaved: output,
  };
}

async function decodeAudioPcmRangeFromInput(
  input: Input,
  startUs: number,
  durationUs: number,
  options: AudioDecodeOptions,
): Promise<AudioPcmBlock> {
  throwIfAborted(options.signal, 'audio PCM decode');
  assertAudioDecodeRange(startUs, durationUs);
  try {
    const tracks = await input.getAudioTracks();
    const track = tracks[options.streamIndex ?? 0];
    if (track === undefined) throw new RangeError('Requested audio stream does not exist');
    const sampleRate = await track.getSampleRate();
    const channelCount = await track.getNumberOfChannels();
    return await readPcmFromSink(
      new AudioSampleSink(track),
      sampleRate,
      channelCount,
      startUs,
      durationUs,
      options.signal,
    );
  } finally {
    input.dispose();
  }
}

/**
 * Reuses one Input and AudioSampleSink across sequential PCM fills.
 *
 * Playback used to construct a new 8 MiB CustomSource and container parser on
 * every ~85 ms mix. After a few dozen seconds the leftover caches and decoder
 * wrappers made preview hitch. Callers still get a fresh decoder per range
 * (mediabunny's samples() API), so pair this with a short PCM window cache.
 */
export class AudioPcmDecodeSession {
  readonly #reader: RangeReader;
  readonly #streamIndex: number;
  #input: Input | undefined;
  #sink: AudioSampleSink | undefined;
  #sampleRate = 0;
  #channelCount = 0;
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;

  public constructor(reader: RangeReader, options: AudioPcmDecodeSessionOptions = {}) {
    this.#reader = reader;
    this.#streamIndex = options.streamIndex ?? 0;
    if (!Number.isSafeInteger(this.#streamIndex) || this.#streamIndex < 0) {
      throw new RangeError('streamIndex must be a non-negative safe integer');
    }
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public pcmRange(startUs: number, durationUs: number, signal?: AbortSignal): Promise<AudioPcmBlock> {
    if (this.#disposed) throw new ReferenceError('AudioPcmDecodeSession is disposed');
    assertAudioDecodeRange(startUs, durationUs);
    const task = this.#tail.then(() => this.#pcmRangeOnce(startUs, durationUs, signal));
    this.#tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sink = undefined;
    this.#input?.dispose();
    this.#input = undefined;
  }

  async #pcmRangeOnce(startUs: number, durationUs: number, signal?: AbortSignal): Promise<AudioPcmBlock> {
    if (this.#disposed) throw new ReferenceError('AudioPcmDecodeSession is disposed');
    await this.#ensure(signal);
    const sink = this.#sink;
    if (sink === undefined) throw new ReferenceError('AudioPcmDecodeSession is not initialized');
    return readPcmFromSink(sink, this.#sampleRate, this.#channelCount, startUs, durationUs, signal);
  }

  async #ensure(signal?: AbortSignal): Promise<void> {
    if (this.#sink !== undefined) return;
    const input = inputFromReader(this.#reader, signal);
    try {
      throwIfAborted(signal, 'audio PCM decode');
      const tracks = await input.getAudioTracks();
      const track = tracks[this.#streamIndex];
      if (track === undefined) throw new RangeError('Requested audio stream does not exist');
      this.#sampleRate = await track.getSampleRate();
      this.#channelCount = await track.getNumberOfChannels();
      this.#sink = new AudioSampleSink(track);
      this.#input = input;
    } catch (error) {
      input.dispose();
      throw error;
    }
  }
}

/**
 * Opens an {@link AudioPcmDecodeSession} over a range reader, so consecutive PCM
 * windows share one demuxer and decoder instead of reopening the container per
 * request.
 *
 * The session owns decoder resources until disposed; callers that need a single
 * isolated range should use {@link decodeAudioPcmRangeFromReader} instead.
 */
export function createAudioPcmDecodeSessionFromReader(
  reader: RangeReader,
  options: AudioPcmDecodeSessionOptions = {},
): AudioPcmDecodeSession {
  return new AudioPcmDecodeSession(reader, options);
}

async function waitForDecodeCapacity(
  decoder: VideoDecoder,
  maxDecodeQueueSize: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  while (decoder.decodeQueueSize >= maxDecodeQueueSize) {
    throwIfAborted(signal, 'video exact seek');
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        decoder.removeEventListener('dequeue', onDequeue);
        reject(new DOMException('Video decode wait was aborted', 'AbortError'));
      };
      const onDequeue = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      decoder.addEventListener('dequeue', onDequeue, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function positiveSessionInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function videoFrameBytes(frame: VideoFrame): number {
  try {
    return frame.allocationSize();
  } catch {
    return frame.codedWidth * frame.codedHeight * 4;
  }
}

function decodeResultFromFrame(
  frame: VideoFrame,
  options: {
    readonly timestampUs: number;
    readonly durationUs: number;
    readonly decodedPackets: number;
    readonly plannedPackets: number;
    readonly decodeStartUs: number;
    readonly targetUs: number;
  },
): VideoDecodeResult {
  let closed = false;
  retainedVideoFrames += 1;
  return {
    frame,
    ...options,
    close: () => {
      if (closed) return;
      closed = true;
      frame.close();
      retainedVideoFrames -= 1;
    },
  };
}

function settleQuietly(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(resolve, timeoutMs);
    void promise.then(
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
    );
  });
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      try {
        onTimeout();
      } catch {
        // Timeout observers cannot hide the stall.
      }
      reject(new DOMException('Persistent video decode stalled', 'AbortError'));
    }, timeoutMs);
    void promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error('Persistent video decode failed'));
      },
    );
  });
}

async function detachDecoderFrame(frame: VideoFrame): Promise<VideoFrame> {
  if (typeof createImageBitmap !== 'function') return frame;
  const timestamp = frame.timestamp;
  const duration = frame.duration;
  const bitmap = await createImageBitmap(frame);
  frame.close();
  try {
    return new VideoFrame(bitmap, {
      timestamp,
      ...(duration === null ? {} : { duration }),
    });
  } finally {
    bitmap.close();
  }
}

function operationWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal, 'persistent video decode');
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Persistent video decode was aborted', 'AbortError'),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('Persistent video decode failed'));
      },
    );
  });
}

/**
 * A bounded, persistent video decoder session.
 *
 * Sequential requests share one Input, decoder and packet iterator. Backward
 * seeks and large forward jumps restart at the nearest verified key packet.
 * Returned frames are caller-owned; cached frames remain session-owned.
 */
export class VideoFrameDecodeSession {
  readonly #reader: RangeReader;
  readonly #index: SampleIndex;
  readonly #streamIndex: number;
  readonly #videoInfo: VideoTrackInfo;
  readonly #maxCachedFrames: number;
  readonly #maxCachedBytes: number;
  readonly #maxSequentialGapUs: number;
  readonly #cache = new Map<number, CachedVideoFrame>();
  #input: Input | undefined;
  #iterator: AsyncIterator<VideoSample> | undefined;
  #current: VideoSample | undefined;
  #lookahead: VideoSample | undefined;
  #inputAbort: AbortController | undefined;
  #tail: Promise<void> = Promise.resolve();
  #clock = 0;
  #cachedBytes = 0;
  #cacheHits = 0;
  #cacheMisses = 0;
  #seeks = 0;
  #sequentialFrames = 0;
  #resets = 0;
  #decoderActive = false;
  #disposed = false;

  public constructor(reader: RangeReader, index: SampleIndex, options: VideoFrameDecodeSessionOptions = {}) {
    this.#reader = reader;
    this.#index = index;
    this.#streamIndex = options.streamIndex ?? 0;
    if (!Number.isSafeInteger(this.#streamIndex) || this.#streamIndex < 0) {
      throw new RangeError('streamIndex must be a non-negative safe integer');
    }
    const videoInfo = index.tracks.filter((track) => track.kind === 'video')[this.#streamIndex];
    if (videoInfo === undefined) throw new RangeError('Requested video stream does not exist');
    this.#videoInfo = videoInfo;
    this.#maxCachedFrames = positiveSessionInteger(options.maxCachedFrames ?? 24, 'maxCachedFrames');
    this.#maxCachedBytes = positiveSessionInteger(options.maxCachedBytes ?? 96 * 1_024 * 1_024, 'maxCachedBytes');
    this.#maxSequentialGapUs = positiveSessionInteger(options.maxSequentialGapUs ?? 3_000_000, 'maxSequentialGapUs');
  }

  public frameAt(targetUs: number, signal?: AbortSignal): Promise<VideoDecodeResult> {
    if (this.#disposed) {
      return Promise.reject(new ReferenceError('VideoFrameDecodeSession is disposed'));
    }
    if (!Number.isSafeInteger(targetUs) || targetUs < 0) {
      return Promise.reject(new RangeError('targetUs must be a non-negative safe integer'));
    }
    const operation = this.#tail.then(() => this.#frameAt(targetUs, signal));
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    if (signal === undefined) return operation;
    void operation.then(
      (result) => {
        if (signal.aborted) result.close();
      },
      () => undefined,
    );
    return operationWithSignal(operation, signal);
  }

  public snapshot(): VideoFrameDecodeSessionSnapshot {
    return {
      streamIndex: this.#streamIndex,
      cachedFrames: this.#cache.size,
      cachedBytes: this.#cachedBytes,
      maxCachedFrames: this.#maxCachedFrames,
      maxCachedBytes: this.#maxCachedBytes,
      maxSequentialGapUs: this.#maxSequentialGapUs,
      cacheHits: this.#cacheHits,
      cacheMisses: this.#cacheMisses,
      seeks: this.#seeks,
      sequentialFrames: this.#sequentialFrames,
      resets: this.#resets,
      active: this.#decoderActive,
      disposed: this.#disposed,
    };
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.#reset(false);
    for (const cached of this.#cache.values()) {
      cached.frame.close();
      retainedVideoFrames -= 1;
    }
    this.#cache.clear();
    this.#cachedBytes = 0;
  }

  async #frameAt(targetUs: number, signal?: AbortSignal): Promise<VideoDecodeResult> {
    if (this.#disposed) throw new ReferenceError('VideoFrameDecodeSession is disposed');
    throwIfAborted(signal, 'persistent video decode');
    const abortInput = (): void => {
      this.#inputAbort?.abort(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('Persistent video decode was aborted', 'AbortError'),
      );
    };
    signal?.addEventListener('abort', abortInput, { once: true });
    try {
      return await this.#frameAtOnce(targetUs, signal);
    } finally {
      signal?.removeEventListener('abort', abortInput);
    }
  }

  async #frameAtOnce(targetUs: number, signal?: AbortSignal): Promise<VideoDecodeResult> {
    const seek = resolveVideoSeek(this.#index, this.#videoInfo.id, targetUs);
    const cached = this.#cache.get(seek.presentationUs);
    if (cached !== undefined) {
      cached.access = ++this.#clock;
      this.#cacheHits += 1;
      return decodeResultFromFrame(cached.frame.clone(), {
        timestampUs: seek.presentationUs,
        durationUs: cached.frame.duration ?? 0,
        decodedPackets: 0,
        plannedPackets: seek.samplesToDecode,
        decodeStartUs: seek.decodeStartUs,
        targetUs,
      });
    }
    this.#cacheMisses += 1;

    const currentUs = this.#current?.microsecondTimestamp;
    if (
      currentUs === undefined ||
      seek.presentationUs < currentUs ||
      seek.presentationUs - currentUs > this.#maxSequentialGapUs
    ) {
      await this.#start(seek.presentationUs, signal);
    }

    let decodedSamples = 0;
    const maxSteps = Math.min(48, Math.max(1, seek.samplesToDecode));
    while (
      this.#current !== undefined &&
      this.#current.microsecondTimestamp < seek.presentationUs &&
      decodedSamples < maxSteps
    ) {
      throwIfAborted(signal, 'persistent video decode');
      const next = await this.#next(signal);
      if (next === undefined) break;
      this.#current.close();
      this.#current = next;
      decodedSamples += 1;
      this.#sequentialFrames += 1;
    }

    if (this.#current === undefined) {
      await this.#start(seek.presentationUs, signal);
    }
    if (this.#current === undefined) {
      throw new Error(`Persistent seek expected PTS ${seek.presentationUs}, received end-of-stream`);
    }

    const decodedFrame = await detachDecoderFrame(this.#current.toVideoFrame());
    const result = decodeResultFromFrame(decodedFrame.clone(), {
      timestampUs: seek.presentationUs,
      durationUs: this.#current.microsecondDuration,
      decodedPackets: Math.max(1, decodedSamples),
      plannedPackets: seek.samplesToDecode,
      decodeStartUs: seek.decodeStartUs,
      targetUs,
    });
    this.#cacheFrame(seek.presentationUs, decodedFrame);
    return result;
  }

  async #start(targetUs: number, signal?: AbortSignal): Promise<void> {
    await this.#reset();
    throwIfAborted(signal, 'persistent video seek');
    this.#inputAbort = new AbortController();
    this.#input = inputFromReader(this.#reader, this.#inputAbort.signal);
    try {
      const tracks = await operationWithSignal(this.#input.getVideoTracks(), signal);
      const track = tracks.find((candidate) => candidate.id === this.#videoInfo.id);
      if (track === undefined) throw new Error('Indexed video track is missing from input');
      const sink = new VideoSampleSink(track, { optimizeForLatency: true });
      this.#iterator = sink.samples(targetUs / MICROSECONDS_PER_SECOND)[Symbol.asyncIterator]();
      this.#decoderActive = true;
      activeVideoDecoders += 1;
      this.#seeks += 1;
      const first = await this.#next(signal);
      if (first === undefined) throw new Error('Video stream ended before the requested timestamp');
      this.#current = first;
    } catch (error) {
      await this.#reset();
      throw error;
    }
  }

  async #next(signal?: AbortSignal): Promise<VideoSample | undefined> {
    if (this.#lookahead !== undefined) {
      const sample = this.#lookahead;
      this.#lookahead = undefined;
      return sample;
    }
    const iterator = this.#iterator;
    if (iterator === undefined) return undefined;
    try {
      const result = await operationWithSignal(
        withDeadline(iterator.next(), 2_000, () => {
          this.#inputAbort?.abort(new DOMException('Persistent video decode stalled', 'AbortError'));
        }),
        signal,
      );
      return result.done ? undefined : result.value;
    } catch (error) {
      await this.#reset();
      throw error;
    }
  }

  async #reset(countReset = true): Promise<void> {
    const iterator = this.#iterator;
    this.#iterator = undefined;
    this.#inputAbort?.abort(new DOMException('Video decode session reset', 'AbortError'));
    this.#inputAbort = undefined;
    this.#current?.close();
    this.#current = undefined;
    this.#lookahead?.close();
    this.#lookahead = undefined;
    this.#input?.dispose();
    this.#input = undefined;
    if (this.#decoderActive) {
      this.#decoderActive = false;
      activeVideoDecoders -= 1;
    }
    if (iterator?.return !== undefined) {
      // Mediabunny/WebCodecs can leave iterator.return() pending after abort.
      // Playback must not wait on that cleanup or the scheduler stays latched.
      await settleQuietly(iterator.return(), 150);
    }
    if (countReset) this.#resets += 1;
  }

  #cacheFrame(timestampUs: number, frame: VideoFrame): void {
    const byteLength = videoFrameBytes(frame);
    if (byteLength > this.#maxCachedBytes) {
      frame.close();
      return;
    }
    const previous = this.#cache.get(timestampUs);
    if (previous !== undefined) {
      previous.frame.close();
      retainedVideoFrames -= 1;
      this.#cachedBytes -= previous.byteLength;
    }
    this.#cache.set(timestampUs, {
      frame,
      byteLength,
      access: ++this.#clock,
    });
    retainedVideoFrames += 1;
    this.#cachedBytes += byteLength;
    while (this.#cache.size > this.#maxCachedFrames || this.#cachedBytes > this.#maxCachedBytes) {
      let oldestKey: number | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.#cache) {
        if (value.access < oldestAccess) {
          oldestKey = key;
          oldestAccess = value.access;
        }
      }
      if (oldestKey === undefined) break;
      const oldest = this.#cache.get(oldestKey);
      if (oldest === undefined) break;
      this.#cache.delete(oldestKey);
      this.#cachedBytes -= oldest.byteLength;
      oldest.frame.close();
      retainedVideoFrames -= 1;
    }
  }
}

export function createVideoFrameDecodeSessionFromReader(
  reader: RangeReader,
  index: SampleIndex,
  options: VideoFrameDecodeSessionOptions = {},
): VideoFrameDecodeSession {
  return new VideoFrameDecodeSession(reader, index, options);
}

export async function decodeVideoFrameAt(
  bytes: Uint8Array,
  targetUs: number,
  options: VideoDecodeOptions = {},
): Promise<VideoDecodeResult> {
  const index =
    options.sampleIndex ??
    (await createSampleIndex(bytes, options.signal === undefined ? {} : { signal: options.signal }));
  return decodeVideoFrameAtFromInput(
    new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS }),
    index,
    targetUs,
    options,
  );
}

/** Decode an exact video frame using demand-driven byte-range reads. */
export async function decodeVideoFrameAtFromReader(
  reader: RangeReader,
  targetUs: number,
  options: VideoDecodeOptions = {},
): Promise<VideoDecodeResult> {
  const index =
    options.sampleIndex ??
    (await createSampleIndexFromReader(reader, options.signal === undefined ? {} : { signal: options.signal }));
  return decodeVideoFrameAtFromInput(inputFromReader(reader, options.signal), index, targetUs, options);
}

async function decodeVideoFrameAtFromInput(
  input: Input,
  index: SampleIndex,
  targetUs: number,
  options: VideoDecodeOptions,
): Promise<VideoDecodeResult> {
  throwIfAborted(options.signal, 'video exact seek');
  if (!Number.isSafeInteger(targetUs) || targetUs < 0) {
    throw new RangeError('targetUs must be a non-negative safe integer');
  }
  if (typeof VideoDecoder !== 'function') throw new Error('VideoDecoder is unavailable');

  const streamIndex = options.streamIndex ?? 0;
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) {
    throw new RangeError('Video stream index must be a non-negative safe integer');
  }
  const videoInfo = index.tracks.filter((track) => track.kind === 'video')[streamIndex];
  if (videoInfo === undefined) throw new RangeError('Requested video stream does not exist');
  const seek = resolveVideoSeek(index, videoInfo.id, targetUs);
  const targetSample = index.samples[videoInfo.id]?.[seek.presentationSample];
  const decodeStartSample = index.samples[videoInfo.id]?.[seek.decodeStartSample];
  if (targetSample === undefined || decodeStartSample === undefined) {
    throw new Error('SampleIndex returned an invalid seek plan');
  }

  let decoder: VideoDecoder | undefined;
  let selectedFrame: VideoFrame | undefined;
  let selectedTimestampUs = Number.MIN_SAFE_INTEGER;
  let selectedDurationUs = 0;
  let decodedPackets = 0;
  let decoderCounted = false;

  try {
    const track = (await input.getVideoTracks()).find((candidate) => candidate.id === videoInfo.id);
    if (track === undefined) throw new Error('Indexed video track is missing from input');
    const config = await track.getDecoderConfig();
    if (config === null) throw new Error('Video decoder config is unavailable');
    const supported = await VideoDecoder.isConfigSupported(config);
    if (!supported.supported) {
      throw new Error(`Video decoder config is unsupported: ${videoInfo.codec}`);
    }

    let decodeFailure: DOMException | undefined;
    decoder = new VideoDecoder({
      output: (frame) => {
        const frameTimestamp = frame.timestamp;
        if (frameTimestamp <= targetUs && frameTimestamp >= selectedTimestampUs) {
          selectedFrame?.close();
          selectedFrame = frame;
          selectedTimestampUs = frameTimestamp;
          selectedDurationUs = frame.duration ?? 0;
        } else {
          frame.close();
        }
      },
      error: (error) => {
        decodeFailure = error;
      },
    });
    activeVideoDecoders += 1;
    decoderCounted = true;
    decoder.configure(copyVideoDecoderConfig(config));

    const sink = new EncodedPacketSink(track);
    const startPacket = await sink.getKeyPacket(targetUs / MICROSECONDS_PER_SECOND, {
      verifyKeyPackets: true,
    });
    if (startPacket === null) throw new Error('No sync packet exists at or before target');
    const stablePacketSequence = startPacket.sequenceNumber === decodeStartSample.sourceSequenceNumber;

    const maxDecodeQueueSize = options.maxDecodeQueueSize ?? 16;
    if (!Number.isSafeInteger(maxDecodeQueueSize) || maxDecodeQueueSize <= 0) {
      throw new RangeError('maxDecodeQueueSize must be a positive safe integer');
    }
    for await (const packet of sink.packets(startPacket)) {
      throwIfAborted(options.signal, 'video exact seek');
      await waitForDecodeCapacity(decoder, maxDecodeQueueSize, options.signal);
      decoder.decode(packet.toEncodedVideoChunk());
      decodedPackets += 1;
      // Some legal segmented containers assign accessor-local sequence numbers
      // or conservatively verify a key packet before the indexed sync point.
      // In that case, decode through the exact target PTS rather than trusting
      // metadata-only sequence identity.
      if (
        (stablePacketSequence && packet.sequenceNumber === targetSample.sourceSequenceNumber) ||
        (!stablePacketSequence && packet.microsecondTimestamp === targetSample.presentationTimestampUs)
      ) {
        break;
      }
    }
    await decoder.flush();
    if (decodeFailure !== undefined) throw decodeFailure;
    if (selectedFrame === undefined || selectedTimestampUs !== targetSample.presentationTimestampUs) {
      throw new Error(
        `Exact seek expected PTS ${targetSample.presentationTimestampUs}, received ${selectedTimestampUs}`,
      );
    }

    let closed = false;
    const frame = selectedFrame;
    retainedVideoFrames += 1;
    return {
      frame,
      timestampUs: selectedTimestampUs,
      durationUs: selectedDurationUs,
      decodedPackets,
      plannedPackets: stablePacketSequence ? seek.samplesToDecode : decodedPackets,
      decodeStartUs: seek.decodeStartUs,
      targetUs,
      close: () => {
        if (closed) return;
        closed = true;
        frame.close();
        retainedVideoFrames -= 1;
      },
    };
  } catch (error) {
    selectedFrame?.close();
    throw error;
  } finally {
    decoder?.close();
    if (decoderCounted) activeVideoDecoders -= 1;
    input.dispose();
  }
}
