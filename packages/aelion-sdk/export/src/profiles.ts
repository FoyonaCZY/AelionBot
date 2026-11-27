export type ExportProfileId =
  | 'webm-vp9-opus'
  | 'mp4-h264-aac'
  | 'mp4-av1-aac'
  | 'mp4-hevc-aac'
  | 'still-png'
  | 'still-jpeg'
  | 'still-webp'
  | 'animated-gif'
  | 'audio-wav';

export interface ExportProfile {
  readonly id: ExportProfileId;
  readonly kind: 'muxed-av' | 'still' | 'animated-image' | 'audio-only';
  readonly mimeType: string;
  readonly extension: string;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly resumability: 'restart-local' | 'checkpointed-units' | 'provider';
}

export const EXPORT_PROFILES: Readonly<Record<ExportProfileId, ExportProfile>> = Object.freeze({
  'webm-vp9-opus': {
    id: 'webm-vp9-opus',
    kind: 'muxed-av',
    mimeType: 'video/webm',
    extension: '.webm',
    videoCodec: 'vp09.00.10.08',
    audioCodec: 'opus',
    resumability: 'checkpointed-units',
  },
  'mp4-h264-aac': {
    id: 'mp4-h264-aac',
    kind: 'muxed-av',
    mimeType: 'video/mp4',
    extension: '.mp4',
    videoCodec: 'avc1.640028',
    audioCodec: 'mp4a.40.2',
    resumability: 'checkpointed-units',
  },
  'mp4-av1-aac': {
    id: 'mp4-av1-aac',
    kind: 'muxed-av',
    mimeType: 'video/mp4',
    extension: '.mp4',
    videoCodec: 'av01.0.08M.08',
    audioCodec: 'mp4a.40.2',
    resumability: 'checkpointed-units',
  },
  'mp4-hevc-aac': {
    id: 'mp4-hevc-aac',
    kind: 'muxed-av',
    mimeType: 'video/mp4',
    extension: '.mp4',
    videoCodec: 'hvc1.1.6.L120.B0',
    audioCodec: 'mp4a.40.2',
    resumability: 'checkpointed-units',
  },
  'still-png': {
    id: 'still-png',
    kind: 'still',
    mimeType: 'image/png',
    extension: '.png',
    resumability: 'checkpointed-units',
  },
  'still-jpeg': {
    id: 'still-jpeg',
    kind: 'still',
    mimeType: 'image/jpeg',
    extension: '.jpg',
    resumability: 'checkpointed-units',
  },
  'still-webp': {
    id: 'still-webp',
    kind: 'still',
    mimeType: 'image/webp',
    extension: '.webp',
    resumability: 'checkpointed-units',
  },
  'animated-gif': {
    id: 'animated-gif',
    kind: 'animated-image',
    mimeType: 'image/gif',
    extension: '.gif',
    resumability: 'checkpointed-units',
  },
  'audio-wav': {
    id: 'audio-wav',
    kind: 'audio-only',
    mimeType: 'audio/wav',
    extension: '.wav',
    resumability: 'checkpointed-units',
  },
});

export interface ExportProfileSupport {
  readonly profile: ExportProfile;
  readonly supported: boolean;
  readonly reasons: readonly string[];
}

export interface ExportCapabilityProbeOptions {
  readonly width?: number;
  readonly height?: number;
  readonly framerate?: number;
  readonly sampleRate?: number;
  readonly numberOfChannels?: number;
  readonly videoBitrate?: number;
  readonly audioBitrate?: number;
}

interface AvcLevel {
  readonly levelHex: string;
  readonly maxMacroblocksPerFrame: number;
  readonly maxMacroblocksPerSecond: number;
}

const AVC_LEVELS: readonly AvcLevel[] = Object.freeze([
  { levelHex: '1e', maxMacroblocksPerFrame: 1_620, maxMacroblocksPerSecond: 40_500 },
  { levelHex: '1f', maxMacroblocksPerFrame: 3_600, maxMacroblocksPerSecond: 108_000 },
  { levelHex: '20', maxMacroblocksPerFrame: 5_120, maxMacroblocksPerSecond: 216_000 },
  { levelHex: '28', maxMacroblocksPerFrame: 8_192, maxMacroblocksPerSecond: 245_760 },
  { levelHex: '29', maxMacroblocksPerFrame: 8_192, maxMacroblocksPerSecond: 245_760 },
  { levelHex: '2a', maxMacroblocksPerFrame: 8_704, maxMacroblocksPerSecond: 522_240 },
  { levelHex: '32', maxMacroblocksPerFrame: 22_080, maxMacroblocksPerSecond: 589_824 },
  { levelHex: '33', maxMacroblocksPerFrame: 36_864, maxMacroblocksPerSecond: 983_040 },
  { levelHex: '34', maxMacroblocksPerFrame: 36_864, maxMacroblocksPerSecond: 2_073_600 },
]);

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

