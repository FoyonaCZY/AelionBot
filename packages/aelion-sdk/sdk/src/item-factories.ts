import type { JsonObject, JsonValue } from '@aelionsdk/core';
import { canonicalClone } from '@aelionsdk/project-schema';
import type {
  AdjustmentItemEntity,
  AudioItemEntity,
  BoxValue,
  CaptionItemEntity,
  ColorValue,
  EntityId,
  GapItemEntity,
  GeneratorItemEntity,
  GeneratorProperties,
  ImageItemEntity,
  ItemVisualProperties,
  LinearTimeMapping,
  MediaSourceReference,
  ShapeItemEntity,
  ShapeProperties,
  TextItemEntity,
  TrackEntity,
  TrackOccupancy,
  TrackRole,
  VideoItemEntity,
  VisualFit,
} from '@aelionsdk/project-schema';

/**
 * Standalone Item constructors, for building a Project that already exists.
 *
 * `ProjectBuilder` composes a Project up front and owns the document while it
 * does. An editor works the other way round: it needs a finished, valid entity
 * to hand to `commands.insertItem` inside a transaction. Without these, every
 * host writes the same schema literals by hand -- and gets a runtime validation
 * failure whenever a required field is missed, because a hand-written object
 * literal is only checked once it reaches the validator.
 */

/** Pixel dimensions used to centre a factory-created visual Item. */
export interface SequenceFrameSize {
  readonly width: number;
  readonly height: number;
}

/** Optional fit and opacity overrides for {@link defaultVisual}. */
export interface VisualDefaultsOptions {
  readonly fit?: VisualFit;
  readonly opacity?: number;
}

function assertProjectNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new RangeError(`${name} must be a canonical JSON number`);
  }
  return value;
}

