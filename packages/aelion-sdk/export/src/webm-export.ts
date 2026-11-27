import { AelionError, frameDurationUs, frameStartUs, throwIfAborted, type Rational } from '@aelionsdk/core';
import {
  AudioSample,
  AudioSampleSource,
  Output,
  Mp4OutputFormat,
  StreamTarget,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from 'mediabunny';

import { av1CodecString, hevcCodecString, negotiateAvcCodecString, preferredAvcCodecString } from './profiles.js';
import { createSinkCompletionBarrier } from './sink-completion.js';

export interface OfflineFrameRequest {
  readonly frameIndex: number;
  readonly timestampUs: number;
  readonly durationUs: number;
  readonly width: number;
  readonly height: number;
}

export interface OfflineAudioRequest {
  readonly startFrame: number;
  readonly frameCount: number;
  readonly sampleRate: number;
  readonly channelCount: number;
}

export interface WebMExportOptions {
  readonly durationUs: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: Rational;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
  /** Exact codec string selected by preflight. Defaults to the profile baseline. */
  readonly videoCodecString?: string;
  /** Exact audio codec string selected by preflight. */
  readonly audioCodecString?: string;
  /** Color interpretation of the RGBA frames passed to the encoder. */
  readonly sourceColorSpace?: VideoColorSpaceInit;
  readonly sink: WritableStream<{
    readonly type: 'write';
    readonly data: Uint8Array<ArrayBuffer>;
    readonly position: number;
  }>;
  /** Idempotent sink-specific cleanup (for example deleting a partial OPFS file). */
  readonly cleanupSink?: (reason: unknown) => void | Promise<void>;
  readonly renderFrame: (request: OfflineFrameRequest, signal?: AbortSignal) => Promise<VideoFrame>;
  readonly renderAudio: (request: OfflineAudioRequest, signal?: AbortSignal) => Promise<Float32Array>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number) => void;
}

export interface WebMExportResult {
  readonly mimeType: string;
  readonly videoFrames: number;
  readonly audioFrames: number;
  readonly durationUs: number;
  /**
   * Configuration submitted to the encoders. Variable bitrate targets are not
   * promises about the measured bitrate of the resulting media.
   */
  readonly encoderConfiguration: MuxedEncoderConfiguration;
}

export interface MuxedEncoderConfiguration {
  readonly profile: 'webm-vp9-opus' | 'mp4-h264-aac' | 'mp4-av1-aac' | 'mp4-hevc-aac';
  readonly video: {
    readonly codec: string;
    readonly codecString: string;
    readonly width: number;
    readonly height: number;
    readonly frameRate: number;
    readonly bitrateMode: 'variable';
    readonly targetBitrate: number;
    readonly sourceColorSpace: {
      readonly primaries: VideoColorPrimaries | null;
      readonly transfer: VideoTransferCharacteristics | null;
      readonly matrix: VideoMatrixCoefficients | null;
      readonly fullRange: boolean | null;
    };
  };
  readonly audio: {
    readonly codec: string;
    readonly sampleRate: number;
    readonly channelCount: number;
    readonly bitrateMode: 'variable';
    readonly targetBitrate: number;
  };
}

export type Mp4ExportOptions = WebMExportOptions;
export type Mp4ExportResult = WebMExportResult;

export interface MuxedExportProfile {
  readonly id: MuxedEncoderConfiguration['profile'];
  readonly operationName: string;
  readonly format: WebMOutputFormat | Mp4OutputFormat;
  readonly videoCodec: 'vp9' | 'avc' | 'av1' | 'hevc';
  readonly fullVideoCodecString: string;
  readonly audioCodec: 'opus' | 'aac';
}

type ExportStage = 'initialize' | 'render-video' | 'encode-video' | 'render-audio' | 'encode-audio' | 'finalize';

const MAIN_THREAD_YIELD_INTERVAL_MS = 16;
const audioEncoderRuntimeSupport = new Map<string, Promise<boolean>>();
const DEFAULT_SOURCE_COLOR_SPACE = Object.freeze({
  primaries: 'bt709' as const,
  transfer: 'iec61966-2-1' as const,
  matrix: 'rgb' as const,
  fullRange: true,
});

