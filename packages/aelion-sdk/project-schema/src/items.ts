import type { JsonObject, JsonValue, Rational } from '@aelionsdk/core';

import type { EntityId, ItemAudioProperties, ItemEntity, TimeRange } from './types.js';

/**
 * Typed views over the Item shapes the Project schema already discriminates.
 *
 * `ItemEntity` is deliberately the loose structural base: it carries only what
 * every Item has, so schema growth cannot break a stored document. That leaves
 * every type-specific field -- `source`, `visual`, `audio`, `paragraphs` -- as
 * unchecked JSON at the type level, and each host application ends up writing
 * the same unsafe accessors to reach them.
 *
 * The `type` field is already a closed discriminant, so those shapes can be
 * named once here. Narrow with the guards below rather than casting.
 */

/** A two-dimensional numeric vector stored in Project JSON. */
export interface Vec2 extends JsonObject {
  x: number;
  y: number;
}

/** One keyframe in a Project animation curve. */
export interface AnimationKeyframe extends JsonObject {
  timeUs: number;
  value: JsonValue;
  interpolation: 'hold' | 'linear' | 'cubic-bezier';
}

/** A keyframed value with explicit time space and infinity behavior. */
export interface AnimationValue extends JsonObject {
  animation: {
    timeSpace: 'item' | 'sequence';
    preInfinity: 'hold' | 'linear' | 'none' | 'cycle' | 'ping-pong';
    postInfinity: 'hold' | 'linear' | 'none' | 'cycle' | 'ping-pong';
    keyframes: AnimationKeyframe[];
  } & JsonObject;
}

/** A number, or a keyframed animation that evaluates to one. */
export type AnimatableNumber = number | AnimationValue;
/** A 2D vector, or a keyframed animation that evaluates to one. */
export type AnimatableVec2 = Vec2 | AnimationValue;

/** A linear-light RGBA color tagged with its working color space. */
export interface ColorValue extends JsonObject {
  space: 'srgb-linear' | 'display-p3-linear' | 'rec2020-linear';
  rgba: number[];
}

