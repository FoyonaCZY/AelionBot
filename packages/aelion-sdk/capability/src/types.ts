import type { Diagnostic, JsonValue } from '@aelionsdk/core';

export type CapabilityStatus = 'supported' | 'degraded' | 'unsupported' | 'unknown';
export type CapabilityTier = 'a' | 'b' | 'c' | 'unsupported';

export interface CapabilityProbe {
  readonly status: CapabilityStatus;
  readonly available: boolean;
  readonly details?: Readonly<Record<string, JsonValue>>;
  readonly diagnostics?: readonly Diagnostic[];
}

export interface CodecConfigProbe {
  readonly id: string;
  readonly kind: 'video-decoder' | 'video-encoder' | 'audio-decoder' | 'audio-encoder';
  readonly codec: string;
  readonly supported: boolean;
  readonly config: Readonly<Record<string, JsonValue>>;
  readonly diagnostics: readonly Diagnostic[];
}

export interface GpuCapability {
  readonly webgpu: CapabilityProbe;
  readonly webgl2: CapabilityProbe;
  readonly offscreenCanvas: CapabilityProbe;
  readonly worker: CapabilityProbe;
  readonly adapter?: {
    readonly features: readonly string[];
    readonly limits: Readonly<Record<string, number>>;
  };
}

export interface AudioCapability {
  readonly audioContext: CapabilityProbe;
  readonly audioWorklet: CapabilityProbe;
  readonly sharedArrayBuffer: CapabilityProbe;
}

export interface StorageCapability {
  readonly opfs: CapabilityProbe;
  readonly fileSystemAccess: CapabilityProbe;
  readonly transferableStreams: CapabilityProbe;
}

/**
 * Still-image decode capability for the formats the SDK accepts through
 * {@link ImageDecoder}/`createImageBitmap`. Probes report what the platform can
 * deterministically signal; a probe with `status: 'unknown'` means the platform
 * exposes no decoder-capability API (e.g. no `ImageDecoder`), not that the
 * format is unsupported.
 */
export interface ImageFormatCapability {
  /** AVIF still decode. */
  readonly avif: CapabilityProbe;
  /** JPEG still decode. */
  readonly jpeg: CapabilityProbe;
  /** PNG still decode. */
  readonly png: CapabilityProbe;
  /** WebP still decode. */
  readonly webp: CapabilityProbe;
}

export interface ColorCapability {
  readonly displayP3Gamut: CapabilityProbe;
  readonly highDynamicRange: CapabilityProbe;
  /** The color contract implemented by the current local renderer/exporter. */
  readonly localExecution: {
    readonly workingColorSpaces: readonly string[];
    readonly colorPrimaries: readonly ('bt709' | 'display-p3' | 'bt2020')[];
    readonly transferFunctions: readonly ('srgb' | 'gamma22' | 'pq' | 'hlg')[];
    readonly matrixCoefficients: readonly ('rgb' | 'bt709' | 'bt2020-ncl')[];
    readonly colorRanges: readonly ('full' | 'limited')[];
    readonly chromaSubsamplings: readonly ('rgb' | '4:4:4' | '4:2:2' | '4:2:0')[];
    readonly alphaModes: readonly ('opaque' | 'premultiplied')[];
    readonly toneMappings: readonly ('none' | 'bt2390' | 'reinhard')[];
    readonly bitDepths: readonly (8 | 10)[];
    readonly hdrPresentation: boolean;
  };
}

export interface CapabilityEnvironment {
  readonly userAgent: string;
  readonly platform: string;
  readonly language: string;
  readonly hardwareConcurrency: number | null;
  readonly deviceMemoryGiB: number | null;
  readonly crossOriginIsolated: boolean;
  readonly secureContext: boolean;
  readonly origin: string;
}

export interface CapabilityReport {
  readonly schemaVersion: '1.0.0';
  readonly generatedAt: string;
  readonly tier: CapabilityTier;
  readonly environment: CapabilityEnvironment;
  readonly codecs: readonly CodecConfigProbe[];
  readonly gpu: GpuCapability;
  readonly audio: AudioCapability;
  readonly storage: StorageCapability;
  readonly color: ColorCapability;
  readonly images: ImageFormatCapability;
  readonly wasm: {
    readonly available: CapabilityProbe;
  };
  readonly diagnostics: readonly Diagnostic[];
}

export interface CapabilityProbeOptions {
  readonly signal?: AbortSignal;
  readonly includeAdapterDetails?: boolean;
}