export interface MuxedExportRange {
  readonly videoStartFrame: number;
  readonly videoEndFrameExclusive: number;
  readonly audioStartFrame: number;
  readonly audioEndFrameExclusive: number;
  /**
   * `range` restarts encoder timestamps at zero. It is intended for independently
   * encoded container fragments whose absolute decode times are patched at commit.
   */
  readonly timestampBase?: 'timeline' | 'range';
}

function nextMainThreadTask(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function verifyAudioEncoderRuntime(config: AudioEncoderConfig): Promise<boolean> {
  const key = JSON.stringify(config);
  const existing = audioEncoderRuntimeSupport.get(key);
  if (existing !== undefined) return existing;
  const verification = new Promise<boolean>((resolve) => {
    let settled = false;
    let encoder: AudioEncoder | undefined;
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        encoder?.close();
      } catch {
        // A codec error can close the encoder before the error callback.
      }
      resolve(supported);
    };
    try {
      encoder = new AudioEncoder({
        output: () => undefined,
        error: () => finish(false),
      });
      encoder.configure(config);
      for (let block = 0; block < 4; block += 1) {
        const frameCount = 1_024;
        const sample = new AudioData({
          format: 'f32',
          sampleRate: config.sampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: config.numberOfChannels,
          timestamp: Math.round((block * frameCount * 1_000_000) / config.sampleRate),
          data: new Float32Array(frameCount * config.numberOfChannels),
        });
        try {
          encoder.encode(sample);
        } finally {
          sample.close();
        }
      }
      void encoder.flush().then(
        () => finish(true),
        () => finish(false),
      );
    } catch {
      finish(false);
    }
  });
  audioEncoderRuntimeSupport.set(key, verification);
  return verification;
}

