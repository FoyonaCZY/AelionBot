import { AelionError, type Diagnostic, type JsonValue } from '@aelionsdk/core';
import { LOCAL_RGBA8_COLOR_CAPABILITY, preflightColorPipeline, type RenderIr } from '@aelionsdk/render-ir';

import {
  exportAv1Mp4,
  exportHevcMp4,
  exportMp4,
  exportWebM,
  type Mp4ExportResult,
  type WebMExportOptions,
  type WebMExportResult,
} from './webm-export.js';
import { exportMuxedInWorker } from './worker-export.js';
import { av1CodecString, hevcCodecString, negotiateAvcCodecString, type ExportProfileId } from './profiles.js';

export type ExportPreflightIssue = Diagnostic;

export interface ExportPreflightReport {
  readonly ok: boolean;
  readonly revision: bigint;
  readonly issues: readonly ExportPreflightIssue[];
  readonly encoderConfiguration?: {
    readonly videoCodecString?: string;
    readonly audioCodecString?: string;
  };
}

export interface FrozenWebMExportOptions extends Omit<
  WebMExportOptions,
  'durationUs' | 'width' | 'height' | 'frameRate' | 'sampleRate' | 'channelCount'
> {
  readonly ir: RenderIr;
  readonly projectRevision: bigint;
  readonly materialBackendAvailable?: (materialId: string, parameters: Readonly<Record<string, JsonValue>>) => boolean;
  /**
   * WebM defaults to Worker. MP4 defaults to inline because current Chromium
   * advertises AAC in DedicatedWorker but fails during encode; `worker` remains opt-in.
   */
  readonly execution?: 'worker' | 'inline';
  /** Host-resolved Export Worker URL for non-Vite or CDN deployments. */
  readonly workerUrl?: string | URL;
}

export type FrozenMp4ExportOptions = FrozenWebMExportOptions;

export interface FrozenProfilePreflightOptions {
  readonly ir: RenderIr;
  readonly projectRevision: bigint;
  readonly profile: ExportProfileId;
  readonly sink: WebMExportOptions['sink'];
  readonly videoBitrate?: number;
  readonly audioBitrate?: number;
  readonly materialBackendAvailable?: FrozenWebMExportOptions['materialBackendAvailable'];
}

interface MuxedPreflightProfile {
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly videoName: string;
  readonly audioName: string;
  readonly verifyAudioRuntime?: boolean;
  readonly negotiateAvc?: boolean;
  readonly hevc?: boolean;
}

const audioRuntimeSupport = new Map<string, Promise<boolean>>();

