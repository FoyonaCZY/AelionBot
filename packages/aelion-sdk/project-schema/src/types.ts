import type { JsonObject, JsonValue, Rational } from '@aelionsdk/core';

export type EntityId = string;
export type CollectionName =
  'assets' | 'sequences' | 'tracks' | 'items' | 'materialInstances' | 'transitions' | 'markers' | 'linkGroups';

export interface TimeRange {
  readonly startUs: number;
  readonly durationUs: number;
}

export interface ProjectSettings extends JsonObject {
  defaultSequenceId: EntityId;
  defaultStillDurationUs: number;
  missingAssetPolicy: 'placeholder' | 'error';
  missingMaterialPolicy: 'placeholder' | 'error';
  missingPluginPolicy: 'placeholder' | 'error';
  locale?: string;
  timezone?: string;
}

/**
 * Frame manifest of an `image-sequence` asset. Frames are uniform-duration
 * stills; each `frameAssetIds` entry references an `image` Asset in the same
 * Project. Sampling a sequence at an item time maps to the frame whose
 * interval contains that time (see {@link imageSequenceFrameIndex}).
 */
export interface ImageSequenceReference extends JsonObject {
  /** Duration of every frame in microseconds. */
  readonly frameDurationUs: number;
  /** Ordered image Asset ids, one per frame, referencing `image` kind Assets. */
  readonly frameAssetIds: EntityId[];
}

export interface ProjectEntity extends JsonObject {
  id: EntityId;
}

export interface SequenceColorFormat extends JsonObject {
  width: number;
  height: number;
  pixelAspectRatio: Rational & JsonObject;
  frameRate: Rational & JsonObject;
  sampleRate: 44_100 | 48_000 | 96_000;
  channelLayout: 'mono' | 'stereo' | '5.1';
  workingColorSpace: 'srgb-linear' | 'display-p3-linear' | 'rec2020-linear';
  /** Defaults to `bt709` for legacy Project v1 documents. */
  colorPrimaries?: 'bt709' | 'display-p3' | 'bt2020';
  /** Defaults to `srgb` for legacy Project v1 documents. */
  transferFunction?: 'srgb' | 'gamma22' | 'pq' | 'hlg';
  /** Defaults to `rgb` for the linear compositing surface. */
  matrixCoefficients?: 'rgb' | 'bt709' | 'bt2020-ncl';
  /** Defaults to `full` for the linear compositing surface. */
  colorRange?: 'full' | 'limited';
  /** Defaults to `4:4:4`; an encoder may require an explicit conversion to `4:2:0`. */
  chromaSubsampling?: 'rgb' | '4:4:4' | '4:2:2' | '4:2:0';
  /** Defaults to `premultiplied` inside the renderer. */
  alphaMode?: 'opaque' | 'premultiplied';
  /** Defaults to `none`; HDR must fail closed when it cannot be presented without conversion. */
  toneMapping?: 'none' | 'bt2390' | 'reinhard';
  /** Defaults to 8 for legacy Project v1 documents. */
  bitDepth?: 8 | 10;
  backgroundColor: JsonObject;
}

export interface SequenceEntity extends ProjectEntity {
  format: SequenceColorFormat & JsonObject;
  trackIds: EntityId[];
  transitionIds: EntityId[];
  materialInstanceIds: EntityId[];
  markerIds: EntityId[];
}

export interface TrackAudioProperties extends JsonObject {
  gainDb: JsonValue;
  pan: JsonValue;
  muted: boolean;
  /** Missing in older Project v1 documents means false. */
  solo?: boolean;
}

/**
 * What a Track is for, which decides how a layout may rearrange it.
 *
 * A `storyline` Track carries the cut everything else is timed against: it is
 * kept packed, so removing a clip closes the hole and inserting one displaces
 * its neighbours. An `overlay` Track is freely positioned and never repacked.
 */
export type TrackRole = 'storyline' | 'overlay';

/**
 * Whether two Items may occupy the same instant on a Track.
 *
 * `exclusive` Tracks reject overlap, which is what makes a single lane readable
 * as a sequence of cuts. `free` Tracks permit it, which stacked titles and
 * layered audio need. Missing means `exclusive` for a storyline and `free`
 * otherwise, so documents written before this field keep their behaviour.
 */
export type TrackOccupancy = 'exclusive' | 'free';

