import { frameStartUs, throwIfAborted } from '@aelionsdk/core';
import { Mp4OutputFormat, WebMOutputFormat } from 'mediabunny';

import { av1CodecString, hevcCodecString, negotiateAvcCodecString, preferredAvcCodecString } from './profiles.js';
import {
  exportMuxed,
  type MuxedEncoderConfiguration,
  type MuxedExportProfile,
  type MuxedExportRange,
  type WebMExportOptions,
  type WebMExportResult,
} from './webm-export.js';

export type ResumableMuxedProfile = MuxedEncoderConfiguration['profile'];

export interface ResumableMuxedUnitMetadata {
  readonly index: number;
  readonly videoStartFrame: number;
  readonly videoEndFrameExclusive: number;
  readonly audioStartFrame: number;
  readonly audioEndFrameExclusive: number;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ResumableMuxedExportManifest {
  readonly version: 1;
  readonly contentId: string;
  readonly configurationId: string;
  readonly profile: ResumableMuxedProfile;
  readonly durationUs: number;
  readonly totalUnits: number;
  readonly completedUnits: number;
  readonly units: readonly ResumableMuxedUnitMetadata[];
  readonly mimeType?: string;
  readonly encoderConfiguration?: MuxedEncoderConfiguration;
  readonly updatedAtMs: number;
}

export interface ResumableMuxedExportUnit {
  readonly index: number;
  readonly init?: Uint8Array;
  readonly media: Uint8Array;
}

export interface ResumableMuxedExportStore {
  loadManifest(key: string, signal?: AbortSignal): Promise<ResumableMuxedExportManifest | undefined>;
  loadUnit(key: string, index: number, signal?: AbortSignal): Promise<ResumableMuxedExportUnit | undefined>;
  /** Commits unit bytes and the advanced manifest in one durable transaction. */
  commitUnit(
    key: string,
    unit: ResumableMuxedExportUnit,
    manifest: ResumableMuxedExportManifest,
    signal?: AbortSignal,
  ): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

function cloneUnit(unit: ResumableMuxedExportUnit): ResumableMuxedExportUnit {
  return {
    index: unit.index,
    ...(unit.init === undefined ? {} : { init: unit.init.slice() }),
    media: unit.media.slice(),
  };
}

export class MemoryResumableMuxedExportStore implements ResumableMuxedExportStore {
  readonly #manifests = new Map<string, ResumableMuxedExportManifest>();
  readonly #units = new Map<string, ResumableMuxedExportUnit>();

  public loadManifest(key: string, signal?: AbortSignal): Promise<ResumableMuxedExportManifest | undefined> {
    throwIfAborted(signal, 'Load resumable export manifest');
    const value = this.#manifests.get(key);
    return Promise.resolve(value === undefined ? undefined : structuredClone(value));
  }

  public loadUnit(key: string, index: number, signal?: AbortSignal): Promise<ResumableMuxedExportUnit | undefined> {
    throwIfAborted(signal, 'Load resumable export unit');
    const value = this.#units.get(`${key}:${index.toString()}`);
    return Promise.resolve(value === undefined ? undefined : cloneUnit(value));
  }

  public commitUnit(
    key: string,
    unit: ResumableMuxedExportUnit,
    manifest: ResumableMuxedExportManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, 'Commit resumable export unit');
    this.#units.set(`${key}:${unit.index.toString()}`, cloneUnit(unit));
    this.#manifests.set(key, structuredClone(manifest));
    return Promise.resolve();
  }

  public delete(key: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Delete resumable export');
    const manifest = this.#manifests.get(key);
    if (manifest !== undefined) {
      for (let index = 0; index < manifest.totalUnits; index += 1) {
        this.#units.delete(`${key}:${index.toString()}`);
      }
    }
    this.#manifests.delete(key);
    return Promise.resolve();
  }
}

interface IndexedDbManifestRecord {
  readonly id: string;
  readonly value: ResumableMuxedExportManifest;
}

interface IndexedDbUnitRecord {
  readonly id: string;
  readonly index: number;
  readonly init?: ArrayBuffer;
  readonly media: ArrayBuffer;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('IndexedDB request failed')), {
      once: true,
    });
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('IndexedDB transaction aborted')),
      { once: true },
    );
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('IndexedDB transaction failed')),
      { once: true },
    );
  });
}