/** An axis-aligned box in Sequence pixel coordinates. */
export interface BoxValue extends JsonObject {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fractional crop insets for the four edges of a visual Item. */
export interface CropValue extends JsonObject {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Animatable transform fields shared by visual Item types. */
export interface ItemVisualTransform extends JsonObject {
  positionPx: AnimatableVec2;
  anchor: AnimatableVec2;
  scale: AnimatableVec2;
  rotationDeg: AnimatableNumber;
  skewDeg: AnimatableVec2;
}

/** How decoded pixels fit the Item's destination bounds. */
export type VisualFit = 'contain' | 'cover' | 'fill' | 'none';

/** Porter-Duff-compatible blend modes supported by the renderer. */
export type BlendMode =
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

/** Rendering properties shared by every visual Item. */
export interface ItemVisualProperties extends JsonObject {
  fit: VisualFit;
  transform: ItemVisualTransform;
  crop: CropValue | AnimationValue;
  opacity: AnimatableNumber;
  blendMode: BlendMode;
  mask?: JsonObject;
}

/** Selects one audio or video stream from a media Asset. */
export interface MediaStreamReference extends JsonObject {
  type: 'video' | 'audio';
  index: number;
}

/** Constant-rate mapping from Item time to source time. */
export interface LinearTimeMapping extends JsonObject {
  type: 'linear';
  rate: Rational & JsonObject;
  reverse: boolean;
  boundary: 'error' | 'hold' | 'loop' | 'transparent';
}

/** Piecewise source-time mapping for ramps and non-linear retiming. */
export interface CurveTimeMapping extends JsonObject {
  type: 'curve';
  points: JsonObject[];
  boundary: 'error' | 'hold' | 'loop' | 'transparent';
}

/** Supported mappings from Item-local time to source time. */
export type ItemTimeMapping = LinearTimeMapping | CurveTimeMapping;

/** Complete reference from a media Item to an Asset stream and source window. */
export interface MediaSourceReference extends JsonObject {
  assetId: EntityId;
  stream: MediaStreamReference;
  sourceRange: TimeRange & JsonObject;
  timeMapping: ItemTimeMapping;
}

/** Source window and time mapping for a nested Sequence Item. */
export interface NestedSequenceSourceReference extends JsonObject {
  sequenceId: EntityId;
  sourceRange: TimeRange & JsonObject;
  timeMapping: ItemTimeMapping;
}

/** Geometry and paint stored by a shape Item. */
export interface ShapeProperties extends JsonObject {
  kind: 'rectangle' | 'ellipse' | 'polygon';
  box: BoxValue;
  fill: ColorValue;
  stroke?: ColorValue;
  strokeWidthPx?: number;
  cornerRadiusPx?: number;
  points?: Vec2[];
}

/** Built-in solid or linear-gradient generator configuration. */
export interface GeneratorProperties extends JsonObject {
  kind: 'solid' | 'linear-gradient';
  colors: ColorValue[];
  angleDeg?: number;
}

/** A styled text run inside a Project paragraph. */
export interface TextRun extends JsonObject {
  text: string;
  /**
   * Required by the document, so an Item read out of a validated Project always
   * carries one. Pass `{}` to inherit the paragraph's style rather than omitting
   * it -- the schema rejects a run without the field.
   */
  style: JsonObject;
}

/** An ordered group of text runs with inheritable paragraph style. */
export interface TextParagraph extends JsonObject {
  /** Required by the document; `{}` means "inherit". See {@link TextRun.style}. */
  style: JsonObject;
  runs: TextRun[];
}

/** A visual Item decoded from a video Asset stream. */
export interface VideoItemEntity extends ItemEntity {
  type: 'video';
  source: MediaSourceReference;
  visual: ItemVisualProperties;
}

/** An audible Item decoded from an audio Asset stream. */
export interface AudioItemEntity extends ItemEntity {
  type: 'audio';
  source: MediaSourceReference;
  audio: ItemAudioProperties;
}

/** A visual Item decoded from a still-image Asset. */
export interface ImageItemEntity extends ItemEntity {
  type: 'image';
  source: MediaSourceReference;
  visual: ItemVisualProperties;
}

/** Rich text laid out inside a fixed pixel box. */
export interface TextItemEntity extends ItemEntity {
  type: 'text';
  box: BoxValue;
  /**
   * What happens to text that does not fit its box.
   *
   * These are the four the document permits and the renderer implements:
   * `clip` cuts at the box, `ellipsis` truncates the last visible line,
   * `visible` lets the text spill, and `auto-fit` shrinks it until it fits.
   */
  overflow: 'clip' | 'ellipsis' | 'visible' | 'auto-fit';
  writingMode: 'horizontal-tb' | 'vertical-rl' | 'vertical-lr';
  paragraphs: TextParagraph[];
  visual: ItemVisualProperties;
}

/** One timed caption cue rendered inside a fixed pixel box. */
export interface CaptionItemEntity extends ItemEntity {
  type: 'caption';
  text: string;
  box: BoxValue;
  style: JsonObject;
  /** A caption is one cue in a fixed box, so it may only clip or shrink. */
  overflow?: 'clip' | 'auto-fit';
  cueSettings?: JsonObject;
  visual: ItemVisualProperties;
}

/** A built-in vector shape rendered as timeline content. */
export interface ShapeItemEntity extends ItemEntity {
  type: 'shape';
  shape: ShapeProperties;
  visual: ItemVisualProperties;
}

/** A built-in solid or gradient source rendered without an Asset. */
export interface GeneratorItemEntity extends ItemEntity {
  type: 'generator';
  generator: GeneratorProperties;
  visual: ItemVisualProperties;
}

/** A visual adjustment span whose Materials affect underlying content. */
export interface AdjustmentItemEntity extends ItemEntity {
  type: 'adjustment';
  visual: ItemVisualProperties;
}

/** A visual Item that evaluates another Sequence as its source. */
export interface NestedSequenceItemEntity extends ItemEntity {
  type: 'nested-sequence';
  source: NestedSequenceSourceReference;
  visual: ItemVisualProperties;
}

/** Timeline content produced directly by a Material instance. */
export interface MaterialContentItemEntity extends ItemEntity {
  type: 'material-content';
  materialInstanceId: EntityId;
  visual: ItemVisualProperties;
}

/**
 * Timed blank space on a Track.
 *
 * A Gap renders nothing and sounds like nothing; it exists so a packed Track
 * can hold deliberate emptiness. Without it, blank space is indistinguishable
 * from an accidental hole, and any layout that closes holes also destroys the
 * pauses an editor placed on purpose.
 */
export interface GapItemEntity extends ItemEntity {
  type: 'gap';
}

/** Discriminated union of every Item shape defined by Project v2. */
export type KnownItemEntity =
  | VideoItemEntity
  | AudioItemEntity
  | ImageItemEntity
  | TextItemEntity
  | CaptionItemEntity
  | ShapeItemEntity
  | GeneratorItemEntity
  | AdjustmentItemEntity
  | NestedSequenceItemEntity
  | MaterialContentItemEntity
  | GapItemEntity;

/** Closed set of Item discriminator values defined by Project v2. */
export type KnownItemType = KnownItemEntity['type'];

/** Item discriminator values in stable schema order. */
export const KNOWN_ITEM_TYPES: readonly KnownItemType[] = [
  'video',
  'audio',
  'image',
  'text',
  'caption',
  'shape',
  'generator',
  'adjustment',
  'nested-sequence',
  'material-content',
  'gap',
] as const;

function record(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function field(item: ItemEntity, key: string): JsonValue | undefined {
  return (item as JsonObject)[key];
}

/** Narrows to the declared Item union; `undefined` for an unrecognised `type`. */
export function asKnownItem(item: ItemEntity): KnownItemEntity | undefined {
  return (KNOWN_ITEM_TYPES as readonly string[]).includes(item.type) ? (item as KnownItemEntity) : undefined;
}

/** Returns whether an Item is a video Item and narrows its type. */
export function isVideoItem(item: ItemEntity): item is VideoItemEntity {
  return item.type === 'video';
}

/** Returns whether an Item is an audio Item and narrows its type. */
export function isAudioItem(item: ItemEntity): item is AudioItemEntity {
  return item.type === 'audio';
}

/** Returns whether an Item is an image Item and narrows its type. */
export function isImageItem(item: ItemEntity): item is ImageItemEntity {
  return item.type === 'image';
}

/** Returns whether an Item is a text Item and narrows its type. */
export function isTextItem(item: ItemEntity): item is TextItemEntity {
  return item.type === 'text';
}

/** Returns whether an Item is a caption Item and narrows its type. */
export function isCaptionItem(item: ItemEntity): item is CaptionItemEntity {
  return item.type === 'caption';
}

/** Returns whether an Item is a shape Item and narrows its type. */
export function isShapeItem(item: ItemEntity): item is ShapeItemEntity {
  return item.type === 'shape';
}

/** Returns whether an Item is a generator Item and narrows its type. */
export function isGeneratorItem(item: ItemEntity): item is GeneratorItemEntity {
  return item.type === 'generator';
}

/** Returns whether an Item is an adjustment Item and narrows its type. */
export function isAdjustmentItem(item: ItemEntity): item is AdjustmentItemEntity {
  return item.type === 'adjustment';
}

/** Returns whether an Item is a nested-Sequence Item and narrows its type. */
export function isNestedSequenceItem(item: ItemEntity): item is NestedSequenceItemEntity {
  return item.type === 'nested-sequence';
}

/** Returns whether an Item is Material-authored content and narrows its type. */
export function isMaterialContentItem(item: ItemEntity): item is MaterialContentItemEntity {
  return item.type === 'material-content';
}

/** Returns whether an Item is a non-rendering gap and narrows its type. */
export function isGapItem(item: ItemEntity): item is GapItemEntity {
  return item.type === 'gap';
}

/** Items backed by a decoded media Asset, whose source window can be trimmed. */
export function isMediaItem(item: ItemEntity): item is VideoItemEntity | AudioItemEntity | ImageItemEntity {
  return isVideoItem(item) || isAudioItem(item) || isImageItem(item);
}

/** Items whose source time advances with the timeline, so trimming reframes it. */
export function isTimedMediaItem(item: ItemEntity): item is VideoItemEntity | AudioItemEntity {
  return isVideoItem(item) || isAudioItem(item);
}

/** Reads a media source only when the Item carries a structurally usable one. */
export function itemMediaSource(item: ItemEntity): MediaSourceReference | undefined {
  if (!isMediaItem(item)) return undefined;
  const source = record(field(item, 'source'));
  return source === undefined || typeof source.assetId !== 'string' ? undefined : (source as MediaSourceReference);
}

/** Reads the visual properties carried by a visual Item. */
export function itemVisual(item: ItemEntity): ItemVisualProperties | undefined {
  return record(field(item, 'visual')) as ItemVisualProperties | undefined;
}

/** Reads the audio properties carried by an audio Item. */
export function itemAudio(item: ItemEntity): ItemAudioProperties | undefined {
  return record(field(item, 'audio')) as ItemAudioProperties | undefined;
}

/** The source window an Item reads from its Asset, in source time. */
export function itemSourceRange(item: ItemEntity): TimeRange | undefined {
  const range = record(itemMediaSource(item)?.sourceRange);
  if (range === undefined) return undefined;
  const startUs = range.startUs;
  const durationUs = range.durationUs;
  return typeof startUs === 'number' && typeof durationUs === 'number' ? { startUs, durationUs } : undefined;
}

/** Resolves an animatable number to its constant value, or `undefined` if keyframed. */
export function constantNumber(value: AnimatableNumber | JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Resolves an animatable vector to its constant value, or `undefined` if keyframed. */
export function constantVec2(value: AnimatableVec2 | JsonValue | undefined): Vec2 | undefined {
  const vector = record(value as JsonValue | undefined);
  if (vector === undefined) return undefined;
  const { x, y } = vector;
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined;
}

/** True when the value carries keyframes rather than a constant. */
export function isAnimated(value: JsonValue | undefined): value is AnimationValue {
  return record(value)?.animation !== undefined;
}
