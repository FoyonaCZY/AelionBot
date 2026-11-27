import { normalizeRational, type JsonObject, type JsonValue, type Rational } from '@aelionsdk/core';
import type { AelionProject } from '@aelionsdk/project-schema';

import {
  ProjectBuilder,
  type AddAssetOptions,
  type ClipAnimatableProperty,
  type Keyframe,
  type SetVisualOptions,
} from './project-builder.js';

const MIGRATION_INTEGRITY = `sha256:${'9d'.repeat(32)}` as const;

export const migrationMaterialPackage = Object.freeze({
  packageId: 'aelion.migration.builtin',
  packageVersion: '1.0.0',
  packageIntegrity: MIGRATION_INTEGRITY,
});

export type MigrationSeverity = 'info' | 'warning' | 'error';

export interface MigrationDiagnostic {
  readonly code: string;
  readonly severity: MigrationSeverity;
  readonly path: string;
  readonly message: string;
}

export interface MigrationResult {
  readonly project: Readonly<AelionProject>;
  readonly diagnostics: readonly MigrationDiagnostic[];
  /** Maps source object identifiers to generated Aelion entity identifiers. */
  readonly entityMap: Readonly<Record<string, string>>;
}

export class ProjectMigrationError extends Error {
  public override readonly name = 'ProjectMigrationError';

  public constructor(public readonly diagnostics: readonly MigrationDiagnostic[]) {
    super(diagnostics.map((value) => `${value.path}: ${value.message}`).join('\n'));
  }
}

export interface MigrationOptions {
  /** Reject every rendering feature that cannot be represented exactly. Defaults to true. */
  readonly strict?: boolean;
  readonly projectId?: string;
  readonly sequenceId?: string;
  readonly title?: string;
  readonly frameRate?: Rational;
}

export interface WebAvAssetBinding extends Omit<AddAssetOptions, 'kind'> {
  readonly kind: 'video' | 'audio' | 'image';
  /** Natural decoded size, required for visual rect conversion. */
  readonly width?: number;
  readonly height?: number;
}

export interface WebAvAnimationFrame {
  /** Item-local time in WebAV microseconds. */
  readonly timeUs: number;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  /** WebAV stores rotation in radians. */
  readonly angle?: number;
  readonly opacity?: number;
}

/**
 * Serializable projection of WebAV BaseSprite public state.
 *
 * WebAV deliberately keeps the IClip and its bytes private on OffscreenSprite,
 * so callers must bind the source Asset explicitly instead of the adapter
 * pretending it can recover source bytes from a Sprite.
 */
export interface WebAvSpriteSnapshot {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'image';
  readonly assetId: string;
  readonly time: {
    readonly offset: number;
    readonly duration: number;
    readonly playbackRate?: number;
  };
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
    readonly angle?: number;
  };
  readonly zIndex?: number;
  readonly opacity?: number;
  readonly flip?: 'horizontal' | 'vertical' | null;
  readonly visible?: boolean;
  readonly sourceStartUs?: number;
  /** Set when the WebAV IClip produces audio as well as video. */
  readonly includeAudio?: boolean;
  /** WebAV's private animation state must be projected explicitly by the caller. */
  readonly animation?: readonly WebAvAnimationFrame[];
}

export interface WebAvProjectSnapshot {
  readonly width: number;
  readonly height: number;
  readonly backgroundColor?: string;
  readonly assets: readonly WebAvAssetBinding[];
  readonly sprites: readonly WebAvSpriteSnapshot[];
}

export interface DiffusionAssetBinding extends Omit<AddAssetOptions, 'id' | 'kind'> {
  /** Diffusion BaseSource.id used by checkpoint Clip.source. */
  readonly sourceId: string;
  readonly assetId: string;
  readonly kind: AddAssetOptions['kind'];
  readonly width?: number;
  readonly height?: number;
  /** Whether a VIDEO source also exposes an audio track. */
  readonly hasAudio?: boolean;
  /** Required to turn a Diffusion CaptionSource into an inline Aelion Caption. */
  readonly captionText?: string;
}

export interface DiffusionMigrationOptions extends MigrationOptions {
  readonly assets: readonly DiffusionAssetBinding[];
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as UnknownRecord;
}

function records(value: unknown, path: string): readonly UnknownRecord[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((entry, index) => record(entry, `${path}[${index.toString()}]`));
}

function finite(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite`);
  }
  return value;
}

function finiteNumeric(value: unknown, fallback: number, path: string): number {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return finite(value, fallback, path);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonClone(value: unknown, path: string): JsonValue {
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError(`${path} must be JSON-serializable`);
  }
  if (typeof serialized !== 'string') {
    throw new TypeError(`${path} must be JSON-serializable`);
  }
  return JSON.parse(serialized) as JsonValue;
}

function usFromSeconds(value: unknown, path: string): number {
  const seconds = finite(value, 0, path);
  const result = Math.round(seconds * 1_000_000);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${path} exceeds the safe time range`);
  return result;
}

function safeUs(value: unknown, path: string): number {
  const result = finite(value, 0, path);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(`${path} must be a non-negative safe integer`);
  }
  return result;
}