/**
 * IndexedDB-backed binary checkpoint store. Unit bytes and their prefix
 * manifest advance in the same read/write transaction, so a reload observes
 * either the previous committed prefix or the complete next unit.
 */
export class IndexedDbResumableMuxedExportStore implements ResumableMuxedExportStore {
  readonly #databaseName: string;
  readonly #namespace: string;
  #database: Promise<IDBDatabase> | undefined;

  public constructor(options: { readonly databaseName?: string; readonly namespace?: string } = {}) {
    this.#databaseName = options.databaseName ?? 'aelion-export-checkpoints';
    this.#namespace = options.namespace ?? 'default';
  }

  public async loadManifest(key: string, signal?: AbortSignal): Promise<ResumableMuxedExportManifest | undefined> {
    throwIfAborted(signal, 'Load resumable export manifest');
    const database = await this.#open();
    throwIfAborted(signal, 'Load resumable export manifest');
    const transaction = database.transaction('manifests', 'readonly');
    const record = await requestResult(
      transaction.objectStore('manifests').get(this.#manifestId(key)) as IDBRequest<
        IndexedDbManifestRecord | undefined
      >,
    );
    await transactionCompletion(transaction);
    return record?.value;
  }

  public async loadUnit(
    key: string,
    index: number,
    signal?: AbortSignal,
  ): Promise<ResumableMuxedExportUnit | undefined> {
    throwIfAborted(signal, 'Load resumable export unit');
    const database = await this.#open();
    throwIfAborted(signal, 'Load resumable export unit');
    const transaction = database.transaction('units', 'readonly');
    const record = await requestResult(
      transaction.objectStore('units').get(this.#unitId(key, index)) as IDBRequest<IndexedDbUnitRecord | undefined>,
    );
    await transactionCompletion(transaction);
    return record === undefined
      ? undefined
      : {
          index: record.index,
          ...(record.init === undefined ? {} : { init: new Uint8Array(record.init) }),
          media: new Uint8Array(record.media),
        };
  }

  public async commitUnit(
    key: string,
    unit: ResumableMuxedExportUnit,
    manifest: ResumableMuxedExportManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, 'Commit resumable export unit');
    const database = await this.#open();
    throwIfAborted(signal, 'Commit resumable export unit');
    const transaction = database.transaction(['units', 'manifests'], 'readwrite');
    transaction.objectStore('units').put({
      id: this.#unitId(key, unit.index),
      index: unit.index,
      ...(unit.init === undefined ? {} : { init: unit.init.slice().buffer }),
      media: unit.media.slice().buffer,
    } satisfies IndexedDbUnitRecord);
    transaction.objectStore('manifests').put({
      id: this.#manifestId(key),
      value: manifest,
    } satisfies IndexedDbManifestRecord);
    await transactionCompletion(transaction);
  }

  public async delete(key: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, 'Delete resumable export');
    const manifest = await this.loadManifest(key, signal);
    const database = await this.#open();
    const transaction = database.transaction(['units', 'manifests'], 'readwrite');
    transaction.objectStore('manifests').delete(this.#manifestId(key));
    for (let index = 0; index < (manifest?.totalUnits ?? 0); index += 1) {
      transaction.objectStore('units').delete(this.#unitId(key, index));
    }
    await transactionCompletion(transaction);
  }

  async #open(): Promise<IDBDatabase> {
    this.#database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#databaseName, 1);
      request.addEventListener(
        'upgradeneeded',
        () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('manifests')) {
            database.createObjectStore('manifests', { keyPath: 'id' });
          }
          if (!database.objectStoreNames.contains('units')) {
            database.createObjectStore('units', { keyPath: 'id' });
          }
        },
        { once: true },
      );
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener(
        'error',
        () => reject(request.error ?? new Error('Unable to open export checkpoint database')),
        { once: true },
      );
    });
    return this.#database;
  }

  #manifestId(key: string): string {
    if (key.length === 0) throw new TypeError('Checkpoint key must not be empty');
    return `${this.#namespace}:manifest:${key}`;
  }

  #unitId(key: string, index: number): string {
    return `${this.#namespace}:unit:${key}:${index.toString()}`;
  }
}

