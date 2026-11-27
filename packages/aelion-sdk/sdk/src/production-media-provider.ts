import type { PcmSourceBlock } from '@aelionsdk/audio';
import { throwIfAborted, type JsonObject } from '@aelionsdk/core';
import {
  BlobRangeReader,
  FetchRangeReader,
  MemoryCacheStore,
  PageMediaResourceGovernor,
  createAudioPcmDecodeSessionFromReader,
  createSampleIndexFromReader,
  createVideoFrameDecodeSessionFromReader,
  decodeAudioPcmRangeFromReader,
  decodeStillImageFromReader,
  decodeVideoFrameAtFromReader,
  proxyPresentationTimeUs,
  selectAssetRepresentation,
  type AudioPcmBlock,
  type AudioPcmDecodeSession,
  type CacheAddress,
  type CacheStore,
  type FetchRangeReaderOptions,
  type MediaResourceGovernorSnapshot,
  type RangeReader,
  type SampleIndex,
  type VideoFrameDecodeSession,
} from '@aelionsdk/media';

import type { AelionMediaProvider, AelionMediaRequest } from './types.js';

const SAMPLE_INDEX_CACHE_VERSION = 'aelion-sample-index-v1';
const AUDIO_PCM_WINDOW_US = 1_000_000;

export type ProductionMediaRole = 'original' | 'proxy' | 'thumbnail' | 'waveform';

export interface ProductionMediaRepresentationOptions {
  /** Stable representation id. Defaults to `${assetId}:${role}`. */
  readonly id?: string;
  readonly role?: ProductionMediaRole;
  readonly durationUs?: number;
  readonly width?: number;
  readonly height?: number;
  /** Optional lowercase SHA-256. Enables content-addressed persistent SampleIndex reuse. */
  readonly contentHash?: string;
  readonly sourceStartUs?: number;
  /** Explicitly marks a range-backed representation as a still image. */
  readonly kind?: 'media' | 'image';
  readonly mimeType?: string;
}

export interface ProductionMediaUrlOptions extends ProductionMediaRepresentationOptions, FetchRangeReaderOptions {}

export interface ProductionMediaProviderOptions {
  /** Persistent or tiered cache. A bounded memory cache is used by default. */
  readonly cache?: CacheStore;
  /** Shared page-level budget. A provider-owned governor is created by default. */
  readonly governor?: PageMediaResourceGovernor;
  readonly maxCachedIndexes?: number;
  readonly maxCachedIndexBytes?: number;
  readonly maxDecodeSessions?: number;
  readonly maxCachedVideoFramesPerSession?: number;
  readonly maxCachedVideoBytesPerSession?: number;
  readonly maxSequentialDecodeGapUs?: number;
  readonly maxCachedImages?: number;
  readonly maxCachedImageBytes?: number;
  readonly maxImageDecodeBytes?: number;
  readonly maxConcurrentOperations?: number;
  readonly maxPendingOperations?: number;
}

export interface ProductionMediaSelection {
  readonly assetId: string;
  readonly representationId: string;
  readonly role: ProductionMediaRole;
  readonly usedProxy: boolean;
  readonly diagnostics: readonly string[];
}

export interface ProductionMediaProbe extends ProductionMediaSelection {
  readonly index: SampleIndex;
}

export interface ProductionMediaProviderSnapshot {
  readonly assets: number;
  readonly representations: number;
  readonly cachedIndexes: number;
  readonly cachedIndexBytes: number;
  readonly maxCachedIndexes: number;
  readonly maxCachedIndexBytes: number;
  readonly decodeSessions: number;
  readonly activeDecodeSessions: number;
  readonly audioSessions: number;
  readonly activeAudioSessions: number;
  readonly maxDecodeSessions: number;
  readonly cachedVideoFrames: number;
  readonly cachedVideoBytes: number;
  readonly maxCachedVideoFramesPerSession: number;
  readonly maxCachedVideoBytesPerSession: number;
  readonly maxSequentialDecodeGapUs: number;
  readonly decodeCacheHits: number;
  readonly decodeCacheMisses: number;
  readonly decodeSeeks: number;
  readonly sequentialDecodedFrames: number;
  readonly cachedImages: number;
  readonly cachedImageBytes: number;
  readonly maxCachedImages: number;
  readonly maxCachedImageBytes: number;
  readonly maxImageDecodeBytes: number;
  readonly imageCacheHits: number;
  readonly imageCacheMisses: number;
  readonly activeOperations: number;
  readonly pendingOperations: number;
  readonly maxConcurrentOperations: number;
  readonly maxPendingOperations: number;
  readonly governor: MediaResourceGovernorSnapshot;
  readonly cache: ReturnType<CacheStore['snapshot']>;
  readonly disposed: boolean;
}

interface RegisteredRepresentation {
  readonly id: string;
  readonly role: ProductionMediaRole;
  readonly reader: RangeReader;
  readonly kind: 'media' | 'image';
  readonly mimeType?: string;
  readonly contentHash?: string;
  durationUs?: number;
  width?: number;
  height?: number;
  readonly sourceStartUs?: number;
}

interface RegisteredAsset {
  readonly representations: Map<string, RegisteredRepresentation>;
}

/**
 * Shrinks a preview frame that is larger than the surface it will be composited
 * into.
 *
 * `maxDimension` previously only chose between registered representations, so
 * with no proxy attached it did nothing and a 4K source was uploaded to the GPU
 * at 4K to be sampled down into a 1080p frame. Scaling here is the same
 * reduction the compositor would do, moved to where it also shrinks the upload.
 *
 * Preview only: export must keep every source pixel. Takes ownership of `frame`
 * and returns an owned frame.
 */