/**
 * Returns AVC codec strings from the smallest level that can represent the
 * requested macroblock rate through progressively more permissive levels.
 * Each level tries High, Main and Baseline profiles because platform encoders
 * commonly expose only a subset even when they support the same dimensions.
 */
export function avcCodecCandidates(width: number, height: number, framerate: number): readonly string[] {
  assertPositiveFinite(width, 'width');
  assertPositiveFinite(height, 'height');
  assertPositiveFinite(framerate, 'framerate');
  const macroblocksPerFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const macroblocksPerSecond = Math.ceil(macroblocksPerFrame * framerate);
  const firstLevel = AVC_LEVELS.findIndex(
    (level) =>
      macroblocksPerFrame <= level.maxMacroblocksPerFrame && macroblocksPerSecond <= level.maxMacroblocksPerSecond,
  );
  if (firstLevel < 0) {
    throw new RangeError(
      `No bounded AVC level supports ${width.toString()}x${height.toString()} at ${framerate.toString()} fps`,
    );
  }
  return AVC_LEVELS.slice(firstLevel).flatMap((level) => [
    `avc1.6400${level.levelHex}`,
    `avc1.4d00${level.levelHex}`,
    `avc1.4200${level.levelHex}`,
  ]);
}

export function preferredAvcCodecString(width: number, height: number, framerate: number): string {
  const codec = avcCodecCandidates(width, height, framerate)[0];
  if (codec === undefined) throw new Error('AVC candidate generation returned no codecs');
  return codec;
}

export function avcEncoderConfig(
  codec: string,
  width: number,
  height: number,
  framerate: number,
  bitrate: number,
): VideoEncoderConfig {
  return {
    codec,
    width,
    height,
    bitrate,
    bitrateMode: 'variable',
    framerate,
    latencyMode: 'quality',
    alpha: 'discard',
    avc: { format: 'avc' },
  };
}

/** Main-profile AV1 level chosen conservatively for HD or UHD output. */
export function av1CodecString(width: number, height: number, framerate: number): string {
  assertPositiveFinite(width, 'width');
  assertPositiveFinite(height, 'height');
  assertPositiveFinite(framerate, 'framerate');
  const samplesPerSecond = width * height * framerate;
  return samplesPerSecond > 1920 * 1080 * 30 ? 'av01.0.12M.08' : 'av01.0.08M.08';
}

/** Main-tier HEVC level chosen conservatively for HD or UHD output. */
export function hevcCodecString(width: number, height: number, framerate: number): string {
  assertPositiveFinite(width, 'width');
  assertPositiveFinite(height, 'height');
  assertPositiveFinite(framerate, 'framerate');
  const samplesPerSecond = width * height * framerate;
  return samplesPerSecond > 1920 * 1080 * 30 ? 'hvc1.1.6.L153.B0' : 'hvc1.1.6.L120.B0';
}

export function negotiatedVideoCodecString(
  profile: Pick<ExportProfile, 'id' | 'videoCodec'>,
  width: number,
  height: number,
  framerate: number,
): string {
  if (profile.id === 'mp4-h264-aac') {
    return preferredAvcCodecString(width, height, framerate);
  }
  if (profile.id === 'mp4-av1-aac') return av1CodecString(width, height, framerate);
  if (profile.id === 'mp4-hevc-aac') return hevcCodecString(width, height, framerate);
  if (profile.videoCodec === undefined) throw new RangeError(`${profile.id} has no video codec`);
  return profile.videoCodec;
}

export interface AvcNegotiationResult {
  readonly selected?: string;
  readonly attempts: readonly {
    readonly codec: string;
    readonly supported: boolean;
    readonly error?: string;
  }[];
}

const avcNegotiationCache = new Map<string, Promise<AvcNegotiationResult>>();

export function negotiateAvcCodecString(options: {
  readonly width: number;
  readonly height: number;
  readonly framerate: number;
  readonly bitrate: number;
}): Promise<AvcNegotiationResult> {
  const key = JSON.stringify(options);
  let negotiation = avcNegotiationCache.get(key);
  if (negotiation === undefined) {
    negotiation = (async () => {
      const attempts: {
        codec: string;
        supported: boolean;
        error?: string;
      }[] = [];
      if (typeof VideoEncoder !== 'function') return { attempts };
      for (const codec of avcCodecCandidates(options.width, options.height, options.framerate)) {
        try {
          const support = await VideoEncoder.isConfigSupported(
            avcEncoderConfig(codec, options.width, options.height, options.framerate, options.bitrate),
          );
          attempts.push({ codec, supported: support.supported === true });
          if (support.supported) return { selected: codec, attempts };
        } catch (error) {
          attempts.push({
            codec,
            supported: false,
            error: error instanceof Error ? error.message : 'VideoEncoder probe failed',
          });
        }
      }
      return { attempts };
    })();
    avcNegotiationCache.set(key, negotiation);
    void negotiation.catch(() => avcNegotiationCache.delete(key));
  }
  return negotiation;
}