export interface ResumableMuxedExportOptions extends Omit<WebMExportOptions, 'onProgress'> {
  readonly key: string;
  readonly contentId: string;
  readonly profile: ResumableMuxedProfile;
  readonly store: ResumableMuxedExportStore;
  /** Target unit duration. Actual boundaries are aligned to complete video frames. */
  readonly segmentDurationUs?: number;
  readonly onProgress?: (progress: number) => void;
  readonly onUnitCommitted?: (completedUnits: number, totalUnits: number) => void;
  readonly deleteCheckpointOnSuccess?: boolean;
  readonly now?: () => number;
}

export interface ResumableMuxedExportResult extends WebMExportResult {
  readonly checkpointKey: string;
  readonly totalUnits: number;
  readonly reusedUnits: number;
  readonly encodedUnits: number;
}

interface PositionedPiece {
  readonly position: number;
  readonly data: Uint8Array;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function sortedBytes(parts: readonly PositionedPiece[]): Uint8Array {
  return concatBytes([...parts].sort((left, right) => left.position - right.position).map((part) => part.data));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function stableConfigurationId(
  options: ResumableMuxedExportOptions,
  videoCodecString: string,
  audioCodecString: string,
  framesPerUnit: number,
): string {
  return JSON.stringify({
    profile: options.profile,
    durationUs: options.durationUs,
    width: options.width,
    height: options.height,
    frameRate: options.frameRate,
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
    videoBitrate: options.videoBitrate,
    audioBitrate: options.audioBitrate,
    videoCodecString,
    audioCodecString,
    framesPerUnit,
  });
}

function compatibleManifest(
  value: ResumableMuxedExportManifest | undefined,
  expected: {
    readonly contentId: string;
    readonly configurationId: string;
    readonly profile: ResumableMuxedProfile;
    readonly durationUs: number;
    readonly totalUnits: number;
  },
): value is ResumableMuxedExportManifest {
  return (
    value?.version === 1 &&
    value.contentId === expected.contentId &&
    value.configurationId === expected.configurationId &&
    value.profile === expected.profile &&
    value.durationUs === expected.durationUs &&
    value.totalUnits === expected.totalUnits &&
    value.completedUnits >= 0 &&
    value.completedUnits <= expected.totalUnits &&
    value.units.length === value.completedUnits &&
    value.units.every((unit, index) => unit.index === index)
  );
}

function patchMp4FragmentSequences(bytes: Uint8Array, firstSequence: number): number {
  let sequence = firstSequence;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 4; index + 12 <= bytes.length; index += 1) {
    if (bytes[index] === 0x6d && bytes[index + 1] === 0x66 && bytes[index + 2] === 0x68 && bytes[index + 3] === 0x64) {
      view.setUint32(index + 8, sequence, false);
      sequence += 1;
      index += 11;
    }
  }
  return sequence;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

interface Mp4Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
}

function directMp4Boxes(bytes: Uint8Array, start: number, end: number): readonly Mp4Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Mp4Box[] = [];
  let position = start;
  while (position + 8 <= end) {
    let size = view.getUint32(position, false);
    const type = String.fromCharCode(
      bytes[position + 4] ?? 0,
      bytes[position + 5] ?? 0,
      bytes[position + 6] ?? 0,
      bytes[position + 7] ?? 0,
    );
    let headerSize = 8;
    if (size === 1) {
      if (position + 16 > end) break;
      const largeSize = view.getBigUint64(position + 8, false);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < headerSize || position + size > end) break;
    boxes.push({
      type,
      start: position,
      end: position + size,
      contentStart: position + headerSize,
    });
    position += size;
  }
  return boxes;
}