async function downscaleForPreview(frame: VideoFrame, request: AelionMediaRequest | undefined): Promise<VideoFrame> {
  const maxDimension = request?.maxDimension;
  if (
    request?.purpose !== 'preview' ||
    maxDimension === undefined ||
    !Number.isFinite(maxDimension) ||
    maxDimension <= 0
  ) {
    return frame;
  }
  const largest = Math.max(frame.displayWidth, frame.displayHeight);
  if (largest <= maxDimension) return frame;
  const scale = maxDimension / largest;
  const width = Math.max(1, Math.round(frame.displayWidth * scale));
  const height = Math.max(1, Math.round(frame.displayHeight * scale));
  const duration = frame.duration;
  const timestamp = frame.timestamp;
  const bitmap = await createImageBitmap(frame, {
    resizeWidth: width,
    resizeHeight: height,
    resizeQuality: 'medium',
  });
  try {
    return new VideoFrame(bitmap, {
      timestamp,
      ...(duration === null ? {} : { duration }),
    });
  } finally {
    bitmap.close();
    frame.close();
  }
}

function stillImageSampleIndex(options: {
  readonly width: number;
  readonly height: number;
  readonly durationUs: number;
  readonly codec: string;
}): SampleIndex {
  const durationUs = Math.max(1, options.durationUs);
  return {
    schemaVersion: '1.0.0',
    container: 'unknown',
    durationUs,
    tracks: [
      {
        kind: 'video',
        id: 0,
        codec: options.codec,
        codecFamily: 'image',
        codedWidth: options.width,
        codedHeight: options.height,
        rotation: 0,
        color: {
          primaries: null,
          transfer: null,
          matrix: 'rgb',
          fullRange: true,
          highDynamicRange: false,
          canBeTransparent: true,
        },
      },
    ],
    capabilities: {
      timingAndSize: true,
      rawDecodeTimestamps: false,
      byteOffsets: false,
    },
    samples: {
      0: [
        {
          trackId: 0,
          sampleIndex: 0,
          kind: 'video',
          decodeOrder: 0,
          presentationOrder: 0,
          sourceSequenceNumber: 0,
          presentationTimestampUs: 0,
          durationUs,
          normalizedDecodeTimeUs: 0,
          isSync: true,
        },
      ],
    },
    presentationOrder: { 0: [0] },
    diagnostics: [],
  };
}

interface ResidentIndex {
  readonly index: SampleIndex;
  readonly byteLength: number;
  access: number;
}

interface ResidentDecodeSession {
  readonly session: VideoFrameDecodeSession;
  access: number;
  active: number;
}

interface ResidentAudioSession {
  readonly session: AudioPcmDecodeSession;
  window: AudioPcmBlock | undefined;
  access: number;
  active: number;
}

function audioWindowCovers(block: AudioPcmBlock, startUs: number, durationUs: number): boolean {
  return startUs >= block.startUs && startUs + durationUs <= block.startUs + block.durationUs;
}

function sliceAudioPcmBlock(block: AudioPcmBlock, startUs: number, durationUs: number): AudioPcmBlock {
  const startFrame = Math.max(0, Math.round(((startUs - block.startUs) * block.sampleRate) / 1_000_000));
  const frameCount = Math.min(
    Math.max(0, Math.ceil((durationUs * block.sampleRate) / 1_000_000)),
    Math.max(0, block.frameCount - startFrame),
  );
  return {
    sampleRate: block.sampleRate,
    channelCount: block.channelCount,
    startUs,
    durationUs,
    frameCount,
    interleaved: block.interleaved.subarray(
      startFrame * block.channelCount,
      (startFrame + frameCount) * block.channelCount,
    ),
  };
}

interface ResidentImage {
  readonly frame: VideoFrame;
  readonly byteLength: number;
  access: number;
}

interface OperationWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort: () => void;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function assertIdentifier(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new TypeError(`${name} must be a non-empty string of at most 512 characters`);
  }
}

function assertOptionalDimension(value: number | undefined, name: string): void {
  if (value !== undefined) positiveSafeInteger(value, name);
}

function assertOptionalTime(value: number | undefined, name: string, allowZero: boolean): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError');
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializeSampleIndex(index: SampleIndex): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(index, (_key, value: unknown) =>
      value instanceof Uint8Array ? { __aelionBytes: [...value] } : value,
    ),
  );
}

function reviveBytes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => reviveBytes(entry));
  if (!isRecord(value)) return value;
  if (
    Array.isArray(value.__aelionBytes) &&
    value.__aelionBytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return Uint8Array.from(value.__aelionBytes as number[]);
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, reviveBytes(entry)]));
}

function deserializeSampleIndex(bytes: Uint8Array): SampleIndex | undefined {
  let value: unknown;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    value = reviveBytes(parsed);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== '1.0.0' ||
    typeof value.durationUs !== 'number' ||
    !Array.isArray(value.tracks) ||
    !isRecord(value.samples) ||
    !isRecord(value.presentationOrder) ||
    !Array.isArray(value.diagnostics)
  ) {
    return undefined;
  }
  return value as unknown as SampleIndex;
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(asError(error, 'Media operation failed'));
      },
    );
  });
}

/**
 * Range-backed media provider for File/Blob, URL and OPFS sources.
 *
 * It keeps whole media out of JavaScript memory, reuses content-addressed
 * SampleIndexes, chooses preview proxies, and bounds decoder work across a page.
 */