function rationalRate(value: number, path: string): Rational {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${path} must be a positive finite number`);
  }
  const denominator = 1_000_000;
  const numerator = Math.round(value * denominator);
  if (!Number.isSafeInteger(numerator) || numerator <= 0) {
    throw new RangeError(`${path} cannot be represented as a safe rational rate`);
  }
  return normalizeRational({ numerator, denominator });
}

function sourceKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function entityId(prefix: string, index: number): string {
  return `${prefix}_${index.toString()}`;
}

function pushDiagnostic(diagnostics: MigrationDiagnostic[], value: MigrationDiagnostic): void {
  if (
    diagnostics.some(
      (existing) => existing.code === value.code && existing.path === value.path && existing.message === value.message,
    )
  ) {
    return;
  }
  diagnostics.push(Object.freeze(value));
}

function finish(
  builder: ProjectBuilder,
  diagnostics: MigrationDiagnostic[],
  entityMap: Record<string, string>,
  strict: boolean,
): MigrationResult {
  if (strict && diagnostics.some((value) => value.severity === 'error')) {
    throw new ProjectMigrationError(Object.freeze([...diagnostics]));
  }
  return Object.freeze({
    project: builder.build(),
    diagnostics: Object.freeze([...diagnostics]),
    entityMap: Object.freeze({ ...entityMap }),
  });
}

function webAvVisual(sprite: WebAvSpriteSnapshot, width: number, height: number): SetVisualOptions | undefined {
  const rect = sprite.rect;
  if (rect === undefined) return undefined;
  const flipX = sprite.flip === 'horizontal' ? -1 : 1;
  const flipY = sprite.flip === 'vertical' ? -1 : 1;
  return {
    fit: 'fill',
    positionPx: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    anchor: { x: 0.5, y: 0.5 },
    scale: {
      x: (rect.w / width) * flipX,
      y: (rect.h / height) * flipY,
    },
    rotationDeg: ((rect.angle ?? 0) * 180) / Math.PI,
    opacity: sprite.opacity ?? 1,
  };
}

function applyWebAvAnimation(
  builder: ProjectBuilder,
  itemId: string,
  sprite: WebAvSpriteSnapshot,
  asset: WebAvAssetBinding,
  width: number,
  height: number,
): void {
  if (sprite.animation === undefined || sprite.animation.length === 0) return;
  const baseRect = sprite.rect ?? {
    x: 0,
    y: 0,
    w: asset.width ?? width,
    h: asset.height ?? height,
    angle: 0,
  };
  const frames = [...sprite.animation].sort((left, right) => left.timeUs - right.timeUs);
  const position: Keyframe[] = [];
  const scale: Keyframe[] = [];
  const rotation: Keyframe[] = [];
  const opacity: Keyframe[] = [];
  for (const frame of frames) {
    const frameWidth = frame.width ?? baseRect.w;
    const frameHeight = frame.height ?? baseRect.h;
    const frameX = frame.x ?? baseRect.x;
    const frameY = frame.y ?? baseRect.y;
    position.push({
      timeUs: safeUs(frame.timeUs, `${sprite.id}.animation.timeUs`),
      value: { x: frameX + frameWidth / 2, y: frameY + frameHeight / 2 },
    });
    scale.push({
      timeUs: frame.timeUs,
      value: {
        x: (frameWidth / width) * (sprite.flip === 'horizontal' ? -1 : 1),
        y: (frameHeight / height) * (sprite.flip === 'vertical' ? -1 : 1),
      },
    });
    rotation.push({
      timeUs: frame.timeUs,
      value: ((frame.angle ?? baseRect.angle ?? 0) * 180) / Math.PI,
    });
    opacity.push({ timeUs: frame.timeUs, value: frame.opacity ?? sprite.opacity ?? 1 });
  }
  builder.setKeyframes(itemId, 'position', position);
  builder.setKeyframes(itemId, 'scale', scale);
  builder.setKeyframes(itemId, 'rotation', rotation);
  builder.setKeyframes(itemId, 'opacity', opacity);
}

export function migrateWebAvProject(snapshot: WebAvProjectSnapshot, options: MigrationOptions = {}): MigrationResult {
  const strict = options.strict ?? true;
  const builder = new ProjectBuilder({
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.sequenceId === undefined ? {} : { sequenceId: options.sequenceId }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
    width: snapshot.width,
    height: snapshot.height,
    ...(snapshot.backgroundColor === undefined ? {} : { backgroundColor: snapshot.backgroundColor }),
  });
  const diagnostics: MigrationDiagnostic[] = [];
  const entityMap: Record<string, string> = {};
  const assets = new Map(snapshot.assets.map((value) => [value.id, value]));
  for (const asset of snapshot.assets) builder.addAsset(asset);

  const visualTracks = new Map<number, string>();
  const audioTrack = builder.addTrack({ id: 'webav_audio', kind: 'audio', name: 'WebAV audio' });
  const visualTrack = (zIndex: number): string => {
    const existing = visualTracks.get(zIndex);
    if (existing !== undefined) return existing;
    const id = builder.addTrack({
      id: entityId('webav_visual', visualTracks.size),
      kind: 'visual',
      name: `WebAV z-index ${zIndex.toString()}`,
    });
    visualTracks.set(zIndex, id);
    return id;
  };

  const sorted = [...snapshot.sprites].sort((left, right) => (left.zIndex ?? 0) - (right.zIndex ?? 0));
  sorted.forEach((sprite, index) => {
    const path = `sprites[${index.toString()}]`;
    const asset = assets.get(sprite.assetId);
    if (asset === undefined) throw new ReferenceError(`${path}.assetId is not bound`);
    if (asset.kind !== sprite.kind) {
      pushDiagnostic(diagnostics, {
        code: 'WEBAV_ASSET_KIND_MISMATCH',
        severity: 'error',
        path: `${path}.assetId`,
        message: `${sprite.kind} Sprite cannot bind a ${asset.kind} Asset`,
      });
      return;
    }
    const atUs = safeUs(sprite.time.offset, `${path}.time.offset`);
    const durationUs = safeUs(sprite.time.duration, `${path}.time.duration`);
    if (durationUs === 0) throw new RangeError(`${path}.time.duration must be positive`);
    const playbackRate = finite(sprite.time.playbackRate, 1, `${path}.time.playbackRate`);
    const rate = rationalRate(playbackRate, `${path}.time.playbackRate`);
    if (Math.abs(rate.numerator / rate.denominator - playbackRate) > 1e-9) {
      pushDiagnostic(diagnostics, {
        code: 'WEBAV_PLAYBACK_RATE_APPROXIMATED',
        severity: 'warning',
        path: `${path}.time.playbackRate`,
        message: `playbackRate was approximated as ${rate.numerator.toString()}/${rate.denominator.toString()}`,
      });
    }
    if (sprite.visible === false) {
      pushDiagnostic(diagnostics, {
        code: 'WEBAV_HIDDEN_SPRITE_SKIPPED',
        severity: 'info',
        path: `${path}.visible`,
        message: 'hidden Sprite was intentionally omitted',
      });
      return;
    }
    if (sprite.includeAudio === true && sprite.kind !== 'video') {
      pushDiagnostic(diagnostics, {
        code: 'WEBAV_AUDIO_STREAM_UNAVAILABLE',
        severity: 'error',
        path: `${path}.includeAudio`,
        message: 'only a video Sprite can expose a linked audio stream',
      });
      return;
    }
    const sourceStartUs = safeUs(sprite.sourceStartUs ?? 0, `${path}.sourceStartUs`);
    const itemId = entityId('webav_item', index);
    if (sprite.kind === 'audio') {
      builder.addMediaClip({
        id: itemId,
        kind: 'audio',
        assetId: sprite.assetId,
        trackId: audioTrack,
        atUs,
        durationUs,
        sourceStartUs,
        sourceDurationUs: Math.max(1, Math.round(durationUs * playbackRate)),
        rate,
        name: sprite.id,
      });
    } else {
      const trackId = visualTrack(sprite.zIndex ?? 0);
      if (sprite.kind === 'image') {
        builder.addImageClip({
          id: itemId,
          assetId: sprite.assetId,
          trackId,
          atUs,
          durationUs,
          name: sprite.id,
          fit: 'fill',
        });
      } else {
        builder.addMediaClip({
          id: itemId,
          kind: 'video',
          assetId: sprite.assetId,
          trackId,
          atUs,
          durationUs,
          sourceStartUs,
          sourceDurationUs: Math.max(1, Math.round(durationUs * playbackRate)),
          rate,
          name: sprite.id,
          fit: 'fill',
        });
      }
      const visual = webAvVisual(sprite, snapshot.width, snapshot.height);
      if (visual !== undefined) builder.setVisual(itemId, visual);
      applyWebAvAnimation(builder, itemId, sprite, asset, snapshot.width, snapshot.height);
      if (sprite.includeAudio === true) {
        const audioId = `${itemId}_audio`;
        builder.addMediaClip({
          id: audioId,
          kind: 'audio',
          assetId: sprite.assetId,
          trackId: audioTrack,
          atUs,
          durationUs,
          sourceStartUs,
          sourceDurationUs: Math.max(1, Math.round(durationUs * playbackRate)),
          rate,
          name: `${sprite.id} audio`,
        });
        entityMap[sourceKey('webav-audio', sprite.id)] = audioId;
      }
    }
    entityMap[sourceKey('webav', sprite.id)] = itemId;
  });

  return finish(builder, diagnostics, entityMap, strict);
}

function diffusionSettings(checkpoint: UnknownRecord): UnknownRecord {
  const value = checkpoint.settings;
  return value === undefined ? {} : record(value, 'checkpoint.settings');
}

function diffusionVisual(
  clip: UnknownRecord,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  path: string,
  diagnostics: MigrationDiagnostic[],
): SetVisualOptions {
  const visualWidth = finite(clip.width, sourceWidth, 'clip.width');
  const visualHeight = finite(clip.height, sourceHeight, 'clip.height');
  const x = finite(clip.x, 0, 'clip.x') + finite(clip.translateX, 0, 'clip.translateX');
  const y = finite(clip.y, 0, 'clip.y') + finite(clip.translateY, 0, 'clip.translateY');
  const opacityPercent = finite(clip.opacity, 100, 'clip.opacity');
  const blendMode = diffusionBlendMode(clip, path, diagnostics);
  return {
    fit: 'fill',
    positionPx: { x, y },
    anchor: {
      x: finite(clip.anchorX, 0, 'clip.anchorX'),
      y: finite(clip.anchorY, 0, 'clip.anchorY'),
    },
    scale: {
      x: (visualWidth / width) * finite(clip.scaleX, 1, 'clip.scaleX'),
      y: (visualHeight / height) * finite(clip.scaleY, 1, 'clip.scaleY'),
    },
    rotationDeg: finite(clip.rotation, 0, 'clip.rotation'),
    opacity: Math.max(0, Math.min(1, opacityPercent / 100)),
    blendMode,
  };
}

const DIFFUSION_AELION_BLEND_MODES = new Set([
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
]);

function diffusionBlendMode(
  clip: UnknownRecord,
  path: string,
  diagnostics: MigrationDiagnostic[],
): NonNullable<SetVisualOptions['blendMode']> {
  const blend = optionalString(clip.blendMode);
  if (blend === undefined || blend === 'source-over') return 'normal';
  if (DIFFUSION_AELION_BLEND_MODES.has(blend)) {
    return blend as NonNullable<SetVisualOptions['blendMode']>;
  }
  pushDiagnostic(diagnostics, {
    code: 'DIFFUSION_BLEND_MODE_UNSUPPORTED',
    severity: 'error',
    path: `${path}.blendMode`,
    message: `Canvas blend mode ${blend} has no equivalent Aelion blend mode`,
  });
  return 'normal';
}

function diffusionCanvasVisual(
  clip: UnknownRecord,
  width: number,
  height: number,
  path: string,
  diagnostics: MigrationDiagnostic[],
): SetVisualOptions {
  const x = finite(clip.x, 0, 'clip.x') + finite(clip.translateX, 0, 'clip.translateX');
  const y = finite(clip.y, 0, 'clip.y') + finite(clip.translateY, 0, 'clip.translateY');
  return {
    fit: 'fill',
    positionPx: { x, y },
    anchor: { x: x / width, y: y / height },
    scale: {
      x: finite(clip.scaleX, 1, 'clip.scaleX'),
      y: finite(clip.scaleY, 1, 'clip.scaleY'),
    },
    rotationDeg: finite(clip.rotation, 0, 'clip.rotation'),
    opacity: Math.max(0, Math.min(1, finite(clip.opacity, 100, 'clip.opacity') / 100)),
    blendMode: diffusionBlendMode(clip, path, diagnostics),
  };
}

function shapeBox(
  clip: UnknownRecord,
  fallbackWidth: number,
  fallbackHeight: number,
): { x: number; y: number; width: number; height: number } {
  const width = finite(clip.width, fallbackWidth, 'clip.width');
  const height = finite(clip.height, fallbackHeight, 'clip.height');
  const anchorX = finite(clip.anchorX, 0, 'clip.anchorX');
  const anchorY = finite(clip.anchorY, 0, 'clip.anchorY');
  const originX = finite(clip.x, 0, 'clip.x') + finite(clip.translateX, 0, 'clip.translateX');
  const originY = finite(clip.y, 0, 'clip.y') + finite(clip.translateY, 0, 'clip.translateY');
  return {
    x: originX - anchorX * width,
    y: originY - anchorY * height,
    width,
    height,
  };
}

function colorWithOpacity(color: string, opacityPercent: number, path: string): string {
  if (opacityPercent >= 100) return color;
  const match = /^#([\da-f]{6})([\da-f]{2})?$/iu.exec(color);
  if (match === null) {
    throw new TypeError(`${path} color opacity requires a six- or eight-digit hex color`);
  }
  const existing = match[2] === undefined ? 255 : Number.parseInt(match[2], 16);
  const alpha = Math.round((existing * Math.max(0, Math.min(100, opacityPercent))) / 100);
  return `#${match[1] ?? '000000'}${alpha.toString(16).padStart(2, '0')}`;
}