function patchMp4DecodeTimes(
  bytes: Uint8Array,
  range: MuxedExportRange,
  frameRate: WebMExportOptions['frameRate'],
): void {
  const divisor = greatestCommonDivisor(frameRate.numerator, frameRate.denominator);
  const videoOffset = BigInt(range.videoStartFrame) * BigInt(frameRate.denominator / divisor);
  const audioOffset = BigInt(range.audioStartFrame);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const moof of directMp4Boxes(bytes, 0, bytes.length).filter((box) => box.type === 'moof')) {
    for (const traf of directMp4Boxes(bytes, moof.contentStart, moof.end).filter((box) => box.type === 'traf')) {
      const children = directMp4Boxes(bytes, traf.contentStart, traf.end);
      const tfhd = children.find((box) => box.type === 'tfhd');
      const tfdt = children.find((box) => box.type === 'tfdt');
      if (tfhd === undefined || tfdt === undefined || tfhd.contentStart + 8 > tfhd.end) {
        throw new Error('Fragmented MP4 unit is missing tfhd/tfdt timing boxes');
      }
      const trackId = view.getUint32(tfhd.contentStart + 4, false);
      const offset = trackId === 1 ? videoOffset : trackId === 2 ? audioOffset : undefined;
      if (offset === undefined) throw new Error(`Unexpected fragmented MP4 track ${trackId}`);
      const version = view.getUint8(tfdt.contentStart);
      if (version !== 1 || tfdt.contentStart + 12 > tfdt.end) {
        throw new Error('Fragmented MP4 tfdt must use a 64-bit base decode time');
      }
      const current = view.getBigUint64(tfdt.contentStart + 4, false);
      view.setBigUint64(tfdt.contentStart + 4, current + offset, false);
    }
  }
}

async function codecStrings(
  options: ResumableMuxedExportOptions,
): Promise<{ readonly video: string; readonly audio: string }> {
  const frameRate = options.frameRate.numerator / options.frameRate.denominator;
  if (options.profile === 'webm-vp9-opus') {
    return {
      video: options.videoCodecString ?? 'vp09.00.10.08',
      audio: options.audioCodecString ?? 'opus',
    };
  }
  if (options.profile === 'mp4-av1-aac') {
    return {
      video: options.videoCodecString ?? av1CodecString(options.width, options.height, frameRate),
      audio: options.audioCodecString ?? 'mp4a.40.2',
    };
  }
  if (options.profile === 'mp4-hevc-aac') {
    return {
      video: options.videoCodecString ?? hevcCodecString(options.width, options.height, frameRate),
      audio: options.audioCodecString ?? 'mp4a.40.2',
    };
  }
  const negotiated =
    options.videoCodecString === undefined
      ? await negotiateAvcCodecString({
          width: options.width,
          height: options.height,
          framerate: frameRate,
          bitrate: options.videoBitrate,
        })
      : undefined;
  return {
    video:
      options.videoCodecString ??
      negotiated?.selected ??
      preferredAvcCodecString(options.width, options.height, frameRate),
    audio: options.audioCodecString ?? 'mp4a.40.2',
  };
}

function profileAndFormat(
  profile: ResumableMuxedProfile,
  init: PositionedPiece[],
  media: PositionedPiece[],
  minimumDurationSeconds: number,
): MuxedExportProfile {
  if (profile === 'webm-vp9-opus') {
    return {
      id: profile,
      operationName: 'Resumable WebM export',
      format: new WebMOutputFormat({
        appendOnly: true,
        minimumClusterDuration: minimumDurationSeconds,
        onEbmlHeader: (data, position) => init.push({ data: data.slice(), position }),
        onSegmentHeader: (data, position) => init.push({ data: data.slice(), position }),
        onCluster: (data, position) => media.push({ data: sizedWebmCluster(data), position }),
      }),
      videoCodec: 'vp9',
      fullVideoCodecString: 'vp09.00.10.08',
      audioCodec: 'opus',
    };
  }
  const videoCodec = profile === 'mp4-av1-aac' ? 'av1' : profile === 'mp4-hevc-aac' ? 'hevc' : 'avc';
  return {
    id: profile,
    operationName: 'Resumable fragmented MP4 export',
    format: new Mp4OutputFormat({
      fastStart: 'fragmented',
      minimumFragmentDuration: minimumDurationSeconds,
      onFtyp: (data, position) => init.push({ data: data.slice(), position }),
      onMoov: (data, position) => init.push({ data: data.slice(), position }),
      onMoof: (data, position) => media.push({ data: data.slice(), position }),
      onMdat: (data, position) => media.push({ data: data.slice(), position }),
    }),
    videoCodec,
    fullVideoCodecString: '',
    audioCodec: 'aac',
  };
}