function assertPositive(value: number, name: string): number {
  assertProjectNumber(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * Takes an owned, canonical copy of a caller-supplied subtree.
 *
 * Two things go wrong without it. A value stored by reference lets a later edit
 * to the caller's object reach through into an Item that is supposed to be
 * finished. And reusing one object twice inside a single Item -- the same colour
 * at both ends of a gradient, the same point twice in a polygon -- makes the
 * transaction reject it as a shared object, from a call site that has nothing
 * obviously wrong with it.
 *
 * `canonicalClone` also rejects the numbers a Project cannot store: `NaN`,
 * infinities, `-0` and unsafe integers fail here, at the call that introduced
 * them, rather than at whatever commit later carries them.
 */
function own<T extends JsonValue>(value: T): T {
  return canonicalClone(value);
}

function assertTime(value: number, name: string, positive = false): number {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new RangeError(`${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
  }
  return value;
}

/** Centred, unscaled, fully opaque -- the visual state a freshly placed clip has. */
export function defaultVisual(frame: SequenceFrameSize, options: VisualDefaultsOptions = {}): ItemVisualProperties {
  const opacity = options.opacity ?? 1;
  assertProjectNumber(opacity, 'opacity');
  if (opacity < 0 || opacity > 1) {
    throw new RangeError('opacity must be from 0 to 1');
  }
  assertPositive(frame.width, 'frame.width');
  assertPositive(frame.height, 'frame.height');
  return {
    fit: options.fit ?? 'contain',
    transform: {
      positionPx: { x: frame.width / 2, y: frame.height / 2 },
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

/** Creates a constant-rate media time map with validated rational components. */
export function linearTimeMapping(
  options: {
    readonly rate?: { readonly numerator: number; readonly denominator: number };
    readonly reverse?: boolean;
    readonly boundary?: LinearTimeMapping['boundary'];
  } = {},
): LinearTimeMapping {
  const rate = options.rate ?? { numerator: 1, denominator: 1 };
  assertPositiveInteger(rate.numerator, 'rate.numerator');
  assertPositiveInteger(rate.denominator, 'rate.denominator');
  return {
    type: 'linear',
    rate: { numerator: rate.numerator, denominator: rate.denominator },
    reverse: options.reverse ?? false,
    boundary: options.boundary ?? 'hold',
  };
}

interface BaseItemOptions {
  readonly id: EntityId;
  readonly trackId: EntityId;
  readonly atUs: number;
  readonly durationUs: number;
  readonly name?: string;
  readonly enabled?: boolean;
  readonly metadata?: JsonObject;
}

function baseItem(options: BaseItemOptions): {
  id: EntityId;
  trackId: EntityId;
  enabled: boolean;
  range: { startUs: number; durationUs: number };
  materialInstanceIds: EntityId[];
  name?: string;
  metadata?: JsonObject;
} {
  assertTime(options.atUs, 'atUs');
  assertTime(options.durationUs, 'durationUs', true);
  return {
    id: options.id,
    trackId: options.trackId,
    ...(options.name === undefined ? {} : { name: options.name }),
    enabled: options.enabled ?? true,
    range: { startUs: options.atUs, durationUs: options.durationUs },
    materialInstanceIds: [],
    ...(options.metadata === undefined ? {} : { metadata: own(options.metadata) }),
  };
}

/** Asset stream, source window and retiming used by a media Item factory. */
export interface MediaSourceOptions {
  readonly assetId: EntityId;
  readonly sourceStartUs?: number;
  readonly sourceDurationUs?: number;
  readonly streamIndex?: number;
  readonly timeMapping?: MediaSourceReference['timeMapping'];
}

function mediaSource(kind: 'video' | 'audio', durationUs: number, options: MediaSourceOptions): MediaSourceReference {
  const sourceStartUs = options.sourceStartUs ?? 0;
  const sourceDurationUs = options.sourceDurationUs ?? durationUs;
  const streamIndex = options.streamIndex ?? 0;
  assertTime(sourceStartUs, 'sourceStartUs');
  assertTime(sourceDurationUs, 'sourceDurationUs', true);
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0 || streamIndex > 1_024) {
    throw new RangeError('streamIndex must be an integer from 0 to 1024');
  }
  return {
    assetId: options.assetId,
    stream: { type: kind, index: streamIndex },
    sourceRange: { startUs: sourceStartUs, durationUs: sourceDurationUs },
    timeMapping: options.timeMapping === undefined ? linearTimeMapping() : own(options.timeMapping),
  };
}

/** Shared options for creating a video or still-image Item. */
export interface CreateMediaItemOptions extends BaseItemOptions, MediaSourceOptions {
  readonly frame: SequenceFrameSize;
  readonly fit?: VisualFit;
  readonly opacity?: number;
}

/** Creates a complete video Item ready for transactional insertion. */
export function createVideoItem(options: CreateMediaItemOptions): VideoItemEntity {
  return {
    ...baseItem(options),
    type: 'video',
    source: mediaSource('video', options.durationUs, options),
    visual: defaultVisual(options.frame, options),
  };
}

/** Creates a complete still-image Item ready for transactional insertion. */
export function createImageItem(options: CreateMediaItemOptions): ImageItemEntity {
  return {
    ...baseItem(options),
    type: 'image',
    source: mediaSource('video', options.durationUs, options),
    visual: defaultVisual(options.frame, options),
  };
}

/** Media source, mixer and fade options for creating an audio Item. */
export interface CreateAudioItemOptions extends BaseItemOptions, MediaSourceOptions {
  readonly gainDb?: number;
  readonly pan?: number;
  readonly fadeInUs?: number;
  readonly fadeOutUs?: number;
  readonly pitchPolicy?: 'varispeed' | 'preserve';
}

/** Creates a complete audio Item and validates its mixer and fade bounds. */
export function createAudioItem(options: CreateAudioItemOptions): AudioItemEntity {
  const gainDb = options.gainDb ?? 0;
  const pan = options.pan ?? 0;
  assertProjectNumber(gainDb, 'gainDb');
  assertProjectNumber(pan, 'pan');
  if (options.fadeInUs !== undefined) assertTime(options.fadeInUs, 'fadeInUs');
  if (options.fadeOutUs !== undefined) assertTime(options.fadeOutUs, 'fadeOutUs');
  if ((options.fadeInUs ?? 0) + (options.fadeOutUs ?? 0) > options.durationUs) {
    throw new RangeError('audio fades cannot overlap past the Item duration');
  }
  return {
    ...baseItem(options),
    type: 'audio',
    source: mediaSource('audio', options.durationUs, options),
    audio: {
      gainDb,
      pan,
      ...(options.fadeInUs === undefined ? {} : { fadeInUs: options.fadeInUs }),
      ...(options.fadeOutUs === undefined ? {} : { fadeOutUs: options.fadeOutUs }),
      ...(options.pitchPolicy === undefined ? {} : { pitchPolicy: options.pitchPolicy }),
    },
  };
}

/**
 * A text run as a caller writes one, before inherited style is made explicit.
 *
 * `style` is optional here and required in the stored document: the schema
 * demands the field on every paragraph and every run, and an Item read back out
 * of a validated Project always has it. Making a caller type `style: {}` on
 * text that inherits everything is noise, so the factory supplies it.
 */
export interface TextRunInput {
  readonly text: string;
  readonly style?: JsonObject;
}

/** A paragraph input whose omitted style fields are stored as empty objects. */
export interface TextParagraphInput {
  readonly style?: JsonObject;
  readonly runs: readonly TextRunInput[];
}

/** Text layout, content and visual frame options for creating a text Item. */
export interface CreateTextItemOptions extends BaseItemOptions {
  readonly frame: SequenceFrameSize;
  readonly box: BoxValue;
  readonly paragraphs: readonly TextParagraphInput[];
  readonly overflow?: TextItemEntity['overflow'];
  readonly writingMode?: TextItemEntity['writingMode'];
}

/** Creates a complete text Item, filling every schema-required style object. */
export function createTextItem(options: CreateTextItemOptions): TextItemEntity {
  if (options.paragraphs.length === 0) throw new RangeError('text needs at least one paragraph');
  const paragraphs = options.paragraphs.map((paragraph) => {
    if (paragraph.runs.length === 0) {
      throw new RangeError('every text paragraph needs at least one run');
    }
    return {
      style: own(paragraph.style ?? {}),
      // Copied rather than shared: the returned Item is the caller's to hand to
      // a transaction, and a later edit to the array they passed must not reach
      // through into it.
      runs: paragraph.runs.map((run) => ({ text: run.text, style: own(run.style ?? {}) })),
    };
  });
  return {
    ...baseItem(options),
    type: 'text',
    box: own(options.box),
    overflow: options.overflow ?? 'auto-fit',
    writingMode: options.writingMode ?? 'horizontal-tb',
    paragraphs,
    visual: defaultVisual(options.frame, { fit: 'none' }),
  };
}

/** Cue text, style and layout options for creating a caption Item. */
export interface CreateCaptionItemOptions extends BaseItemOptions {
  readonly frame: SequenceFrameSize;
  readonly text: string;
  readonly box: BoxValue;
  readonly style: JsonObject;
  readonly overflow?: CaptionItemEntity['overflow'];
}

/** Creates a complete caption Item ready for transactional insertion. */
export function createCaptionItem(options: CreateCaptionItemOptions): CaptionItemEntity {
  return {
    ...baseItem(options),
    type: 'caption',
    text: options.text,
    box: own(options.box),
    style: own(options.style),
    ...(options.overflow === undefined ? {} : { overflow: options.overflow }),
    visual: defaultVisual(options.frame, { fit: 'none' }),
  };
}

/** Geometry and frame options for creating a shape Item. */
export interface CreateShapeItemOptions extends BaseItemOptions {
  readonly frame: SequenceFrameSize;
  readonly shape: ShapeProperties;
}

/** Creates a complete shape Item while taking ownership of its geometry. */
export function createShapeItem(options: CreateShapeItemOptions): ShapeItemEntity {
  return {
    ...baseItem(options),
    type: 'shape',
    shape: own(options.shape),
    visual: defaultVisual(options.frame, { fit: 'none' }),
  };
}

/** Built-in source and frame options for creating a generator Item. */
export interface CreateGeneratorItemOptions extends BaseItemOptions {
  readonly frame: SequenceFrameSize;
  readonly kind: GeneratorProperties['kind'];
  readonly colors: readonly ColorValue[];
  readonly angleDeg?: number;
}

/** Creates a bounded solid or gradient generator Item. */
export function createGeneratorItem(options: CreateGeneratorItemOptions): GeneratorItemEntity {
  if (options.colors.length === 0) throw new RangeError('a generator needs at least one colour');
  if (options.colors.length > 16) throw new RangeError('a generator accepts at most 16 colours');
  if (options.angleDeg !== undefined) assertProjectNumber(options.angleDeg, 'angleDeg');
  return {
    ...baseItem(options),
    type: 'generator',
    generator: {
      kind: options.kind,
      colors: options.colors.map((color) => own(color)),
      ...(options.angleDeg === undefined ? {} : { angleDeg: options.angleDeg }),
    },
    visual: defaultVisual(options.frame),
  };
}

/** Frame options for creating a Material-bearing adjustment Item. */
export interface CreateAdjustmentItemOptions extends BaseItemOptions {
  readonly frame: SequenceFrameSize;
}

/** Creates a complete adjustment Item ready for Materials to be attached. */
export function createAdjustmentItem(options: CreateAdjustmentItemOptions): AdjustmentItemEntity {
  return {
    ...baseItem(options),
    type: 'adjustment',
    visual: defaultVisual(options.frame),
  };
}

/**
 * Blank time on a Track.
 *
 * The Item a packed Track needs in order to hold a deliberate pause: without
 * one, blank space is just a hole, and any layout that closes holes also closes
 * the silence somebody placed on purpose.
 */
export function createGapItem(options: BaseItemOptions): GapItemEntity {
  return { ...baseItem(options), type: 'gap' };
}

/** Ownership, kind and layout policy for creating an empty Track. */
export interface CreateTrackOptions {
  readonly id: EntityId;
  readonly sequenceId: EntityId;
  readonly kind: TrackEntity['kind'];
  readonly name?: string;
  readonly role?: TrackRole;
  readonly occupancy?: TrackOccupancy;
  readonly enabled?: boolean;
  readonly locked?: boolean;
}

/** Creates an empty Track with complete visual or audio defaults. */
export function createTrack(options: CreateTrackOptions): TrackEntity {
  return {
    id: options.id,
    sequenceId: options.sequenceId,
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
}