export interface TrackEntity extends ProjectEntity {
  sequenceId: EntityId;
  kind: 'visual' | 'audio' | 'caption';
  /** Defaults to `overlay`; see {@link trackRole}. */
  role?: TrackRole;
  /** Defaults to the role's implied policy; see {@link trackOccupancy}. */
  occupancy?: TrackOccupancy;
  enabled: boolean;
  locked: boolean;
  itemIds: EntityId[];
  materialInstanceIds: EntityId[];
  audio?: TrackAudioProperties;
}

/** The Track's role, defaulting to `overlay` for documents that predate the field. */
export function trackRole(track: TrackEntity): TrackRole {
  return track.role === 'storyline' ? 'storyline' : 'overlay';
}

/** The Track's occupancy policy, defaulting to what its role implies. */
export function trackOccupancy(track: TrackEntity): TrackOccupancy {
  if (track.occupancy !== undefined) return track.occupancy;
  return trackRole(track) === 'storyline' ? 'exclusive' : 'free';
}

/** Order-independent key for a pair of Items. */
export function itemPairKey(left: EntityId, right: EntityId): string {
  return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

/**
 * Item pairs joined by a Transition, which are supposed to overlap.
 *
 * A cross dissolve is exactly two clips playing at once, so the Items carrying
 * it overlap by the length of the Transition. That is the one overlap an
 * exclusive Track has to permit -- forbidding it would make a storyline and a
 * dissolve mutually exclusive, which is not a trade any editor would accept.
 */
export function transitionJoinedPairs(project: AelionProject): ReadonlySet<string> {
  const pairs = new Set<string>();
  for (const transition of Object.values(project.transitions)) {
    pairs.add(itemPairKey(transition.fromItemId, transition.toItemId));
  }
  return pairs;
}

export interface ItemEntity extends ProjectEntity {
  trackId: EntityId;
  type: string;
  enabled: boolean;
  range: TimeRange & JsonObject;
  materialInstanceIds: EntityId[];
  markerIds?: EntityId[];
  linkGroupId?: EntityId;
}

/** Project v1 audio Items can use varispeed or deterministic pitch-preserving stretch. */
export interface ItemAudioProperties extends JsonObject {
  gainDb: JsonValue;
  pan: JsonValue;
  fadeInUs?: number;
  fadeOutUs?: number;
  pitchPolicy?: 'varispeed' | 'preserve';
  channelMap?: JsonValue[];
}

export interface TransitionEntity extends ProjectEntity {
  sequenceId: EntityId;
  trackId: EntityId;
  fromItemId: EntityId;
  toItemId: EntityId;
  range: TimeRange & JsonObject;
  materialInstanceId: EntityId;
}

export interface MaterialInstanceEntity extends ProjectEntity {
  definition: JsonObject;
  enabled: boolean;
  parameters: JsonObject;
}

export interface LinkGroupEntity extends ProjectEntity {
  kind: 'av-sync' | 'edit-group';
  itemIds: EntityId[];
  syncOffsetsUs?: Record<EntityId, number>;
}

export interface MarkerEntity extends ProjectEntity {
  owner: { type: 'sequence' | 'item'; id: EntityId } & JsonObject;
  timeUs: number;
  durationUs: number;
  label?: string;
  color?: string;
  payload?: JsonValue;
}

export interface AelionProject extends JsonObject {
  $schema: string;
  schemaVersion: string;
  projectId: EntityId;
  metadata: JsonObject;
  settings: ProjectSettings;
  assets: Record<EntityId, ProjectEntity>;
  sequences: Record<EntityId, SequenceEntity>;
  tracks: Record<EntityId, TrackEntity>;
  items: Record<EntityId, ItemEntity>;
  materialInstances: Record<EntityId, MaterialInstanceEntity>;
  transitions: Record<EntityId, TransitionEntity>;
  markers: Record<EntityId, MarkerEntity>;
  linkGroups: Record<EntityId, LinkGroupEntity>;
  extensions: Record<string, JsonValue>;
}

export interface FrameFormat {
  readonly width: number;
  readonly height: number;
  readonly pixelAspectRatio: Rational;
  readonly frameRate: Rational;
  readonly sampleRate: 44_100 | 48_000 | 96_000;
  readonly channelLayout: 'mono' | 'stereo' | '5.1';
}

export const COLLECTION_NAMES: readonly CollectionName[] = [
  'assets',
  'sequences',
  'tracks',
  'items',
  'materialInstances',
  'transitions',
  'markers',
  'linkGroups',
] as const;