function diffusionStroke(
  value: unknown,
  path: string,
  diagnostics: MigrationDiagnostic[],
): { readonly color: string; readonly width: number } | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  if (value.length === 0) return undefined;
  if (value.length > 1) {
    pushDiagnostic(diagnostics, {
      code: 'DIFFUSION_MULTIPLE_STROKES_UNSUPPORTED',
      severity: 'error',
      path,
      message: 'Aelion v1 can preserve only one shape/text stroke',
    });
  }
  const stroke = record(value[0], `${path}[0]`);
  const lineCap = optionalString(stroke.lineCap);
  const lineJoin = optionalString(stroke.lineJoin);
  const miterLimit = finite(stroke.miterLimit, 10, `${path}[0].miterLimit`);
  if (
    (lineCap !== undefined && lineCap !== 'butt') ||
    (lineJoin !== undefined && lineJoin !== 'miter') ||
    miterLimit !== 10
  ) {
    pushDiagnostic(diagnostics, {
      code: 'DIFFUSION_STROKE_GEOMETRY_UNSUPPORTED',
      severity: 'error',
      path: `${path}[0]`,
      message: 'stroke cap/join/miter geometry differs from Aelion v1',
    });
  }
  const color = optionalString(stroke.color) ?? '#000000';
  return {
    color: colorWithOpacity(color, finite(stroke.opacity, 100, `${path}[0].opacity`), `${path}[0]`),
    width: finite(stroke.width, 1, `${path}[0].width`),
  };
}