async function encoderSupport(
  profile: ExportProfile,
  options: ExportCapabilityProbeOptions = {},
): Promise<ExportProfileSupport> {
  const reasons: string[] = [];
  if (profile.videoCodec !== undefined) {
    if (typeof VideoEncoder !== 'function') reasons.push('EXPORT_VIDEO_ENCODER_UNAVAILABLE');
    else {
      try {
        const width = options.width ?? 1_280;
        const height = options.height ?? 720;
        const framerate = options.framerate ?? 30;
        const codecs =
          profile.id === 'mp4-h264-aac'
            ? avcCodecCandidates(width, height, framerate)
            : [negotiatedVideoCodecString(profile, width, height, framerate)];
        let supported = false;
        for (const codec of codecs) {
          const result = await VideoEncoder.isConfigSupported(
            profile.id === 'mp4-h264-aac'
              ? avcEncoderConfig(codec, width, height, framerate, options.videoBitrate ?? 4_000_000)
              : {
                  codec,
                  width,
                  height,
                  bitrate: options.videoBitrate ?? 4_000_000,
                  bitrateMode: 'variable',
                  framerate,
                  latencyMode: 'quality',
                  alpha: 'discard',
                  ...(profile.id === 'mp4-hevc-aac' ? { hevc: { format: 'hevc' as const } } : {}),
                },
          );
          if (result.supported) {
            supported = true;
            break;
          }
        }
        if (!supported) reasons.push('EXPORT_VIDEO_CONFIG_UNSUPPORTED');
      } catch {
        reasons.push('EXPORT_VIDEO_CONFIG_PROBE_FAILED');
      }
    }
  }
  if (profile.audioCodec !== undefined) {
    if (typeof AudioEncoder !== 'function') reasons.push('EXPORT_AUDIO_ENCODER_UNAVAILABLE');
    else {
      try {
        const supported = await AudioEncoder.isConfigSupported({
          codec: profile.audioCodec,
          sampleRate: options.sampleRate ?? 48_000,
          numberOfChannels: options.numberOfChannels ?? 2,
          bitrate: options.audioBitrate ?? 128_000,
          bitrateMode: 'variable',
          ...(profile.audioCodec === 'mp4a.40.2'
            ? { aac: { format: 'aac' as const } }
            : profile.audioCodec === 'opus'
              ? { opus: { format: 'opus' as const } }
              : {}),
        });
        if (!supported.supported) reasons.push('EXPORT_AUDIO_CONFIG_UNSUPPORTED');
      } catch {
        reasons.push('EXPORT_AUDIO_CONFIG_PROBE_FAILED');
      }
    }
  }
  if (profile.kind === 'still' && typeof OffscreenCanvas !== 'function') {
    reasons.push('EXPORT_IMAGE_CANVAS_UNAVAILABLE');
  }
  if (profile.kind === 'animated-image' && typeof OffscreenCanvas !== 'function') {
    reasons.push('EXPORT_IMAGE_CANVAS_UNAVAILABLE');
  }
  return { profile, supported: reasons.length === 0, reasons };
}

export async function probeExportProfiles(
  options: ExportCapabilityProbeOptions = {},
): Promise<readonly ExportProfileSupport[]> {
  return Promise.all(Object.values(EXPORT_PROFILES).map((profile) => encoderSupport(profile, options)));
}

export interface SelectExportProfileOptions extends ExportCapabilityProbeOptions {
  readonly preferred: ExportProfileId;
  readonly fallbacks?: readonly ExportProfileId[];
  readonly remoteAvailable?: boolean;
}

export interface ExportProfileSelection {
  readonly selected?: ExportProfile;
  readonly execution: 'local' | 'remote' | 'unsupported';
  readonly attempts: readonly ExportProfileSupport[];
}

export async function selectExportProfile(options: SelectExportProfileOptions): Promise<ExportProfileSelection> {
  const ids = [options.preferred, ...(options.fallbacks ?? [])].filter(
    (id, index, values) => values.indexOf(id) === index,
  );
  const attempts: ExportProfileSupport[] = [];
  for (const id of ids) {
    const profile = (EXPORT_PROFILES as Partial<Record<string, ExportProfile>>)[id];
    if (profile === undefined) {
      throw new RangeError(`Unknown export profile ${String(id)}`);
    }
    const support = await encoderSupport(profile, options);
    attempts.push(support);
    if (support.supported) return { selected: support.profile, execution: 'local', attempts };
  }
  return options.remoteAvailable === true
    ? { selected: EXPORT_PROFILES[options.preferred], execution: 'remote', attempts }
    : { execution: 'unsupported', attempts };
}