export class ProductionMediaProvider implements AelionMediaProvider {
  readonly #assets = new Map<string, RegisteredAsset>();
  readonly #residentIndexes = new Map<string, ResidentIndex>();
  readonly #decodeSessions = new Map<string, ResidentDecodeSession>();
  readonly #audioSessions = new Map<string, ResidentAudioSession>();
  readonly #residentImages = new Map<string, ResidentImage>();
  readonly #indexOperations = new Map<string, Promise<SampleIndex>>();
  readonly #cache: CacheStore;
  readonly #governor: PageMediaResourceGovernor;
  readonly #ownsGovernor: boolean;
  readonly #maxCachedIndexes: number;
  readonly #maxCachedIndexBytes: number;
  readonly #maxDecodeSessions: number;
  readonly #maxCachedVideoFramesPerSession: number;
  readonly #maxCachedVideoBytesPerSession: number;
  readonly #maxSequentialDecodeGapUs: number;
  readonly #maxCachedImages: number;
  readonly #maxCachedImageBytes: number;
  readonly #maxImageDecodeBytes: number;
  readonly #maxConcurrentOperations: number;
  readonly #maxPendingOperations: number;
  readonly #waiters: OperationWaiter[] = [];
  readonly #lifecycle = new AbortController();
  #cachedIndexBytes = 0;
  #cachedImageBytes = 0;
  #imageCacheHits = 0;
  #imageCacheMisses = 0;
  #clock = 0;
  #activeOperations = 0;
  #operationSequence = 0;
  #generation = 0;
  #disposed = false;