function diagnoseDiffusionTextRendering(clip: UnknownRecord, path: string, diagnostics: MigrationDiagnostic[]): void {
  if (clip.background !== undefined) {
    pushDiagnostic(diagnostics, {
      code: 'DIFFUSION_TEXT_BACKGROUND_UNSUPPORTED',
      severity: 'error',
      path: `${path}.background`,
      message: 'text background padding/radius requires a linked Aelion background Shape',
    });
  }
  if (Array.isArray(clip.shadows) && clip.shadows.length > 0) {
    pushDiagnostic(diagnostics, {
      code: 'DIFFUSION_TEXT_SHADOWS_UNSUPPORTED',
      severity: 'error',
      path: `${path}.shadows`,
      message: 'text shadows require an Aelion text-shadow Material',
    });
  }
  if (clip.glow !== undefined) {
    pushDiagnostic(diagnostics, {
      code: 'DIFFUSION_TEXT_GLOW_UNSUPPORTED',
      severity: 'error',
      path: `${path}.glow`,
      message: 'text glow requires an Aelion glow Material',
    });
  }
}

function diffusionStyle(clip: UnknownRecord, path: string, diagnostics: MigrationDiagnostic[]): JsonObject {
  const font = clip.font === undefined ? {} : record(clip.font, 'clip.font');
  const stroke = diffusionStroke(clip.strokes, `${path}.strokes`, diagnostics);
  const fontSize = finiteNumeric(clip.fontSize ?? font.size, 48, `${path}.font.size`);
  const align = optionalString(clip.align);
  return {
    fontFamilies: [optionalString(font.family) ?? 'sans-serif'],
    fontSizePx: fontSize,
    fontWeight: finiteNumeric(font.weight, 400, `${path}.font.weight`),
    fontStyle: optionalString(font.style) ?? 'normal',
    fill: optionalString(clip.color) ?? '#ffffff',
    ...(stroke === undefined
      ? {}
      : {
          stroke: stroke.color,
          strokeWidthPx: stroke.width,
        }),
    align: align === 'center' ? 'center' : align === 'right' ? 'end' : 'start',
    lineHeightPx: fontSize * finite(clip.leading, 1, `${path}.leading`),
  };
}

function textStyleWithOpacity(style: JsonObject, value: unknown, path: string): JsonObject {
  if (value === undefined) return style;
  const opacity = finite(value, 100, path);
  return {
    ...style,
    ...(typeof style.fill === 'string' ? { fill: colorWithOpacity(style.fill, opacity, path) } : {}),
    ...(typeof style.stroke === 'string' ? { stroke: colorWithOpacity(style.stroke, opacity, path) } : {}),
  };
}

interface MigratedTextContent {
  readonly text: string;
  readonly style: JsonObject;
  readonly runs?: readonly { readonly text: string; readonly style: JsonObject }[];
}

function transformedText(value: string, casing: unknown): string {
  return casing === 'upper' ? value.toLocaleUpperCase() : casing === 'lower' ? value.toLocaleLowerCase() : value;
}

function migrateDiffusionTextContent(
  clip: UnknownRecord,
  sourceText: string,
  path: string,
  diagnostics: MigrationDiagnostic[],
): MigratedTextContent {
  diagnoseDiffusionTextRendering(clip, path, diagnostics);
  const style = diffusionStyle(clip, path, diagnostics);
  if (!Array.isArray(clip.styles) || clip.styles.length === 0) {
    return { text: transformedText(sourceText, clip.casing), style };
  }
  const overrides = clip.styles.flatMap((raw, index) => {
    const override = record(raw, `${path}.styles[${index.toString()}]`);
    const start = finite(override.start, 0, `${path}.styles[${index.toString()}].start`);
    const end = finite(override.end, sourceText.length, `${path}.styles[${index.toString()}].end`);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > sourceText.length
    ) {
      pushDiagnostic(diagnostics, {
        code: 'DIFFUSION_TEXT_STYLE_RANGE_INVALID',
        severity: 'error',
        path: `${path}.styles[${index.toString()}]`,
        message: 'style override range is outside the source text',
      });
      return [];
    }
    const overrideStyle = record(override.style, `${path}.styles[${index.toString()}].style`);
    diagnoseDiffusionTextRendering(overrideStyle, `${path}.styles[${index.toString()}].style`, diagnostics);
    return [{ start, end, style: overrideStyle, index }];
  });
  const boundaries = [
    ...new Set([0, sourceText.length, ...overrides.flatMap((value) => [value.start, value.end])]),
  ].sort((left, right) => left - right);
  const runs = boundaries.slice(0, -1).flatMap((start, boundaryIndex) => {
    const end = boundaries[boundaryIndex + 1];
    if (end === undefined || end <= start) return [];
    const applicable = overrides.filter((value) => value.start <= start && value.end >= end);
    let combined = { ...clip } as Record<string, unknown>;
    for (const override of applicable) {
      const overrideFont =
        override.style.font === undefined
          ? {}
          : record(override.style.font, `${path}.styles[${override.index.toString()}].style.font`);
      const baseFont = combined.font === undefined ? {} : record(combined.font, `${path}.font`);
      combined = {
        ...combined,
        ...override.style,
        font: { ...baseFont, ...overrideFont },
      };
    }
    const overrideOpacity = applicable.reduce<unknown>(
      (value, override) => (override.style.opacity === undefined ? value : override.style.opacity),
      undefined,
    );
    return [
      {
        text: transformedText(sourceText.slice(start, end), combined.casing),
        style: textStyleWithOpacity(
          diffusionStyle(combined, `${path}.styles`, diagnostics),
          overrideOpacity,
          `${path}.styles.opacity`,
        ),
      },
    ];
  });
  return {
    text: runs.map((run) => run.text).join(''),
    style,
    runs,
  };
}

function addMigrationMaterial(
  builder: ProjectBuilder,
  itemId: string,
  materialId: string,
  parameters: JsonObject,
  id: string,
): void {
  const instanceId = builder.addMaterialInstance({
    id,
    ...migrationMaterialPackage,
    materialId,
    parameters,
    previewPolicy: 'required',
  });
  builder.attachEffect(itemId, instanceId);
}

const DIFFUSION_EFFECTS = new Set([
  'blur',
  'brightness',
  'contrast',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
]);

function migrateDiffusionEffects(
  builder: ProjectBuilder,
  clip: UnknownRecord,
  itemId: string,
  path: string,
  diagnostics: MigrationDiagnostic[],
  width: number,
  height: number,
): void {
  if (!Array.isArray(clip.effects)) return;
  clip.effects.forEach((raw, index) => {
    const effect = record(raw, `${path}.effects[${index.toString()}]`);
    const type = requiredString(effect.type, `${path}.effects[${index.toString()}].type`);
    if (!DIFFUSION_EFFECTS.has(type)) {
      pushDiagnostic(diagnostics, {
        code: 'DIFFUSION_EFFECT_UNSUPPORTED',
        severity: 'error',
        path: `${path}.effects[${index.toString()}]`,
        message: `effect ${type} has no safe Aelion migration Material`,
      });
      return;
    }
    const value = finite(effect.value, 0, `${path}.effects[${index.toString()}].value`);
    addMigrationMaterial(
      builder,
      itemId,
      `diffusion-${type}`,
      type === 'blur' ? { value, width, height } : { value },
      `${itemId}_effect_${index.toString()}`,
    );
  });
}

