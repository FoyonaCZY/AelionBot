import type { Diagnostic, Rational } from '@aelionsdk/core';

export type TrackKind = 'video' | 'audio';

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

export interface RangeRead {
  readonly bytes: Uint8Array;
  readonly range: ByteRange;
  readonly totalSize: number;
  readonly source: 'memory' | 'blob' | 'network';
}

export interface RangeReader {
  readonly id: string;
  readonly kind: 'memory' | 'blob' | 'network';
  size(signal?: AbortSignal): Promise<number>;
  read(range: ByteRange, signal?: AbortSignal): Promise<RangeRead>;
}

export interface SampleEntry {
  readonly trackId: number;
  readonly sampleIndex: number;
  readonly kind: TrackKind;
  readonly decodeOrder: number;
  readonly presentationOrder: number;
  readonly sourceSequenceNumber: number;
  /** Presentation timestamp (PTS) on the source timeline. */
  readonly presentationTimestampUs: number;
  readonly durationUs: number;
  /** Zero-origin monotonic decode timeline; not the raw container DTS. */
  readonly normalizedDecodeTimeUs: number;
  readonly isSync: boolean;
  readonly byteOffset?: number;
  readonly byteLength?: number;
}

export interface VideoTrackInfo {
  readonly kind: 'video';
  readonly id: number;
  readonly codec: string;
  readonly codecFamily: string;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly rotation: number;
  readonly color: {
    readonly primaries: 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020' | null;
    readonly transfer: 'bt709' | 'smpte170m' | 'iec61966-2-1' | 'linear' | 'pq' | 'hlg' | null;
    readonly matrix: 'rgb' | 'bt709' | 'bt470bg' | 'smpte170m' | 'bt2020-ncl' | null;
    readonly fullRange: boolean | null;
    readonly highDynamicRange: boolean;
    readonly canBeTransparent: boolean;
  };
  readonly timeBase?: Rational;
  readonly description?: Uint8Array;
}

export interface AudioTrackInfo {
  readonly kind: 'audio';
  readonly id: number;
  readonly codec: string;
  readonly codecFamily: string;
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly timeBase?: Rational;
  readonly description?: Uint8Array;
}

export type TrackInfo = VideoTrackInfo | AudioTrackInfo;

export interface SampleIndex {
  readonly schemaVersion: '1.0.0';
  readonly container: 'mp4' | 'mov' | 'mkv' | 'ts' | 'webm' | 'unknown';
  readonly durationUs: number;
  readonly tracks: readonly TrackInfo[];
  readonly capabilities: {
    /** PTS, duration, sync state, encoded size and decode order are exact. */
    readonly timingAndSize: true;
    /** Raw container DTS is adapter-dependent and is not exposed by Mediabunny 1.50.8. */
    readonly rawDecodeTimestamps: boolean;
    /** Physical sample offsets are adapter-dependent and are not exposed by Mediabunny 1.50.8. */
    readonly byteOffsets: boolean;
  };
  /** Samples are stored in decode order for each track. */
  readonly samples: Readonly<Record<number, readonly SampleEntry[]>>;
  /** Decode-order sample indexes sorted into presentation order for exact lookup. */
  readonly presentationOrder: Readonly<Record<number, readonly number[]>>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SeekPoint {
  readonly trackId: number;
  readonly targetUs: number;
  readonly decodeStartSample: number;
  readonly presentationSample: number;
  readonly decodeStartUs: number;
  readonly presentationUs: number;
  readonly samplesToDecode: number;
}

export interface MediaProbeOptions {
  readonly signal?: AbortSignal;
  readonly includeSamples?: boolean;
}

export interface VideoDecoderResourceSnapshot {
  readonly activeDecoders: number;
  readonly retainedFrames: number;
}