function verifyAudioEncoderRuntime(config: AudioEncoderConfig): Promise<boolean> {
  const key = JSON.stringify(config);
  const existing = audioRuntimeSupport.get(key);
  if (existing !== undefined) return existing;
  const probe = new Promise<boolean>((resolve) => {
    let settled = false;
    let encoder: AudioEncoder | undefined;
    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        encoder?.close();
      } catch {
        // A codec error can close the encoder before the error callback runs.
      }
      resolve(supported);
    };
    try {
      encoder = new AudioEncoder({
        output: () => undefined,
        error: () => finish(false),
      });
      encoder.configure(config);
      const frameCount = 1_024;
      // Some AAC implementations need several access units before flush can
      // drain encoder priming. Probe the same 1,024-frame cadence used by the
      // real muxed export instead of treating a single priming block as proof
      // that the runtime rejected AAC.
      for (let block = 0; block < 4; block += 1) {
        const audio = new AudioData({
          format: 'f32',
          sampleRate: config.sampleRate,
          numberOfFrames: frameCount,
          numberOfChannels: config.numberOfChannels,
          timestamp: Math.round((block * frameCount * 1_000_000) / config.sampleRate),
          data: new Float32Array(frameCount * config.numberOfChannels),
        });
        try {
          encoder.encode(audio);
        } finally {
          audio.close();
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
  audioRuntimeSupport.set(key, probe);
  return probe;
}

export type AudioExportCodec = 'opus' | 'aac';

export interface AudioExportCapabilityEntry {
  readonly codec: AudioExportCodec;
  readonly codecString: 'opus' | 'mp4a.40.2';
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly bitrate: number;
  readonly declaredSupported: boolean;
  readonly runtimeSupported: boolean;
  readonly supported: boolean;
  readonly reason?:
    | 'EXPORT_AUDIO_ENCODER_UNAVAILABLE'
    | 'EXPORT_AUDIO_CONFIG_UNSUPPORTED'
    | 'EXPORT_AUDIO_RUNTIME_CANARY_FAILED'
    | 'EXPORT_AUDIO_CONFIG_PROBE_FAILED';
}

export interface ProbeAudioExportMatrixOptions {
  readonly codecs?: readonly AudioExportCodec[];
  readonly sampleRates?: readonly number[];
  readonly channelCounts?: readonly number[];
  readonly bitratePerChannel?: number;
}

/**
 * Probes the exact multichannel/sample-rate matrix advertised to a host.
 *
 * `isConfigSupported()` is not accepted as sufficient evidence: every declared
 * configuration also encodes and flushes four real AudioData blocks. This
 * catches runtimes that advertise AAC/Opus but fail when the encoder is used.
 */
export async function probeAudioExportMatrix(
  options: ProbeAudioExportMatrixOptions = {},
): Promise<readonly AudioExportCapabilityEntry[]> {
  const codecs = options.codecs ?? ['opus', 'aac'];
  const sampleRates = options.sampleRates ?? [44_100, 48_000, 96_000];
  const channelCounts = options.channelCounts ?? [1, 2, 6];
  const bitratePerChannel = options.bitratePerChannel ?? 64_000;
  for (const [values, name] of [
    [sampleRates, 'sampleRates'],
    [channelCounts, 'channelCounts'],
  ] as const) {
    if (values.length === 0 || values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError(`${name} must contain positive safe integers`);
    }
  }
  if (!Number.isSafeInteger(bitratePerChannel) || bitratePerChannel <= 0) {
    throw new RangeError('bitratePerChannel must be a positive safe integer');
  }

  const entries: AudioExportCapabilityEntry[] = [];
  for (const codec of codecs) {
    const codecString = codec === 'aac' ? 'mp4a.40.2' : 'opus';
    for (const sampleRate of sampleRates) {
      for (const channelCount of channelCounts) {
        const bitrate = bitratePerChannel * channelCount;
        if (typeof AudioEncoder !== 'function') {
          entries.push({
            codec,
            codecString,
            sampleRate,
            channelCount,
            bitrate,
            declaredSupported: false,
            runtimeSupported: false,
            supported: false,
            reason: 'EXPORT_AUDIO_ENCODER_UNAVAILABLE',
          });
          continue;
        }
        const config: AudioEncoderConfig = {
          codec: codecString,
          sampleRate,
          numberOfChannels: channelCount,
          bitrate,
          bitrateMode: 'variable',
          ...(codec === 'aac' ? { aac: { format: 'aac' as const } } : { opus: { format: 'opus' as const } }),
        };
        try {
          const declaredSupported = (await AudioEncoder.isConfigSupported(config)).supported === true;
          const runtimeSupported = declaredSupported && (await verifyAudioEncoderRuntime(config));
          entries.push({
            codec,
            codecString,
            sampleRate,
            channelCount,
            bitrate,
            declaredSupported,
            runtimeSupported,
            supported: runtimeSupported,
            ...(!declaredSupported
              ? { reason: 'EXPORT_AUDIO_CONFIG_UNSUPPORTED' as const }
              : !runtimeSupported
                ? { reason: 'EXPORT_AUDIO_RUNTIME_CANARY_FAILED' as const }
                : {}),
          });
        } catch {
          entries.push({
            codec,
            codecString,
            sampleRate,
            channelCount,
            bitrate,
            declaredSupported: false,
            runtimeSupported: false,
            supported: false,
            reason: 'EXPORT_AUDIO_CONFIG_PROBE_FAILED',
          });
        }
      }
    }
  }
  return entries;
}

function channelCount(layout: string): number | undefined {
  if (layout === 'mono') return 1;
  if (layout === 'stereo') return 2;
  if (layout === '5.1') return 6;
  return undefined;
}

function sourceColorSpace(ir: RenderIr): VideoColorSpaceInit {
  if (
    ir.colorPrimaries !== 'bt709' ||
    ir.transferFunction !== 'srgb' ||
    ir.matrixCoefficients !== 'rgb' ||
    ir.colorRange !== 'full'
  ) {
    throw new TypeError('COLOR_EXPORT_RGBA_CONVERSION_UNSUPPORTED');
  }
  return {
    primaries: 'bt709',
    transfer: 'iec61966-2-1',
    matrix: 'rgb',
    fullRange: true,
  };
}

async function preflightMuxedExport(
  options: FrozenWebMExportOptions,
  profile: MuxedPreflightProfile,
): Promise<ExportPreflightReport> {
  const issues: ExportPreflightIssue[] = [];
  try {
    issues.push(...preflightColorPipeline(options.ir, LOCAL_RGBA8_COLOR_CAPABILITY).issues);
  } catch (error) {
    issues.push({
      code: 'COLOR_PIPELINE_CONTRACT_INVALID',
      severity: 'error',
      message: error instanceof Error ? error.message : 'Invalid color pipeline contract',
      recoverable: false,
    });
  }
  if (options.projectRevision !== options.ir.revision) {
    issues.push({
      code: 'EXPORT_REVISION_MISMATCH',
      severity: 'error',
      message: `Project revision ${options.projectRevision.toString()} does not match frozen Render IR revision ${options.ir.revision.toString()}`,
      recoverable: false,
    });
  }
  if (channelCount(options.ir.channelLayout) === undefined) {
    issues.push({
      code: 'EXPORT_CHANNEL_LAYOUT_UNSUPPORTED',
      severity: 'error',
      message: options.ir.channelLayout,
      recoverable: false,
    });
  }
  if (options.sink.locked) {
    issues.push({
      code: 'EXPORT_SINK_LOCKED',
      severity: 'error',
      message: 'Export sink is already locked by another writer',
      recoverable: true,
    });
  }
  const videoConfig: VideoEncoderConfig = {
    codec: profile.videoCodec,
    width: options.ir.width,
    height: options.ir.height,
    bitrate: options.videoBitrate,
    bitrateMode: 'variable',
    framerate: options.ir.frameRate.numerator / options.ir.frameRate.denominator,
    latencyMode: 'quality',
    alpha: 'discard',
    ...(profile.hevc === true ? { hevc: { format: 'hevc' as const } } : {}),
  };
  const audioConfig: AudioEncoderConfig = {
    codec: profile.audioCodec,
    sampleRate: options.ir.sampleRate,
    numberOfChannels: channelCount(options.ir.channelLayout) ?? 0,
    bitrate: options.audioBitrate,
    bitrateMode: 'variable',
    ...(profile.audioCodec === 'mp4a.40.2'
      ? { aac: { format: 'aac' as const } }
      : profile.audioCodec === 'opus'
        ? { opus: { format: 'opus' as const } }
        : {}),
  };
  let selectedVideoCodec: string | undefined;
  let selectedAudioCodec: string | undefined;
  if (typeof VideoEncoder !== 'function') {
    issues.push({
      code: 'EXPORT_VIDEO_ENCODER_UNAVAILABLE',
      severity: 'error',
      message: 'VideoEncoder is unavailable',
      recoverable: false,
    });
  } else {
    try {
      if (profile.negotiateAvc === true) {
        const negotiation = await negotiateAvcCodecString({
          width: options.ir.width,
          height: options.ir.height,
          framerate: options.ir.frameRate.numerator / options.ir.frameRate.denominator,
          bitrate: options.videoBitrate,
        });
        selectedVideoCodec = negotiation.selected;
        if (selectedVideoCodec === undefined) {
          issues.push({
            code: 'EXPORT_VIDEO_CONFIG_UNSUPPORTED',
            severity: 'error',
            message: `${profile.videoName} export config is unsupported`,
            recoverable: false,
            details: {
              attemptedCodecStrings: negotiation.attempts.map((attempt) => attempt.codec),
            },
          });
        }
      } else if ((await VideoEncoder.isConfigSupported(videoConfig)).supported) {
        selectedVideoCodec = profile.videoCodec;
      } else {
        issues.push({
          code: 'EXPORT_VIDEO_CONFIG_UNSUPPORTED',
          severity: 'error',
          message: `${profile.videoName} export config is unsupported`,
          recoverable: false,
        });
      }
    } catch (cause) {
      issues.push({
        code: 'EXPORT_VIDEO_CONFIG_PROBE_FAILED',
        severity: 'error',
        message: `${profile.videoName} export config probe failed`,
        recoverable: true,
        cause,
      });
    }
  }
  if (typeof AudioEncoder !== 'function') {
    issues.push({
      code: 'EXPORT_AUDIO_ENCODER_UNAVAILABLE',
      severity: 'error',
      message: 'AudioEncoder is unavailable',
      recoverable: false,
    });
  } else {
    let runtimeSupported = false;
    try {
      const declaredSupported = (await AudioEncoder.isConfigSupported(audioConfig)).supported === true;
      runtimeSupported =
        declaredSupported && profile.verifyAudioRuntime === true
          ? await verifyAudioEncoderRuntime(audioConfig)
          : declaredSupported;
    } catch (cause) {
      issues.push({
        code: 'EXPORT_AUDIO_CONFIG_PROBE_FAILED',
        severity: 'error',
        message: `${profile.audioName} export config probe failed`,
        recoverable: true,
        cause,
      });
    }
    if (runtimeSupported) selectedAudioCodec = profile.audioCodec;
    else if (!issues.some((issue) => issue.code === 'EXPORT_AUDIO_CONFIG_PROBE_FAILED')) {
      issues.push({
        code: 'EXPORT_AUDIO_CONFIG_UNSUPPORTED',
        severity: 'error',
        message: `${profile.audioName} export config is unsupported at runtime`,
        recoverable: false,
      });
    }
  }
  for (const material of Object.values(options.ir.materials)) {
    if (!material.enabled) continue;
    const available =
      material.program !== undefined && (options.materialBackendAvailable?.(material.id, material.parameters) ?? true);
    if (!available) {
      issues.push({
        code: 'EXPORT_MATERIAL_BACKEND_UNAVAILABLE',
        severity: 'error',
        message: `Material ${material.id} has no offline backend`,
        recoverable: false,
      });
    }
  }
  return {
    ok: issues.length === 0,
    revision: options.ir.revision,
    issues,
    ...(selectedVideoCodec === undefined && selectedAudioCodec === undefined
      ? {}
      : {
          encoderConfiguration: {
            ...(selectedVideoCodec === undefined ? {} : { videoCodecString: selectedVideoCodec }),
            ...(selectedAudioCodec === undefined ? {} : { audioCodecString: selectedAudioCodec }),
          },
        }),
  };
}

export function preflightWebMExport(options: FrozenWebMExportOptions): Promise<ExportPreflightReport> {
  return preflightMuxedExport(options, {
    videoCodec: 'vp09.00.10.08',
    audioCodec: 'opus',
    videoName: 'VP9',
    audioName: 'Opus',
  });
}

export function preflightMp4Export(options: FrozenMp4ExportOptions): Promise<ExportPreflightReport> {
  return preflightMuxedExport(options, {
    videoCodec: 'avc1.640028',
    audioCodec: 'mp4a.40.2',
    videoName: 'H.264',
    audioName: 'AAC',
    verifyAudioRuntime: true,
    negotiateAvc: true,
  });
}

export function preflightAv1Mp4Export(options: FrozenMp4ExportOptions): Promise<ExportPreflightReport> {
  return preflightMuxedExport(options, {
    videoCodec: av1CodecString(
      options.ir.width,
      options.ir.height,
      options.ir.frameRate.numerator / options.ir.frameRate.denominator,
    ),
    audioCodec: 'mp4a.40.2',
    videoName: 'AV1',
    audioName: 'AAC',
    verifyAudioRuntime: true,
  });
}

export function preflightHevcMp4Export(options: FrozenMp4ExportOptions): Promise<ExportPreflightReport> {
  return preflightMuxedExport(options, {
    videoCodec: hevcCodecString(
      options.ir.width,
      options.ir.height,
      options.ir.frameRate.numerator / options.ir.frameRate.denominator,
    ),
    audioCodec: 'mp4a.40.2',
    videoName: 'HEVC',
    audioName: 'AAC',
    verifyAudioRuntime: true,
    hevc: true,
  });
}

/** Profile-wide preflight used by the SDK before any sink writer is acquired. */
export async function preflightProfileExport(options: FrozenProfilePreflightOptions): Promise<ExportPreflightReport> {
  if (
    options.profile === 'webm-vp9-opus' ||
    options.profile === 'mp4-h264-aac' ||
    options.profile === 'mp4-av1-aac' ||
    options.profile === 'mp4-hevc-aac'
  ) {
    const muxed = {
      ir: options.ir,
      projectRevision: options.projectRevision,
      videoBitrate: options.videoBitrate ?? 8_000_000,
      audioBitrate: options.audioBitrate ?? 192_000,
      sink: options.sink,
      renderFrame: () => Promise.reject(new Error('Preflight does not render frames')),
      renderAudio: () => Promise.reject(new Error('Preflight does not render audio')),
      ...(options.materialBackendAvailable === undefined
        ? {}
        : { materialBackendAvailable: options.materialBackendAvailable }),
    } satisfies FrozenWebMExportOptions;
    if (options.profile === 'mp4-h264-aac') return preflightMp4Export(muxed);
    if (options.profile === 'mp4-av1-aac') return preflightAv1Mp4Export(muxed);
    if (options.profile === 'mp4-hevc-aac') return preflightHevcMp4Export(muxed);
    return preflightWebMExport(muxed);
  }

  const issues: ExportPreflightIssue[] = [];
  try {
    issues.push(...preflightColorPipeline(options.ir, LOCAL_RGBA8_COLOR_CAPABILITY).issues);
  } catch (error) {
    issues.push({
      code: 'COLOR_PIPELINE_CONTRACT_INVALID',
      severity: 'error',
      message: error instanceof Error ? error.message : 'Invalid color pipeline contract',
      recoverable: false,
    });
  }
  if (options.projectRevision !== options.ir.revision) {
    issues.push({
      code: 'EXPORT_REVISION_MISMATCH',
      severity: 'error',
      message: `Project revision ${options.projectRevision.toString()} does not match frozen Render IR revision ${options.ir.revision.toString()}`,
      recoverable: false,
    });
  }
  if (options.sink.locked) {
    issues.push({
      code: 'EXPORT_SINK_LOCKED',
      severity: 'error',
      message: 'Export sink is already locked by another writer',
      recoverable: true,
    });
  }
  if (
    (options.profile === 'still-png' ||
      options.profile === 'still-jpeg' ||
      options.profile === 'still-webp' ||
      options.profile === 'animated-gif') &&
    typeof OffscreenCanvas !== 'function'
  ) {
    issues.push({
      code: 'EXPORT_IMAGE_CANVAS_UNAVAILABLE',
      severity: 'error',
      message: 'OffscreenCanvas is unavailable for image export',
      recoverable: false,
    });
  }
  if (options.profile !== 'audio-wav') {
    for (const material of Object.values(options.ir.materials)) {
      if (!material.enabled) continue;
      const available =
        material.program !== undefined &&
        (options.materialBackendAvailable?.(material.id, material.parameters) ?? true);
      if (!available) {
        issues.push({
          code: 'EXPORT_MATERIAL_BACKEND_UNAVAILABLE',
          severity: 'error',
          message: `Material ${material.id} has no offline backend`,
          recoverable: false,
        });
      }
    }
  }
  return { ok: issues.length === 0, revision: options.ir.revision, issues };
}

export async function exportFrozenRenderIrWebM(options: FrozenWebMExportOptions): Promise<WebMExportResult> {
  const report = await preflightWebMExport(options);
  if (!report.ok) {
    throw new AelionError(report.issues);
  }
  const exportOptions: WebMExportOptions = {
    durationUs: options.ir.durationUs,
    width: options.ir.width,
    height: options.ir.height,
    frameRate: options.ir.frameRate,
    sampleRate: options.ir.sampleRate,
    channelCount: channelCount(options.ir.channelLayout) ?? 0,
    videoBitrate: options.videoBitrate,
    audioBitrate: options.audioBitrate,
    sourceColorSpace: sourceColorSpace(options.ir),
    ...(report.encoderConfiguration?.videoCodecString === undefined
      ? {}
      : { videoCodecString: report.encoderConfiguration.videoCodecString }),
    ...(report.encoderConfiguration?.audioCodecString === undefined
      ? {}
      : { audioCodecString: report.encoderConfiguration.audioCodecString }),
    sink: options.sink,
    ...(options.cleanupSink === undefined ? {} : { cleanupSink: options.cleanupSink }),
    renderFrame: options.renderFrame,
    renderAudio: options.renderAudio,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  };
  return options.execution === 'inline'
    ? exportWebM(exportOptions)
    : exportMuxedInWorker({
        ...exportOptions,
        profile: 'webm',
        ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
      });
}

export async function exportFrozenRenderIrMp4(options: FrozenMp4ExportOptions): Promise<Mp4ExportResult> {
  const report = await preflightMp4Export(options);
  if (!report.ok) throw new AelionError(report.issues);
  const exportOptions: WebMExportOptions = {
    durationUs: options.ir.durationUs,
    width: options.ir.width,
    height: options.ir.height,
    frameRate: options.ir.frameRate,
    sampleRate: options.ir.sampleRate,
    channelCount: channelCount(options.ir.channelLayout) ?? 0,
    videoBitrate: options.videoBitrate,
    audioBitrate: options.audioBitrate,
    sourceColorSpace: sourceColorSpace(options.ir),
    ...(report.encoderConfiguration?.videoCodecString === undefined
      ? {}
      : { videoCodecString: report.encoderConfiguration.videoCodecString }),
    ...(report.encoderConfiguration?.audioCodecString === undefined
      ? {}
      : { audioCodecString: report.encoderConfiguration.audioCodecString }),
    sink: options.sink,
    ...(options.cleanupSink === undefined ? {} : { cleanupSink: options.cleanupSink }),
    renderFrame: options.renderFrame,
    renderAudio: options.renderAudio,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  };
  return options.execution === 'worker'
    ? exportMuxedInWorker({
        ...exportOptions,
        profile: 'mp4',
        ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
      })
    : exportMp4(exportOptions);
}

async function exportFrozenRenderIrAlternativeMp4(
  options: FrozenMp4ExportOptions,
  profile: 'mp4-av1' | 'mp4-hevc',
): Promise<Mp4ExportResult> {
  const report = profile === 'mp4-av1' ? await preflightAv1Mp4Export(options) : await preflightHevcMp4Export(options);
  if (!report.ok) throw new AelionError(report.issues);
  const exportOptions: WebMExportOptions = {
    durationUs: options.ir.durationUs,
    width: options.ir.width,
    height: options.ir.height,
    frameRate: options.ir.frameRate,
    sampleRate: options.ir.sampleRate,
    channelCount: channelCount(options.ir.channelLayout) ?? 0,
    videoBitrate: options.videoBitrate,
    audioBitrate: options.audioBitrate,
    sourceColorSpace: sourceColorSpace(options.ir),
    ...(report.encoderConfiguration?.videoCodecString === undefined
      ? {}
      : { videoCodecString: report.encoderConfiguration.videoCodecString }),
    ...(report.encoderConfiguration?.audioCodecString === undefined
      ? {}
      : { audioCodecString: report.encoderConfiguration.audioCodecString }),
    sink: options.sink,
    ...(options.cleanupSink === undefined ? {} : { cleanupSink: options.cleanupSink }),
    renderFrame: options.renderFrame,
    renderAudio: options.renderAudio,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  };
  if (options.execution === 'worker') {
    return exportMuxedInWorker({
      ...exportOptions,
      profile,
      ...(options.workerUrl === undefined ? {} : { workerUrl: options.workerUrl }),
    });
  }
  return profile === 'mp4-av1' ? exportAv1Mp4(exportOptions) : exportHevcMp4(exportOptions);
}

export function exportFrozenRenderIrAv1Mp4(options: FrozenMp4ExportOptions): Promise<Mp4ExportResult> {
  return exportFrozenRenderIrAlternativeMp4(options, 'mp4-av1');
}

export function exportFrozenRenderIrHevcMp4(options: FrozenMp4ExportOptions): Promise<Mp4ExportResult> {
  return exportFrozenRenderIrAlternativeMp4(options, 'mp4-hevc');
}