interface DiffusionAnimation {
  readonly key: string;
  readonly frames: readonly { readonly timeUs: number; readonly value: JsonValue }[];
}

function diffusionAnimations(
  clip: UnknownRecord,
  path: string,
  diagnostics: MigrationDiagnostic[],
): readonly DiffusionAnimation[] {
  if (!Array.isArray(clip.animations)) return [];
  return clip.animations.flatMap((raw, index) => {
    const animation = record(raw, `${path}.animations[${index.toString()}]`);
    const key = requiredString(animation.key, `${path}.animations[${index.toString()}].key`);
    const frames = records(animation.frames, `${path}.animations[${index.toString()}].frames`).map(
      (frame, frameIndex) => {
        if (frame.easing !== undefined || animation.easing !== undefined) {
          pushDiagnostic(diagnostics, {
            code: 'DIFFUSION_EASING_APPROXIMATED',
            severity: 'warning',
            path: `${path}.animations[${index.toString()}].frames[${frameIndex.toString()}]`,
            message: 'Diffusion easing was converted to linear interpolation',
          });
        }
        const value = frame.value;
        if (
          value === undefined ||
          (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean' && value !== null)
        ) {
          throw new TypeError(`${path}.animations[${index.toString()}].frames.value is invalid`);
        }
        return {
          timeUs: usFromSeconds(
            frame.time,
            `${path}.animations[${index.toString()}].frames[${frameIndex.toString()}].time`,
          ),
          value: value as JsonValue,
        };
      },
    );
    return [{ key, frames }];
  });
}

function interpolateNumberFrames(
  frames: readonly { readonly timeUs: number; readonly value: JsonValue }[],
  timeUs: number,
  fallback: number,
): number {
  const numeric = frames.filter(
    (entry): entry is { readonly timeUs: number; readonly value: number } => typeof entry.value === 'number',
  );
  if (numeric.length === 0) return fallback;
  const nextIndex = numeric.findIndex((entry) => entry.timeUs >= timeUs);
  if (nextIndex <= 0) return numeric[Math.max(0, nextIndex)]?.value ?? fallback;
  const right = numeric[nextIndex];
  const left = numeric[nextIndex - 1];
  if (right === undefined || left === undefined) return numeric.at(-1)?.value ?? fallback;
  const progress = (timeUs - left.timeUs) / Math.max(1, right.timeUs - left.timeUs);
  return left.value + (right.value - left.value) * progress;
}

function applyDiffusionAnimations(
  builder: ProjectBuilder,
  clip: UnknownRecord,
  itemId: string,
  path: string,
  diagnostics: MigrationDiagnostic[],
): void {
  const animations = diffusionAnimations(clip, path, diagnostics);
  const byKey = new Map(animations.map((value) => [value.key, value]));
  const applyScalar = (
    sourceKeyName: string,
    property: ClipAnimatableProperty,
    transform: (value: number) => number = (value) => value,
  ): void => {
    const animation = byKey.get(sourceKeyName);
    if (animation === undefined) return;
    builder.setKeyframes(
      itemId,
      property,
      animation.frames.map((frame) => ({
        timeUs: frame.timeUs,
        value: transform(finite(frame.value, 0, `${path}.animations.${sourceKeyName}`)),
      })),
    );
  };
  applyScalar('rotation', 'rotation');
  applyScalar('opacity', 'opacity', (value) => value / 100);

  const positionKeys = ['x', 'y', 'translateX', 'translateY'];
  const positionAnimations = positionKeys.flatMap((key) => {
    const value = byKey.get(key);
    return value === undefined ? [] : [value];
  });
  if (positionAnimations.length > 0) {
    const times = [...new Set(positionAnimations.flatMap((value) => value.frames.map((frame) => frame.timeUs)))].sort(
      (left, right) => left - right,
    );
    builder.setKeyframes(
      itemId,
      'position',
      times.map((timeUs) => ({
        timeUs,
        value: {
          x:
            interpolateNumberFrames(byKey.get('x')?.frames ?? [], timeUs, finite(clip.x, 0, `${path}.x`)) +
            interpolateNumberFrames(
              byKey.get('translateX')?.frames ?? [],
              timeUs,
              finite(clip.translateX, 0, `${path}.translateX`),
            ),
          y:
            interpolateNumberFrames(byKey.get('y')?.frames ?? [], timeUs, finite(clip.y, 0, `${path}.y`)) +
            interpolateNumberFrames(
              byKey.get('translateY')?.frames ?? [],
              timeUs,
              finite(clip.translateY, 0, `${path}.translateY`),
            ),
        },
      })),
    );
  }
  const scaleKeys = ['scale', 'scaleX', 'scaleY'];
  const scaleAnimations = scaleKeys.flatMap((key) => {
    const value = byKey.get(key);
    return value === undefined ? [] : [value];
  });
  if (scaleAnimations.length > 0) {
    const times = [...new Set(scaleAnimations.flatMap((value) => value.frames.map((frame) => frame.timeUs)))].sort(
      (left, right) => left - right,
    );
    builder.setKeyframes(
      itemId,
      'scale',
      times.map((timeUs) => {
        const common = interpolateNumberFrames(byKey.get('scale')?.frames ?? [], timeUs, 1);
        return {
          timeUs,
          value: {
            x:
              common *
              interpolateNumberFrames(
                byKey.get('scaleX')?.frames ?? [],
                timeUs,
                finite(clip.scaleX, 1, `${path}.scaleX`),
              ),
            y:
              common *
              interpolateNumberFrames(
                byKey.get('scaleY')?.frames ?? [],
                timeUs,
                finite(clip.scaleY, 1, `${path}.scaleY`),
              ),
          },
        };
      }),
    );
  }

  const supported = new Set(['x', 'y', 'translateX', 'translateY', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity']);
  animations
    .filter((value) => !supported.has(value.key))
    .forEach((value) =>
      pushDiagnostic(diagnostics, {
        code: 'DIFFUSION_ANIMATION_UNSUPPORTED',
        severity: 'error',
        path: `${path}.animations.${value.key}`,
        message: `animated property ${value.key} cannot be migrated without semantic loss`,
      }),
    );
}

function migrateDiffusionMask(
  builder: ProjectBuilder,
  clip: UnknownRecord,
  itemId: string,
  trackId: string,
  range: { readonly atUs: number; readonly durationUs: number },
  path: string,
  diagnostics: MigrationDiagnostic[],
): void {
  if (clip.mask === undefined) return;
  const mask = record(clip.mask, `${path}.mask`);
  const type = requiredString(mask.type, `${path}.mask.type`);
  if (type !== 'RECT' && type !== 'ELLIPSE') {
    pushDiagnostic(diagnostics, {
      code: 'DIFFUSION_MASK_UNSUPPORTED',
      severity: 'error',
      path: `${path}.mask`,
      message: `mask type ${type} cannot be migrated`,
    });
    return;
  }
  const maskItemId = `${itemId}_mask`;
  builder.addShapeClip({
    id: maskItemId,
    trackId,
    kind: type === 'ELLIPSE' ? 'ellipse' : 'rectangle',
    atUs: range.atUs,
    durationUs: range.durationUs,
    box: {
      x: finite(mask.x, 0, `${path}.mask.x`),
      y: finite(mask.y, 0, `${path}.mask.y`),
      width: finite(mask.width, 1, `${path}.mask.width`),
      height: finite(mask.height, 1, `${path}.mask.height`),
    },
    fill: '#ffffff',
    ...(type === 'RECT' ? { cornerRadiusPx: finite(mask.radius, 0, `${path}.mask.radius`) } : {}),
  });
  builder.setMask(itemId, {
    sourceItemId: maskItemId,
    channel: 'alpha',
    invert: false,
    featherPx: 0,
    space: 'canvas',
    consumeSource: true,
  });
  if (Array.isArray(mask.animations) && mask.animations.length > 0) {
    pushDiagnostic(diagnostics, {
      code: 'DIFFUSION_MASK_ANIMATION_UNSUPPORTED',
      severity: 'error',
      path: `${path}.mask.animations`,
      message: 'animated geometric masks require conversion to Aelion shape keyframes',
    });
  }
}

function diffusionAudioFades(
  clip: UnknownRecord,
  path: string,
  trimmedHeadUs: number,
  durationUs: number,
  diagnostics: MigrationDiagnostic[],
): { readonly fadeInUs: number; readonly fadeOutUs: number } {
  const rawFadeInUs = usFromSeconds(clip.fadeInDurationSeconds, `${path}.fadeInDurationSeconds`);
  const rawFadeOutUs = usFromSeconds(clip.fadeOutDurationSeconds, `${path}.fadeOutDurationSeconds`);
  if (rawFadeInUs < 0 || rawFadeOutUs < 0) {
    throw new RangeError(`${path} audio fade durations must be non-negative`);
  }
  const fadeInUs = Math.max(0, rawFadeInUs - trimmedHeadUs);
  const maximumFadeOutUs = Math.max(0, durationUs - fadeInUs);
  const fadeOutUs = Math.min(rawFadeOutUs, maximumFadeOutUs);
  if (fadeOutUs !== rawFadeOutUs) {
    pushDiagnostic(diagnostics, {
      code: 'DIFFUSION_AUDIO_FADES_OVERLAP',
      severity: 'error',
      path,
      message: 'audio fade durations overlap after trimming at composition time zero',
    });
  }
  return { fadeInUs, fadeOutUs };
}

function compatibleAssetKind(type: string, kind: AddAssetOptions['kind']): boolean {
  if (type === 'VIDEO') return kind === 'video';
  if (type === 'IMAGE') return kind === 'image';
  if (type === 'AUDIO') return kind === 'audio' || kind === 'video';
  return true;
}

export function migrateDiffusionCheckpoint(value: unknown, options: DiffusionMigrationOptions): MigrationResult {
  const checkpoint = record(value, 'checkpoint');
  const settings = diffusionSettings(checkpoint);
  const width = finite(settings.width, 1920, 'checkpoint.settings.width');
  const height = finite(settings.height, 1080, 'checkpoint.settings.height');
  const strict = options.strict ?? true;
  const checkpointTitle = optionalString(checkpoint.displayName);
  const builder = new ProjectBuilder({
    ...(options.projectId === undefined ? { projectId: 'diffusion_project' } : { projectId: options.projectId }),
    ...(options.sequenceId === undefined ? {} : { sequenceId: options.sequenceId }),
    ...(options.title === undefined
      ? checkpointTitle === undefined
        ? {}
        : { title: checkpointTitle }
      : { title: options.title }),
    ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
    width,
    height,
    ...(optionalString(settings.background) === undefined
      ? {}
      : {
          backgroundColor:
            optionalString(settings.background) === 'transparent'
              ? '#00000000'
              : (optionalString(settings.background) ?? '#000000'),
        }),
  });
  builder.setProjectExtension('aelion.migration.diffusion', {
    source: '@diffusion-studio/core',
    ...(checkpoint.id === undefined ? {} : { sourceId: jsonClone(checkpoint.id, 'checkpoint.id') }),
    ...(checkpoint.data === undefined ? {} : { data: jsonClone(checkpoint.data, 'checkpoint.data') }),
  });
  const diagnostics: MigrationDiagnostic[] = [];
  const entityMap: Record<string, string> = {};
  const assets = new Map(options.assets.map((asset) => [asset.sourceId, asset]));
  for (const asset of options.assets) {
    builder.addAsset({
      id: asset.assetId,
      kind: asset.kind,
      ...(asset.locator === undefined ? {} : { locator: asset.locator }),
      ...(asset.name === undefined ? {} : { name: asset.name }),
      ...(asset.mimeType === undefined ? {} : { mimeType: asset.mimeType }),
      ...(asset.contentHash === undefined ? {} : { contentHash: asset.contentHash }),
      ...(asset.byteLength === undefined ? {} : { byteLength: asset.byteLength }),
      ...(asset.probeHint === undefined ? {} : { probeHint: asset.probeHint }),
      ...(asset.representations === undefined ? {} : { representations: asset.representations }),
      ...(asset.metadata === undefined ? {} : { metadata: asset.metadata }),
    });
  }

  const layers = records(checkpoint.layers, 'checkpoint.layers');
  const transitionWork: {
    readonly clip: UnknownRecord;
    readonly itemId: string;
    readonly nextItemId?: string;
    readonly path: string;
    readonly centerUs: number;
  }[] = [];

  // Diffusion layer 0 is top-most; Aelion paints later Tracks on top.
  [...layers].reverse().forEach((layer, reverseIndex) => {
    const sourceIndex = layers.length - reverseIndex - 1;
    const clips = records(layer.clips, `checkpoint.layers[${sourceIndex.toString()}].clips`);
    const firstType = optionalString(clips[0]?.type) ?? 'BASE';
    const kind = firstType === 'AUDIO' ? 'audio' : firstType === 'CAPTION' ? 'caption' : 'visual';
    const trackId = entityId('diffusion_layer', sourceIndex);
    builder.addTrack({
      id: trackId,
      kind,
      name:
        optionalString(layer.displayName) ?? optionalString(layer.name) ?? `Diffusion layer ${sourceIndex.toString()}`,
      enabled: layer.disabled !== true,
    });
    builder.setTrackExtension(trackId, 'aelion.migration.diffusion', {
      ...(layer.mode === undefined ? {} : { mode: jsonClone(layer.mode, 'layer.mode') }),
      ...(layer.data === undefined ? {} : { data: jsonClone(layer.data, 'layer.data') }),
    });
    entityMap[sourceKey('diffusion-layer', optionalString(layer.id) ?? sourceIndex.toString())] = trackId;
    const itemIds: (string | undefined)[] = Array.from({ length: clips.length });
    clips.forEach((clip, clipIndex) => {
      const path = `checkpoint.layers[${sourceIndex.toString()}].clips[${clipIndex.toString()}]`;
      const type = requiredString(clip.type, `${path}.type`);
      const sourceId = optionalString(clip.source);
      const asset = sourceId === undefined ? undefined : assets.get(sourceId);
      const originalDelayUs = usFromSeconds(clip.delay, `${path}.delay`);
      const atUs = Math.max(0, originalDelayUs);
      const rawDurationUs = usFromSeconds(clip.duration, `${path}.duration`);
      if (rawDurationUs <= 0) throw new RangeError(`${path}.duration must be positive`);
      const trimmedHeadUs = Math.max(0, -originalDelayUs);
      const durationUs = rawDurationUs - trimmedHeadUs;
      if (durationUs <= 0) {
        pushDiagnostic(diagnostics, {
          code: 'DIFFUSION_CLIP_BEFORE_TIMELINE_SKIPPED',
          severity: 'info',
          path,
          message: 'Clip ends at or before composition time zero',
        });
        return;
      }
      const itemId = entityId('diffusion_item', clipIndex + sourceIndex * 1000);
      const name = optionalString(clip.displayName) ?? optionalString(clip.name) ?? optionalString(clip.id);
      const rangeRaw = Array.isArray(clip.range) ? clip.range : undefined;
      const sourceStartUs =
        (rangeRaw === undefined ? 0 : usFromSeconds(rangeRaw[0], `${path}.range[0]`)) + trimmedHeadUs;
      const sourceEndUs =
        rangeRaw === undefined ? sourceStartUs + durationUs : usFromSeconds(rangeRaw[1], `${path}.range[1]`);
      if (sourceEndUs <= sourceStartUs) {
        pushDiagnostic(diagnostics, {
          code: 'DIFFUSION_SOURCE_RANGE_INVALID',
          severity: 'error',
          path: `${path}.range`,
          message: 'source range must end after its trimmed start',
        });
      }
      const sourceDurationUs = Math.max(1, sourceEndUs - sourceStartUs);
      const mediaRate = normalizeRational({
        numerator: sourceDurationUs,
        denominator: durationUs,
      });

      if (clip.disabled === true) {
        pushDiagnostic(diagnostics, {
          code: 'DIFFUSION_DISABLED_CLIP_SKIPPED',
          severity: 'info',
          path: `${path}.disabled`,
          message: 'disabled Clip was intentionally omitted',
        });
        return;
      }

      if (type === 'VIDEO' || type === 'IMAGE' || type === 'AUDIO') {
        if (asset === undefined) {
          pushDiagnostic(diagnostics, {
            code: 'DIFFUSION_SOURCE_UNBOUND',
            severity: 'error',
            path: `${path}.source`,
            message: `source ${sourceId ?? '<missing>'} has no asset binding`,
          });
          return;
        }
        if (!compatibleAssetKind(type, asset.kind)) {
          pushDiagnostic(diagnostics, {
            code: 'DIFFUSION_SOURCE_KIND_MISMATCH',
            severity: 'error',
            path: `${path}.source`,
            message: `${type} Clip cannot bind an ${asset.kind} Aelion Asset`,
          });
          return;
        }
        const fades = diffusionAudioFades(clip, path, trimmedHeadUs, durationUs, diagnostics);
        if (type === 'AUDIO') {
          const volume =
            clip.muted === true
              ? 0
              : finite(clip.baseVolume, 1, `${path}.baseVolume`) * finite(clip.volume, 1, `${path}.volume`);
          builder.addMediaClip({
            id: itemId,
            kind: 'audio',
            assetId: asset.assetId,
            trackId,
            atUs,
            durationUs,
            sourceStartUs,
            sourceDurationUs,
            rate: mediaRate,
            ...(name === undefined ? {} : { name }),
            gainDb: volume <= 0 ? -120 : 20 * Math.log10(volume),
            ...(fades.fadeInUs === 0 ? {} : { fadeInUs: fades.fadeInUs }),
            ...(fades.fadeOutUs === 0 ? {} : { fadeOutUs: fades.fadeOutUs }),
          });
        } else if (type === 'IMAGE') {
          builder.addImageClip({
            id: itemId,
            assetId: asset.assetId,
            trackId,
            atUs,
            durationUs,
            ...(name === undefined ? {} : { name }),
            fit: 'fill',
          });
        } else {
          builder.addMediaClip({
            id: itemId,
            kind: 'video',
            assetId: asset.assetId,
            trackId,
            atUs,
            durationUs,
            sourceStartUs,
            sourceDurationUs,
            rate: mediaRate,
            ...(name === undefined ? {} : { name }),
            fit: 'fill',
          });
        }
        if (type !== 'AUDIO') {
          const sourceWidth = asset.width ?? finite(clip.width, width, `${path}.width`);
          const sourceHeight = asset.height ?? finite(clip.height, height, `${path}.height`);
          builder.setVisual(itemId, diffusionVisual(clip, width, height, sourceWidth, sourceHeight, path, diagnostics));
          if (type === 'VIDEO') {
            const probeHint = asset.probeHint;
            const hasAudio =
              asset.hasAudio ?? (probeHint !== undefined && Object.hasOwn(probeHint, 'audioCodec') ? true : undefined);
            if (hasAudio === undefined) {
              pushDiagnostic(diagnostics, {
                code: 'DIFFUSION_VIDEO_AUDIO_UNKNOWN',
                severity: 'warning',
                path: `${path}.source`,
                message: 'video source audio presence is unknown; set assets[].hasAudio to preserve it explicitly',
              });
            } else if (hasAudio) {
              const audioTrackId = builder.addTrack({
                id: `${trackId}_audio_${clipIndex.toString()}`,
                kind: 'audio',
                name: `${name ?? itemId} audio`,
              });
              const volume =
                clip.muted === true
                  ? 0
                  : finite(clip.baseVolume, 1, `${path}.baseVolume`) * finite(clip.volume, 1, `${path}.volume`);
              const audioItemId = `${itemId}_audio`;
              builder.addMediaClip({
                id: audioItemId,
                kind: 'audio',
                assetId: asset.assetId,
                trackId: audioTrackId,
                atUs,
                durationUs,
                sourceStartUs,
                sourceDurationUs,
                rate: mediaRate,
                gainDb: volume <= 0 ? -120 : 20 * Math.log10(volume),
                name: `${name ?? itemId} audio`,
                ...(fades.fadeInUs === 0 ? {} : { fadeInUs: fades.fadeInUs }),
                ...(fades.fadeOutUs === 0 ? {} : { fadeOutUs: fades.fadeOutUs }),
              });
              entityMap[sourceKey('diffusion-audio', optionalString(clip.id) ?? itemId)] = audioItemId;
            }
          }
        }
      } else if (type === 'TEXT') {
        const box = shapeBox(clip, width * 0.8, height * 0.2);
        const content = migrateDiffusionTextContent(clip, optionalString(clip.text) ?? '', path, diagnostics);
        builder.addTextClip({
          id: itemId,
          trackId,
          text: content.text,
          atUs,
          durationUs,
          box,
          style: content.style,
          ...(content.runs === undefined ? {} : { runs: content.runs }),
          ...(name === undefined ? {} : { name }),
        });
        builder.setVisual(itemId, diffusionCanvasVisual(clip, width, height, path, diagnostics));
      } else if (type === 'CAPTION') {
        if (asset?.captionText === undefined) {
          pushDiagnostic(diagnostics, {
            code: 'DIFFUSION_CAPTION_TEXT_UNBOUND',
            severity: 'error',
            path: `${path}.source`,
            message: 'CaptionSource text must be supplied as assets[].captionText',
          });
          return;
        }
        const content = migrateDiffusionTextContent(clip, asset.captionText, path, diagnostics);
        if (content.runs !== undefined) {
          pushDiagnostic(diagnostics, {
            code: 'DIFFUSION_CAPTION_STYLE_RANGES_UNSUPPORTED',
            severity: 'error',
            path: `${path}.styles`,
            message: 'Aelion v1 Caption Items support one style; use a Text Item for rich runs',
          });
        }
        builder.addCaptionClip({
          id: itemId,
          trackId,
          text: content.text,
          atUs,
          durationUs,
          box: shapeBox(clip, width * 0.8, height * 0.2),
          style: content.style,
          ...(name === undefined ? {} : { name }),
        });
        builder.setVisual(itemId, diffusionCanvasVisual(clip, width, height, path, diagnostics));
      } else if (type === 'RECT' || type === 'ELLIPSE' || type === 'POLYGON') {
        const box = shapeBox(clip, 100, 100);
        const sides = Math.max(3, Math.round(finite(clip.sides, 6, `${path}.sides`)));
        const points =
          type !== 'POLYGON'
            ? undefined
            : Array.from({ length: sides }, (_, pointIndex) => {
                const angle = (pointIndex / sides) * Math.PI * 2 - Math.PI / 2;
                return { x: 0.5 + Math.cos(angle) / 2, y: 0.5 + Math.sin(angle) / 2 };
              });
        const stroke = diffusionStroke(clip.strokes, `${path}.strokes`, diagnostics);
        builder.addShapeClip({
          id: itemId,
          trackId,
          kind: type === 'RECT' ? 'rectangle' : type === 'ELLIPSE' ? 'ellipse' : 'polygon',
          atUs,
          durationUs,
          box,
          fill: optionalString(clip.fill) ?? '#ffffff',
          ...(stroke === undefined ? {} : { stroke: stroke.color, strokeWidthPx: stroke.width }),
          ...(type === 'RECT' ? { cornerRadiusPx: finite(clip.radius, 0, `${path}.radius`) } : {}),
          ...(points === undefined ? {} : { points }),
          ...(name === undefined ? {} : { name }),
          opacity: Math.max(0, Math.min(1, finite(clip.opacity, 100, `${path}.opacity`) / 100)),
        });
        builder.setVisual(itemId, diffusionCanvasVisual(clip, width, height, path, diagnostics));
      } else {
        pushDiagnostic(diagnostics, {
          code: 'DIFFUSION_CLIP_TYPE_UNSUPPORTED',
          severity: 'error',
          path: `${path}.type`,
          message: `clip type ${type} cannot be migrated`,
        });
        return;
      }
      if (clip.data !== undefined) {
        builder.setItemMetadata(itemId, {
          diffusion: { data: jsonClone(clip.data, `${path}.data`) },
        });
      }
      itemIds[clipIndex] = itemId;
      entityMap[sourceKey('diffusion', optionalString(clip.id) ?? itemId)] = itemId;
      if (type !== 'AUDIO') {
        migrateDiffusionEffects(builder, clip, itemId, path, diagnostics, width, height);
        applyDiffusionAnimations(builder, clip, itemId, path, diagnostics);
        migrateDiffusionMask(builder, clip, itemId, trackId, { atUs, durationUs }, path, diagnostics);
      }
    });

    clips.forEach((clip, clipIndex) => {
      const itemId = itemIds[clipIndex];
      if (itemId === undefined || clip.transition === undefined) return;
      const nextItemId = itemIds[clipIndex + 1];
      transitionWork.push({
        clip,
        itemId,
        ...(nextItemId === undefined ? {} : { nextItemId }),
        path: `checkpoint.layers[${sourceIndex.toString()}].clips[${clipIndex.toString()}].transition`,
        centerUs: Math.max(0, usFromSeconds(clip.delay, 'clip.delay') + usFromSeconds(clip.duration, 'clip.duration')),
      });
    });
  });

  transitionWork.forEach((work, index) => {
    const transition = record(work.clip.transition, work.path);
    if (work.nextItemId === undefined) {
      pushDiagnostic(diagnostics, {
        code: 'DIFFUSION_TRANSITION_WITHOUT_SUCCESSOR',
        severity: 'error',
        path: work.path,
        message: 'transition is attached to the final Clip in its Layer',
      });
      return;
    }
    const type = requiredString(transition.type, `${work.path}.type`);
    const supported = new Set(['dissolve', 'slide-from-right', 'slide-from-left', 'fade-to-black', 'fade-to-white']);
    if (!supported.has(type)) {
      pushDiagnostic(diagnostics, {
        code: 'DIFFUSION_TRANSITION_UNSUPPORTED',
        severity: 'error',
        path: `${work.path}.type`,
        message: `transition ${type} is not supported`,
      });
      return;
    }
    const durationUs = usFromSeconds(transition.duration, `${work.path}.duration`);
    const atUs = Math.max(0, work.centerUs - Math.floor(durationUs / 2));
    const materialInstanceId = builder.addMaterialInstance({
      id: entityId('diffusion_transition_material', index),
      ...migrationMaterialPackage,
      materialId: `diffusion-${type}`,
      parameters: {},
    });
    builder.addTransition({
      id: entityId('diffusion_transition', index),
      fromItemId: work.itemId,
      toItemId: work.nextItemId,
      materialInstanceId,
      atUs,
      durationUs,
    });
  });

  const markers = Array.isArray(checkpoint.markers) ? checkpoint.markers : [];
  markers.forEach((raw, index) => {
    const marker = record(raw, `checkpoint.markers[${index.toString()}]`);
    const label = optionalString(marker.displayName) ?? optionalString(marker.name);
    const color = optionalString(marker.color);
    builder.addMarker({
      id: entityId('diffusion_marker', index),
      timeUs: usFromSeconds(marker.time, `checkpoint.markers[${index.toString()}].time`),
      ...(label === undefined ? {} : { label }),
      ...(color === undefined ? {} : { color }),
      ...(marker.data === undefined
        ? {}
        : { payload: jsonClone(marker.data, `checkpoint.markers[${index.toString()}].data`) }),
    });
  });

  return finish(builder, diagnostics, entityMap, strict);
}