function exportFailure(stage: ExportStage, cause: unknown): AelionError {
  const causeName = cause instanceof DOMException ? cause.name : '';
  const causeMessage = cause instanceof Error ? cause.message : '';
  if (causeName === 'QuotaExceededError' || /quota|storage|disk|write failed/iu.test(causeMessage)) {
    return new AelionError([
      {
        code: 'EXPORT_STORAGE_WRITE_FAILED',
        severity: 'error',
        message: `Export sink write failed: ${causeMessage || 'unknown storage failure'}`,
        recoverable: true,
        cause,
      },
    ]);
  }
  const mapping: Record<ExportStage, readonly [string, string]> = {
    initialize: ['EXPORT_ENCODER_INIT_FAILED', 'Failed to initialize export encoders or muxer'],
    'render-video': ['EXPORT_VIDEO_RENDER_FAILED', 'Failed to render an export video frame'],
    'encode-video': ['EXPORT_VIDEO_ENCODER_FAILED', 'Video encoder rejected an export frame'],
    'render-audio': ['EXPORT_AUDIO_RENDER_FAILED', 'Failed to render an export PCM block'],
    'encode-audio': ['EXPORT_AUDIO_ENCODER_FAILED', 'Audio encoder rejected an export block'],
    finalize: ['EXPORT_MUX_OR_SINK_FAILED', 'Failed to finalize muxed output or write the sink'],
  };
  const [code, prefix] = mapping[stage];
  return new AelionError([
    {
      code,
      severity: 'error',
      message: `${prefix}: ${cause instanceof Error ? cause.message : 'unknown failure'}`,
      recoverable: stage === 'finalize',
      cause,
    },
  ]);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export async function exportMuxed(
  options: WebMExportOptions,
  profile: MuxedExportProfile,
  range?: MuxedExportRange,
): Promise<WebMExportResult> {
  assertPositiveInteger(options.durationUs, 'durationUs');
  assertPositiveInteger(options.width, 'width');
  assertPositiveInteger(options.height, 'height');
  assertPositiveInteger(options.sampleRate, 'sampleRate');
  assertPositiveInteger(options.channelCount, 'channelCount');
  const fullVideoFrameCount = Math.ceil(
    (options.durationUs * options.frameRate.numerator) / (1_000_000 * options.frameRate.denominator),
  );
  const fullAudioFrameCount = Math.floor((options.durationUs * options.sampleRate) / 1_000_000);
  const videoStartFrame = range?.videoStartFrame ?? 0;
  const videoEndFrameExclusive = range?.videoEndFrameExclusive ?? fullVideoFrameCount;
  const audioStartFrame = range?.audioStartFrame ?? 0;
  const audioEndFrameExclusive = range?.audioEndFrameExclusive ?? fullAudioFrameCount;
  const rangeTimestampBaseUs = range?.timestampBase === 'range' ? frameStartUs(videoStartFrame, options.frameRate) : 0;
  const rangeAudioBaseFrame = range?.timestampBase === 'range' ? audioStartFrame : 0;
  for (const [value, name] of [
    [videoStartFrame, 'videoStartFrame'],
    [videoEndFrameExclusive, 'videoEndFrameExclusive'],
    [audioStartFrame, 'audioStartFrame'],
    [audioEndFrameExclusive, 'audioEndFrameExclusive'],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  if (
    videoStartFrame >= videoEndFrameExclusive ||
    videoEndFrameExclusive > fullVideoFrameCount ||
    audioStartFrame >= audioEndFrameExclusive ||
    audioEndFrameExclusive > fullAudioFrameCount
  ) {
    throw new RangeError('Muxed export range must be a non-empty subset of the timeline');
  }
  throwIfAborted(options.signal, profile.operationName);
  const sourceColorSpace = {
    primaries: options.sourceColorSpace?.primaries ?? DEFAULT_SOURCE_COLOR_SPACE.primaries,
    transfer: options.sourceColorSpace?.transfer ?? DEFAULT_SOURCE_COLOR_SPACE.transfer,
    matrix: options.sourceColorSpace?.matrix ?? DEFAULT_SOURCE_COLOR_SPACE.matrix,
    fullRange: options.sourceColorSpace?.fullRange ?? DEFAULT_SOURCE_COLOR_SPACE.fullRange,
  };
  if (profile.audioCodec === 'aac') {
    const runtimeConfig: AudioEncoderConfig = {
      codec: options.audioCodecString ?? 'mp4a.40.2',
      sampleRate: options.sampleRate,
      numberOfChannels: options.channelCount,
      bitrate: options.audioBitrate,
      bitrateMode: 'variable',
      ...{ aac: { format: 'aac' as const } },
    };
    const supported = await verifyAudioEncoderRuntime(runtimeConfig);
    if (!supported) {
      throw new AelionError([
        {
          code: 'EXPORT_AUDIO_CONFIG_UNSUPPORTED',
          severity: 'error',
          message: 'AAC encoder configuration failed the runtime encode canary',
          recoverable: false,
        },
      ]);
    }
  }

  // StreamTarget closes its writer during Output.finalize(). Some Firefox
  // builds have resolved that close before the consumer sink's close callback
  // became observable. Pipe through a barrier and await the pipe separately so
  // a completed export always means the caller's sink is fully closed.
  const sinkBarrier = createSinkCompletionBarrier(options.sink);
  let output: Output | undefined;
  let videoFrames = 0;
  let audioFrames = 0;
  let stage: ExportStage = 'initialize';
  let pendingRenderedFrame:
    | Promise<
        | {
            readonly ok: true;
            readonly frame: VideoFrame;
          }
        | {
            readonly ok: false;
            readonly error: unknown;
          }
      >
    | undefined;
  let lastMainThreadYieldMs = performance.now();
  const yieldMainThreadWhenDue = async (): Promise<void> => {
    throwIfAborted(options.signal, 'WebM export');
    if (performance.now() - lastMainThreadYieldMs < MAIN_THREAD_YIELD_INTERVAL_MS) return;
    await nextMainThreadTask();
    lastMainThreadYieldMs = performance.now();
    throwIfAborted(options.signal, 'WebM export');
  };
  try {
    const target = new StreamTarget(sinkBarrier.writable, {
      chunked: true,
      chunkSize: 64 * 1_024,
    });
    output = new Output({
      format: profile.format,
      target,
    });
    const videoSource = new VideoSampleSource({
      codec: profile.videoCodec,
      fullCodecString: options.videoCodecString ?? profile.fullVideoCodecString,
      bitrate: options.videoBitrate,
      bitrateMode: 'variable',
      keyFrameInterval: 1,
      latencyMode: 'quality',
      alpha: 'discard',
    });
    const audioSource = new AudioSampleSource({
      codec: profile.audioCodec,
      ...(options.audioCodecString === undefined ? {} : { fullCodecString: options.audioCodecString }),
      bitrate: options.audioBitrate,
      bitrateMode: 'variable',
    });
    output.addVideoTrack(videoSource, {
      frameRate: options.frameRate.numerator / options.frameRate.denominator,
    });
    output.addAudioTrack(audioSource);

    await output.start();
    await yieldMainThreadWhenDue();
    const rangedVideoFrames = videoEndFrameExclusive - videoStartFrame;
    const beginRender = (frameIndex: number) => {
      const timestampUs = frameStartUs(frameIndex, options.frameRate);
      const durationUs = Math.min(frameDurationUs(frameIndex, options.frameRate), options.durationUs - timestampUs);
      return Promise.resolve(
        options.renderFrame(
          { frameIndex, timestampUs, durationUs, width: options.width, height: options.height },
          options.signal,
        ),
      ).then(
        (frame) => ({ ok: true as const, frame }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    };
    pendingRenderedFrame = beginRender(videoStartFrame);
    for (let frameIndex = videoStartFrame; frameIndex < videoEndFrameExclusive; frameIndex += 1) {
      throwIfAborted(options.signal, 'WebM video export');
      const timestampUs = frameStartUs(frameIndex, options.frameRate);
      const durationUs = Math.min(frameDurationUs(frameIndex, options.frameRate), options.durationUs - timestampUs);
      if (durationUs <= 0) break;
      stage = 'render-video';
      const renderPromise = pendingRenderedFrame;
      if (renderPromise === undefined) throw new Error('Video render pipeline was not primed');
      const rendered = await renderPromise;
      pendingRenderedFrame = frameIndex + 1 < videoEndFrameExclusive ? beginRender(frameIndex + 1) : undefined;
      if (!rendered.ok) throw rendered.error;
      const frame = rendered.frame;
      try {
        stage = 'encode-video';
        const sample = new VideoSample(frame, {
          timestamp: (timestampUs - rangeTimestampBaseUs) / 1_000_000,
          duration: durationUs / 1_000_000,
          colorSpace: sourceColorSpace,
        });
        try {
          await videoSource.add(sample);
        } finally {
          sample.close();
        }
      } finally {
        frame.close();
      }
      videoFrames += 1;
      options.onProgress?.(videoFrames / rangedVideoFrames / 2);
      await yieldMainThreadWhenDue();
    }
    videoSource.close();

    const totalAudioFrames = audioEndFrameExclusive - audioStartFrame;
    const blockFrames = 1_024;
    while (audioFrames < totalAudioFrames) {
      throwIfAborted(options.signal, 'WebM audio export');
      const frameCount = Math.min(blockFrames, totalAudioFrames - audioFrames);
      stage = 'render-audio';
      const pcm = await options.renderAudio(
        {
          startFrame: audioStartFrame + audioFrames,
          frameCount,
          sampleRate: options.sampleRate,
          channelCount: options.channelCount,
        },
        options.signal,
      );
      if (pcm.length !== frameCount * options.channelCount) {
        throw new RangeError('renderAudio returned an unexpected interleaved PCM length');
      }
      const sample = new AudioSample({
        data: pcm,
        format: 'f32',
        numberOfChannels: options.channelCount,
        sampleRate: options.sampleRate,
        timestamp: (audioStartFrame + audioFrames - rangeAudioBaseFrame) / options.sampleRate,
      });
      try {
        stage = 'encode-audio';
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
      audioFrames += frameCount;
      options.onProgress?.(Math.min(1 - Number.EPSILON, 0.5 + audioFrames / totalAudioFrames / 2));
      await yieldMainThreadWhenDue();
    }
    audioSource.close();
    stage = 'finalize';
    await output.finalize();
    await sinkBarrier.completion;
    options.onProgress?.(1);
    return {
      mimeType: await output.getMimeType(),
      videoFrames,
      audioFrames,
      durationUs: options.durationUs,
      encoderConfiguration: {
        profile: profile.id,
        video: {
          codec: profile.videoCodec,
          codecString: options.videoCodecString ?? profile.fullVideoCodecString,
          width: options.width,
          height: options.height,
          frameRate: options.frameRate.numerator / options.frameRate.denominator,
          bitrateMode: 'variable',
          targetBitrate: options.videoBitrate,
          sourceColorSpace,
        },
        audio: {
          codec: profile.audioCodec,
          sampleRate: options.sampleRate,
          channelCount: options.channelCount,
          bitrateMode: 'variable',
          targetBitrate: options.audioBitrate,
        },
      },
    };
  } catch (error) {
    if (pendingRenderedFrame !== undefined) {
      const pending = await pendingRenderedFrame;
      if (pending.ok) pending.frame.close();
      pendingRenderedFrame = undefined;
    }
    if (output !== undefined && output.state !== 'finalized' && output.state !== 'canceled') {
      try {
        await output.cancel();
      } catch {
        // Preserve the first failure. Stream cancellation is best-effort cleanup.
      }
    }
    sinkBarrier.abort(error);
    await sinkBarrier.completion.catch(() => undefined);
    try {
      await options.cleanupSink?.(error);
    } catch {
      // Cleanup errors are reported by the concrete sink; preserve the primary failure.
    }
    if (error instanceof AelionError) throw error;
    throw exportFailure(stage, error);
  }
}

export function exportWebM(options: WebMExportOptions): Promise<WebMExportResult> {
  return exportMuxed(options, {
    id: 'webm-vp9-opus',
    operationName: 'WebM export',
    format: new WebMOutputFormat(),
    videoCodec: 'vp9',
    fullVideoCodecString: 'vp09.00.10.08',
    audioCodec: 'opus',
  });
}

export async function exportMp4(options: Mp4ExportOptions): Promise<Mp4ExportResult> {
  const framerate = options.frameRate.numerator / options.frameRate.denominator;
  const negotiated =
    options.videoCodecString === undefined
      ? await negotiateAvcCodecString({
          width: options.width,
          height: options.height,
          framerate,
          bitrate: options.videoBitrate,
        })
      : undefined;
  const videoCodecString =
    options.videoCodecString ??
    negotiated?.selected ??
    preferredAvcCodecString(options.width, options.height, framerate);
  return exportMuxed(
    {
      ...options,
      videoCodecString,
      audioCodecString: options.audioCodecString ?? 'mp4a.40.2',
    },
    {
      id: 'mp4-h264-aac',
      operationName: 'MP4 export',
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      videoCodec: 'avc',
      fullVideoCodecString: videoCodecString,
      audioCodec: 'aac',
    },
  );
}

export function exportAv1Mp4(options: Mp4ExportOptions): Promise<Mp4ExportResult> {
  const framerate = options.frameRate.numerator / options.frameRate.denominator;
  const videoCodecString = options.videoCodecString ?? av1CodecString(options.width, options.height, framerate);
  return exportMuxed(
    {
      ...options,
      videoCodecString,
      audioCodecString: options.audioCodecString ?? 'mp4a.40.2',
    },
    {
      id: 'mp4-av1-aac',
      operationName: 'AV1 MP4 export',
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      videoCodec: 'av1',
      fullVideoCodecString: videoCodecString,
      audioCodec: 'aac',
    },
  );
}

export function exportHevcMp4(options: Mp4ExportOptions): Promise<Mp4ExportResult> {
  const framerate = options.frameRate.numerator / options.frameRate.denominator;
  const videoCodecString = options.videoCodecString ?? hevcCodecString(options.width, options.height, framerate);
  return exportMuxed(
    {
      ...options,
      videoCodecString,
      audioCodecString: options.audioCodecString ?? 'mp4a.40.2',
    },
    {
      id: 'mp4-hevc-aac',
      operationName: 'HEVC MP4 export',
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      videoCodec: 'hevc',
      fullVideoCodecString: videoCodecString,
      audioCodec: 'aac',
    },
  );
}