  public constructor(options: ProductionMediaProviderOptions = {}) {
    this.#maxCachedIndexes = positiveSafeInteger(options.maxCachedIndexes ?? 8, 'maxCachedIndexes');
    this.#maxCachedIndexBytes = positiveSafeInteger(
      options.maxCachedIndexBytes ?? 64 * 1_024 * 1_024,
      'maxCachedIndexBytes',
    );
    this.#maxConcurrentOperations = positiveSafeInteger(
      options.maxConcurrentOperations ?? 4,
      'maxConcurrentOperations',
    );
    this.#maxPendingOperations = nonNegativeSafeInteger(options.maxPendingOperations ?? 64, 'maxPendingOperations');
    this.#maxDecodeSessions = positiveSafeInteger(
      options.maxDecodeSessions ?? this.#maxConcurrentOperations,
      'maxDecodeSessions',
    );
    this.#maxCachedVideoFramesPerSession = positiveSafeInteger(
      options.maxCachedVideoFramesPerSession ?? 24,
      'maxCachedVideoFramesPerSession',
    );
    this.#maxCachedVideoBytesPerSession = positiveSafeInteger(
      options.maxCachedVideoBytesPerSession ?? 96 * 1_024 * 1_024,
      'maxCachedVideoBytesPerSession',
    );
    this.#maxSequentialDecodeGapUs = positiveSafeInteger(
      options.maxSequentialDecodeGapUs ?? 3_000_000,
      'maxSequentialDecodeGapUs',
    );
    this.#maxCachedImages = positiveSafeInteger(options.maxCachedImages ?? 16, 'maxCachedImages');
    this.#maxCachedImageBytes = positiveSafeInteger(
      options.maxCachedImageBytes ?? 256 * 1_024 * 1_024,
      'maxCachedImageBytes',
    );
    this.#maxImageDecodeBytes = positiveSafeInteger(
      options.maxImageDecodeBytes ?? 64 * 1_024 * 1_024,
      'maxImageDecodeBytes',
    );
    this.#cache = options.cache ?? new MemoryCacheStore(this.#maxCachedIndexBytes);
    this.#ownsGovernor = options.governor === undefined;
    this.#governor =
      options.governor ??
      new PageMediaResourceGovernor(
        {
          decoderSlots: this.#maxConcurrentOperations,
          gpuBytes: 1,
          cacheBytes: this.#maxCachedIndexBytes,
        },
        Math.max(1, this.#maxPendingOperations),
      );
  }

  public registerReader(
    assetId: string,
    reader: RangeReader,
    options: ProductionMediaRepresentationOptions = {},
  ): void {
    this.#assertActive();
    assertIdentifier(assetId, 'assetId');
    assertIdentifier(reader.id, 'RangeReader id');
    const role = options.role ?? 'original';
    const id = options.id ?? `${assetId}:${role}`;
    assertIdentifier(id, 'representation id');
    assertOptionalTime(options.durationUs, 'durationUs', false);
    assertOptionalTime(options.sourceStartUs, 'sourceStartUs', true);
    assertOptionalDimension(options.width, 'width');
    assertOptionalDimension(options.height, 'height');
    if (options.mimeType !== undefined && options.mimeType.trim().length === 0) {
      throw new TypeError('mimeType must be a non-empty string');
    }
    if (options.contentHash !== undefined && !/^[0-9a-f]{64}$/u.test(options.contentHash)) {
      throw new TypeError('contentHash must be a lowercase SHA-256 value');
    }

    let asset = this.#assets.get(assetId);
    if (asset === undefined) {
      asset = { representations: new Map() };
      this.#assets.set(assetId, asset);
    }
    if (role === 'original') {
      for (const [existingId, existing] of asset.representations) {
        if (existing.role === 'original' && existingId !== id) {
          asset.representations.delete(existingId);
          this.#dropResidentIndex(this.#indexKey(assetId, existingId));
          this.#dropDecodeSessions(assetId, existingId);
          this.#dropAudioSessions(assetId, existingId);
          this.#dropResidentImage(this.#indexKey(assetId, existingId));
        }
      }
    }
    asset.representations.set(id, {
      id,
      role,
      reader,
      kind: options.kind ?? 'media',
      ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
      ...(options.durationUs === undefined ? {} : { durationUs: options.durationUs }),
      ...(options.width === undefined ? {} : { width: options.width }),
      ...(options.height === undefined ? {} : { height: options.height }),
      ...(options.contentHash === undefined ? {} : { contentHash: options.contentHash }),
      ...(options.sourceStartUs === undefined ? {} : { sourceStartUs: options.sourceStartUs }),
    });
    this.#generation += 1;
    this.#dropResidentIndex(this.#indexKey(assetId, id));
    this.#dropDecodeSessions(assetId, id);
    this.#dropAudioSessions(assetId, id);
    this.#dropResidentImage(this.#indexKey(assetId, id));
  }

  public registerBlob(assetId: string, blob: Blob, options: ProductionMediaRepresentationOptions = {}): void {
    const role = options.role ?? 'original';
    const id = options.id ?? `${assetId}:${role}`;
    this.registerReader(assetId, new BlobRangeReader(id, blob), {
      ...options,
      id,
      role,
      kind: options.kind ?? (blob.type.startsWith('image/') ? 'image' : 'media'),
      ...(options.mimeType === undefined && blob.type.length > 0 ? { mimeType: blob.type } : {}),
    });
  }

  public registerFile(assetId: string, file: File, options: ProductionMediaRepresentationOptions = {}): void {
    this.registerBlob(assetId, file, options);
  }

  public registerImageBlob(assetId: string, blob: Blob, options: ProductionMediaRepresentationOptions = {}): void {
    this.registerBlob(assetId, blob, {
      ...options,
      kind: 'image',
      ...(options.mimeType === undefined && blob.type.length > 0 ? { mimeType: blob.type } : {}),
    });
  }

  public registerImageFile(assetId: string, file: File, options: ProductionMediaRepresentationOptions = {}): void {
    this.registerImageBlob(assetId, file, options);
  }

  public registerUrl(assetId: string, url: string, options: ProductionMediaUrlOptions = {}): void {
    const role = options.role ?? 'original';
    const id = options.id ?? `${assetId}:${role}`;
    const readerOptions: FetchRangeReaderOptions = {
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    };
    this.registerReader(assetId, new FetchRangeReader(id, url, readerOptions), {
      ...options,
      id,
      role,
    });
  }

  public async registerOpfs(
    assetId: string,
    path: string,
    options: ProductionMediaRepresentationOptions = {},
  ): Promise<void> {
    this.#assertActive();
    const navigatorValue: unknown = Reflect.get(globalThis, 'navigator');
    const storage = isRecord(navigatorValue) ? navigatorValue.storage : undefined;
    const getDirectory = isRecord(storage) ? storage.getDirectory : undefined;
    if (typeof getDirectory !== 'function') {
      throw new Error('Origin Private File System is unavailable');
    }
    const parts = path.split('/');
    if (parts.length === 0 || parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
      throw new TypeError('OPFS path must be a relative file path without empty or dot segments');
    }
    const fileName = parts.pop();
    if (fileName === undefined) throw new TypeError('OPFS path must name a file');
    let directory = await (Reflect.apply(getDirectory, storage, []) as Promise<FileSystemDirectoryHandle>);
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();
    this.registerFile(assetId, file, options);
  }

  public unregister(assetId: string): boolean {
    this.#assertActive();
    const removed = this.#assets.delete(assetId);
    if (!removed) return false;
    this.#generation += 1;
    for (const key of [...this.#residentIndexes.keys()]) {
      if (key.startsWith(`${assetId}\u0000`)) this.#dropResidentIndex(key);
    }
    this.#dropDecodeSessions(assetId);
    this.#dropAudioSessions(assetId);
    for (const key of [...this.#residentImages.keys()]) {
      if (key.startsWith(`${assetId}\u0000`)) this.#dropResidentImage(key);
    }
    return true;
  }

  public representationFor(
    assetId: string,
    request: Partial<AelionMediaRequest> & { readonly purpose?: 'preview' | 'export' } = {},
  ): ProductionMediaSelection {
    const selected = this.#select(assetId, request);
    return {
      assetId,
      representationId: selected.representation.id,
      role: selected.representation.role,
      usedProxy: selected.usedProxy,
      diagnostics: selected.diagnostics,
    };
  }

  public async probe(
    assetId: string,
    options: Partial<AelionMediaRequest> & { readonly signal?: AbortSignal } = {},
  ): Promise<ProductionMediaProbe> {
    const selected = this.#select(assetId, options);
    const index = await this.#sampleIndex(assetId, selected.representation, options.signal);
    return {
      assetId,
      representationId: selected.representation.id,
      role: selected.representation.role,
      usedProxy: selected.usedProxy,
      diagnostics: selected.diagnostics,
      index,
    };
  }

  public async frameAt(
    assetId: string,
    streamIndex: number,
    sourceTimeUs: number,
    signal?: AbortSignal,
    request?: AelionMediaRequest,
  ): Promise<VideoFrame> {
    this.#assertActive();
    const selected = this.#select(assetId, request ?? { purpose: 'export' });
    if (selected.representation.kind === 'image') {
      if (streamIndex !== 0) throw new RangeError('Still images only expose stream index 0');
      return this.#run(signal, (operationSignal) =>
        this.#imageFrame(assetId, selected.representation, operationSignal),
      );
    }
    const index = await this.#sampleIndex(assetId, selected.representation, signal);
    const presentationTimeUs = proxyPresentationTimeUs(sourceTimeUs, {
      id: selected.representation.id,
      role: selected.representation.role,
      locator: selected.representation.reader.id,
      ...(selected.representation.durationUs === undefined ? {} : { durationUs: selected.representation.durationUs }),
      ...(selected.representation.sourceStartUs === undefined
        ? {}
        : { sourceStartUs: selected.representation.sourceStartUs }),
    });
    return this.#run(signal, async (operationSignal) => {
      const lease = await this.#governor.acquire(
        {
          ownerId: `aelion-media:${++this.#operationSequence}:${assetId}`,
          priority: request?.purpose === 'preview' ? 'preview' : 'export',
          decoderSlots: 1,
          gpuBytes: 0,
          cacheBytes: 0,
        },
        operationSignal,
      );
      try {
        const decodeOptions = {
          sampleIndex: index,
          streamIndex,
          signal: operationSignal,
          maxDecodeQueueSize: 8,
        };
        if (request?.transient === true) {
          const result = await decodeVideoFrameAtFromReader(
            selected.representation.reader,
            presentationTimeUs,
            decodeOptions,
          );
          try {
            throwIfAborted(operationSignal, 'production media video decode');
            return await downscaleForPreview(result.frame.clone(), request);
          } finally {
            result.close();
          }
        }
        const resident = this.#acquireDecodeSession(assetId, selected.representation, streamIndex, index);
        try {
          const result =
            resident === undefined
              ? await decodeVideoFrameAtFromReader(selected.representation.reader, presentationTimeUs, decodeOptions)
              : await resident.session.frameAt(presentationTimeUs, operationSignal);
          try {
            throwIfAborted(operationSignal, 'production media video decode');
            return await downscaleForPreview(result.frame.clone(), request);
          } finally {
            result.close();
          }
        } finally {
          if (resident !== undefined) {
            resident.active -= 1;
            resident.access = ++this.#clock;
          }
        }
      } finally {
        await lease.dispose();
      }
    });
  }

  public async pcmRange(
    assetId: string,
    streamIndex: number,
    startUs: number,
    durationUs: number,
    signal?: AbortSignal,
  ): Promise<PcmSourceBlock> {
    this.#assertActive();
    const selected = this.#select(assetId, { purpose: 'export' });
    // A window hit is a view into PCM this provider already holds. Admission and
    // the operation queue exist to bound concurrent decoding, and this path
    // decodes nothing, so charging it a decoder slot only lets a memcpy wait
    // behind real video decode admission -- fifty times a second during
    // playback, which is exactly when the audio ring can least afford to wait.
    const cached = this.#cachedAudioWindow(assetId, selected.representation, streamIndex, startUs, durationUs);
    if (cached !== undefined) {
      throwIfAborted(signal, 'production media audio slice');
      return cached;
    }
    return this.#run(signal, async (operationSignal) => {
      const lease = await this.#governor.acquire(
        {
          ownerId: `aelion-media:${++this.#operationSequence}:${assetId}:audio`,
          priority: 'preview',
          decoderSlots: 1,
          gpuBytes: 0,
          cacheBytes: 0,
        },
        operationSignal,
      );
      try {
        const resident = this.#acquireAudioSession(assetId, selected.representation, streamIndex);
        if (resident === undefined) {
          return await decodeAudioPcmRangeFromReader(selected.representation.reader, startUs, durationUs, {
            streamIndex,
            signal: operationSignal,
          });
        }
        try {
          const cached = resident.window;
          if (cached !== undefined && audioWindowCovers(cached, startUs, durationUs)) {
            return sliceAudioPcmBlock(cached, startUs, durationUs);
          }
          const decodeDurationUs = Math.max(durationUs, AUDIO_PCM_WINDOW_US);
          const block = await resident.session.pcmRange(startUs, decodeDurationUs, operationSignal);
          resident.window = block;
          return decodeDurationUs === durationUs ? block : sliceAudioPcmBlock(block, startUs, durationUs);
        } finally {
          resident.active -= 1;
          resident.access = ++this.#clock;
        }
      } finally {
        await lease.dispose();
      }
    });
  }

  public clear(): void {
    this.#assertActive();
    this.#generation += 1;
    this.#residentIndexes.clear();
    this.#cachedIndexBytes = 0;
    for (const resident of this.#decodeSessions.values()) resident.session.dispose();
    this.#decodeSessions.clear();
    for (const resident of this.#audioSessions.values()) resident.session.dispose();
    this.#audioSessions.clear();
    for (const resident of this.#residentImages.values()) resident.frame.close();
    this.#residentImages.clear();
    this.#cachedImageBytes = 0;
  }

  public registerImageUrl(assetId: string, url: string, options: ProductionMediaUrlOptions = {}): void {
    this.registerUrl(assetId, url, { ...options, kind: 'image' });
  }

  public snapshot(): ProductionMediaProviderSnapshot {
    const decodeSnapshots = [...this.#decodeSessions.values()].map((value) => value.session.snapshot());
    return {
      assets: this.#assets.size,
      representations: [...this.#assets.values()].reduce((total, asset) => total + asset.representations.size, 0),
      cachedIndexes: this.#residentIndexes.size,
      cachedIndexBytes: this.#cachedIndexBytes,
      maxCachedIndexes: this.#maxCachedIndexes,
      maxCachedIndexBytes: this.#maxCachedIndexBytes,
      decodeSessions: this.#decodeSessions.size,
      activeDecodeSessions: [...this.#decodeSessions.values()].filter((value) => value.active > 0).length,
      audioSessions: this.#audioSessions.size,
      activeAudioSessions: [...this.#audioSessions.values()].filter((value) => value.active > 0).length,
      maxDecodeSessions: this.#maxDecodeSessions,
      cachedVideoFrames: decodeSnapshots.reduce((total, value) => total + value.cachedFrames, 0),
      cachedVideoBytes: decodeSnapshots.reduce((total, value) => total + value.cachedBytes, 0),
      maxCachedVideoFramesPerSession: this.#maxCachedVideoFramesPerSession,
      maxCachedVideoBytesPerSession: this.#maxCachedVideoBytesPerSession,
      maxSequentialDecodeGapUs: this.#maxSequentialDecodeGapUs,
      decodeCacheHits: decodeSnapshots.reduce((total, value) => total + value.cacheHits, 0),
      decodeCacheMisses: decodeSnapshots.reduce((total, value) => total + value.cacheMisses, 0),
      decodeSeeks: decodeSnapshots.reduce((total, value) => total + value.seeks, 0),
      sequentialDecodedFrames: decodeSnapshots.reduce((total, value) => total + value.sequentialFrames, 0),
      cachedImages: this.#residentImages.size,
      cachedImageBytes: this.#cachedImageBytes,
      maxCachedImages: this.#maxCachedImages,
      maxCachedImageBytes: this.#maxCachedImageBytes,
      maxImageDecodeBytes: this.#maxImageDecodeBytes,
      imageCacheHits: this.#imageCacheHits,
      imageCacheMisses: this.#imageCacheMisses,
      activeOperations: this.#activeOperations,
      pendingOperations: this.#waiters.length,
      maxConcurrentOperations: this.#maxConcurrentOperations,
      maxPendingOperations: this.#maxPendingOperations,
      governor: this.#governor.snapshot(),
      cache: this.#cache.snapshot(),
      disposed: this.#disposed,
    };
  }

  public getDiagnosticSnapshot(): JsonObject {
    return this.snapshot() as unknown as JsonObject;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle.abort(new DOMException('ProductionMediaProvider was disposed', 'AbortError'));
    for (const waiter of this.#waiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      waiter.reject(new ReferenceError('ProductionMediaProvider is disposed'));
    }
    this.#assets.clear();
    this.#residentIndexes.clear();
    this.#cachedIndexBytes = 0;
    for (const resident of this.#decodeSessions.values()) resident.session.dispose();
    this.#decodeSessions.clear();
    for (const resident of this.#audioSessions.values()) resident.session.dispose();
    this.#audioSessions.clear();
    for (const resident of this.#residentImages.values()) resident.frame.close();
    this.#residentImages.clear();
    this.#cachedImageBytes = 0;
    if (this.#ownsGovernor) this.#governor.dispose();
  }

  #select(
    assetId: string,
    request: Partial<AelionMediaRequest>,
  ): {
    readonly representation: RegisteredRepresentation;
    readonly usedProxy: boolean;
    readonly diagnostics: readonly string[];
  } {
    this.#assertActive();
    const asset = this.#assets.get(assetId);
    if (asset === undefined) throw new ReferenceError(`Unknown media asset: ${assetId}`);
    const original = [...asset.representations.values()].find((value) => value.role === 'original');
    if (original === undefined) throw new ReferenceError(`Media asset has no original: ${assetId}`);
    const manifest = {
      id: assetId,
      locator: original.reader.id,
      representations: [...asset.representations.values()].map((value) => ({
        id: value.id,
        role: value.role,
        locator: value.reader.id,
        ...(value.durationUs === undefined ? {} : { durationUs: value.durationUs }),
        ...(value.width === undefined ? {} : { width: value.width }),
        ...(value.height === undefined ? {} : { height: value.height }),
        ...(value.contentHash === undefined ? {} : { contentHash: value.contentHash }),
        ...(value.sourceStartUs === undefined ? {} : { sourceStartUs: value.sourceStartUs }),
      })),
    } satisfies JsonObject;
    const selection = selectAssetRepresentation(manifest, {
      purpose: request.purpose ?? 'export',
      ...(request.maxDimension === undefined ? {} : { maxDimension: request.maxDimension }),
      ...(original.durationUs === undefined ? {} : { sourceDurationUs: original.durationUs }),
    });
    const representation = asset.representations.get(selection.representation.id);
    if (representation === undefined) {
      throw new Error(`Selected media representation is not registered: ${selection.representation.id}`);
    }
    return {
      representation,
      usedProxy: selection.usedProxy,
      diagnostics: selection.diagnostics,
    };
  }

  #sampleIndex(assetId: string, representation: RegisteredRepresentation, signal?: AbortSignal): Promise<SampleIndex> {
    throwIfAborted(signal, 'production media sample index');
    const key = this.#indexKey(assetId, representation.id);
    const resident = this.#residentIndexes.get(key);
    if (resident !== undefined) {
      resident.access = ++this.#clock;
      return Promise.resolve(resident.index);
    }
    const current = this.#indexOperations.get(key);
    if (current !== undefined) return awaitWithSignal(current, signal);

    const generation = this.#generation;
    const operation = this.#run(this.#lifecycle.signal, async (operationSignal) => {
      const address = this.#cacheAddress(representation);
      if (address !== undefined) {
        const cached = await this.#cache.get(address, operationSignal);
        if (cached !== undefined) {
          const restored = deserializeSampleIndex(cached);
          if (restored !== undefined) {
            this.#rememberIndex(key, restored, cached.byteLength, generation);
            this.#hydrateRepresentation(representation, restored, generation);
            return restored;
          }
          await this.#cache.delete(address, operationSignal);
        }
      }

      const index =
        representation.kind === 'image'
          ? await this.#stillImageIndex(assetId, representation, operationSignal)
          : await createSampleIndexFromReader(representation.reader, {
              signal: operationSignal,
            });
      const serialized = serializeSampleIndex(index);
      this.#hydrateRepresentation(representation, index, generation);
      this.#rememberIndex(key, index, serialized.byteLength, generation);
      if (address !== undefined && serialized.byteLength <= this.#maxCachedIndexBytes) {
        await this.#cache.put(address, serialized, operationSignal);
      }
      return index;
    });
    this.#indexOperations.set(key, operation);
    void operation.finally(() => this.#indexOperations.delete(key)).catch(() => undefined);
    return awaitWithSignal(operation, signal);
  }

  #hydrateRepresentation(representation: RegisteredRepresentation, index: SampleIndex, generation: number): void {
    if (generation !== this.#generation) return;
    representation.durationUs ??= index.durationUs;
    const video = index.tracks.find((track) => track.kind === 'video');
    if (video !== undefined) {
      representation.width ??= video.codedWidth;
      representation.height ??= video.codedHeight;
    }
  }

  #rememberIndex(key: string, index: SampleIndex, byteLength: number, generation: number): void {
    if (generation !== this.#generation || byteLength > this.#maxCachedIndexBytes) return;
    this.#dropResidentIndex(key);
    this.#residentIndexes.set(key, { index, byteLength, access: ++this.#clock });
    this.#cachedIndexBytes += byteLength;
    while (this.#residentIndexes.size > this.#maxCachedIndexes || this.#cachedIndexBytes > this.#maxCachedIndexBytes) {
      const oldest = [...this.#residentIndexes.entries()].sort((left, right) => left[1].access - right[1].access)[0];
      if (oldest === undefined) break;
      this.#dropResidentIndex(oldest[0]);
    }
  }

  #dropResidentIndex(key: string): void {
    const resident = this.#residentIndexes.get(key);
    if (resident !== undefined) this.#cachedIndexBytes -= resident.byteLength;
    this.#residentIndexes.delete(key);
  }

  #acquireDecodeSession(
    assetId: string,
    representation: RegisteredRepresentation,
    streamIndex: number,
    index: SampleIndex,
  ): ResidentDecodeSession | undefined {
    const key = this.#decodeSessionKey(assetId, representation.id, streamIndex);
    const existing = this.#decodeSessions.get(key);
    if (existing !== undefined) {
      existing.active += 1;
      existing.access = ++this.#clock;
      return existing;
    }
    while (this.#decodeSessions.size >= this.#maxDecodeSessions) {
      const oldest = [...this.#decodeSessions.entries()]
        .filter(([, value]) => value.active === 0)
        .sort((left, right) => left[1].access - right[1].access)[0];
      if (oldest === undefined) return undefined;
      oldest[1].session.dispose();
      this.#decodeSessions.delete(oldest[0]);
    }
    const resident: ResidentDecodeSession = {
      session: createVideoFrameDecodeSessionFromReader(representation.reader, index, {
        streamIndex,
        maxCachedFrames: this.#maxCachedVideoFramesPerSession,
        maxCachedBytes: this.#maxCachedVideoBytesPerSession,
        maxSequentialGapUs: this.#maxSequentialDecodeGapUs,
      }),
      active: 1,
      access: ++this.#clock,
    };
    this.#decodeSessions.set(key, resident);
    return resident;
  }

  #dropDecodeSessions(assetId: string, representationId?: string): void {
    const prefix = representationId === undefined ? `${assetId}\u0000` : `${assetId}\u0000${representationId}\u0000`;
    for (const [key, resident] of [...this.#decodeSessions]) {
      if (!key.startsWith(prefix)) continue;
      resident.session.dispose();
      this.#decodeSessions.delete(key);
    }
  }

  /**
   * Returns a slice of an already-decoded window, or `undefined` when the range
   * is not covered. Synchronous and side-effect free apart from LRU bookkeeping,
   * so it is safe to consult before admission.
   */
  #cachedAudioWindow(
    assetId: string,
    representation: RegisteredRepresentation,
    streamIndex: number,
    startUs: number,
    durationUs: number,
  ): PcmSourceBlock | undefined {
    const key = this.#decodeSessionKey(assetId, representation.id, streamIndex);
    const resident = this.#audioSessions.get(key);
    const window = resident?.window;
    if (resident === undefined || window === undefined) return undefined;
    if (!audioWindowCovers(window, startUs, durationUs)) return undefined;
    resident.access = ++this.#clock;
    return sliceAudioPcmBlock(window, startUs, durationUs);
  }

  #acquireAudioSession(
    assetId: string,
    representation: RegisteredRepresentation,
    streamIndex: number,
  ): ResidentAudioSession | undefined {
    const key = this.#decodeSessionKey(assetId, representation.id, streamIndex);
    const existing = this.#audioSessions.get(key);
    if (existing !== undefined) {
      existing.active += 1;
      existing.access = ++this.#clock;
      return existing;
    }
    while (this.#audioSessions.size >= this.#maxDecodeSessions) {
      const oldest = [...this.#audioSessions.entries()]
        .filter(([, value]) => value.active === 0)
        .sort((left, right) => left[1].access - right[1].access)[0];
      if (oldest === undefined) return undefined;
      oldest[1].session.dispose();
      this.#audioSessions.delete(oldest[0]);
    }
    const resident: ResidentAudioSession = {
      session: createAudioPcmDecodeSessionFromReader(representation.reader, { streamIndex }),
      window: undefined,
      active: 1,
      access: ++this.#clock,
    };
    this.#audioSessions.set(key, resident);
    return resident;
  }

  #dropAudioSessions(assetId: string, representationId?: string): void {
    const prefix = representationId === undefined ? `${assetId}\u0000` : `${assetId}\u0000${representationId}\u0000`;
    for (const [key, resident] of [...this.#audioSessions]) {
      if (!key.startsWith(prefix)) continue;
      resident.session.dispose();
      this.#audioSessions.delete(key);
    }
  }

  async #stillImageIndex(
    assetId: string,
    representation: RegisteredRepresentation,
    signal: AbortSignal,
  ): Promise<SampleIndex> {
    const width = representation.width;
    const height = representation.height;
    if (typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0) {
      return stillImageSampleIndex({
        width,
        height,
        durationUs: representation.durationUs ?? 1,
        codec: representation.mimeType ?? 'image',
      });
    }
    const frame = await this.#imageFrame(assetId, representation, signal);
    try {
      return stillImageSampleIndex({
        width: frame.displayWidth,
        height: frame.displayHeight,
        durationUs: representation.durationUs ?? 1,
        codec: representation.mimeType ?? 'image',
      });
    } finally {
      frame.close();
    }
  }

  async #imageFrame(
    assetId: string,
    representation: RegisteredRepresentation,
    signal: AbortSignal,
  ): Promise<VideoFrame> {
    const key = this.#indexKey(assetId, representation.id);
    const resident = this.#residentImages.get(key);
    if (resident !== undefined) {
      resident.access = ++this.#clock;
      this.#imageCacheHits += 1;
      return resident.frame.clone();
    }
    this.#imageCacheMisses += 1;
    const generation = this.#generation;
    const decoded = await decodeStillImageFromReader(representation.reader, {
      maxBytes: this.#maxImageDecodeBytes,
      ...(representation.mimeType === undefined ? {} : { mimeType: representation.mimeType }),
      signal,
    });
    const byteLength = (() => {
      try {
        return decoded.frame.allocationSize();
      } catch {
        return decoded.width * decoded.height * 4;
      }
    })();
    const value: ResidentImage = {
      frame: decoded.frame,
      byteLength,
      access: ++this.#clock,
    };
    if (generation === this.#generation && byteLength <= this.#maxCachedImageBytes) {
      this.#rememberImage(key, value);
    }
    try {
      return value.frame.clone();
    } finally {
      if (this.#residentImages.get(key) !== value) value.frame.close();
    }
  }

  #rememberImage(key: string, image: ResidentImage): void {
    this.#dropResidentImage(key);
    this.#residentImages.set(key, image);
    this.#cachedImageBytes += image.byteLength;
    while (this.#residentImages.size > this.#maxCachedImages || this.#cachedImageBytes > this.#maxCachedImageBytes) {
      const oldest = [...this.#residentImages.entries()].sort((left, right) => left[1].access - right[1].access)[0];
      if (oldest === undefined) break;
      this.#dropResidentImage(oldest[0]);
    }
  }

  #dropResidentImage(key: string): void {
    const resident = this.#residentImages.get(key);
    if (resident === undefined) return;
    this.#residentImages.delete(key);
    this.#cachedImageBytes -= resident.byteLength;
    resident.frame.close();
  }

  #cacheAddress(representation: RegisteredRepresentation): CacheAddress | undefined {
    return representation.contentHash === undefined
      ? undefined
      : {
          namespace: 'sample-index',
          contentHash: representation.contentHash,
          version: SAMPLE_INDEX_CACHE_VERSION,
          variant: representation.id,
        };
  }

  #indexKey(assetId: string, representationId: string): string {
    return `${assetId}\u0000${representationId}`;
  }

  #decodeSessionKey(assetId: string, representationId: string, streamIndex: number): string {
    return `${assetId}\u0000${representationId}\u0000${streamIndex.toString()}`;
  }

  async #run<T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertActive();
    const release = await this.#acquireOperation(signal);
    const controller = new AbortController();
    const signals = signal === undefined ? [this.#lifecycle.signal] : [this.#lifecycle.signal, signal];
    const listeners = signals.map((source) => {
      const abort = (): void => controller.abort(abortReason(source));
      source.addEventListener('abort', abort, { once: true });
      if (source.aborted) abort();
      return { source, abort };
    });
    try {
      throwIfAborted(controller.signal, 'production media operation');
      return await operation(controller.signal);
    } finally {
      for (const listener of listeners) {
        listener.source.removeEventListener('abort', listener.abort);
      }
      release();
    }
  }

  #acquireOperation(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    if (this.#activeOperations < this.#maxConcurrentOperations && this.#waiters.length === 0) {
      this.#activeOperations += 1;
      return Promise.resolve(this.#releaseOperation());
    }
    if (this.#waiters.length >= this.#maxPendingOperations) {
      return Promise.reject(new RangeError('MEDIA_RESOURCE_QUEUE_FULL'));
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index < 0) return;
        this.#waiters.splice(index, 1);
        reject(signal === undefined ? new Error('Operation aborted') : abortReason(signal));
      };
      const waiter: OperationWaiter = {
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
        onAbort,
      };
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #releaseOperation(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeOperations -= 1;
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      waiter.signal?.removeEventListener('abort', waiter.onAbort);
      this.#activeOperations += 1;
      waiter.resolve(this.#releaseOperation());
    };
  }

  #assertActive(): void {
    if (this.#disposed) throw new ReferenceError('ProductionMediaProvider is disposed');
  }
}
