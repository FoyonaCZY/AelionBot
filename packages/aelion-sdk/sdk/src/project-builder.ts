import {
  AelionError,
  frameStartUs,
  normalizeRational,
  type JsonObject,
  type JsonValue,
  type Rational,
} from '@aelionsdk/core';
import {
  CURRENT_PROJECT_SCHEMA_URI,
  CURRENT_PROJECT_SCHEMA_VERSION,
  ProjectValidator,
  canonicalClone,
  imageSequenceDurationUs,
  type AelionProject,
  type ImageSequenceReference,
  type ItemEntity,
  type MaterialInstanceEntity,
  type MarkerEntity,
  type TrackEntity,
  type TrackOccupancy,
  type TrackRole,
  type TransitionEntity,
} from '@aelionsdk/project-schema';

import { defaultSchemas } from './default-schemas.js';
import type { ProductionMediaProvider, ProductionMediaProbe } from './production-media-provider.js';

const ENTITY_ID = /^[A-Za-z][A-Za-z0-9._:-]*$/u;

export interface CreateProjectOptions {
  readonly projectId?: string;
  readonly sequenceId?: string;
  readonly title?: string;
  readonly sequenceName?: string;
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: Rational;
  readonly sampleRate?: 44_100 | 48_000 | 96_000;
  readonly channelLayout?: 'mono' | 'stereo' | '5.1';
  readonly workingColorSpace?: 'srgb-linear' | 'display-p3-linear' | 'rec2020-linear';
  readonly colorPrimaries?: 'bt709' | 'display-p3' | 'bt2020';
  readonly transferFunction?: 'srgb' | 'gamma22' | 'pq' | 'hlg';
  readonly matrixCoefficients?: 'rgb' | 'bt709' | 'bt2020-ncl';
  readonly colorRange?: 'full' | 'limited';
  readonly chromaSubsampling?: 'rgb' | '4:4:4' | '4:2:2' | '4:2:0';
  readonly alphaMode?: 'opaque' | 'premultiplied';
  readonly toneMapping?: 'none' | 'bt2390' | 'reinhard';
  readonly bitDepth?: 8 | 10;
  readonly backgroundColor?: string | readonly [number, number, number, number];
  /** Omit for content-derived duration. */
  readonly durationUs?: number;
  /** Skip Ajv `new Function()` compilation in strict-CSP renderers. */
  readonly skipAjvCompile?: boolean;
  /** Schema validation mode (`'auto' | 'ajv' | 'structural'`). */
  readonly schemaValidationMode?: 'auto' | 'ajv' | 'structural';
}

export interface AddTrackOptions {
  readonly id?: string;
  readonly kind: 'visual' | 'audio' | 'caption';
  readonly name?: string;
  /** Marks the Track that carries the cut, so layouts keep it packed. */
  readonly role?: TrackRole;
  /** Whether Items may overlap. Defaults to what the role implies. */
  readonly occupancy?: TrackOccupancy;
  readonly enabled?: boolean;
  readonly locked?: boolean;
}

export interface AddAssetOptions {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'image' | 'font' | 'lut' | 'binary' | 'image-sequence';
  readonly locator?: JsonObject;
  readonly name?: string;
  readonly mimeType?: string;
  readonly contentHash?: string;
  readonly byteLength?: number;
  readonly probeHint?: JsonObject;
  readonly representations?: readonly JsonObject[];
  readonly metadata?: JsonObject;
  /** Required for `kind: 'image-sequence'`; ignored for other kinds. */
  readonly imageSequence?: ImageSequenceReference;
}

export interface AddMediaClipOptions {
  readonly id?: string;
  readonly kind: 'video' | 'audio';
  readonly assetId: string;
  readonly trackId: string;
  readonly atUs?: number;
  readonly durationUs: number;
  readonly sourceStartUs?: number;
  readonly sourceDurationUs?: number;
  readonly streamIndex?: number;
  readonly boundary?: 'error' | 'hold' | 'loop' | 'transparent';
  readonly rate?: Rational;
  /** Curve time-mapping points, mutually exclusive with `rate`. */
  readonly curvePoints?: readonly {
    readonly itemTimeUs: number;
    readonly sourceTimeUs: number;
    readonly interpolation?: 'linear' | 'hold' | 'cubic';
  }[];
  readonly name?: string;
  readonly fit?: 'contain' | 'cover' | 'fill' | 'none';
  readonly opacity?: number;
  readonly gainDb?: number;
  readonly pan?: number;
  readonly fadeInUs?: number;
  readonly fadeOutUs?: number;
  readonly pitchPolicy?: 'varispeed' | 'preserve';
}

export interface AddImageClipOptions {
  readonly id?: string;
  readonly assetId: string;
  readonly trackId: string;
  readonly atUs?: number;
  readonly durationUs?: number;
  readonly name?: string;
  readonly fit?: 'contain' | 'cover' | 'fill' | 'none';
  readonly opacity?: number;
}

/**
 * Options for adding an image-sequence Clip. Registers an `image-sequence`
 * Asset whose frame manifest references the given `image` Assets, then adds an
 * image Item that samples the sequence deterministically through the frame
 * mapping (see `imageSequenceFrameIndex`).
 */
export interface AddImageSequenceClipOptions {
  readonly id?: string;
  /** Ordered `image` Assets, one per frame. */
  readonly frameAssetIds: readonly string[];
  readonly frameDurationUs: number;
  readonly trackId: string;
  readonly atUs?: number;
  readonly durationUs?: number;
  readonly name?: string;
  readonly fit?: 'contain' | 'cover' | 'fill' | 'none';
  readonly opacity?: number;
}

export interface ClipBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AddTextClipOptions {
  readonly id?: string;
  readonly trackId: string;
  readonly text: string;
  readonly atUs?: number;
  readonly durationUs: number;
  readonly box?: ClipBox;
  readonly style?: JsonObject;
  /** Optional rich-text runs. Their concatenated text must equal `text`. */
  readonly runs?: readonly {
    readonly text: string;
    readonly style?: JsonObject;
  }[];
  readonly paragraphStyle?: JsonObject;
  readonly overflow?: 'clip' | 'ellipsis' | 'visible' | 'auto-fit';
  readonly writingMode?: 'horizontal-tb' | 'vertical-rl' | 'vertical-lr';
  readonly name?: string;
  readonly opacity?: number;
}