function sizedWebmCluster(data: Uint8Array): Uint8Array {
  if (
    data.length < 5 ||
    data[0] !== 0x1f ||
    data[1] !== 0x43 ||
    data[2] !== 0xb6 ||
    data[3] !== 0x75 ||
    data[4] !== 0xff
  ) {
    throw new Error('Append-only WebM cluster does not use the expected unknown-size header');
  }
  const payloadLength = BigInt(data.length - 5);
  if (payloadLength >= 1n << 56n) throw new RangeError('WebM cluster exceeds EBML limits');
  const result = new Uint8Array(data.length + 7);
  result.set(data.subarray(0, 4), 0);
  result[4] = 0x01;
  let remaining = payloadLength;
  for (let index = 11; index >= 5; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  result.set(data.subarray(5), 12);
  return result;
}

function unitRange(
  unitIndex: number,
  framesPerUnit: number,
  fullVideoFrames: number,
  fullAudioFrames: number,
  options: ResumableMuxedExportOptions,
): MuxedExportRange {
  const videoStartFrame = unitIndex * framesPerUnit;
  const videoEndFrameExclusive = Math.min(fullVideoFrames, videoStartFrame + framesPerUnit);
  const startUs = frameStartUs(videoStartFrame, options.frameRate);
  const endUs =
    videoEndFrameExclusive === fullVideoFrames
      ? options.durationUs
      : frameStartUs(videoEndFrameExclusive, options.frameRate);
  return {
    videoStartFrame,
    videoEndFrameExclusive,
    audioStartFrame: Math.floor((startUs * options.sampleRate) / 1_000_000),
    audioEndFrameExclusive:
      videoEndFrameExclusive === fullVideoFrames
        ? fullAudioFrames
        : Math.floor((endUs * options.sampleRate) / 1_000_000),
  };
}

async function writeCompletedOutput(
  options: ResumableMuxedExportOptions,
  manifest: ResumableMuxedExportManifest,
): Promise<void> {
  const writer = options.sink.getWriter();
  let position = 0;
  let mp4Sequence = 1;
  try {
    for (let index = 0; index < manifest.totalUnits; index += 1) {
      throwIfAborted(options.signal, 'Assemble resumable export');
      const unit = await options.store.loadUnit(options.key, index, options.signal);
      const metadata = manifest.units[index];
      if (unit === undefined || metadata === undefined || unit.index !== index) {
        throw new Error(`Committed export unit ${index.toString()} is missing`);
      }
      const hash = await sha256(concatBytes(unit.init === undefined ? [unit.media] : [unit.init, unit.media]));
      if (hash !== metadata.sha256) {
        throw new Error(`Committed export unit ${index.toString()} failed SHA-256 verification`);
      }
      if (unit.init !== undefined) {
        await writer.write({
          type: 'write',
          position,
          data: unit.init as Uint8Array<ArrayBuffer>,
        });
        position += unit.init.byteLength;
      }
      const media = unit.media.slice();
      if (options.profile !== 'webm-vp9-opus') {
        mp4Sequence = patchMp4FragmentSequences(media, mp4Sequence);
      }
      await writer.write({ type: 'write', position, data: media });
      position += media.byteLength;
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
}

/**
 * Encodes frame-aligned WebM clusters or fMP4 fragments and checkpoints every
 * complete unit. Resume reuses the committed prefix, verifies every unit hash,
 * and re-encodes only the first missing unit onward.
 */
export async function exportResumableMuxed(options: ResumableMuxedExportOptions): Promise<ResumableMuxedExportResult> {
  if (options.key.length === 0 || options.contentId.length === 0) {
    throw new TypeError('key and contentId must not be empty');
  }
  const segmentDurationUs = options.segmentDurationUs ?? 2_000_000;
  if (!Number.isSafeInteger(segmentDurationUs) || segmentDurationUs <= 0) {
    throw new RangeError('segmentDurationUs must be a positive safe integer');
  }
  throwIfAborted(options.signal, 'Resumable muxed export');
  const fullVideoFrames = Math.ceil(
    (options.durationUs * options.frameRate.numerator) / (1_000_000 * options.frameRate.denominator),
  );
  const fullAudioFrames = Math.floor((options.durationUs * options.sampleRate) / 1_000_000);
  const framesPerUnit = Math.max(
    1,
    Math.round((segmentDurationUs * options.frameRate.numerator) / (1_000_000 * options.frameRate.denominator)),
  );
  const totalUnits = Math.ceil(fullVideoFrames / framesPerUnit);
  const codecs = await codecStrings(options);
  const configurationId = stableConfigurationId(options, codecs.video, codecs.audio, framesPerUnit);
  const expected = {
    contentId: options.contentId,
    configurationId,
    profile: options.profile,
    durationUs: options.durationUs,
    totalUnits,
  };
  let manifest = await options.store.loadManifest(options.key, options.signal);
  if (!compatibleManifest(manifest, expected)) {
    await options.store.delete(options.key, options.signal);
    manifest = {
      version: 1,
      ...expected,
      completedUnits: 0,
      units: [],
      updatedAtMs: (options.now ?? Date.now)(),
    };
  }
  const reusedUnits = manifest.completedUnits;
  options.onProgress?.(manifest.completedUnits / totalUnits);

  for (let index = manifest.completedUnits; index < totalUnits; index += 1) {
    throwIfAborted(options.signal, 'Resumable muxed export');
    const range = unitRange(index, framesPerUnit, fullVideoFrames, fullAudioFrames, options);
    const init: PositionedPiece[] = [];
    const media: PositionedPiece[] = [];
    const profile = profileAndFormat(options.profile, init, media, segmentDurationUs / 1_000_000 + 1);
    const discardSink = new WritableStream<{
      readonly type: 'write';
      readonly data: Uint8Array<ArrayBuffer>;
      readonly position: number;
    }>();
    const exportRange: MuxedExportRange =
      options.profile === 'webm-vp9-opus' ? range : { ...range, timestampBase: 'range' };
    const result = await exportMuxed(
      {
        durationUs: options.durationUs,
        width: options.width,
        height: options.height,
        frameRate: options.frameRate,
        sampleRate: options.sampleRate,
        channelCount: options.channelCount,
        videoBitrate: options.videoBitrate,
        audioBitrate: options.audioBitrate,
        videoCodecString: codecs.video,
        audioCodecString: codecs.audio,
        sink: discardSink,
        renderFrame: options.renderFrame,
        renderAudio: options.renderAudio,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onProgress: (progress) => options.onProgress?.((index + progress) / totalUnits),
      },
      { ...profile, fullVideoCodecString: codecs.video },
      exportRange,
    );
    const encodedMedia = sortedBytes(media);
    if (options.profile !== 'webm-vp9-opus') {
      patchMp4DecodeTimes(encodedMedia, range, options.frameRate);
    }
    const unitInit = index === 0 ? sortedBytes(init) : undefined;
    const unit: ResumableMuxedExportUnit = {
      index,
      ...(unitInit === undefined ? {} : { init: unitInit }),
      media: encodedMedia,
    };
    if (unit.media.byteLength === 0 || (index === 0 && unit.init?.byteLength === 0)) {
      throw new Error(`Muxer did not emit a complete resumable unit ${index.toString()}`);
    }
    const metadata: ResumableMuxedUnitMetadata = {
      index,
      ...range,
      byteLength: (unit.init?.byteLength ?? 0) + unit.media.byteLength,
      sha256: await sha256(concatBytes(unit.init === undefined ? [unit.media] : [unit.init, unit.media])),
    };
    manifest = {
      ...manifest,
      completedUnits: index + 1,
      units: [...manifest.units, metadata],
      mimeType: result.mimeType,
      encoderConfiguration: result.encoderConfiguration,
      updatedAtMs: (options.now ?? Date.now)(),
    };
    await options.store.commitUnit(options.key, unit, manifest, options.signal);
    options.onUnitCommitted?.(manifest.completedUnits, totalUnits);
    options.onProgress?.(manifest.completedUnits / totalUnits);
  }

  if (manifest.mimeType === undefined || manifest.encoderConfiguration === undefined) {
    throw new Error('Completed resumable export manifest is missing encoder metadata');
  }
  await writeCompletedOutput(options, manifest);
  if (options.deleteCheckpointOnSuccess === true) {
    await options.store.delete(options.key, options.signal);
  }
  return {
    mimeType: manifest.mimeType,
    videoFrames: fullVideoFrames,
    audioFrames: fullAudioFrames,
    durationUs: options.durationUs,
    encoderConfiguration: manifest.encoderConfiguration,
    checkpointKey: options.key,
    totalUnits,
    reusedUnits,
    encodedUnits: totalUnits - reusedUnits,
  };
}