export interface AddCaptionClipOptions {
  readonly id?: string;
  readonly trackId: string;
  readonly text: string;
  readonly atUs?: number;
  readonly durationUs: number;
  readonly box?: ClipBox;
  readonly style?: JsonObject;
  readonly overflow?: 'clip' | 'auto-fit';
  readonly cueSettings?: JsonObject;
  readonly name?: string;
}

export interface AddShapeClipOptions {
  readonly id?: string;
  readonly trackId: string;
  readonly kind: 'rectangle' | 'ellipse' | 'polygon';
  readonly atUs?: number;
  readonly durationUs: number;
  readonly box: ClipBox;
  readonly fill: string | readonly [number, number, number, number];
  readonly stroke?: string | readonly [number, number, number, number];
  readonly strokeWidthPx?: number;
  readonly cornerRadiusPx?: number;
  readonly points?: readonly { readonly x: number; readonly y: number }[];
  readonly name?: string;
  readonly opacity?: number;
}

export interface AddMaterialInstanceOptions {
  readonly id?: string;
  readonly packageId: string;
  readonly packageVersion: string;
  readonly packageIntegrity: `sha256:${string}`;
  readonly materialId: string;
  readonly parameters?: JsonObject;
  readonly name?: string;
  readonly previewPolicy?: 'required' | 'skippable-when-degraded';
  readonly resourceBindings?: JsonObject;
  readonly inputBindings?: JsonObject;
  readonly randomSeed?: number;
}

export interface AddTransitionOptions {
  readonly id?: string;
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly materialInstanceId: string;
  readonly atUs: number;
  readonly durationUs: number;
}

export interface SetMaskOptions {
  readonly sourceItemId: string;
  readonly channel?: 'alpha' | 'luma';
  readonly invert?: boolean;
  readonly featherPx?: number;
  readonly space?: 'source' | 'canvas';
  readonly consumeSource?: boolean;
}

export interface SetVisualOptions {
  readonly fit?: 'contain' | 'cover' | 'fill' | 'none';
  readonly positionPx?: { readonly x: number; readonly y: number };
  readonly anchor?: { readonly x: number; readonly y: number };
  readonly scale?: { readonly x: number; readonly y: number };
  readonly rotationDeg?: number;
  readonly skewDeg?: { readonly x: number; readonly y: number };
  readonly opacity?: number;
  readonly blendMode?:
    | 'normal'
    | 'multiply'
    | 'screen'
    | 'overlay'
    | 'darken'
    | 'lighten'
    | 'color-dodge'
    | 'color-burn'
    | 'hard-light'
    | 'soft-light'
    | 'difference'
    | 'exclusion';
}

export interface Keyframe<T extends JsonValue = JsonValue> {
  readonly timeUs: number;
  readonly value: T;
  readonly interpolation?: 'hold' | 'linear' | 'cubic-bezier';
  readonly easing?: JsonObject;
  /** Outgoing Bézier handle (value-space tangent) for the graph editor. */
  readonly handleOut?: { readonly x: number; readonly y: number };
  /** Incoming Bézier handle for the next keyframe's control point. */
  readonly handleIn?: { readonly x: number; readonly y: number };
}

export type ClipAnimatableProperty = 'opacity' | 'position' | 'scale' | 'rotation' | 'gain' | 'pan';

export interface ImportMediaOptions {
  readonly provider: Pick<ProductionMediaProvider, 'probe'>;
  readonly assetId: string;
  readonly atUs?: number;
  readonly durationUs?: number;
  readonly sourceStartUs?: number;
  readonly name?: string;
  readonly mimeType?: string;
  readonly videoTrackId?: string;
  readonly audioTrackId?: string;
  readonly video?: boolean;
  readonly audio?: boolean;
  readonly fit?: AddMediaClipOptions['fit'];
}

export interface ImportedMedia {
  readonly assetId: string;
  readonly durationUs: number;
  readonly probe: ProductionMediaProbe;
  readonly videoTrackId?: string;
  readonly audioTrackId?: string;
  readonly videoItemId?: string;
  readonly audioItemId?: string;
  readonly linkGroupId?: string;
}

export interface AddMarkerOptions {
  readonly id?: string;
  readonly timeUs: number;
  readonly durationUs?: number;
  readonly label?: string;
  readonly color?: string;
  readonly payload?: JsonValue;
  readonly itemId?: string;
}

function assertEntityId(value: string, name: string): void {
  if (value.length > 128 || !ENTITY_ID.test(value)) {
    throw new TypeError(`${name} must be a valid Aelion entity id`);
  }
}

function assertTime(value: number, name: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new RangeError(`${name} must be ${positive ? 'a positive' : 'a non-negative'} safe integer`);
  }
}

function assertFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function toMicroseconds(value: number, multiplier: number, name: string): number {
  assertFiniteNumber(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
  const result = Math.round(value * multiplier);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds the safe time range`);
  return result;
}

/** Convert seconds to canonical integer microseconds. */
export function seconds(value: number): number {
  return toMicroseconds(value, 1_000_000, 'seconds');
}

/** Convert milliseconds to canonical integer microseconds. */
export function milliseconds(value: number): number {
  return toMicroseconds(value, 1_000, 'milliseconds');
}

/** Return the exact quantized start time of a frame count. */
export function frames(value: number, frameRate: Rational = { numerator: 30, denominator: 1 }): number {
  return frameStartUs(value, frameRate);
}

/** Create a validated Project v1 document through small, type-safe operations. */
export class ProjectBuilder {
  readonly #project: AelionProject;
  readonly #validator: ProjectValidator;
  readonly #counters = new Map<string, number>();

  public constructor(options: CreateProjectOptions = {}) {
    this.#validator = new ProjectValidator({
      projectSchema: defaultSchemas.project,
      materialInstanceSchema: defaultSchemas.materialInstance,
      ...(options.skipAjvCompile === undefined ? {} : { skipAjvCompile: options.skipAjvCompile }),
      ...(options.schemaValidationMode === undefined ? {} : { schemaMode: options.schemaValidationMode }),
    });
    const projectId = options.projectId ?? 'project_1';
    const sequenceId = options.sequenceId ?? 'sequence_1';
    assertEntityId(projectId, 'projectId');
    assertEntityId(sequenceId, 'sequenceId');
    const width = options.width ?? 1920;
    const height = options.height ?? 1080;
    const frameRate = options.frameRate ?? { numerator: 30, denominator: 1 };
    if (!Number.isSafeInteger(width) || width <= 0 || width > 65_535) {
      throw new RangeError('width must be an integer from 1 to 65535');
    }
    if (!Number.isSafeInteger(height) || height <= 0 || height > 65_535) {
      throw new RangeError('height must be an integer from 1 to 65535');
    }
    if (
      !Number.isSafeInteger(frameRate.numerator) ||
      !Number.isSafeInteger(frameRate.denominator) ||
      frameRate.numerator <= 0 ||
      frameRate.denominator <= 0
    ) {
      throw new RangeError('frameRate must use positive safe integers');
    }
    if (options.durationUs !== undefined) assertTime(options.durationUs, 'durationUs');

    this.#project = {
      $schema: CURRENT_PROJECT_SCHEMA_URI,
      schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      projectId,
      metadata: options.title === undefined ? {} : { title: options.title },
      settings: {
        defaultSequenceId: sequenceId,
        defaultStillDurationUs: seconds(3),
        missingAssetPolicy: 'error',
        missingMaterialPolicy: 'error',
        missingPluginPolicy: 'error',
      },
      assets: {},
      sequences: {
        [sequenceId]: {
          id: sequenceId,
          ...(options.sequenceName === undefined ? {} : { name: options.sequenceName }),
          format: {
            width,
            height,
            pixelAspectRatio: { numerator: 1, denominator: 1 },
            frameRate: { numerator: frameRate.numerator, denominator: frameRate.denominator },
            sampleRate: options.sampleRate ?? 48_000,
            channelLayout: options.channelLayout ?? 'stereo',
            workingColorSpace: options.workingColorSpace ?? 'srgb-linear',
            colorPrimaries: options.colorPrimaries ?? 'bt709',
            transferFunction: options.transferFunction ?? 'srgb',
            matrixCoefficients: options.matrixCoefficients ?? 'rgb',
            colorRange: options.colorRange ?? 'full',
            chromaSubsampling: options.chromaSubsampling ?? '4:4:4',
            alphaMode: options.alphaMode ?? 'premultiplied',
            toneMapping: options.toneMapping ?? 'none',
            bitDepth: options.bitDepth ?? 8,
            backgroundColor:
              options.backgroundColor === undefined
                ? { space: 'srgb-linear', rgba: [0, 0, 0, 1] }
                : this.#color(options.backgroundColor),
          },
          duration:
            options.durationUs === undefined
              ? { mode: 'content' }
              : { mode: 'fixed', durationUs: options.durationUs, overflow: 'clip' },
          trackIds: [],
          transitionIds: [],
          materialInstanceIds: [],
          markerIds: [],
        },
      },
      tracks: {},
      items: {},
      materialInstances: {},
      transitions: {},
      markers: {},
      linkGroups: {},
      extensions: {},
    };
  }

  public get projectId(): string {
    return this.#project.projectId;
  }

  public get sequenceId(): string {
    return this.#project.settings.defaultSequenceId;
  }

  public addTrack(options: AddTrackOptions): string {
    const id = options.id ?? this.#nextId(`track_${options.kind}`);
    this.#assertUnused(id);
    const track: TrackEntity = {
      id,
      sequenceId: this.sequenceId,
      kind: options.kind,
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.occupancy === undefined ? {} : { occupancy: options.occupancy }),
      enabled: options.enabled ?? true,
      locked: options.locked ?? false,
      itemIds: [],
      materialInstanceIds: [],
      ...(options.kind === 'audio' ? { audio: { gainDb: 0, pan: 0, muted: false, solo: false } } : {}),
    };
    this.#project.tracks[id] = track;
    this.#sequence().trackIds.push(id);
    return id;
  }

  public addAsset(options: AddAssetOptions): string {
    this.#assertUnused(options.id);
    if (options.contentHash !== undefined && !/^[0-9a-f]{64}$/u.test(options.contentHash)) {
      throw new TypeError('contentHash must be a lowercase SHA-256 value');
    }
    if (options.byteLength !== undefined) assertTime(options.byteLength, 'byteLength');
    if (options.kind === 'image-sequence' && options.imageSequence === undefined) {
      throw new TypeError('image-sequence assets require an imageSequence frame manifest');
    }
    this.#project.assets[options.id] = {
      id: options.id,
      kind: options.kind,
      locator: options.locator ?? { type: 'runtime-binding', bindingId: options.id },
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
      ...(options.contentHash === undefined
        ? {}
        : { contentHash: { algorithm: 'sha256', value: options.contentHash } }),
      ...(options.byteLength === undefined ? {} : { byteLength: options.byteLength }),
      ...(options.probeHint === undefined ? {} : { probeHint: options.probeHint }),
      ...(options.representations === undefined ? {} : { representations: [...options.representations] }),
      ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      ...(options.imageSequence === undefined
        ? {}
        : {
            imageSequence: {
              ...options.imageSequence,
              frameAssetIds: [...options.imageSequence.frameAssetIds],
            },
          }),
    };
    return options.id;
  }

  public addMediaClip(options: AddMediaClipOptions): string {
    const track = this.#project.tracks[options.trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${options.trackId}`);
    const expectedTrack = options.kind === 'audio' ? 'audio' : 'visual';
    if (track.kind !== expectedTrack) {
      throw new TypeError(`${options.kind} clips require a ${expectedTrack} Track`);
    }
    if (this.#project.assets[options.assetId] === undefined) {
      throw new ReferenceError(`Unknown Asset: ${options.assetId}`);
    }
    const id = options.id ?? this.#nextId(`item_${options.kind}`);
    this.#assertUnused(id);
    const atUs = options.atUs ?? 0;
    const sourceStartUs = options.sourceStartUs ?? 0;
    const sourceDurationUs = options.sourceDurationUs ?? options.durationUs;
    const streamIndex = options.streamIndex ?? 0;
    const rate = normalizeRational(options.rate ?? { numerator: 1, denominator: 1 });
    assertTime(atUs, 'atUs');
    assertTime(options.durationUs, 'durationUs', true);
    assertTime(sourceStartUs, 'sourceStartUs');
    assertTime(sourceDurationUs, 'sourceDurationUs', true);
    assertTime(streamIndex, 'streamIndex');
    if (options.fadeInUs !== undefined) assertTime(options.fadeInUs, 'fadeInUs');
    if (options.fadeOutUs !== undefined) assertTime(options.fadeOutUs, 'fadeOutUs');
    const pitchPolicy: unknown = options.pitchPolicy;
    if (pitchPolicy !== undefined && pitchPolicy !== 'varispeed' && pitchPolicy !== 'preserve') {
      throw new RangeError('pitchPolicy must be varispeed or preserve');
    }
    if ((options.fadeInUs ?? 0) + (options.fadeOutUs ?? 0) > options.durationUs) {
      throw new RangeError('audio fades cannot overlap past the Clip duration');
    }
    if (options.curvePoints !== undefined && options.rate !== undefined) {
      throw new TypeError('curvePoints and rate are mutually exclusive');
    }

    const timeMapping: JsonObject =
      options.curvePoints === undefined
        ? {
            type: 'linear',
            rate: { numerator: rate.numerator, denominator: rate.denominator },
            reverse: false,
            boundary: options.boundary ?? 'hold',
          }
        : {
            type: 'curve',
            points: options.curvePoints.map((point) => ({
              itemTimeUs: point.itemTimeUs,
              sourceTimeUs: point.sourceTimeUs,
              interpolation: point.interpolation ?? 'linear',
            })),
            boundary: options.boundary ?? 'hold',
          };
    const source = {
      assetId: options.assetId,
      stream: { type: options.kind, index: streamIndex },
      sourceRange: { startUs: sourceStartUs, durationUs: sourceDurationUs },
      timeMapping,
    };
    const item: ItemEntity =
      options.kind === 'video'
        ? {
            id,
            trackId: track.id,
            type: 'video',
            ...(options.name === undefined ? {} : { name: options.name }),
            enabled: true,
            range: { startUs: atUs, durationUs: options.durationUs },
            source,
            visual: this.#visual(options.fit ?? 'contain', options.opacity ?? 1),
            materialInstanceIds: [],
          }
        : {
            id,
            trackId: track.id,
            type: 'audio',
            ...(options.name === undefined ? {} : { name: options.name }),
            enabled: true,
            range: { startUs: atUs, durationUs: options.durationUs },
            source,
            audio: {
              gainDb: options.gainDb ?? 0,
              pan: options.pan ?? 0,
              ...(options.fadeInUs === undefined ? {} : { fadeInUs: options.fadeInUs }),
              ...(options.fadeOutUs === undefined ? {} : { fadeOutUs: options.fadeOutUs }),
              ...(options.pitchPolicy === undefined ? {} : { pitchPolicy: options.pitchPolicy }),
            },
            materialInstanceIds: [],
          };
    this.#project.items[id] = item;
    track.itemIds.push(id);
    return id;
  }

  public setBackgroundColor(value: string | readonly [number, number, number, number]): this {
    (this.#sequence().format as JsonObject).backgroundColor = this.#color(value);
    return this;
  }

  public setProjectExtension(namespace: string, value: JsonValue): this {
    this.#project.extensions[namespace] = structuredClone(value);
    return this;
  }

  public setTrackExtension(trackId: string, namespace: string, value: JsonValue): this {
    const track = this.#project.tracks[trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${trackId}`);
    const current =
      track.extensions !== null && typeof track.extensions === 'object' && !Array.isArray(track.extensions)
        ? track.extensions
        : {};
    track.extensions = {
      ...current,
      [namespace]: structuredClone(value),
    };
    return this;
  }

  public setItemMetadata(itemId: string, metadata: JsonObject): this {
    const item = this.#project.items[itemId];
    if (item === undefined) throw new ReferenceError(`Unknown Item: ${itemId}`);
    item.metadata = structuredClone(metadata);
    return this;
  }

  /** Add a first-class still image Clip backed by an image Asset. */
  public addImageClip(options: AddImageClipOptions): string {
    const track = this.#project.tracks[options.trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${options.trackId}`);
    if (track.kind !== 'visual') throw new TypeError('image clips require a visual Track');
    const asset = this.#project.assets[options.assetId];
    if (asset === undefined) throw new ReferenceError(`Unknown Asset: ${options.assetId}`);
    if (asset.kind !== 'image') throw new TypeError('image clips require an image Asset');
    const id = options.id ?? this.#nextId('item_image');
    this.#assertUnused(id);
    const atUs = options.atUs ?? 0;
    const durationUs = options.durationUs ?? this.#project.settings.defaultStillDurationUs;
    assertTime(atUs, 'atUs');
    assertTime(durationUs, 'durationUs', true);
    const item: ItemEntity = {
      id,
      trackId: track.id,
      type: 'image',
      ...(options.name === undefined ? {} : { name: options.name }),
      enabled: true,
      range: { startUs: atUs, durationUs },
      source: {
        assetId: options.assetId,
        stream: { type: 'video', index: 0 },
        sourceRange: { startUs: 0, durationUs },
        timeMapping: {
          type: 'linear',
          rate: { numerator: 1, denominator: 1 },
          reverse: false,
          boundary: 'hold',
        },
      },
      visual: this.#visual(options.fit ?? 'contain', options.opacity ?? 1),
      materialInstanceIds: [],
    };
    this.#project.items[id] = item;
    track.itemIds.push(id);
    return id;
  }

  /**
   * Add an image-sequence Clip: registers an `image-sequence` Asset whose frame
   * manifest references existing `image` Assets, then adds an image Clip that
   * samples the sequence deterministically through the frame mapping.
   */
  public addImageSequenceClip(options: AddImageSequenceClipOptions): string {
    const track = this.#project.tracks[options.trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${options.trackId}`);
    if (track.kind !== 'visual') throw new TypeError('image-sequence clips require a visual Track');
    if (options.frameAssetIds.length === 0) {
      throw new RangeError('frameAssetIds must contain at least one frame');
    }
    assertTime(options.frameDurationUs, 'frameDurationUs', true);
    for (const frameAssetId of options.frameAssetIds) {
      const frameAsset = this.#project.assets[frameAssetId];
      if (frameAsset === undefined) throw new ReferenceError(`Unknown frame Asset: ${frameAssetId}`);
      if (frameAsset.kind !== 'image') {
        throw new TypeError(`frame Asset ${frameAssetId} must be an image Asset`);
      }
    }
    const assetId = options.id ?? this.#nextId('asset_image_sequence');
    this.#assertUnused(assetId);
    const sequence: ImageSequenceReference = {
      frameDurationUs: options.frameDurationUs,
      frameAssetIds: [...options.frameAssetIds],
    };
    this.addAsset({ id: assetId, kind: 'image-sequence', imageSequence: sequence });

    const itemId = this.#nextId('item_image_sequence');
    this.#assertUnused(itemId);
    const atUs = options.atUs ?? 0;
    const sequenceDurationUs = imageSequenceDurationUs(sequence);
    const durationUs = options.durationUs ?? sequenceDurationUs;
    assertTime(atUs, 'atUs');
    assertTime(durationUs, 'durationUs', true);
    const item: ItemEntity = {
      id: itemId,
      trackId: track.id,
      type: 'image',
      ...(options.name === undefined ? {} : { name: options.name }),
      enabled: true,
      range: { startUs: atUs, durationUs },
      source: {
        assetId,
        stream: { type: 'video', index: 0 },
        sourceRange: { startUs: 0, durationUs: sequenceDurationUs },
        timeMapping: {
          type: 'linear',
          rate: { numerator: 1, denominator: 1 },
          reverse: false,
          boundary: 'hold',
        },
      },
      visual: this.#visual(options.fit ?? 'contain', options.opacity ?? 1),
      materialInstanceIds: [],
    };
    this.#project.items[itemId] = item;
    track.itemIds.push(itemId);
    return itemId;
  }

  public addTextClip(options: AddTextClipOptions): string {
    const track = this.#project.tracks[options.trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${options.trackId}`);
    if (track.kind !== 'visual') throw new TypeError('text clips require a visual Track');
    const id = options.id ?? this.#nextId('item_text');
    this.#assertUnused(id);
    const atUs = options.atUs ?? 0;
    assertTime(atUs, 'atUs');
    assertTime(options.durationUs, 'durationUs', true);
    if (options.text.length > 1_000_000) throw new RangeError('text exceeds 1,000,000 characters');
    if (
      options.runs !== undefined &&
      (options.runs.length === 0 || options.runs.map((run) => run.text).join('') !== options.text)
    ) {
      throw new TypeError('text runs must be non-empty and concatenate to text');
    }
    const sequence = this.#sequence();
    const format = sequence.format as JsonObject;
    const width = typeof format.width === 'number' ? format.width : 1920;
    const height = typeof format.height === 'number' ? format.height : 1080;
    const box = options.box ?? {
      x: width * 0.1,
      y: height * 0.1,
      width: width * 0.8,
      height: height * 0.8,
    };
    this.#assertBox(box);
    const item: ItemEntity = {
      id,
      trackId: track.id,
      type: 'text',
      ...(options.name === undefined ? {} : { name: options.name }),
      enabled: true,
      range: { startUs: atUs, durationUs: options.durationUs },
      box: { ...box },
      overflow: options.overflow ?? 'auto-fit',
      writingMode: options.writingMode ?? 'horizontal-tb',
      paragraphs: [
        {
          style: options.paragraphStyle ?? {},
          runs: options.runs?.map((run) => ({
            text: run.text,
            style: {
              ...(options.style ?? {
                fontFamilies: ['sans-serif'],
                fontSizePx: 48,
                fontWeight: 400,
                fill: '#ffffff',
              }),
              ...(run.style ?? {}),
            },
          })) ?? [
            {
              text: options.text,
              style: options.style ?? {
                fontFamilies: ['sans-serif'],
                fontSizePx: 48,
                fontWeight: 400,
                fill: '#ffffff',
              },
            },
          ],
        },
      ],
      visual: this.#visual('none', options.opacity ?? 1),
      materialInstanceIds: [],
    };
    this.#project.items[id] = item;
    track.itemIds.push(id);
    return id;
  }

  public addCaptionClip(options: AddCaptionClipOptions): string {
    const track = this.#project.tracks[options.trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${options.trackId}`);
    if (track.kind !== 'caption') throw new TypeError('caption clips require a caption Track');
    const id = options.id ?? this.#nextId('item_caption');
    this.#assertUnused(id);
    const atUs = options.atUs ?? 0;
    assertTime(atUs, 'atUs');
    assertTime(options.durationUs, 'durationUs', true);
    if (options.text.length > 1_000_000) {
      throw new RangeError('caption text exceeds 1,000,000 characters');
    }
    const sequence = this.#sequence();
    const format = sequence.format as JsonObject;
    const width = typeof format.width === 'number' ? format.width : 1920;
    const height = typeof format.height === 'number' ? format.height : 1080;
    const box = options.box ?? {
      x: width * 0.1,
      y: height * 0.72,
      width: width * 0.8,
      height: height * 0.2,
    };
    this.#assertBox(box);
    const item: ItemEntity = {
      id,
      trackId: track.id,
      type: 'caption',
      ...(options.name === undefined ? {} : { name: options.name }),
      enabled: true,
      range: { startUs: atUs, durationUs: options.durationUs },
      text: options.text,
      box: { ...box },
      style: options.style ?? {
        fontFamilies: ['sans-serif'],
        fontSizePx: 42,
        fontWeight: 600,
        fill: '#ffffff',
        stroke: '#000000',
        strokeWidthPx: 2,
        align: 'center',
      },
      overflow: options.overflow ?? 'auto-fit',
      ...(options.cueSettings === undefined ? {} : { cueSettings: options.cueSettings }),
      visual: this.#visual('none', 1),
      materialInstanceIds: [],
    };
    this.#project.items[id] = item;
    track.itemIds.push(id);
    return id;
  }

  public addShapeClip(options: AddShapeClipOptions): string {
    const track = this.#project.tracks[options.trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${options.trackId}`);
    if (track.kind !== 'visual') throw new TypeError('shape clips require a visual Track');
    const id = options.id ?? this.#nextId('item_shape');
    this.#assertUnused(id);
    const atUs = options.atUs ?? 0;
    assertTime(atUs, 'atUs');
    assertTime(options.durationUs, 'durationUs', true);
    this.#assertBox(options.box);
    if (options.strokeWidthPx !== undefined) {
      assertFiniteNumber(options.strokeWidthPx, 'strokeWidthPx');
    }
    if (options.cornerRadiusPx !== undefined) {
      assertFiniteNumber(options.cornerRadiusPx, 'cornerRadiusPx');
    }
    if (options.kind === 'polygon' && (options.points?.length ?? 0) < 3) {
      throw new RangeError('polygon shapes require at least three points');
    }
    const item: ItemEntity = {
      id,
      trackId: track.id,
      type: 'shape',
      ...(options.name === undefined ? {} : { name: options.name }),
      enabled: true,
      range: { startUs: atUs, durationUs: options.durationUs },
      shape: {
        kind: options.kind,
        box: { ...options.box },
        fill: this.#color(options.fill),
        ...(options.stroke === undefined ? {} : { stroke: this.#color(options.stroke) }),
        ...(options.strokeWidthPx === undefined ? {} : { strokeWidthPx: options.strokeWidthPx }),
        ...(options.cornerRadiusPx === undefined ? {} : { cornerRadiusPx: options.cornerRadiusPx }),
        ...(options.points === undefined ? {} : { points: options.points.map((point) => ({ ...point })) }),
      },
      visual: this.#visual('none', options.opacity ?? 1),
      materialInstanceIds: [],
    };
    this.#project.items[id] = item;
    track.itemIds.push(id);
    return id;
  }

  public addMaterialInstance(options: AddMaterialInstanceOptions): string {
    const id = options.id ?? this.#nextId('material');
    this.#assertUnused(id);
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(options.packageId)) {
      throw new TypeError('packageId is invalid');
    }
    if (
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
        options.packageVersion,
      )
    ) {
      throw new TypeError('packageVersion must be valid SemVer');
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(options.packageIntegrity)) {
      throw new TypeError('packageIntegrity must be a sha256 integrity value');
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(options.materialId)) {
      throw new TypeError('materialId is invalid');
    }
    if (
      options.randomSeed !== undefined &&
      (!Number.isInteger(options.randomSeed) || options.randomSeed < 0 || options.randomSeed > 4_294_967_295)
    ) {
      throw new RangeError('randomSeed must be a uint32');
    }
    const instance: MaterialInstanceEntity = {
      id,
      definition: {
        packageId: options.packageId,
        packageVersion: options.packageVersion,
        packageIntegrity: options.packageIntegrity,
        materialId: options.materialId,
      },
      ...(options.name === undefined ? {} : { name: options.name }),
      enabled: true,
      previewPolicy: options.previewPolicy ?? 'required',
      parameters: options.parameters ?? {},
      ...(options.resourceBindings === undefined ? {} : { resourceBindings: options.resourceBindings }),
      ...(options.inputBindings === undefined ? {} : { inputBindings: options.inputBindings }),
      ...(options.randomSeed === undefined ? {} : { randomSeed: options.randomSeed }),
    };
    this.#project.materialInstances[id] = instance;
    return id;
  }

  public attachEffect(itemId: string, materialInstanceId: string): this {
    const item = this.#project.items[itemId];
    if (item === undefined) throw new ReferenceError(`Unknown Item: ${itemId}`);
    if (this.#project.materialInstances[materialInstanceId] === undefined) {
      throw new ReferenceError(`Unknown MaterialInstance: ${materialInstanceId}`);
    }
    if (!item.materialInstanceIds.includes(materialInstanceId)) {
      item.materialInstanceIds.push(materialInstanceId);
    }
    return this;
  }

  public addTransition(options: AddTransitionOptions): string {
    const from = this.#project.items[options.fromItemId];
    const to = this.#project.items[options.toItemId];
    if (from === undefined) throw new ReferenceError(`Unknown Item: ${options.fromItemId}`);
    if (to === undefined) throw new ReferenceError(`Unknown Item: ${options.toItemId}`);
    if (from.trackId !== to.trackId) throw new TypeError('Transition Items must share a Track');
    const track = this.#project.tracks[from.trackId];
    if (track === undefined) throw new ReferenceError(`Unknown Track: ${from.trackId}`);
    if (this.#project.materialInstances[options.materialInstanceId] === undefined) {
      throw new ReferenceError(`Unknown MaterialInstance: ${options.materialInstanceId}`);
    }
    assertTime(options.atUs, 'atUs');
    assertTime(options.durationUs, 'durationUs', true);
    const id = options.id ?? this.#nextId('transition');
    this.#assertUnused(id);
    const transition: TransitionEntity = {
      id,
      sequenceId: this.sequenceId,
      trackId: track.id,
      kind: track.kind === 'audio' ? 'audio' : 'visual',
      fromItemId: from.id,
      toItemId: to.id,
      range: { startUs: options.atUs, durationUs: options.durationUs },
      materialInstanceId: options.materialInstanceId,
    };
    this.#project.transitions[id] = transition;
    this.#sequence().transitionIds.push(id);
    return id;
  }

  public setMask(itemId: string, options: SetMaskOptions): this {
    const item = this.#project.items[itemId];
    const source = this.#project.items[options.sourceItemId];
    if (item === undefined) throw new ReferenceError(`Unknown Item: ${itemId}`);
    if (source === undefined) throw new ReferenceError(`Unknown Item: ${options.sourceItemId}`);
    const visual = (item as JsonObject).visual;
    if (visual === null || typeof visual !== 'object' || Array.isArray(visual)) {
      throw new TypeError(`${itemId} is not a visual Item`);
    }
    const featherPx = options.featherPx ?? 0;
    assertFiniteNumber(featherPx, 'featherPx');
    if (featherPx < 0 || featherPx > 4096) {
      throw new RangeError('featherPx must be from 0 to 4096');
    }
    (visual as JsonObject).mask = {
      sourceItemId: options.sourceItemId,
      channel: options.channel ?? 'alpha',
      invert: options.invert ?? false,
      featherPx,
      space: options.space ?? 'canvas',
      consumeSource: options.consumeSource ?? true,
    };
    return this;
  }

  public setVisual(itemId: string, options: SetVisualOptions): this {
    const item = this.#project.items[itemId];
    if (item === undefined) throw new ReferenceError(`Unknown Item: ${itemId}`);
    const entity = item as JsonObject;
    const visual = entity.visual;
    if (visual === null || typeof visual !== 'object' || Array.isArray(visual)) {
      throw new TypeError(`${itemId} is not a visual Item`);
    }
    const target = visual as JsonObject;
    if (options.fit !== undefined) target.fit = options.fit;
    if (options.opacity !== undefined) {
      assertFiniteNumber(options.opacity, 'opacity');
      if (options.opacity < 0 || options.opacity > 1) {
        throw new RangeError('opacity must be from 0 to 1');
      }
      target.opacity = options.opacity;
    }
    if (options.blendMode !== undefined) target.blendMode = options.blendMode;
    const transform = target.transform;
    if (transform === null || typeof transform !== 'object' || Array.isArray(transform)) {
      throw new TypeError(`${itemId} has no visual transform`);
    }
    const transformTarget = transform as JsonObject;
    const assignPoint = (
      key: 'positionPx' | 'anchor' | 'scale' | 'skewDeg',
      value: { readonly x: number; readonly y: number } | undefined,
    ): void => {
      if (value === undefined) return;
      assertFiniteNumber(value.x, `${key}.x`);
      assertFiniteNumber(value.y, `${key}.y`);
      transformTarget[key] = { x: value.x, y: value.y };
    };
    assignPoint('positionPx', options.positionPx);
    assignPoint('anchor', options.anchor);
    assignPoint('scale', options.scale);
    assignPoint('skewDeg', options.skewDeg);
    if (options.rotationDeg !== undefined) {
      assertFiniteNumber(options.rotationDeg, 'rotationDeg');
      transformTarget.rotationDeg = options.rotationDeg;
    }
    return this;
  }

  public setKeyframes(itemId: string, property: ClipAnimatableProperty, keyframes: readonly Keyframe[]): this {
    const item = this.#project.items[itemId];
    if (item === undefined) throw new ReferenceError(`Unknown Item: ${itemId}`);
    if (keyframes.length === 0) throw new RangeError('keyframes must not be empty');
    const sorted = [...keyframes].sort((left, right) => left.timeUs - right.timeUs);
    sorted.forEach((keyframe, index) => {
      assertTime(keyframe.timeUs, `keyframes[${index.toString()}].timeUs`);
      if (index > 0 && sorted[index - 1]?.timeUs === keyframe.timeUs) {
        throw new RangeError('keyframe times must be unique');
      }
    });
    const animation: JsonObject = {
      animation: {
        timeSpace: 'item',
        preInfinity: 'hold',
        postInfinity: 'hold',
        keyframes: sorted.map((keyframe) => ({
          timeUs: keyframe.timeUs,
          value: keyframe.value,
          interpolation: keyframe.interpolation ?? 'linear',
          ...(keyframe.easing === undefined ? {} : { easing: keyframe.easing }),
          ...(keyframe.handleOut === undefined
            ? {}
            : { handleOut: { x: keyframe.handleOut.x, y: keyframe.handleOut.y } }),
          ...(keyframe.handleIn === undefined ? {} : { handleIn: { x: keyframe.handleIn.x, y: keyframe.handleIn.y } }),
        })),
      },
    };
    const entity = item as JsonObject;
    if (property === 'gain' || property === 'pan') {
      const audio = entity.audio;
      if (audio === null || typeof audio !== 'object' || Array.isArray(audio)) {
        throw new TypeError(`${itemId} is not an audio Item`);
      }
      (audio as JsonObject)[property === 'gain' ? 'gainDb' : 'pan'] = animation;
      return this;
    }
    const visual = entity.visual;
    if (visual === null || typeof visual !== 'object' || Array.isArray(visual)) {
      throw new TypeError(`${itemId} is not a visual Item`);
    }
    if (property === 'opacity') {
      (visual as JsonObject).opacity = animation;
      return this;
    }
    const transform = (visual as JsonObject).transform;
    if (transform === null || typeof transform !== 'object' || Array.isArray(transform)) {
      throw new TypeError(`${itemId} has no visual transform`);
    }
    const field = property === 'position' ? 'positionPx' : property === 'scale' ? 'scale' : 'rotationDeg';
    (transform as JsonObject)[field] = animation;
    return this;
  }

  public async importMedia(options: ImportMediaOptions): Promise<ImportedMedia> {
    assertEntityId(options.assetId, 'assetId');
    const probe = await options.provider.probe(options.assetId, { purpose: 'export' });
    const video = probe.index.tracks.find((track) => track.kind === 'video');
    const audio = probe.index.tracks.find((track) => track.kind === 'audio');
    const importVideo = (options.video ?? true) && video !== undefined;
    const importAudio = (options.audio ?? true) && audio !== undefined;
    if (!importVideo && !importAudio) {
      throw new TypeError('Media import did not find an enabled video or audio stream');
    }
    const sourceStartUs = options.sourceStartUs ?? 0;
    assertTime(sourceStartUs, 'sourceStartUs');
    const availableDurationUs = probe.index.durationUs - sourceStartUs;
    if (availableDurationUs <= 0) throw new RangeError('sourceStartUs is outside the media');
    const durationUs = options.durationUs ?? availableDurationUs;
    assertTime(durationUs, 'durationUs', true);
    if (durationUs > availableDurationUs) {
      throw new RangeError('durationUs exceeds the available source media');
    }
    if (this.#project.assets[options.assetId] === undefined) {
      this.addAsset({
        id: options.assetId,
        kind: importVideo ? 'video' : 'audio',
        ...(options.name === undefined ? {} : { name: options.name }),
        mimeType:
          options.mimeType ??
          `${importVideo ? 'video' : 'audio'}/${
            probe.index.container === 'mp4'
              ? 'mp4'
              : probe.index.container === 'mov'
                ? 'quicktime'
                : probe.index.container === 'mkv'
                  ? 'x-matroska'
                  : probe.index.container === 'ts'
                    ? 'mp2t'
                    : 'webm'
          }`,
        probeHint: {
          durationUs: probe.index.durationUs,
          ...(video === undefined
            ? {}
            : {
                width: video.codedWidth,
                height: video.codedHeight,
                videoCodec: video.codec,
              }),
          ...(audio === undefined ? {} : { audioCodec: audio.codec }),
        },
      });
    }

    const atUs = options.atUs ?? 0;
    assertTime(atUs, 'atUs');
    let videoTrackId: string | undefined;
    let audioTrackId: string | undefined;
    let videoItemId: string | undefined;
    let audioItemId: string | undefined;
    if (importVideo) {
      videoTrackId = this.#resolveTrack('visual', options.videoTrackId);
      videoItemId = this.addMediaClip({
        kind: 'video',
        assetId: options.assetId,
        trackId: videoTrackId,
        atUs,
        durationUs,
        sourceStartUs,
        sourceDurationUs: durationUs,
        streamIndex: probe.index.tracks.filter((track) => track.kind === 'video').indexOf(video),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.fit === undefined ? {} : { fit: options.fit }),
      });
    }
    if (importAudio) {
      audioTrackId = this.#resolveTrack('audio', options.audioTrackId);
      audioItemId = this.addMediaClip({
        kind: 'audio',
        assetId: options.assetId,
        trackId: audioTrackId,
        atUs,
        durationUs,
        sourceStartUs,
        sourceDurationUs: durationUs,
        streamIndex: probe.index.tracks.filter((track) => track.kind === 'audio').indexOf(audio),
        ...(options.name === undefined ? {} : { name: options.name }),
      });
    }
    let linkGroupId: string | undefined;
    if (videoItemId !== undefined && audioItemId !== undefined) {
      linkGroupId = this.#nextId('link_av');
      this.#project.linkGroups[linkGroupId] = {
        id: linkGroupId,
        kind: 'av-sync',
        itemIds: [videoItemId, audioItemId],
        syncOffsetsUs: { [videoItemId]: 0, [audioItemId]: 0 },
      };
      this.#project.items[videoItemId] = {
        ...this.#project.items[videoItemId],
        linkGroupId,
      } as ItemEntity;
      this.#project.items[audioItemId] = {
        ...this.#project.items[audioItemId],
        linkGroupId,
      } as ItemEntity;
    }
    return {
      assetId: options.assetId,
      durationUs,
      probe,
      ...(videoTrackId === undefined ? {} : { videoTrackId }),
      ...(audioTrackId === undefined ? {} : { audioTrackId }),
      ...(videoItemId === undefined ? {} : { videoItemId }),
      ...(audioItemId === undefined ? {} : { audioItemId }),
      ...(linkGroupId === undefined ? {} : { linkGroupId }),
    };
  }

  public addMarker(options: AddMarkerOptions): string {
    const id = options.id ?? this.#nextId('marker');
    this.#assertUnused(id);
    assertTime(options.timeUs, 'timeUs');
    assertTime(options.durationUs ?? 0, 'durationUs');
    if (options.itemId !== undefined && this.#project.items[options.itemId] === undefined) {
      throw new ReferenceError(`Unknown Item: ${options.itemId}`);
    }
    const marker: MarkerEntity = {
      id,
      owner:
        options.itemId === undefined ? { type: 'sequence', id: this.sequenceId } : { type: 'item', id: options.itemId },
      timeUs: options.timeUs,
      durationUs: options.durationUs ?? 0,
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.color === undefined ? {} : { color: options.color }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    };
    this.#project.markers[id] = marker;
    if (options.itemId === undefined) this.#sequence().markerIds.push(id);
    else {
      const item = this.#project.items[options.itemId];
      if (item !== undefined) item.markerIds = [...(item.markerIds ?? []), id];
    }
    return id;
  }

  public build(): Readonly<AelionProject> {
    const candidate = canonicalClone(this.#project);
    const result = this.#validator.validate(candidate);
    if (!result.ok) throw new AelionError(result.diagnostics);
    return deepFreeze(result.value.project);
  }

  #sequence(): AelionProject['sequences'][string] {
    const sequence = this.#project.sequences[this.sequenceId];
    if (sequence === undefined) throw new Error('Default Sequence is missing');
    return sequence;
  }

  #resolveTrack(kind: 'visual' | 'audio', requestedId?: string): string {
    if (requestedId !== undefined) {
      const track = this.#project.tracks[requestedId];
      if (track === undefined) throw new ReferenceError(`Unknown Track: ${requestedId}`);
      if (track.kind !== kind) throw new TypeError(`${requestedId} is not a ${kind} Track`);
      return requestedId;
    }
    const existing = Object.values(this.#project.tracks).find((track) => track.kind === kind);
    return existing?.id ?? this.addTrack({ kind });
  }

  #assertBox(box: ClipBox): void {
    assertFiniteNumber(box.x, 'box.x');
    assertFiniteNumber(box.y, 'box.y');
    assertFiniteNumber(box.width, 'box.width');
    assertFiniteNumber(box.height, 'box.height');
    if (box.width <= 0 || box.height <= 0) {
      throw new RangeError('box width and height must be positive');
    }
  }

  #color(value: string | readonly [number, number, number, number]): JsonObject {
    let rgba: readonly number[];
    if (typeof value === 'string') {
      if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(value)) {
        throw new TypeError('color strings must be #RRGGBB or #RRGGBBAA');
      }
      const channel = (offset: number): number => Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
      const linear = (channelValue: number): number =>
        channelValue <= 0.04045 ? channelValue / 12.92 : ((channelValue + 0.055) / 1.055) ** 2.4;
      rgba = [linear(channel(1)), linear(channel(3)), linear(channel(5)), value.length === 9 ? channel(7) : 1];
    } else {
      rgba = value;
    }
    if (rgba.length !== 4 || rgba.some((channelValue) => !Number.isFinite(channelValue))) {
      throw new TypeError('color must contain four finite channels');
    }
    return { space: 'srgb-linear', rgba: [...rgba] };
  }

  #visual(fit: NonNullable<AddMediaClipOptions['fit']>, opacity: number): JsonObject {
    assertFiniteNumber(opacity, 'opacity');
    if (opacity < 0 || opacity > 1) throw new RangeError('opacity must be from 0 to 1');
    const sequence = this.#sequence();
    const format = sequence.format as JsonObject;
    const width = typeof format.width === 'number' ? format.width : 1920;
    const height = typeof format.height === 'number' ? format.height : 1080;
    return {
      fit,
      transform: {
        positionPx: { x: width / 2, y: height / 2 },
        anchor: { x: 0.5, y: 0.5 },
        scale: { x: 1, y: 1 },
        rotationDeg: 0,
        skewDeg: { x: 0, y: 0 },
      },
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      opacity,
      blendMode: 'normal',
    };
  }

  #assertUnused(id: string): void {
    assertEntityId(id, 'entity id');
    for (const collection of [
      this.#project.assets,
      this.#project.sequences,
      this.#project.tracks,
      this.#project.items,
      this.#project.materialInstances,
      this.#project.transitions,
      this.#project.markers,
      this.#project.linkGroups,
    ]) {
      if (collection[id] !== undefined) throw new TypeError(`Entity id is already used: ${id}`);
    }
  }

  #nextId(prefix: string): string {
    let counter = this.#counters.get(prefix) ?? 0;
    for (;;) {
      counter += 1;
      const candidate = `${prefix}_${counter.toString()}`;
      try {
        this.#assertUnused(candidate);
        this.#counters.set(prefix, counter);
        return candidate;
      } catch (error) {
        if (!(error instanceof TypeError) || !error.message.startsWith('Entity id is already used')) {
          throw error;
        }
      }
    }
  }
}

export function createProject(options: CreateProjectOptions = {}): ProjectBuilder {
  return new ProjectBuilder(options);
}
