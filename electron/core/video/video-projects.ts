// Host-side Video Studio project repository and atomic AelionSDK v2.0 editor.
// Projects live under <workspaceRoot>/videos/<botId>/<projectId>/ to break the 100 MiB attachment ceiling.
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { normalizeRational, type JsonObject, type JsonValue, type Rational } from '@aelionsdk/core';
import {
  ProjectValidator,
  type AelionProject,
  type ItemEntity,
  type MaterialInstanceEntity,
  type TrackEntity,
  type TransitionEntity,
} from '@aelionsdk/project-schema';
import { parseSrt, parseWebVtt } from '@aelionsdk/render-ir';
import { createProject, defaultSchemas } from '@aelionsdk/sdk';
import { TransactionEngine, TransactionHistory, type TransactionBuilder } from '@aelionsdk/transaction';
import { AppError } from '../../../shared/errors';
import {
  VIDEO_ASPECT_DIMENSIONS,
  type VideoAspectPreset,
  type VideoAssetImportInput,
  type VideoAssetInfo,
  type VideoClipEffect,
  type VideoClipKind,
  type VideoClipStyle,
  type VideoClipSummary,
  type VideoClipTransitionRef,
  type VideoEditOperation,
  type VideoEditRequest,
  type VideoEditResult,
  type VideoExportJob,
  type VideoMediaProbe,
  type VideoProjectCreateInput,
  type VideoProjectDetail,
  type VideoProjectSummary,
  type VideoSubtitleCue,
  type VideoTextBox,
  type VideoTextStyle,
  type VideoTrackKind,
  type VideoTrackSummary,
} from '../../../shared/types/video-studio-types';
import {
  effectIntensityFromParameters,
  effectMaterialSpec,
  presetForEffectDefinition,
  presetForTransitionDefinition,
  transitionDefinitionForPreset,
  VIDEO_TRANSITION_PRESETS,
} from './video-presets';

export const VIDEO_ENGINE_SCHEME = 'aelion-video';
const MASTERING_EXTENSION = 'aelion.audio.mastering';
const DEFAULT_STILL_DURATION_US = 3_000_000;
const GLOBAL_BOT_DIR = '_global';
const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB ceiling

export const STANDARD_TRACK_IDS = {
  videoMain: 'video-main',
  videoOverlay: 'video-overlay',
  captions: 'captions',
  audioVoice: 'audio-voice',
  audioBgm: 'audio-bgm',
} as const;

interface StoredAssetMeta {
  id: string;
  filename: string;
  sha256: string;
  kind: VideoAssetInfo['kind'];
  name: string;
  mimeType: string;
  byteLength: number;
  sourcePath?: string;
  attachmentId?: string;
  artifactId?: string;
  probe?: VideoMediaProbe;
}

interface ProjectMeta {
  id: string;
  botId?: string;
  sessionId?: string;
  title: string;
  aspect: VideoAspectPreset;
  createdAt: string;
  updatedAt: string;
  revision: string;
  posterDataUrl?: string;
  assets: Record<string, StoredAssetMeta>;
}

interface LoadedProject {
  dir: string;
  meta: ProjectMeta;
  engine: TransactionEngine;
  history: TransactionHistory;
  revisionOffset: bigint;
}

export interface VideoAssetImportExtendedInput {
  projectId: string;
  source:
    | VideoAssetImportInput['source']
    | { kind: 'artifact'; botId: string; path: string }
    | { kind: 'design'; path: string; botId?: string; sessionId?: string; width?: number; height?: number };
  name?: string;
  assetId?: string;
  analyze?: boolean;
}

export interface VideoProjectsDeps {
  /** Base folder containing per-bot project dirs (`<workspaceRoot>/videos/<botId>/<projectId>`). */
  workspaceRoot: () => string;
  /** Optional reader for VM/artifact workspace files. */
  readWorkspaceFile?: (botId: string, path: string) => Promise<{ bytes: Buffer; name: string; resolvedPath?: string }>;
  /** Optional reader for stored chat attachments. */
  readAttachment?: (attachmentId: string) => { bytes: Buffer; name: string; mime?: string };
  /** Optional HTML DesignWork slide -> PNG renderer. */
  renderDesignPageToPng?: (input: {
    botId?: string;
    sessionId?: string;
    path: string;
    width: number;
    height: number;
    allowHostFile?: boolean;
  }) => Promise<{ bytes: Buffer; name?: string }>;
  /** Optional host path validator / resolver. */
  resolveHostPath?: (rawPath: string) => string;
  /** Optional provider of recent exports for project detail snapshots. */
  listExports?: (projectId: string) => VideoExportJob[];
}

function makeEntityId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function sanitizeEntityId(raw: string | undefined, prefix: string): string {
  if (!raw) return makeEntityId(prefix);
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._:-]/g, '_');
  if (!cleaned || !/^[A-Za-z]/.test(cleaned)) return `${prefix}_${cleaned || randomUUID().slice(0, 8)}`;
  return cleaned.slice(0, 120);
}

function assertSafeDirSegment(value: string): string {
  const cleaned = value.trim();
  if (!cleaned || cleaned === '.' || cleaned === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(cleaned)) {
    throw new AppError('video.invalid_operation', '无效标识符');
  }
  return cleaned;
}

function writeAtomicJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

function sha256File(filePath: string): Promise<{ hash: string; size: number }> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.byteLength;
      hash.update(buf);
    });
    stream.on('error', rejectHash);
    stream.on('end', () => resolveHash({ hash: hash.digest('hex'), size }));
  });
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const MIME_BY_EXT: Record<string, { mime: string; kind: VideoAssetInfo['kind'] }> = {
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.m4v': { mime: 'video/mp4', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
  '.mkv': { mime: 'video/x-matroska', kind: 'video' },
  '.avi': { mime: 'video/x-msvideo', kind: 'video' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
  '.wav': { mime: 'audio/wav', kind: 'audio' },
  '.m4a': { mime: 'audio/mp4', kind: 'audio' },
  '.aac': { mime: 'audio/aac', kind: 'audio' },
  '.ogg': { mime: 'audio/ogg', kind: 'audio' },
  '.opus': { mime: 'audio/opus', kind: 'audio' },
  '.flac': { mime: 'audio/flac', kind: 'audio' },
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.bmp': { mime: 'image/bmp', kind: 'image' },
  '.avif': { mime: 'image/avif', kind: 'image' },
  '.ttf': { mime: 'font/ttf', kind: 'font' },
  '.otf': { mime: 'font/otf', kind: 'font' },
  '.woff2': { mime: 'font/woff2', kind: 'font' },
};

export function inferMediaKindAndMime(
  filename: string,
  providedMime?: string,
): { mime: string; kind: VideoAssetInfo['kind'] } {
  const ext = extname(filename).toLowerCase();
  const byExt = MIME_BY_EXT[ext];
  if (byExt) return { mime: providedMime || byExt.mime, kind: byExt.kind };
  if (providedMime) {
    if (providedMime.startsWith('video/')) return { mime: providedMime, kind: 'video' };
    if (providedMime.startsWith('audio/')) return { mime: providedMime, kind: 'audio' };
    if (providedMime.startsWith('image/')) return { mime: providedMime, kind: 'image' };
    if (providedMime.startsWith('font/')) return { mime: providedMime, kind: 'font' };
  }
  return { mime: providedMime || 'application/octet-stream', kind: 'video' };
}

function fpsToRational(fps: number): Rational {
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
    throw new AppError('video.invalid_operation', '帧率必须在 (0, 240] 之间');
  }
  if (Math.abs(fps - 23.976) < 0.01) return { numerator: 24_000, denominator: 1_001 };
  if (Math.abs(fps - 29.97) < 0.01) return { numerator: 30_000, denominator: 1_001 };
  if (Math.abs(fps - 59.94) < 0.01) return { numerator: 60_000, denominator: 1_001 };
  return normalizeRational({ numerator: Math.round(fps * 1000), denominator: 1000 });
}

function rateToRational(rate: number): Rational {
  if (!Number.isFinite(rate) || rate <= 0.05 || rate > 16) {
    throw new AppError('video.invalid_operation', '播放倍率必须在 0.05–16 之间');
  }
  return normalizeRational({ numerator: Math.max(1, Math.round(rate * 10_000)), denominator: 10_000 });
}

function asObj(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asNum(value: unknown, fallback?: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeIntUs(value: number, label: string, min = 0): number {
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded < min) {
    throw new AppError('video.invalid_operation', `${label} 必须是 >= ${min} 的有效微秒数`);
  }
  return rounded;
}

const VALID_BLEND_MODES = new Set([
  'normal',
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

function makeDefaultVisual(
  width: number,
  height: number,
  style?: Partial<VideoClipStyle>,
  defaultFit = 'contain',
): JsonObject {
  const fit = style?.fit ?? defaultFit;
  const opacity = style?.opacity !== undefined ? Math.max(0, Math.min(1, style.opacity)) : 1;
  const blendMode = style?.blendMode && VALID_BLEND_MODES.has(style.blendMode) ? style.blendMode : 'normal';
  return {
    fit,
    transform: {
      positionPx: style?.positionPx
        ? { x: style.positionPx.x, y: style.positionPx.y }
        : { x: width / 2, y: height / 2 },
      anchor: style?.anchor ? { x: style.anchor.x, y: style.anchor.y } : { x: 0.5, y: 0.5 },
      scale: style?.scale ? { x: style.scale.x, y: style.scale.y } : { x: 1, y: 1 },
      rotationDeg: style?.rotationDeg ?? 0,
      skewDeg: { x: 0, y: 0 },
    },
    crop: {
      left: Math.max(0, Math.min(1, style?.crop?.left ?? 0)),
      top: Math.max(0, Math.min(1, style?.crop?.top ?? 0)),
      right: Math.max(0, Math.min(1, style?.crop?.right ?? 0)),
      bottom: Math.max(0, Math.min(1, style?.crop?.bottom ?? 0)),
    },
    opacity,
    blendMode,
  };
}

function toSdkTextStyle(style?: Partial<VideoTextStyle>, isCaption = false): JsonObject {
  const base: JsonObject = isCaption
    ? {
        fontFamilies: ['sans-serif'],
        fontSizePx: 42,
        fontWeight: 600,
        fill: '#ffffff',
        stroke: '#000000',
        strokeWidthPx: 2,
        align: 'center',
      }
    : {
        fontFamilies: ['sans-serif'],
        fontSizePx: 56,
        fontWeight: 700,
        fill: '#ffffff',
        align: 'center',
      };
  if (!style) return base;
  const out: JsonObject = { ...base };
  if (style.fontFamily !== undefined) out.fontFamilies = [style.fontFamily];
  if (style.fontSizePx !== undefined) out.fontSizePx = style.fontSizePx;
  if (style.fontWeight !== undefined) out.fontWeight = style.fontWeight;
  if (style.fontStyle !== undefined) out.fontStyle = style.fontStyle;
  if (style.fill !== undefined) out.fill = style.fill;
  if (style.stroke !== undefined) out.stroke = style.stroke;
  if (style.strokeWidthPx !== undefined) out.strokeWidthPx = style.strokeWidthPx;
  if (style.align !== undefined) out.align = style.align;
  if (style.backgroundFill !== undefined) out.backgroundFill = style.backgroundFill;
  if (style.backgroundOpacity !== undefined) out.backgroundOpacity = style.backgroundOpacity;
  if (style.backgroundPaddingPx !== undefined) out.backgroundPaddingPx = style.backgroundPaddingPx;
  if (style.backgroundRadiusPx !== undefined) out.backgroundRadiusPx = style.backgroundRadiusPx;
  if (style.lineHeightPx !== undefined) out.lineHeightPx = style.lineHeightPx;
  if (style.letterSpacingPx !== undefined) out.letterSpacingPx = style.letterSpacingPx;
  return out;
}

function fromSdkTextStyle(raw: JsonObject | undefined): VideoTextStyle | undefined {
  if (!raw) return undefined;
  const families = Array.isArray(raw.fontFamilies) ? raw.fontFamilies : undefined;
  const style: VideoTextStyle = {};
  if (typeof families?.[0] === 'string') style.fontFamily = families[0];
  if (typeof raw.fontSizePx === 'number') style.fontSizePx = raw.fontSizePx;
  if (typeof raw.fontWeight === 'number') style.fontWeight = raw.fontWeight;
  if (raw.fontStyle === 'normal' || raw.fontStyle === 'italic') style.fontStyle = raw.fontStyle;
  if (typeof raw.fill === 'string') style.fill = raw.fill;
  if (typeof raw.stroke === 'string') style.stroke = raw.stroke;
  if (typeof raw.strokeWidthPx === 'number') style.strokeWidthPx = raw.strokeWidthPx;
  if (raw.align === 'start' || raw.align === 'center' || raw.align === 'end') style.align = raw.align;
  if (typeof raw.backgroundFill === 'string') style.backgroundFill = raw.backgroundFill;
  if (typeof raw.backgroundOpacity === 'number') style.backgroundOpacity = raw.backgroundOpacity;
  if (typeof raw.backgroundPaddingPx === 'number') style.backgroundPaddingPx = raw.backgroundPaddingPx;
  if (typeof raw.backgroundRadiusPx === 'number') style.backgroundRadiusPx = raw.backgroundRadiusPx;
  if (typeof raw.lineHeightPx === 'number') style.lineHeightPx = raw.lineHeightPx;
  if (typeof raw.letterSpacingPx === 'number') style.letterSpacingPx = raw.letterSpacingPx;
  return style;
}

function extractClipStyle(visual: JsonObject | undefined): VideoClipStyle | undefined {
  if (!visual) return undefined;
  const transform = asObj(visual.transform);
  const pos = asObj(transform?.positionPx);
  const anchor = asObj(transform?.anchor);
  const scale = asObj(transform?.scale);
  const crop = asObj(visual.crop);
  const style: VideoClipStyle = {};
  if (visual.fit === 'contain' || visual.fit === 'cover' || visual.fit === 'fill' || visual.fit === 'none') {
    style.fit = visual.fit;
  }
  const opacity = asNum(visual.opacity);
  if (opacity !== undefined) style.opacity = opacity;
  if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') style.positionPx = { x: pos.x, y: pos.y };
  if (anchor && typeof anchor.x === 'number' && typeof anchor.y === 'number') {
    style.anchor = { x: anchor.x, y: anchor.y };
  }
  if (scale && typeof scale.x === 'number' && typeof scale.y === 'number') style.scale = { x: scale.x, y: scale.y };
  const rotationDeg = asNum(transform?.rotationDeg);
  if (rotationDeg !== undefined) style.rotationDeg = rotationDeg;
  if (crop && typeof crop.left === 'number') {
    style.crop = {
      left: asNum(crop.left, 0),
      top: asNum(crop.top, 0),
      right: asNum(crop.right, 0),
      bottom: asNum(crop.bottom, 0),
    };
  }
  if (typeof visual.blendMode === 'string') style.blendMode = visual.blendMode;
  return style;
}

function computeProjectDurationUs(project: Readonly<AelionProject>): number {
  let maxEnd = 0;
  for (const item of Object.values(project.items)) {
    if (!item.enabled) continue;
    maxEnd = Math.max(maxEnd, item.range.startUs + item.range.durationUs);
  }
  return maxEnd;
}

function defaultBox(width: number, height: number, role: 'text' | 'caption'): VideoTextBox {
  if (role === 'caption') {
    return {
      x: Math.round(width * 0.08),
      y: Math.round(height * 0.76),
      width: Math.round(width * 0.84),
      height: Math.round(height * 0.18),
    };
  }
  return {
    x: Math.round(width * 0.1),
    y: Math.round(height * 0.12),
    width: Math.round(width * 0.8),
    height: Math.round(height * 0.24),
  };
}

function findUnusedEntityId(project: Readonly<AelionProject>, prefix: string): string {
  for (;;) {
    const id = makeEntityId(prefix);
    if (
      !project.assets[id] &&
      !project.sequences[id] &&
      !project.tracks[id] &&
      !project.items[id] &&
      !project.materialInstances[id] &&
      !project.transitions[id] &&
      !project.markers[id] &&
      !project.linkGroups[id]
    ) {
      return id;
    }
  }
}

function assertUnusedEntityId(project: Readonly<AelionProject>, id: string): void {
  if (
    project.assets[id] ||
    project.sequences[id] ||
    project.tracks[id] ||
    project.items[id] ||
    project.materialInstances[id] ||
    project.transitions[id] ||
    project.markers[id] ||
    project.linkGroups[id]
  ) {
    throw new AppError('video.invalid_operation', `实体 ID 已被占用：${id}`);
  }
}

export class VideoProjects {
  private readonly loaded = new Map<string, LoadedProject>();
  private readonly validator: ProjectValidator;

  constructor(private readonly deps: VideoProjectsDeps) {
    this.validator = new ProjectValidator({
      projectSchema: defaultSchemas.project,
      materialInstanceSchema: defaultSchemas.materialInstance,
    });
  }

  private videosRoot(): string {
    const root = join(this.deps.workspaceRoot(), 'videos');
    mkdirSync(root, { recursive: true });
    return root;
  }

  private projectDirFor(botId: string | undefined, projectId: string): string {
    const botSeg = botId ? assertSafeDirSegment(botId) : GLOBAL_BOT_DIR;
    const projSeg = assertSafeDirSegment(projectId);
    return join(this.videosRoot(), botSeg, projSeg);
  }

  private findProjectDir(projectId: string): string | undefined {
    let safeId: string;
    try {
      safeId = assertSafeDirSegment(projectId);
    } catch {
      return undefined;
    }
    const existing = this.loaded.get(safeId);
    if (existing && existsSync(join(existing.dir, 'project.json'))) return existing.dir;
    const root = this.videosRoot();
    if (!existsSync(root)) return undefined;
    for (const botEntry of readdirSync(root, { withFileTypes: true })) {
      if (!botEntry.isDirectory()) continue;
      const botRoot = resolve(root, botEntry.name);
      const candidate = resolve(botRoot, safeId);
      if (!candidate.startsWith(botRoot + sep)) continue;
      if (existsSync(join(candidate, 'project.json')) && existsSync(join(candidate, 'meta.json'))) {
        return candidate;
      }
    }
    return undefined;
  }

  private currentRevision(entry: LoadedProject): string {
    return (entry.revisionOffset + entry.history.revision).toString();
  }

  private load(projectId: string): LoadedProject {
    const cached = this.loaded.get(projectId);
    if (cached) return cached;
    const dir = this.findProjectDir(projectId);
    if (!dir) throw new AppError('video.project_not_found', `未找到视频项目：${projectId}`);
    const rawProject = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as AelionProject;
    const rawMeta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as ProjectMeta;
    const revisionOffset = /^\d+$/.test(rawMeta.revision || '') ? BigInt(rawMeta.revision) : 1n;
    const engine = new TransactionEngine(rawProject, (candidate) => this.validator.validate(candidate));
    const history = new TransactionHistory(engine, { maxEntries: 100 });
    const entry: LoadedProject = { dir, meta: rawMeta, engine, history, revisionOffset };
    this.loaded.set(projectId, entry);
    return entry;
  }

  private persist(entry: LoadedProject): void {
    entry.meta.revision = this.currentRevision(entry);
    entry.meta.updatedAt = new Date().toISOString();
    writeAtomicJson(join(entry.dir, 'project.json'), entry.history.getSnapshot());
    writeAtomicJson(join(entry.dir, 'meta.json'), entry.meta);
  }

  assetUrl(projectId: string, assetId: string): string {
    return `${VIDEO_ENGINE_SCHEME}://asset/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}`;
  }

  projectDir(projectId: string): string {
    return this.load(projectId).dir;
  }

  exportsDir(projectId: string): string {
    const dir = join(this.load(projectId).dir, 'exports');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  cacheDir(projectId: string): string {
    const dir = join(this.load(projectId).dir, 'cache');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  resolveAssetPath(projectId: string, assetId: string): { path: string; mimeType: string; name: string } {
    const entry = this.load(projectId);
    const meta = entry.meta.assets[assetId];
    if (!meta) throw new AppError('video.asset_not_found', `未找到素材：${assetId}`);
    const assetsRoot = resolve(entry.dir, 'assets');
    const fullPath = resolve(assetsRoot, meta.filename);
    if (!fullPath.startsWith(assetsRoot + sep) || !existsSync(fullPath)) {
      throw new AppError('video.asset_not_found', `素材文件缺失：${assetId}`);
    }
    return { path: fullPath, mimeType: meta.mimeType, name: meta.name };
  }

  readProjectJson(projectId: string): {
    project: AelionProject;
    revision: string;
    assets: Record<
      string,
      {
        url: string;
        kind: VideoAssetInfo['kind'];
        name: string;
        mime: string;
        width?: number;
        height?: number;
        durationUs?: number;
      }
    >;
  } {
    const entry = this.load(projectId);
    const project = structuredClone(entry.history.getSnapshot()) as AelionProject;
    const assets: Record<
      string,
      {
        url: string;
        kind: VideoAssetInfo['kind'];
        name: string;
        mime: string;
        width?: number;
        height?: number;
        durationUs?: number;
      }
    > = {};
    for (const [assetId, meta] of Object.entries(entry.meta.assets)) {
      assets[assetId] = {
        url: this.assetUrl(projectId, assetId),
        kind: meta.kind,
        name: meta.name,
        mime: meta.mimeType,
        ...(meta.probe?.width !== undefined ? { width: meta.probe.width } : {}),
        ...(meta.probe?.height !== undefined ? { height: meta.probe.height } : {}),
        ...(meta.probe?.durationUs !== undefined ? { durationUs: meta.probe.durationUs } : {}),
      };
    }
    return { project, revision: this.currentRevision(entry), assets };
  }

  list(filter?: { botId?: string; sessionId?: string }): VideoProjectSummary[] {
    const root = this.videosRoot();
    if (!existsSync(root)) return [];
    const results: VideoProjectSummary[] = [];
    for (const botEntry of readdirSync(root, { withFileTypes: true })) {
      if (!botEntry.isDirectory()) continue;
      if (filter?.botId && botEntry.name !== filter.botId) continue;
      const botDir = join(root, botEntry.name);
      for (const projEntry of readdirSync(botDir, { withFileTypes: true })) {
        if (!projEntry.isDirectory()) continue;
        const metaFile = join(botDir, projEntry.name, 'meta.json');
        const projectFile = join(botDir, projEntry.name, 'project.json');
        if (!existsSync(metaFile) || !existsSync(projectFile)) continue;
        try {
          const loaded = this.load(projEntry.name);
          if (filter?.botId && loaded.meta.botId !== filter.botId) continue;
          if (filter?.sessionId && loaded.meta.sessionId !== filter.sessionId) continue;
          results.push(this.toSummary(loaded));
        } catch {
          // Skip corrupted folders rather than breaking listing
        }
      }
    }
    results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return results;
  }

  get(projectId: string): VideoProjectDetail {
    return this.toDetail(this.load(projectId));
  }

  inspect(projectId: string): VideoProjectDetail {
    return this.get(projectId);
  }

  create(input: VideoProjectCreateInput = {}): VideoProjectDetail {
    const aspect: VideoAspectPreset = input.aspect ?? '16:9';
    const presetDim = aspect === 'custom' ? { width: 1920, height: 1080 } : VIDEO_ASPECT_DIMENSIONS[aspect];
    const width = Math.max(16, Math.min(8192, Math.round(input.width ?? presetDim.width)));
    const height = Math.max(16, Math.min(8192, Math.round(input.height ?? presetDim.height)));
    const fps = input.fps ?? 30;
    const frameRate = fpsToRational(fps);
    const sampleRate = input.sampleRate ?? 48_000;
    const title = (input.title?.trim() || 'Untitled Video').slice(0, 200);
    const projectId = makeEntityId('proj');
    const sequenceId = 'seq_main';

    const builder = createProject({
      projectId,
      sequenceId,
      title,
      width,
      height,
      frameRate,
      sampleRate,
      backgroundColor: input.backgroundColor ?? '#000000',
    });

    // Standard track layout: bottom-to-top visual order + captions + voice/bgm audio
    builder.addTrack({
      id: STANDARD_TRACK_IDS.videoMain,
      kind: 'visual',
      name: 'Main Video',
      role: 'storyline',
      occupancy: 'exclusive',
    });
    builder.addTrack({
      id: STANDARD_TRACK_IDS.videoOverlay,
      kind: 'visual',
      name: 'Overlay',
      role: 'overlay',
      occupancy: 'free',
    });
    builder.addTrack({
      id: STANDARD_TRACK_IDS.captions,
      kind: 'caption',
      name: 'Captions',
      role: 'overlay',
      occupancy: 'free',
    });
    builder.addTrack({
      id: STANDARD_TRACK_IDS.audioVoice,
      kind: 'audio',
      name: 'Voiceover',
      role: 'overlay',
      occupancy: 'free',
    });
    builder.addTrack({
      id: STANDARD_TRACK_IDS.audioBgm,
      kind: 'audio',
      name: 'Background Music',
      role: 'overlay',
      occupancy: 'free',
    });

    const project = builder.build();
    const dir = this.projectDirFor(input.botId, projectId);
    mkdirSync(join(dir, 'assets'), { recursive: true });
    mkdirSync(join(dir, 'exports'), { recursive: true });
    mkdirSync(join(dir, 'cache'), { recursive: true });

    const now = new Date().toISOString();
    const engine = new TransactionEngine(project, (candidate) => this.validator.validate(candidate), {
      adoptValidatedProject: true,
    });
    const history = new TransactionHistory(engine, { maxEntries: 100 });
    const revisionOffset = 1n;
    const meta: ProjectMeta = {
      id: projectId,
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      title,
      aspect,
      createdAt: now,
      updatedAt: now,
      revision: (revisionOffset + history.revision).toString(),
      assets: {},
    };

    const loaded: LoadedProject = { dir, meta, engine, history, revisionOffset };
    this.loaded.set(projectId, loaded);
    this.persist(loaded);
    return this.toDetail(loaded);
  }

  delete(projectId: string): void {
    const dir = this.findProjectDir(projectId);
    this.loaded.delete(projectId);
    if (!dir) throw new AppError('video.project_not_found', `未找到视频项目：${projectId}`);
    rmSync(dir, { recursive: true, force: true });
  }

  async importAsset(
    input: VideoAssetImportExtendedInput,
    probe?: VideoMediaProbe,
  ): Promise<{ asset: VideoAssetInfo; project: VideoProjectDetail; deduplicated: boolean }> {
    const entry = this.load(input.projectId);
    const snapshot = entry.history.getSnapshot();
    const seq = snapshot.sequences[snapshot.settings.defaultSequenceId]!;
    const canvasWidth = seq.format.width;
    const canvasHeight = seq.format.height;

    let bytes: Buffer | undefined;
    let hostCopyPath: string | undefined;
    let sourceName: string;
    let sourceMime: string | undefined;
    let sourcePath: string | undefined;
    let attachmentId: string | undefined;
    let artifactId: string | undefined;

    const src = input.source;
    if (src.kind === 'host') {
      const full = this.deps.resolveHostPath ? this.deps.resolveHostPath(src.path) : resolve(src.path);
      if (!existsSync(full)) throw new AppError('video.asset_not_found', `文件不存在：${src.path}`);
      const st = statSync(full);
      if (!st.isFile()) throw new AppError('video.invalid_operation', `路径不是文件：${src.path}`);
      if (st.size > MAX_IMPORT_BYTES) throw new AppError('video.invalid_operation', '文件超过 4 GiB 上限');
      const ext = extname(full).toLowerCase();
      if ((ext === '.html' || ext === '.htm') && this.deps.renderDesignPageToPng) {
        const rendered = await this.deps.renderDesignPageToPng({
          botId: entry.meta.botId,
          path: full,
          width: canvasWidth,
          height: canvasHeight,
          allowHostFile: true,
        });
        bytes = rendered.bytes;
        sourceName = input.name?.trim() || `${basename(full, ext)}.png`;
        sourceMime = 'image/png';
      } else {
        hostCopyPath = full;
        sourceName = input.name?.trim() || basename(full);
      }
      sourcePath = full;
    } else if (src.kind === 'workspace' || src.kind === 'artifact') {
      if (!this.deps.readWorkspaceFile) {
        throw new AppError('video.invalid_operation', '工作区文件服务尚未就绪');
      }
      const ext = extname(src.path).toLowerCase();
      if ((ext === '.html' || ext === '.htm') && this.deps.renderDesignPageToPng) {
        const rendered = await this.deps.renderDesignPageToPng({
          botId: src.botId,
          path: src.path,
          width: canvasWidth,
          height: canvasHeight,
        });
        bytes = rendered.bytes;
        sourceName = input.name?.trim() || rendered.name || `${basename(src.path, ext)}.png`;
        sourceMime = 'image/png';
        sourcePath = src.path;
        if (src.kind === 'artifact') artifactId = `${src.botId}:${src.path}`;
      } else {
        const file = await this.deps.readWorkspaceFile(src.botId, src.path);
        bytes = file.bytes;
        sourceName = input.name?.trim() || file.name;
        sourcePath = file.resolvedPath || src.path;
        if (src.kind === 'artifact') artifactId = `${src.botId}:${src.path}`;
      }
    } else if (src.kind === 'attachment') {
      if (!this.deps.readAttachment) {
        throw new AppError('video.invalid_operation', '附件服务尚未就绪');
      }
      const att = this.deps.readAttachment(src.attachmentId);
      bytes = att.bytes;
      sourceName = input.name?.trim() || att.name;
      sourceMime = att.mime;
      attachmentId = src.attachmentId;
    } else if (src.kind === 'design') {
      if (!this.deps.renderDesignPageToPng) {
        throw new AppError('video.invalid_operation', '设计稿渲染服务尚未就绪');
      }
      const rendered = await this.deps.renderDesignPageToPng({
        botId: src.botId ?? entry.meta.botId,
        sessionId: src.sessionId,
        path: src.path,
        width: src.width ?? canvasWidth,
        height: src.height ?? canvasHeight,
      });
      bytes = rendered.bytes;
      const ext = extname(src.path);
      sourceName = input.name?.trim() || rendered.name || `${basename(src.path, ext)}.png`;
      sourceMime = 'image/png';
      sourcePath = src.path;
    } else {
      throw new AppError('video.invalid_operation', '不支持的素材来源');
    }

    const { mime, kind } = inferMediaKindAndMime(sourceName, sourceMime);
    let sha256: string;
    let byteLength: number;
    if (hostCopyPath) {
      const info = await sha256File(hostCopyPath);
      sha256 = info.hash;
      byteLength = info.size;
    } else if (bytes) {
      sha256 = sha256Buffer(bytes);
      byteLength = bytes.byteLength;
    } else {
      throw new AppError('video.invalid_operation', '无法读取素材内容');
    }

    // Deduplicate by sha256 unless caller requested a distinct explicit assetId that does not match
    const existingMeta = Object.values(entry.meta.assets).find(
      (item) => item.sha256 === sha256 && (!input.assetId || item.id === input.assetId),
    );
    if (existingMeta && entry.history.getSnapshot().assets[existingMeta.id]) {
      if (probe) this.updateAssetProbe(input.projectId, existingMeta.id, probe);
      const refreshed = this.load(input.projectId);
      const detail = this.toDetail(refreshed);
      const assetInfo = detail.assets.find((a) => a.id === existingMeta.id)!;
      return { asset: assetInfo, project: detail, deduplicated: true };
    }

    const requestedId = input.assetId
      ? sanitizeEntityId(input.assetId, 'asset')
      : findUnusedEntityId(snapshot, 'asset');
    assertUnusedEntityId(snapshot, requestedId);

    const rawExt = extname(sourceName).toLowerCase();
    const ext = /^\.[a-z0-9]{1,10}$/.test(rawExt)
      ? rawExt
      : kind === 'image'
        ? '.png'
        : kind === 'audio'
          ? '.wav'
          : '.mp4';
    const safeStem = requestedId.replace(/[^A-Za-z0-9_-]/g, '_');
    const filename = `${safeStem}${ext}`;
    const assetsRoot = resolve(entry.dir, 'assets');
    const destPath = resolve(assetsRoot, filename);
    if (!destPath.startsWith(assetsRoot + sep)) {
      throw new AppError('video.invalid_operation', '非法的素材文件名');
    }
    mkdirSync(assetsRoot, { recursive: true });
    if (hostCopyPath) {
      copyFileSync(hostCopyPath, destPath);
    } else if (bytes) {
      writeFileSync(destPath, bytes);
    }

    const probeHint = buildProbeHint(probe);
    const assetEntity: JsonObject = {
      id: requestedId,
      kind,
      name: sourceName.slice(0, 256),
      locator: { type: 'url', uri: this.assetUrl(input.projectId, requestedId) },
      mimeType: mime,
      contentHash: { algorithm: 'sha256', value: sha256 },
      byteLength,
      ...(probeHint ? { probeHint } : {}),
    };

    entry.history.edit({ label: `Import asset ${sourceName}` }, (tx) => {
      tx.createEntity('assets', requestedId, assetEntity);
    });

    entry.meta.assets[requestedId] = {
      id: requestedId,
      filename,
      sha256,
      kind,
      name: sourceName,
      mimeType: mime,
      byteLength,
      ...(sourcePath ? { sourcePath } : {}),
      ...(attachmentId ? { attachmentId } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(probe ? { probe } : {}),
    };
    if (!entry.meta.posterDataUrl && probe?.posterDataUrl) {
      entry.meta.posterDataUrl = probe.posterDataUrl;
    }
    this.persist(entry);

    const detail = this.toDetail(entry);
    const assetInfo = detail.assets.find((a) => a.id === requestedId)!;
    return { asset: assetInfo, project: detail, deduplicated: false };
  }

  updateAssetProbe(projectId: string, assetId: string, probe: VideoMediaProbe): VideoProjectDetail {
    const entry = this.load(projectId);
    const meta = entry.meta.assets[assetId];
    if (!meta) throw new AppError('video.asset_not_found', `未找到素材：${assetId}`);
    meta.probe = { ...(meta.probe ?? { durationUs: 0, hasAudio: false }), ...probe };
    if (!entry.meta.posterDataUrl && probe.posterDataUrl) {
      entry.meta.posterDataUrl = probe.posterDataUrl;
    }
    const probeHint = buildProbeHint(meta.probe);
    if (probeHint && entry.history.getSnapshot().assets[assetId]) {
      entry.history.edit({ label: `Update probe for ${assetId}` }, (tx) => {
        tx.setField('assets', assetId, ['probeHint'], probeHint);
      });
    }
    this.persist(entry);
    return this.toDetail(entry);
  }

  setProjectPoster(projectId: string, posterDataUrl: string): void {
    const entry = this.load(projectId);
    entry.meta.posterDataUrl = posterDataUrl;
    this.persist(entry);
  }

  getAssetProbe(projectId: string, assetId: string): VideoMediaProbe | undefined {
    const entry = this.load(projectId);
    return entry.meta.assets[assetId]?.probe;
  }

  edit(request: VideoEditRequest): VideoEditResult {
    const entry = this.load(request.projectId);
    if (request.expectedRevision !== undefined && this.currentRevision(entry) !== String(request.expectedRevision)) {
      throw new AppError(
        'video.revision_conflict',
        `项目版本冲突：期望 ${request.expectedRevision}，当前为 ${this.currentRevision(entry)}`,
      );
    }
    if (!Array.isArray(request.operations) || request.operations.length === 0) {
      throw new AppError('video.invalid_operation', 'operations 不能为空');
    }

    const warnings: string[] = [];
    let applied = 0;

    // Partition runs of undo/redo vs regular atomic edits so a batch of regular ops becomes ONE undo step.
    let idx = 0;
    while (idx < request.operations.length) {
      const current = request.operations[idx]!;
      if (current.op === 'undo') {
        try {
          entry.history.undo();
          applied += 1;
        } catch (error) {
          throw new AppError('video.invalid_operation', `无法撤销：${(error as Error).message}`);
        }
        idx += 1;
        continue;
      }
      if (current.op === 'redo') {
        try {
          entry.history.redo();
          applied += 1;
        } catch (error) {
          throw new AppError('video.invalid_operation', `无法重做：${(error as Error).message}`);
        }
        idx += 1;
        continue;
      }

      const batch: VideoEditOperation[] = [];
      while (idx < request.operations.length) {
        const nextOp = request.operations[idx]!;
        if (nextOp.op === 'undo' || nextOp.op === 'redo') break;
        batch.push(nextOp);
        idx += 1;
      }

      const label =
        request.historyLabel || (batch.length === 1 ? `video:${batch[0]!.op}` : `video:batch(${batch.length})`);

      try {
        entry.history.edit({ label }, (tx) => {
          const draft = structuredClone(entry.history.getSnapshot()) as AelionProject;
          for (const op of batch) {
            this.applyOperationToDraft(draft, tx, entry.meta, op, warnings);
            applied += 1;
          }
        });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('video.invalid_operation', (error as Error).message);
      }
    }

    this.persist(entry);
    const detail = this.toDetail(entry);
    return {
      project: detail,
      revision: this.currentRevision(entry),
      applied,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  private applyOperationToDraft(
    draft: AelionProject,
    tx: TransactionBuilder,
    meta: ProjectMeta,
    op: VideoEditOperation,
    warnings: string[],
  ): void {
    const seqId = draft.settings.defaultSequenceId;
    const seq = draft.sequences[seqId]!;
    const canvasWidth = seq.format.width;
    const canvasHeight = seq.format.height;

    const ensureTrack = (requestedId: string | undefined, kind: VideoTrackKind): TrackEntity => {
      if (requestedId) {
        const found = draft.tracks[requestedId];
        if (!found) throw new AppError('video.invalid_operation', `轨道不存在：${requestedId}`);
        if (found.kind !== kind) {
          throw new AppError('video.invalid_operation', `轨道 ${requestedId} 类型不匹配，期望 ${kind}`);
        }
        if (found.locked) throw new AppError('video.invalid_operation', `轨道已锁定：${requestedId}`);
        return found;
      }
      const preferredId =
        kind === 'visual'
          ? STANDARD_TRACK_IDS.videoMain
          : kind === 'caption'
            ? STANDARD_TRACK_IDS.captions
            : STANDARD_TRACK_IDS.audioVoice;
      const preferred = draft.tracks[preferredId];
      if (preferred && preferred.kind === kind && !preferred.locked) return preferred;
      const anyTrack = Object.values(draft.tracks).find((t) => t.kind === kind && !t.locked);
      if (anyTrack) return anyTrack;
      const newId = findUnusedEntityId(draft, `track_${kind}`);
      const track: TrackEntity = {
        id: newId,
        sequenceId: seqId,
        kind,
        name: kind === 'visual' ? 'Video' : kind === 'caption' ? 'Captions' : 'Audio',
        role: 'overlay',
        occupancy: 'free',
        enabled: true,
        locked: false,
        itemIds: [],
        materialInstanceIds: [],
        ...(kind === 'audio' ? { audio: { gainDb: 0, pan: 0, muted: false, solo: false } } : {}),
      };
      draft.tracks[newId] = track;
      seq.trackIds.push(newId);
      tx.createEntity('tracks', newId, track as unknown as JsonObject);
      tx.listInsert('sequences', seqId, ['trackIds'], newId);
      return track;
    };

    const trackEndUs = (track: TrackEntity): number => {
      let end = 0;
      for (const id of track.itemIds) {
        const it = draft.items[id];
        if (it) end = Math.max(end, it.range.startUs + it.range.durationUs);
      }
      return end;
    };

    const deleteItemCascade = (itemId: string) => {
      const item = draft.items[itemId];
      if (!item) return;
      const track = draft.tracks[item.trackId];
      for (const transition of Object.values(draft.transitions)) {
        if (transition.fromItemId === itemId || transition.toItemId === itemId) {
          seq.transitionIds = seq.transitionIds.filter((id) => id !== transition.id);
          delete draft.transitions[transition.id];
          delete draft.materialInstances[transition.materialInstanceId];
          tx.listRemove('sequences', transition.sequenceId, ['transitionIds'], transition.id);
          tx.deleteEntity('transitions', transition.id);
          tx.deleteEntity('materialInstances', transition.materialInstanceId);
        }
      }
      const markerIds = new Set<string>(item.markerIds ?? []);
      for (const marker of Object.values(draft.markers)) {
        if (marker.owner.type === 'item' && marker.owner.id === itemId) markerIds.add(marker.id);
      }
      for (const markerId of markerIds) {
        if (seq.markerIds.includes(markerId)) {
          seq.markerIds = seq.markerIds.filter((id) => id !== markerId);
          tx.listRemove('sequences', seqId, ['markerIds'], markerId);
        }
        if (draft.markers[markerId]) {
          delete draft.markers[markerId];
          tx.deleteEntity('markers', markerId);
        }
      }
      if (item.linkGroupId) {
        const group = draft.linkGroups[item.linkGroupId];
        if (group) {
          const remaining = group.itemIds.filter((id) => id !== itemId);
          if (remaining.length < 2) {
            for (const remId of remaining) {
              if (draft.items[remId]?.linkGroupId === group.id) {
                delete draft.items[remId]!.linkGroupId;
                tx.removeField('items', remId, ['linkGroupId']);
              }
            }
            delete draft.linkGroups[group.id];
            tx.deleteEntity('linkGroups', group.id);
          } else {
            group.itemIds = remaining;
            tx.listRemove('linkGroups', group.id, ['itemIds'], itemId);
            if (group.syncOffsetsUs && Object.hasOwn(group.syncOffsetsUs, itemId)) {
              delete group.syncOffsetsUs[itemId];
              tx.removeField('linkGroups', group.id, ['syncOffsetsUs', itemId]);
            }
          }
        }
      }
      if (track) {
        track.itemIds = track.itemIds.filter((id) => id !== itemId);
        tx.listRemove('tracks', track.id, ['itemIds'], itemId);
      }
      delete draft.items[itemId];
      tx.deleteEntity('items', itemId);
      for (const matId of item.materialInstanceIds) {
        if (draft.materialInstances[matId]) {
          delete draft.materialInstances[matId];
          tx.deleteEntity('materialInstances', matId);
        }
      }
    };

    const rebindTransitionsForItem = (itemId: string) => {
      for (const tr of Object.values(draft.transitions)) {
        if (tr.fromItemId !== itemId && tr.toItemId !== itemId) continue;
        const from = draft.items[tr.fromItemId];
        const to = draft.items[tr.toItemId];
        if (!from || !to || from.trackId !== to.trackId) {
          seq.transitionIds = seq.transitionIds.filter((id) => id !== tr.id);
          delete draft.transitions[tr.id];
          delete draft.materialInstances[tr.materialInstanceId];
          tx.listRemove('sequences', tr.sequenceId, ['transitionIds'], tr.id);
          tx.deleteEntity('transitions', tr.id);
          tx.deleteEntity('materialInstances', tr.materialInstanceId);
          continue;
        }
        const earlier = from.range.startUs <= to.range.startUs ? from : to;
        const later = earlier === from ? to : from;
        const earlierEnd = earlier.range.startUs + earlier.range.durationUs;
        const overlapStart = Math.max(earlier.range.startUs, later.range.startUs);
        const overlapEnd = Math.min(earlierEnd, later.range.startUs + later.range.durationUs);
        const cutUs = overlapEnd > overlapStart ? Math.round((overlapStart + overlapEnd) / 2) : earlierEnd;
        const maxDur = Math.max(1, Math.min(earlier.range.durationUs, later.range.durationUs));
        const durUs = Math.min(tr.range.durationUs, maxDur);
        const nextStartUs = Math.max(0, cutUs - Math.floor(durUs / 2));
        if (tr.fromItemId !== earlier.id) {
          tr.fromItemId = earlier.id;
          tx.setField('transitions', tr.id, ['fromItemId'], earlier.id);
        }
        if (tr.toItemId !== later.id) {
          tr.toItemId = later.id;
          tx.setField('transitions', tr.id, ['toItemId'], later.id);
        }
        if (tr.trackId !== earlier.trackId) {
          tr.trackId = earlier.trackId;
          tx.setField('transitions', tr.id, ['trackId'], earlier.trackId);
        }
        if (tr.range.startUs !== nextStartUs || tr.range.durationUs !== durUs) {
          tr.range = { startUs: nextStartUs, durationUs: durUs };
          tx.setField('transitions', tr.id, ['range'], { startUs: nextStartUs, durationUs: durUs });
        }
      }
    };

    switch (op.op) {
      case 'add_clip': {
        const asset = draft.assets[op.assetId];
        if (!asset) throw new AppError('video.asset_not_found', `未找到素材：${op.assetId}`);
        const assetKind = String(asset.kind);
        const kind: 'video' | 'audio' | 'image' =
          op.kind ?? (assetKind === 'audio' ? 'audio' : assetKind === 'image' ? 'image' : 'video');
        const trackKind: VideoTrackKind = op.trackKind ?? (kind === 'audio' ? 'audio' : 'visual');
        if (kind === 'audio' && trackKind !== 'audio') {
          throw new AppError('video.invalid_operation', '音频片段必须放在音频轨道上');
        }
        if (kind !== 'audio' && trackKind !== 'visual') {
          throw new AppError('video.invalid_operation', '视频/图片片段必须放在视觉轨道上');
        }
        const track = ensureTrack(op.trackId, trackKind);
        const clipId = op.clipId ? sanitizeEntityId(op.clipId, 'clip') : findUnusedEntityId(draft, `clip_${kind}`);
        assertUnusedEntityId(draft, clipId);

        const assetMeta = meta.assets[op.assetId];
        const probeDurationUs = assetMeta?.probe?.durationUs ?? asNum(asObj(asset.probeHint)?.durationUs);
        const rateVal = op.rate ?? 1;
        const rate = rateToRational(rateVal);
        const sourceStartUs = safeIntUs(op.sourceStartUs ?? 0, 'sourceStartUs', 0);
        const defaultDur =
          kind === 'image'
            ? draft.settings.defaultStillDurationUs || DEFAULT_STILL_DURATION_US
            : probeDurationUs
              ? Math.max(1, Math.round((probeDurationUs - sourceStartUs) / rateVal))
              : DEFAULT_STILL_DURATION_US;
        const durationUs = safeIntUs(op.durationUs ?? defaultDur, 'durationUs', 1);
        const sourceDurationUs = Math.max(1, Math.round(durationUs * rateVal));
        const startUs = safeIntUs(op.startUs ?? trackEndUs(track), 'startUs', 0);

        const source: JsonObject = {
          assetId: op.assetId,
          stream: { type: kind === 'audio' ? 'audio' : 'video', index: 0 },
          sourceRange: { startUs: sourceStartUs, durationUs: kind === 'image' ? durationUs : sourceDurationUs },
          timeMapping: {
            type: 'linear',
            rate: { numerator: rate.numerator, denominator: rate.denominator },
            reverse: false,
            boundary: 'hold',
          },
        };

        const clipName = op.name ?? (typeof asset.name === 'string' ? asset.name : undefined);
        let item: ItemEntity;
        if (kind === 'audio') {
          const fadeInUs = op.fadeInUs !== undefined ? safeIntUs(op.fadeInUs, 'fadeInUs', 0) : undefined;
          const fadeOutUs = op.fadeOutUs !== undefined ? safeIntUs(op.fadeOutUs, 'fadeOutUs', 0) : undefined;
          item = {
            id: clipId,
            trackId: track.id,
            type: 'audio',
            ...(clipName ? { name: clipName.slice(0, 256) } : {}),
            enabled: true,
            range: { startUs, durationUs },
            source,
            audio: {
              gainDb: op.gainDb ?? 0,
              pan: 0,
              ...(fadeInUs !== undefined ? { fadeInUs } : {}),
              ...(fadeOutUs !== undefined ? { fadeOutUs } : {}),
            },
            materialInstanceIds: [],
          };
        } else {
          item = {
            id: clipId,
            trackId: track.id,
            type: kind,
            ...(clipName ? { name: clipName.slice(0, 256) } : {}),
            enabled: true,
            range: { startUs, durationUs },
            source,
            visual: makeDefaultVisual(canvasWidth, canvasHeight, op.style, 'contain'),
            materialInstanceIds: [],
          };
        }

        draft.items[clipId] = item;
        track.itemIds.push(clipId);
        tx.createEntity('items', clipId, item as unknown as JsonObject);
        tx.listInsert('tracks', track.id, ['itemIds'], clipId);
        break;
      }

      case 'move_clip': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        const fromTrack = draft.tracks[item.trackId];
        if (!fromTrack || fromTrack.locked) throw new AppError('video.invalid_operation', `源轨道不可编辑`);
        const targetTrack = op.trackId ? draft.tracks[op.trackId] : fromTrack;
        if (!targetTrack) throw new AppError('video.invalid_operation', `目标轨道不存在：${op.trackId}`);
        if (targetTrack.locked) throw new AppError('video.invalid_operation', `目标轨道已锁定：${targetTrack.id}`);
        const requiredKind: VideoTrackKind =
          item.type === 'audio' ? 'audio' : item.type === 'caption' ? 'caption' : 'visual';
        if (item.type !== 'gap' && targetTrack.kind !== requiredKind) {
          throw new AppError('video.invalid_operation', `片段类型 ${item.type} 不能移动到 ${targetTrack.kind} 轨道`);
        }
        const nextStartUs = safeIntUs(op.startUs, 'startUs', 0);
        const deltaUs = nextStartUs - item.range.startUs;
        if (targetTrack.id !== fromTrack.id) {
          fromTrack.itemIds = fromTrack.itemIds.filter((id) => id !== item.id);
          targetTrack.itemIds.push(item.id);
          item.trackId = targetTrack.id;
          tx.listRemove('tracks', fromTrack.id, ['itemIds'], item.id);
          tx.listInsert('tracks', targetTrack.id, ['itemIds'], item.id);
          tx.setField('items', item.id, ['trackId'], targetTrack.id);
        }
        item.range = { startUs: nextStartUs, durationUs: item.range.durationUs };
        tx.setField('items', item.id, ['range', 'startUs'], nextStartUs);
        if (op.ripple && targetTrack.id === fromTrack.id && deltaUs !== 0) {
          const oldEnd = nextStartUs - deltaUs + item.range.durationUs;
          shiftTrackAfter(draft, tx, targetTrack, oldEnd, deltaUs, item.id);
        }
        rebindTransitionsForItem(item.id);
        break;
      }

      case 'trim_clip': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        const track = draft.tracks[item.trackId];
        if (!track || track.locked) throw new AppError('video.invalid_operation', '轨道已锁定');
        const oldStartUs = item.range.startUs;
        const oldDurationUs = item.range.durationUs;
        const oldEndUs = oldStartUs + oldDurationUs;
        const nextStartUs = op.startUs !== undefined ? safeIntUs(op.startUs, 'startUs', 0) : oldStartUs;
        const nextDurationUs =
          op.durationUs !== undefined ? safeIntUs(op.durationUs, 'durationUs', 1) : Math.max(1, oldEndUs - nextStartUs);
        const startDeltaUs = nextStartUs - oldStartUs;
        const endDeltaUs = nextStartUs + nextDurationUs - oldEndUs;

        item.range = { startUs: nextStartUs, durationUs: nextDurationUs };
        tx.setField('items', item.id, ['range'], { startUs: nextStartUs, durationUs: nextDurationUs });

        const source = asObj(item.source);
        const sourceRange = asObj(source?.sourceRange);
        const timeMapping = asObj(source?.timeMapping);
        if (source && sourceRange && timeMapping?.type === 'linear') {
          const rateObj = asObj(timeMapping.rate);
          const rate =
            rateObj && typeof rateObj.numerator === 'number' && typeof rateObj.denominator === 'number'
              ? rateObj.numerator / rateObj.denominator
              : 1;
          const prevSourceStart = asNum(sourceRange.startUs, 0)!;
          const nextSourceStart =
            op.sourceStartUs !== undefined
              ? safeIntUs(op.sourceStartUs, 'sourceStartUs', 0)
              : Math.max(0, Math.round(prevSourceStart + startDeltaUs * rate));
          const nextSourceDur = Math.max(1, Math.round(nextDurationUs * rate));
          source.sourceRange = { startUs: nextSourceStart, durationUs: nextSourceDur };
          tx.setField('items', item.id, ['source', 'sourceRange'], {
            startUs: nextSourceStart,
            durationUs: nextSourceDur,
          });
        }

        if (op.ripple && endDeltaUs !== 0) {
          for (const otherId of track.itemIds) {
            if (otherId === item.id) continue;
            const other = draft.items[otherId];
            if (other && other.range.startUs >= oldEndUs) {
              const shifted = Math.max(0, other.range.startUs + endDeltaUs);
              other.range = { startUs: shifted, durationUs: other.range.durationUs };
              tx.setField('items', other.id, ['range', 'startUs'], shifted);
            }
          }
          for (const tr of Object.values(draft.transitions)) {
            if (
              tr.trackId === track.id &&
              tr.range.startUs >= oldEndUs &&
              tr.fromItemId !== item.id &&
              tr.toItemId !== item.id
            ) {
              const shifted = Math.max(0, tr.range.startUs + endDeltaUs);
              tr.range = { startUs: shifted, durationUs: tr.range.durationUs };
              tx.setField('transitions', tr.id, ['range', 'startUs'], shifted);
            }
          }
        }
        rebindTransitionsForItem(item.id);
        break;
      }

      case 'split_clip': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        const track = draft.tracks[item.trackId];
        if (!track || track.locked) throw new AppError('video.invalid_operation', '轨道已锁定');
        const atUs = safeIntUs(op.atUs, 'atUs', 0);
        const itemEndUs = item.range.startUs + item.range.durationUs;
        if (atUs <= item.range.startUs || atUs >= itemEndUs) {
          throw new AppError('video.invalid_operation', '分割时间点必须严格位于片段起止范围内部');
        }
        const leftDurationUs = atUs - item.range.startUs;
        const rightDurationUs = itemEndUs - atUs;
        const rightId = op.rightClipId
          ? sanitizeEntityId(op.rightClipId, 'clip')
          : findUnusedEntityId(draft, `${item.id}_r`);
        assertUnusedEntityId(draft, rightId);

        const rightItem = structuredClone(item) as ItemEntity;
        rightItem.id = rightId;
        rightItem.range = { startUs: atUs, durationUs: rightDurationUs };
        delete rightItem.linkGroupId;
        delete rightItem.markerIds;

        // Clone materialInstances so every MaterialInstance has exactly one owner (SDK invariant!)
        const rightMaterialIds: string[] = [];
        for (const matId of item.materialInstanceIds) {
          const origMat = draft.materialInstances[matId];
          if (!origMat) continue;
          const clonedMatId = findUnusedEntityId(draft, 'mat');
          const clonedMat = structuredClone(origMat) as MaterialInstanceEntity;
          clonedMat.id = clonedMatId;
          draft.materialInstances[clonedMatId] = clonedMat;
          tx.createEntity('materialInstances', clonedMatId, clonedMat as unknown as JsonObject);
          rightMaterialIds.push(clonedMatId);
        }
        rightItem.materialInstanceIds = rightMaterialIds;

        // Split media sourceRange proportionally
        const leftSource = asObj(item.source);
        const leftSourceRange = asObj(leftSource?.sourceRange);
        const rightSource = asObj(rightItem.source);
        const timeMapping = asObj(leftSource?.timeMapping);
        if (leftSource && leftSourceRange && rightSource && timeMapping?.type === 'linear') {
          const rateObj = asObj(timeMapping.rate);
          const rate =
            rateObj && typeof rateObj.numerator === 'number' && typeof rateObj.denominator === 'number'
              ? rateObj.numerator / rateObj.denominator
              : 1;
          const origSrcStart = asNum(leftSourceRange.startUs, 0)!;
          const origSrcDur = asNum(leftSourceRange.durationUs, Math.round(item.range.durationUs * rate))!;
          const leftSrcDur = Math.max(1, Math.min(origSrcDur - 1, Math.round(leftDurationUs * rate)));
          const rightSrcDur = Math.max(1, origSrcDur - leftSrcDur);
          leftSource.sourceRange = { startUs: origSrcStart, durationUs: leftSrcDur };
          rightSource.sourceRange = { startUs: origSrcStart + leftSrcDur, durationUs: rightSrcDur };
          tx.setField('items', item.id, ['source', 'sourceRange'], { startUs: origSrcStart, durationUs: leftSrcDur });
        }

        // Clamp audio fades if they exceed the new halves
        const leftAudio = asObj(item.audio);
        if (leftAudio) {
          if (typeof leftAudio.fadeOutUs === 'number') {
            delete leftAudio.fadeOutUs;
            tx.removeField('items', item.id, ['audio', 'fadeOutUs']);
          }
          if (typeof leftAudio.fadeInUs === 'number' && leftAudio.fadeInUs > leftDurationUs) {
            leftAudio.fadeInUs = leftDurationUs;
            tx.setField('items', item.id, ['audio', 'fadeInUs'], leftDurationUs);
          }
        }
        const rightAudio = asObj(rightItem.audio);
        if (rightAudio) {
          delete rightAudio.fadeInUs;
          if (typeof rightAudio.fadeOutUs === 'number' && rightAudio.fadeOutUs > rightDurationUs) {
            rightAudio.fadeOutUs = rightDurationUs;
          }
        }

        item.range = { startUs: item.range.startUs, durationUs: leftDurationUs };
        tx.setField('items', item.id, ['range', 'durationUs'], leftDurationUs);

        const idxInTrack = track.itemIds.indexOf(item.id);
        const beforeId = idxInTrack >= 0 ? track.itemIds[idxInTrack + 1] : undefined;
        draft.items[rightId] = rightItem;
        if (idxInTrack >= 0) track.itemIds.splice(idxInTrack + 1, 0, rightId);
        else track.itemIds.push(rightId);
        tx.createEntity('items', rightId, rightItem as unknown as JsonObject);
        tx.listInsert('tracks', track.id, ['itemIds'], rightId, beforeId);

        // Rebind outgoing transitions from the original clip to the right half
        for (const tr of Object.values(draft.transitions)) {
          if (tr.fromItemId === item.id) {
            tr.fromItemId = rightId;
            tx.setField('transitions', tr.id, ['fromItemId'], rightId);
          }
        }
        rebindTransitionsForItem(rightId);
        break;
      }

      case 'delete_clip': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        const track = draft.tracks[item.trackId];
        if (!track || track.locked) throw new AppError('video.invalid_operation', '轨道已锁定');
        const removedDur = item.range.durationUs;
        const removedEnd = item.range.startUs + removedDur;
        deleteItemCascade(item.id);
        if (op.ripple) {
          for (const otherId of track.itemIds) {
            const other = draft.items[otherId];
            if (other && other.range.startUs >= removedEnd) {
              const shifted = Math.max(0, other.range.startUs - removedDur);
              other.range = { startUs: shifted, durationUs: other.range.durationUs };
              tx.setField('items', other.id, ['range', 'startUs'], shifted);
            }
          }
          for (const tr of Object.values(draft.transitions)) {
            if (tr.trackId === track.id && tr.range.startUs >= removedEnd) {
              const shifted = Math.max(0, tr.range.startUs - removedDur);
              tr.range = { startUs: shifted, durationUs: tr.range.durationUs };
              tx.setField('transitions', tr.id, ['range', 'startUs'], shifted);
            }
          }
        }
        break;
      }

      case 'replace_asset': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        const newAsset = draft.assets[op.assetId];
        if (!newAsset) throw new AppError('video.asset_not_found', `未找到素材：${op.assetId}`);
        const source = asObj(item.source);
        if (!source) throw new AppError('video.invalid_operation', `片段 ${op.clipId} 不是媒体素材片段`);
        source.assetId = op.assetId;
        tx.setField('items', item.id, ['source', 'assetId'], op.assetId);
        const nextSourceStart = op.sourceStartUs !== undefined ? safeIntUs(op.sourceStartUs, 'sourceStartUs', 0) : 0;
        const probeDur = meta.assets[op.assetId]?.probe?.durationUs ?? asNum(asObj(newAsset.probeHint)?.durationUs);
        if (!op.keepDuration && probeDur && probeDur > nextSourceStart) {
          const nextDur = probeDur - nextSourceStart;
          item.range = { startUs: item.range.startUs, durationUs: nextDur };
          source.sourceRange = { startUs: nextSourceStart, durationUs: nextDur };
          tx.setField('items', item.id, ['range', 'durationUs'], nextDur);
          tx.setField('items', item.id, ['source', 'sourceRange'], { startUs: nextSourceStart, durationUs: nextDur });
        } else if (op.sourceStartUs !== undefined) {
          const prevRange = asObj(source.sourceRange);
          const curDur = asNum(prevRange?.durationUs, item.range.durationUs)!;
          source.sourceRange = { startUs: nextSourceStart, durationUs: curDur };
          tx.setField('items', item.id, ['source', 'sourceRange', 'startUs'], nextSourceStart);
        }
        break;
      }

      case 'add_text': {
        const role = op.role ?? 'text';
        const trackKind: VideoTrackKind = role === 'caption' ? 'caption' : 'visual';
        const defaultTrackId = role === 'caption' ? STANDARD_TRACK_IDS.captions : STANDARD_TRACK_IDS.videoOverlay;
        const track = ensureTrack(op.trackId ?? (draft.tracks[defaultTrackId] ? defaultTrackId : undefined), trackKind);
        const clipId = op.clipId ? sanitizeEntityId(op.clipId, role) : findUnusedEntityId(draft, `clip_${role}`);
        assertUnusedEntityId(draft, clipId);
        const startUs = safeIntUs(op.startUs, 'startUs', 0);
        const durationUs = safeIntUs(op.durationUs, 'durationUs', 1);
        const box = op.box ?? defaultBox(canvasWidth, canvasHeight, role);
        const styleObj = toSdkTextStyle(op.style, role === 'caption');
        const visual = makeDefaultVisual(canvasWidth, canvasHeight, op.clipStyle, 'none');

        const item: ItemEntity =
          role === 'caption'
            ? {
                id: clipId,
                trackId: track.id,
                type: 'caption',
                enabled: true,
                range: { startUs, durationUs },
                text: op.text,
                box: { ...box },
                style: styleObj,
                overflow: 'auto-fit',
                visual,
                materialInstanceIds: [],
              }
            : {
                id: clipId,
                trackId: track.id,
                type: 'text',
                enabled: true,
                range: { startUs, durationUs },
                box: { ...box },
                overflow: 'auto-fit',
                writingMode: 'horizontal-tb',
                paragraphs: [{ style: {}, runs: [{ text: op.text, style: styleObj }] }],
                visual,
                materialInstanceIds: [],
              };

        draft.items[clipId] = item;
        track.itemIds.push(clipId);
        tx.createEntity('items', clipId, item as unknown as JsonObject);
        tx.listInsert('tracks', track.id, ['itemIds'], clipId);
        break;
      }

      case 'update_text': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        if (item.type !== 'text' && item.type !== 'caption') {
          throw new AppError('video.invalid_operation', `片段 ${op.clipId} 不是文本或字幕`);
        }
        if (op.box) {
          const prevBox = (asObj(item.box) ??
            defaultBox(canvasWidth, canvasHeight, item.type)) as unknown as VideoTextBox;
          const nextBox: JsonObject = {
            x: op.box.x ?? prevBox.x,
            y: op.box.y ?? prevBox.y,
            width: Math.max(1, op.box.width ?? prevBox.width),
            height: Math.max(1, op.box.height ?? prevBox.height),
          };
          item.box = nextBox;
          tx.setField('items', item.id, ['box'], nextBox);
        }
        if (item.type === 'caption') {
          if (op.text !== undefined) {
            item.text = op.text;
            tx.setField('items', item.id, ['text'], op.text);
          }
          if (op.style) {
            const prev = asObj(item.style) ?? {};
            const patch = partialSdkTextStyle(op.style);
            const finalStyle = { ...prev, ...patch };
            item.style = finalStyle;
            tx.setField('items', item.id, ['style'], finalStyle);
          }
        } else {
          const paragraphs = Array.isArray(item.paragraphs) ? (item.paragraphs as JsonObject[]) : [];
          const firstPara = paragraphs[0] ?? {
            style: {},
            runs: [{ text: '', style: toSdkTextStyle(undefined, false) }],
          };
          const runs = Array.isArray(firstPara.runs) ? (firstPara.runs as JsonObject[]) : [];
          const firstRun = runs[0] ?? { text: '', style: toSdkTextStyle(undefined, false) };
          const nextText = op.text !== undefined ? op.text : String(firstRun.text ?? '');
          const prevStyle = asObj(firstRun.style) ?? toSdkTextStyle(undefined, false);
          const nextStyle = op.style ? { ...prevStyle, ...partialSdkTextStyle(op.style) } : prevStyle;
          const nextParagraphs = [
            { style: asObj(firstPara.style) ?? {}, runs: [{ text: nextText, style: nextStyle }] },
          ];
          item.paragraphs = nextParagraphs;
          tx.setField('items', item.id, ['paragraphs'], nextParagraphs);
        }
        break;
      }

      case 'import_subtitles': {
        const track = ensureTrack(
          op.trackId ?? (draft.tracks[STANDARD_TRACK_IDS.captions] ? STANDARD_TRACK_IDS.captions : undefined),
          'caption',
        );
        let cues: VideoSubtitleCue[];
        if (op.cues && op.cues.length > 0) {
          cues = op.cues.map((c) => ({
            startUs: safeIntUs(c.startUs, 'cue.startUs', 0),
            endUs: safeIntUs(c.endUs, 'cue.endUs', 1),
            text: c.text,
          }));
        } else if (typeof op.content === 'string' && op.content.trim()) {
          const fmt = op.format === 'vtt' || op.content.trimStart().startsWith('WEBVTT') ? 'vtt' : 'srt';
          const parsed = fmt === 'vtt' ? parseWebVtt(op.content) : parseSrt(op.content);
          cues = parsed.map((c) => ({ startUs: c.startUs, endUs: c.endUs, text: c.text }));
        } else {
          throw new AppError('video.invalid_operation', 'import_subtitles 需要提供 content 或 cues');
        }

        if (op.replaceExisting) {
          const toDelete = track.itemIds.slice();
          for (const existingId of toDelete) {
            deleteItemCascade(existingId);
          }
        }

        // Optional silence-aware alignment if voiceover silence ranges are cached in project metadata
        const voiceSilences = collectTrackSilences(draft, meta, STANDARD_TRACK_IDS.audioVoice);
        const sortedCues = [...cues]
          .filter((c) => c.endUs > c.startUs && c.text.trim().length > 0)
          .sort((a, b) => a.startUs - b.startUs);

        const box = op.box ?? defaultBox(canvasWidth, canvasHeight, 'caption');
        const styleObj = toSdkTextStyle(op.style, true);
        let prevEndUs = 0;

        for (const rawCue of sortedCues) {
          let startUs = rawCue.startUs;
          let endUs = rawCue.endUs;
          if (voiceSilences.length > 0) {
            for (const s of voiceSilences) {
              if (s.startUs <= startUs && startUs < s.endUs && s.endUs < endUs) {
                startUs = s.endUs;
                warnings.push(`Aligned caption start from ${rawCue.startUs}us to ${startUs}us past silence`);
              }
            }
          }
          if (startUs < prevEndUs) {
            startUs = prevEndUs;
            if (endUs <= startUs) continue;
            warnings.push(`Adjusted overlapping caption cue to start at ${startUs}us`);
          }
          const durationUs = Math.max(1, endUs - startUs);
          prevEndUs = startUs + durationUs;

          const clipId = findUnusedEntityId(draft, 'cap');
          const item: ItemEntity = {
            id: clipId,
            trackId: track.id,
            type: 'caption',
            enabled: true,
            range: { startUs, durationUs },
            text: rawCue.text.trim(),
            box: { ...box },
            style: { ...styleObj },
            overflow: 'auto-fit',
            visual: makeDefaultVisual(canvasWidth, canvasHeight, undefined, 'none'),
            materialInstanceIds: [],
          };
          draft.items[clipId] = item;
          track.itemIds.push(clipId);
          tx.createEntity('items', clipId, item as unknown as JsonObject);
          tx.listInsert('tracks', track.id, ['itemIds'], clipId);
        }
        break;
      }

      case 'set_transition': {
        const from = draft.items[op.fromClipId];
        const to = draft.items[op.toClipId];
        if (!from || !to) throw new AppError('video.invalid_operation', '转场两端片段不存在');
        if (from.trackId !== to.trackId) {
          throw new AppError('video.invalid_operation', '转场两端片段必须位于同一轨道');
        }
        const track = draft.tracks[from.trackId];
        if (!track || track.locked) throw new AppError('video.invalid_operation', '轨道已锁定');

        // Remove any existing transition between this pair
        for (const existing of Object.values(draft.transitions)) {
          if (
            (existing.fromItemId === from.id && existing.toItemId === to.id) ||
            (existing.fromItemId === to.id && existing.toItemId === from.id)
          ) {
            seq.transitionIds = seq.transitionIds.filter((id) => id !== existing.id);
            delete draft.transitions[existing.id];
            delete draft.materialInstances[existing.materialInstanceId];
            tx.listRemove('sequences', existing.sequenceId, ['transitionIds'], existing.id);
            tx.deleteEntity('transitions', existing.id);
            tx.deleteEntity('materialInstances', existing.materialInstanceId);
          }
        }

        if (op.preset === null) break;

        const presetMeta = VIDEO_TRANSITION_PRESETS[op.preset];
        if (!presetMeta) throw new AppError('video.invalid_operation', `不支持的转场预设：${String(op.preset)}`);
        const earlier = from.range.startUs <= to.range.startUs ? from : to;
        const later = earlier === from ? to : from;
        const requestedDur = op.durationUs ?? presetMeta.defaultDurationUs;
        const maxDur = Math.max(1, Math.min(earlier.range.durationUs, later.range.durationUs));
        const durationUs = Math.min(safeIntUs(requestedDur, 'durationUs', 1), maxDur);
        const earlierEnd = earlier.range.startUs + earlier.range.durationUs;
        const overlapStart = Math.max(earlier.range.startUs, later.range.startUs);
        const overlapEnd = Math.min(earlierEnd, later.range.startUs + later.range.durationUs);
        const cutUs = overlapEnd > overlapStart ? Math.round((overlapStart + overlapEnd) / 2) : earlierEnd;
        const startUs = Math.max(0, cutUs - Math.floor(durationUs / 2));

        // Guard against overlapping visual transitions in the same sequence
        const kind = track.kind === 'audio' ? 'audio' : 'visual';
        if (kind === 'visual') {
          for (const other of Object.values(draft.transitions)) {
            if (other.sequenceId !== seqId) continue;
            const otherTrack = draft.tracks[other.trackId];
            if (otherTrack?.kind === 'audio') continue;
            const otherEnd = other.range.startUs + other.range.durationUs;
            if (startUs < otherEnd && startUs + durationUs > other.range.startUs) {
              throw new AppError('video.invalid_operation', '同一序列中两个视觉转场的时间范围不能重叠');
            }
          }
        }

        const matId = findUnusedEntityId(draft, 'mat_tr');
        const mat: MaterialInstanceEntity = {
          id: matId,
          definition: transitionDefinitionForPreset(op.preset) as unknown as JsonObject,
          enabled: true,
          previewPolicy: 'required',
          parameters: {},
        };
        const trId = findUnusedEntityId(draft, 'tr');
        const tr: TransitionEntity = {
          id: trId,
          sequenceId: seqId,
          trackId: track.id,
          kind,
          fromItemId: earlier.id,
          toItemId: later.id,
          range: { startUs, durationUs },
          materialInstanceId: matId,
        };
        draft.materialInstances[matId] = mat;
        draft.transitions[trId] = tr;
        seq.transitionIds.push(trId);
        tx.createEntity('materialInstances', matId, mat as unknown as JsonObject);
        tx.createEntity('transitions', trId, tr as unknown as JsonObject);
        tx.listInsert('sequences', seqId, ['transitionIds'], trId);
        break;
      }

      case 'set_effect': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        if (item.type === 'audio' || item.type === 'gap') {
          throw new AppError('video.invalid_operation', `片段 ${op.clipId} 不支持视觉滤镜`);
        }

        const existingMatId = item.materialInstanceIds.find((matId) => {
          const mat = draft.materialInstances[matId];
          return mat && presetForEffectDefinition(asObj(mat.definition)) === op.preset;
        });

        if (op.remove) {
          if (existingMatId) {
            item.materialInstanceIds = item.materialInstanceIds.filter((id) => id !== existingMatId);
            delete draft.materialInstances[existingMatId];
            tx.listRemove('items', item.id, ['materialInstanceIds'], existingMatId);
            tx.deleteEntity('materialInstances', existingMatId);
          }
          break;
        }

        const spec = effectMaterialSpec(op.preset, {
          intensity: op.intensity,
          params: op.params,
          width: canvasWidth,
          height: canvasHeight,
        });

        if (existingMatId) {
          const existing = draft.materialInstances[existingMatId]!;
          const enabled = op.enabled ?? existing.enabled;
          existing.enabled = enabled;
          existing.parameters = spec.parameters;
          tx.setField('materialInstances', existingMatId, ['enabled'], enabled);
          tx.setField('materialInstances', existingMatId, ['parameters'], spec.parameters);
        } else {
          const matId = findUnusedEntityId(draft, 'mat_fx');
          const mat: MaterialInstanceEntity = {
            id: matId,
            definition: spec.definition as unknown as JsonObject,
            enabled: op.enabled ?? true,
            previewPolicy: 'required',
            parameters: spec.parameters,
          };
          draft.materialInstances[matId] = mat;
          item.materialInstanceIds.push(matId);
          tx.createEntity('materialInstances', matId, mat as unknown as JsonObject);
          tx.listInsert('items', item.id, ['materialInstanceIds'], matId);
        }
        break;
      }

      case 'set_keyframes': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        const isAudioProp = op.property === 'gain' || op.property === 'pan';

        if (op.keyframes.length === 0) {
          if (isAudioProp) {
            if (!asObj(item.audio)) throw new AppError('video.invalid_operation', `片段 ${op.clipId} 没有音频属性`);
            const field = op.property === 'gain' ? 'gainDb' : 'pan';
            (item.audio as JsonObject)[field] = 0;
            tx.setField('items', item.id, ['audio', field], 0);
          } else {
            const visual = asObj(item.visual);
            if (!visual) throw new AppError('video.invalid_operation', `片段 ${op.clipId} 没有视觉属性`);
            if (op.property === 'opacity') {
              visual.opacity = 1;
              tx.setField('items', item.id, ['visual', 'opacity'], 1);
            } else {
              const transform = asObj(visual.transform)!;
              const field =
                op.property === 'position' ? 'positionPx' : op.property === 'scale' ? 'scale' : 'rotationDeg';
              const resetVal: JsonValue =
                op.property === 'position'
                  ? { x: canvasWidth / 2, y: canvasHeight / 2 }
                  : op.property === 'scale'
                    ? { x: 1, y: 1 }
                    : 0;
              transform[field] = resetVal;
              tx.setField('items', item.id, ['visual', 'transform', field], resetVal);
            }
          }
          break;
        }

        const sorted = [...op.keyframes].sort((a, b) => a.timeUs - b.timeUs);
        const mappedKeyframes = sorted.map((kf, index) => {
          const timeUs = safeIntUs(kf.timeUs, `keyframes[${index}].timeUs`, 0);
          if (index > 0 && Math.round(sorted[index - 1]!.timeUs) === timeUs) {
            throw new AppError('video.invalid_operation', '关键帧时间戳不能重复');
          }
          const interp = kf.interpolation === 'cubic' ? 'cubic-bezier' : (kf.interpolation ?? 'linear');
          return {
            timeUs,
            value: kf.value as JsonValue,
            interpolation: interp,
          };
        });

        const animation: JsonObject = {
          animation: {
            timeSpace: 'item',
            preInfinity: 'hold',
            postInfinity: 'hold',
            keyframes: mappedKeyframes,
          },
        };

        if (isAudioProp) {
          if (!asObj(item.audio)) throw new AppError('video.invalid_operation', `片段 ${op.clipId} 不是音频片段`);
          const field = op.property === 'gain' ? 'gainDb' : 'pan';
          (item.audio as JsonObject)[field] = animation;
          tx.setField('items', item.id, ['audio', field], animation);
        } else {
          const visual = asObj(item.visual);
          if (!visual) throw new AppError('video.invalid_operation', `片段 ${op.clipId} 不是视觉片段`);
          if (op.property === 'opacity') {
            visual.opacity = animation;
            tx.setField('items', item.id, ['visual', 'opacity'], animation);
          } else {
            const transform = asObj(visual.transform);
            if (!transform) throw new AppError('video.invalid_operation', `片段 ${op.clipId} 缺少变换属性`);
            const field = op.property === 'position' ? 'positionPx' : op.property === 'scale' ? 'scale' : 'rotationDeg';
            transform[field] = animation;
            tx.setField('items', item.id, ['visual', 'transform', field], animation);
          }
        }
        break;
      }

      case 'remove_silence': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        const source = asObj(item.source);
        const assetId = typeof source?.assetId === 'string' ? source.assetId : undefined;
        if (!assetId) throw new AppError('video.invalid_operation', `片段 ${op.clipId} 缺少媒体素材`);
        const probe = meta.assets[assetId]?.probe;
        const rawSilences = probe?.silences ?? [];
        const minSilenceUs = op.minimumSilenceUs ?? 300_000;
        const paddingUs = op.paddingUs ?? 40_000;
        const thresholdDb = op.thresholdDb;

        const srcRange = asObj(source?.sourceRange);
        const clipSrcStart = asNum(srcRange?.startUs, 0)!;
        const clipSrcDur = asNum(srcRange?.durationUs, item.range.durationUs)!;
        const clipSrcEnd = clipSrcStart + clipSrcDur;

        // Filter silence intervals inside this clip's source range
        const removable: Array<{ startUs: number; endUs: number }> = [];
        for (const seg of rawSilences) {
          if (thresholdDb !== undefined && seg.peakDb !== undefined && seg.peakDb > thresholdDb) continue;
          const s = Math.max(clipSrcStart, seg.startUs + paddingUs);
          const e = Math.min(clipSrcEnd, seg.endUs - paddingUs);
          if (e - s >= minSilenceUs) {
            removable.push({ startUs: s, endUs: e });
          }
        }
        removable.sort((a, b) => a.startUs - b.startUs);

        if (removable.length === 0) {
          warnings.push(`No removable silence found in clip ${op.clipId}`);
          break;
        }

        // Compute audible (kept) source ranges
        const kept: Array<{ startUs: number; durationUs: number }> = [];
        let cursor = clipSrcStart;
        for (const rem of removable) {
          if (rem.startUs > cursor) {
            kept.push({ startUs: cursor, durationUs: rem.startUs - cursor });
          }
          cursor = Math.max(cursor, rem.endUs);
        }
        if (cursor < clipSrcEnd) {
          kept.push({ startUs: cursor, durationUs: clipSrcEnd - cursor });
        }

        const track = draft.tracks[item.trackId];
        if (!track || track.locked) throw new AppError('video.invalid_operation', '轨道已锁定');
        const oldEndUs = item.range.startUs + item.range.durationUs;

        if (kept.length === 0) {
          const removedDur = item.range.durationUs;
          deleteItemCascade(item.id);
          shiftTrackAfter(draft, tx, track, oldEndUs, -removedDur);
          break;
        }

        const timeMapping = asObj(source?.timeMapping);
        const rateObj = timeMapping?.type === 'linear' ? asObj(timeMapping.rate) : undefined;
        const rate =
          rateObj && typeof rateObj.numerator === 'number' && typeof rateObj.denominator === 'number'
            ? rateObj.numerator / rateObj.denominator
            : 1;

        let timelineCursor = item.range.startUs;
        const first = kept[0]!;
        const firstTimelineDur = Math.max(1, Math.round(first.durationUs / rate));
        item.range = { startUs: timelineCursor, durationUs: firstTimelineDur };
        source!.sourceRange = { startUs: first.startUs, durationUs: first.durationUs };
        tx.setField('items', item.id, ['range'], { startUs: timelineCursor, durationUs: firstTimelineDur });
        tx.setField('items', item.id, ['source', 'sourceRange'], {
          startUs: first.startUs,
          durationUs: first.durationUs,
        });
        timelineCursor += firstTimelineDur;

        const idxInTrack = track.itemIds.indexOf(item.id);
        const anchorId = idxInTrack >= 0 ? track.itemIds[idxInTrack + 1] : undefined;
        let lastSegmentId = item.id;

        for (let i = 1; i < kept.length; i += 1) {
          const seg = kept[i]!;
          const segTimelineDur = Math.max(1, Math.round(seg.durationUs / rate));
          const segId = findUnusedEntityId(draft, `${item.id}_s${i}`);
          const segItem = structuredClone(item) as ItemEntity;
          segItem.id = segId;
          segItem.range = { startUs: timelineCursor, durationUs: segTimelineDur };
          delete segItem.linkGroupId;
          delete segItem.markerIds;
          const segMatIds: string[] = [];
          for (const matId of item.materialInstanceIds) {
            const origMat = draft.materialInstances[matId];
            if (!origMat) continue;
            const clonedMatId = findUnusedEntityId(draft, 'mat');
            const clonedMat = structuredClone(origMat) as MaterialInstanceEntity;
            clonedMat.id = clonedMatId;
            draft.materialInstances[clonedMatId] = clonedMat;
            tx.createEntity('materialInstances', clonedMatId, clonedMat as unknown as JsonObject);
            segMatIds.push(clonedMatId);
          }
          segItem.materialInstanceIds = segMatIds;
          (segItem.source as JsonObject).sourceRange = { startUs: seg.startUs, durationUs: seg.durationUs };

          draft.items[segId] = segItem;
          const insertPos = anchorId ? track.itemIds.indexOf(anchorId) : track.itemIds.length;
          track.itemIds.splice(insertPos, 0, segId);
          tx.createEntity('items', segId, segItem as unknown as JsonObject);
          tx.listInsert('tracks', track.id, ['itemIds'], segId, anchorId);
          timelineCursor += segTimelineDur;
          lastSegmentId = segId;
        }

        const removedUs = oldEndUs - timelineCursor;
        if (removedUs > 0) {
          shiftTrackAfter(draft, tx, track, oldEndUs, -removedUs);
        }
        if (lastSegmentId !== item.id) {
          for (const tr of Object.values(draft.transitions)) {
            if (tr.fromItemId === item.id) {
              tr.fromItemId = lastSegmentId;
              tx.setField('transitions', tr.id, ['fromItemId'], lastSegmentId);
            }
          }
          rebindTransitionsForItem(lastSegmentId);
        }
        break;
      }

      case 'auto_duck': {
        if (!op.programTrackIds.length || !op.sidechainTrackIds.length) {
          throw new AppError('video.invalid_operation', 'auto_duck 需要指定 programTrackIds 和 sidechainTrackIds');
        }
        for (const trackId of [...op.programTrackIds, ...op.sidechainTrackIds]) {
          const track = draft.tracks[trackId];
          if (!track || track.kind !== 'audio') {
            throw new AppError('video.invalid_operation', `auto_duck 仅支持音频轨道：${trackId}`);
          }
        }
        const currentExt = asObj(seq.extensions) ?? {};
        const currentMastering = asObj(currentExt[MASTERING_EXTENSION]) ?? {};
        const existingDucking = Array.isArray(currentMastering.ducking)
          ? (currentMastering.ducking as JsonObject[])
          : [];
        const newProgramSet = new Set(op.programTrackIds);
        // Remove any prior rules targeting the same programTrackIds (SDK forbids duplicate programTrackId across rules)
        const filteredDucking = existingDucking.filter((rule) => {
          const ids = Array.isArray(rule.programTrackIds) ? rule.programTrackIds : [];
          return !ids.some((id) => typeof id === 'string' && newProgramSet.has(id));
        });
        const newRule: JsonObject = {
          programTrackIds: [...new Set(op.programTrackIds)],
          sidechainTrackIds: [...new Set(op.sidechainTrackIds)],
          thresholdDb: op.thresholdDb ?? -30,
          reductionDb: op.reductionDb !== undefined ? -Math.abs(op.reductionDb) : -12,
          attackUs: safeIntUs(op.attackUs ?? 10_000, 'attackUs', 0),
          releaseUs: safeIntUs(op.releaseUs ?? 250_000, 'releaseUs', 0),
          lookaheadUs: 0,
        };
        const nextMastering: JsonObject = {
          ...currentMastering,
          ducking: [...filteredDucking, newRule],
        };
        const nextExtensions: JsonObject = { ...currentExt, [MASTERING_EXTENSION]: nextMastering };
        seq.extensions = nextExtensions;
        tx.setField('sequences', seqId, ['extensions'], nextExtensions);
        break;
      }

      case 'normalize_loudness': {
        const targetLufs = op.targetLufs ?? -14;
        const maximumGainDb = Math.max(0, op.maximumGainDb ?? 24);
        const ceilingDbtp = op.ceilingDbtp ?? -1;
        if (!Number.isFinite(targetLufs) || !Number.isFinite(maximumGainDb) || !Number.isFinite(ceilingDbtp)) {
          throw new AppError('video.invalid_operation', '响度参数必须是有效数值');
        }
        const currentExt = asObj(seq.extensions) ?? {};
        const currentMastering = asObj(currentExt[MASTERING_EXTENSION]) ?? {};
        const nextMastering: JsonObject = {
          ...currentMastering,
          targetLufs,
          maximumGainDb,
          limiter: {
            ceilingDbtp,
            releaseUs: 100_000,
            lookaheadUs: 0,
          },
        };
        const nextExtensions: JsonObject = { ...currentExt, [MASTERING_EXTENSION]: nextMastering };
        seq.extensions = nextExtensions;
        tx.setField('sequences', seqId, ['extensions'], nextExtensions);
        break;
      }

      case 'snap_to_beats': {
        const maxOffsetUs = safeIntUs(op.maxOffsetUs ?? 250_000, 'maxOffsetUs', 1);
        const beatTimesUs = collectSequenceBeatTimesUs(draft, meta, op.audioClipId, op.audioTrackId);
        if (beatTimesUs.length === 0) {
          warnings.push('No beat markers available on audio tracks; analyze audio beats first');
          break;
        }
        const targetIds =
          op.clipIds && op.clipIds.length > 0
            ? op.clipIds
            : (draft.tracks[STANDARD_TRACK_IDS.videoMain]?.itemIds ?? []);

        const sortedTargets = targetIds
          .map((id) => draft.items[id])
          .filter((item): item is ItemEntity => Boolean(item))
          .sort((a, b) => a.range.startUs - b.range.startUs);

        const prevEndByTrack = new Map<string, number>();
        for (const clip of sortedTargets) {
          let nearest = clip.range.startUs;
          let bestDist = maxOffsetUs + 1;
          for (const beat of beatTimesUs) {
            const dist = Math.abs(beat - clip.range.startUs);
            if (dist < bestDist) {
              bestDist = dist;
              nearest = beat;
            }
          }
          const track = draft.tracks[clip.trackId];
          const isExclusive =
            track?.occupancy === 'exclusive' || (track?.occupancy === undefined && track?.role === 'storyline');
          const minStart = isExclusive ? (prevEndByTrack.get(clip.trackId) ?? 0) : 0;
          const snappedStart = Math.max(minStart, nearest);
          if (bestDist <= maxOffsetUs && snappedStart !== clip.range.startUs) {
            clip.range = { startUs: snappedStart, durationUs: clip.range.durationUs };
            tx.setField('items', clip.id, ['range', 'startUs'], snappedStart);
            rebindTransitionsForItem(clip.id);
          }
          prevEndByTrack.set(clip.trackId, clip.range.startUs + clip.range.durationUs);
        }
        break;
      }

      case 'set_track_audio': {
        const track = draft.tracks[op.trackId];
        if (!track) throw new AppError('video.invalid_operation', `轨道不存在：${op.trackId}`);
        if (op.enabled !== undefined) {
          track.enabled = op.enabled;
          tx.setField('tracks', track.id, ['enabled'], op.enabled);
        }
        if (op.locked !== undefined) {
          track.locked = op.locked;
          tx.setField('tracks', track.id, ['locked'], op.locked);
        }
        if (track.kind === 'audio' && (op.muted !== undefined || op.solo !== undefined || op.gainDb !== undefined)) {
          const prevAudio = track.audio ?? { gainDb: 0, pan: 0, muted: false, solo: false };
          const nextAudio = {
            ...prevAudio,
            ...(op.muted !== undefined ? { muted: op.muted } : {}),
            ...(op.solo !== undefined ? { solo: op.solo } : {}),
            ...(op.gainDb !== undefined ? { gainDb: op.gainDb } : {}),
          };
          track.audio = nextAudio;
          tx.setField('tracks', track.id, ['audio'], nextAudio as unknown as JsonObject);
        }
        break;
      }

      case 'set_clip_style': {
        const item = draft.items[op.clipId];
        if (!item) throw new AppError('video.invalid_operation', `片段不存在：${op.clipId}`);
        const visual = asObj(item.visual);
        if (visual && op.style) {
          if (op.style.fit !== undefined) {
            visual.fit = op.style.fit;
            tx.setField('items', item.id, ['visual', 'fit'], op.style.fit);
          }
          if (op.style.opacity !== undefined) {
            const clamped = Math.max(0, Math.min(1, op.style.opacity));
            visual.opacity = clamped;
            tx.setField('items', item.id, ['visual', 'opacity'], clamped);
          }
          if (op.style.blendMode !== undefined && VALID_BLEND_MODES.has(op.style.blendMode)) {
            visual.blendMode = op.style.blendMode;
            tx.setField('items', item.id, ['visual', 'blendMode'], op.style.blendMode);
          }
          if (op.style.crop !== undefined) {
            const prevCrop = asObj(visual.crop) ?? { left: 0, top: 0, right: 0, bottom: 0 };
            const nextCrop: JsonObject = {
              left: Math.max(0, Math.min(1, op.style.crop.left ?? asNum(prevCrop.left, 0)!)),
              top: Math.max(0, Math.min(1, op.style.crop.top ?? asNum(prevCrop.top, 0)!)),
              right: Math.max(0, Math.min(1, op.style.crop.right ?? asNum(prevCrop.right, 0)!)),
              bottom: Math.max(0, Math.min(1, op.style.crop.bottom ?? asNum(prevCrop.bottom, 0)!)),
            };
            visual.crop = nextCrop;
            tx.setField('items', item.id, ['visual', 'crop'], nextCrop);
          }
          const transform = asObj(visual.transform);
          if (transform) {
            if (op.style.positionPx !== undefined) {
              const p = { x: op.style.positionPx.x, y: op.style.positionPx.y };
              transform.positionPx = p;
              tx.setField('items', item.id, ['visual', 'transform', 'positionPx'], p);
            }
            if (op.style.anchor !== undefined) {
              const a = { x: op.style.anchor.x, y: op.style.anchor.y };
              transform.anchor = a;
              tx.setField('items', item.id, ['visual', 'transform', 'anchor'], a);
            }
            if (op.style.scale !== undefined) {
              const s = { x: op.style.scale.x, y: op.style.scale.y };
              transform.scale = s;
              tx.setField('items', item.id, ['visual', 'transform', 'scale'], s);
            }
            if (op.style.rotationDeg !== undefined) {
              transform.rotationDeg = op.style.rotationDeg;
              tx.setField('items', item.id, ['visual', 'transform', 'rotationDeg'], op.style.rotationDeg);
            }
          }
        }

        const audio = asObj(item.audio);
        if (audio) {
          if (op.gainDb !== undefined) {
            audio.gainDb = op.gainDb;
            tx.setField('items', item.id, ['audio', 'gainDb'], op.gainDb);
          }
          if (op.pan !== undefined) {
            const pan = Math.max(-1, Math.min(1, op.pan));
            audio.pan = pan;
            tx.setField('items', item.id, ['audio', 'pan'], pan);
          }
          if (op.fadeInUs !== undefined) {
            const v = safeIntUs(op.fadeInUs, 'fadeInUs', 0);
            audio.fadeInUs = v;
            tx.setField('items', item.id, ['audio', 'fadeInUs'], v);
          }
          if (op.fadeOutUs !== undefined) {
            const v = safeIntUs(op.fadeOutUs, 'fadeOutUs', 0);
            audio.fadeOutUs = v;
            tx.setField('items', item.id, ['audio', 'fadeOutUs'], v);
          }
        }

        if (op.rate !== undefined) {
          const source = asObj(item.source);
          const timeMapping = asObj(source?.timeMapping);
          const sourceRange = asObj(source?.sourceRange);
          if (source && timeMapping?.type === 'linear' && sourceRange) {
            const rational = rateToRational(op.rate);
            const srcDur = asNum(sourceRange.durationUs, item.range.durationUs)!;
            const nextTimelineDur = Math.max(1, Math.round(srcDur / op.rate));
            timeMapping.rate = { numerator: rational.numerator, denominator: rational.denominator };
            item.range = { startUs: item.range.startUs, durationUs: nextTimelineDur };
            tx.setField('items', item.id, ['source', 'timeMapping', 'rate'], {
              numerator: rational.numerator,
              denominator: rational.denominator,
            });
            tx.setField('items', item.id, ['range', 'durationUs'], nextTimelineDur);
            rebindTransitionsForItem(item.id);
          }
        }
        break;
      }

      case 'undo':
      case 'redo':
        break;
    }
  }

  private toSummary(entry: LoadedProject): VideoProjectSummary {
    const project = entry.history.getSnapshot();
    const seq = project.sequences[project.settings.defaultSequenceId]!;
    const fps = Number((seq.format.frameRate.numerator / seq.format.frameRate.denominator).toFixed(3));
    return {
      id: entry.meta.id,
      ...(entry.meta.botId ? { botId: entry.meta.botId } : {}),
      ...(entry.meta.sessionId ? { sessionId: entry.meta.sessionId } : {}),
      title: entry.meta.title,
      aspect: entry.meta.aspect,
      width: seq.format.width,
      height: seq.format.height,
      fps,
      sampleRate: seq.format.sampleRate,
      durationUs: computeProjectDurationUs(project),
      revision: this.currentRevision(entry),
      trackCount: seq.trackIds.length,
      clipCount: Object.keys(project.items).length,
      assetCount: Object.keys(project.assets).length,
      ...(entry.meta.posterDataUrl ? { posterDataUrl: entry.meta.posterDataUrl } : {}),
      createdAt: entry.meta.createdAt,
      updatedAt: entry.meta.updatedAt,
    };
  }

  private toDetail(entry: LoadedProject): VideoProjectDetail {
    const project = entry.history.getSnapshot();
    const seqId = project.settings.defaultSequenceId;
    const seq = project.sequences[seqId]!;
    const summary = this.toSummary(entry);

    // Index transitions by fromItemId and toItemId
    const transitionInByClip = new Map<string, VideoClipTransitionRef>();
    const transitionOutByClip = new Map<string, VideoClipTransitionRef>();
    for (const tr of Object.values(project.transitions)) {
      const mat = project.materialInstances[tr.materialInstanceId];
      const preset = presetForTransitionDefinition(asObj(mat?.definition)) ?? 'cross-dissolve';
      const ref: VideoClipTransitionRef = { id: tr.id, preset, durationUs: tr.range.durationUs };
      transitionOutByClip.set(tr.fromItemId, ref);
      transitionInByClip.set(tr.toItemId, ref);
    }

    const tracks: VideoTrackSummary[] = seq.trackIds
      .map((id) => project.tracks[id])
      .filter((t): t is TrackEntity => Boolean(t))
      .map((track) => {
        const clips: VideoClipSummary[] = track.itemIds
          .map((itemId) => project.items[itemId])
          .filter((item): item is ItemEntity => Boolean(item))
          .map((item) => {
            const source = asObj(item.source);
            const assetId = typeof source?.assetId === 'string' ? source.assetId : undefined;
            const sourceRange = asObj(source?.sourceRange);
            const timeMapping = asObj(source?.timeMapping);
            const rateObj = timeMapping?.type === 'linear' ? asObj(timeMapping.rate) : undefined;
            const rate =
              rateObj && typeof rateObj.numerator === 'number' && typeof rateObj.denominator === 'number'
                ? Number((rateObj.numerator / rateObj.denominator).toFixed(4))
                : undefined;
            const audio = asObj(item.audio);
            const visual = asObj(item.visual);

            let text: string | undefined;
            let textBox: VideoTextBox | undefined;
            let textStyle: VideoTextStyle | undefined;
            if (item.type === 'caption') {
              text = typeof item.text === 'string' ? item.text : '';
              const box = asObj(item.box);
              if (box) {
                textBox = {
                  x: asNum(box.x, 0)!,
                  y: asNum(box.y, 0)!,
                  width: asNum(box.width, 100)!,
                  height: asNum(box.height, 40)!,
                };
              }
              textStyle = fromSdkTextStyle(asObj(item.style));
            } else if (item.type === 'text') {
              const paras = Array.isArray(item.paragraphs) ? (item.paragraphs as JsonObject[]) : [];
              const runs = paras.flatMap((p) => (Array.isArray(p.runs) ? (p.runs as JsonObject[]) : []));
              text = runs.map((r) => String(r.text ?? '')).join('');
              const box = asObj(item.box);
              if (box) {
                textBox = {
                  x: asNum(box.x, 0)!,
                  y: asNum(box.y, 0)!,
                  width: asNum(box.width, 100)!,
                  height: asNum(box.height, 40)!,
                };
              }
              textStyle = fromSdkTextStyle(asObj(runs[0]?.style));
            }

            const effects: VideoClipEffect[] = [];
            for (const matId of item.materialInstanceIds) {
              const mat = project.materialInstances[matId];
              if (!mat) continue;
              const preset = presetForEffectDefinition(asObj(mat.definition));
              if (!preset) continue;
              const numericParams: Record<string, number> = {};
              for (const [k, v] of Object.entries(mat.parameters)) {
                if (typeof v === 'number' && Number.isFinite(v)) numericParams[k] = v;
              }
              effects.push({
                id: mat.id,
                preset,
                enabled: mat.enabled,
                intensity: effectIntensityFromParameters(preset, mat.parameters),
                params: numericParams,
              });
            }

            const assetMeta = assetId ? entry.meta.assets[assetId] : undefined;
            const trIn = transitionInByClip.get(item.id);
            const trOut = transitionOutByClip.get(item.id);

            return {
              id: item.id,
              trackId: item.trackId,
              kind: item.type as VideoClipKind,
              ...(typeof item.name === 'string' ? { name: item.name } : {}),
              ...(assetId ? { assetId } : {}),
              startUs: item.range.startUs,
              durationUs: item.range.durationUs,
              ...(sourceRange ? { sourceStartUs: asNum(sourceRange.startUs, 0) } : {}),
              ...(sourceRange ? { sourceDurationUs: asNum(sourceRange.durationUs, item.range.durationUs) } : {}),
              ...(rate !== undefined ? { rate } : {}),
              enabled: item.enabled,
              ...(visual ? { style: extractClipStyle(visual) } : {}),
              ...(audio && asNum(audio.gainDb) !== undefined ? { gainDb: asNum(audio.gainDb) } : {}),
              ...(audio && asNum(audio.pan) !== undefined ? { pan: asNum(audio.pan) } : {}),
              ...(audio && asNum(audio.fadeInUs) !== undefined ? { fadeInUs: asNum(audio.fadeInUs) } : {}),
              ...(audio && asNum(audio.fadeOutUs) !== undefined ? { fadeOutUs: asNum(audio.fadeOutUs) } : {}),
              ...(text !== undefined ? { text } : {}),
              ...(textBox ? { textBox } : {}),
              ...(textStyle ? { textStyle } : {}),
              ...(effects.length ? { effects } : {}),
              ...(trIn ? { transitionIn: trIn } : {}),
              ...(trOut ? { transitionOut: trOut } : {}),
              ...(assetMeta?.probe?.posterDataUrl ? { posterDataUrl: assetMeta.probe.posterDataUrl } : {}),
            };
          });

        return {
          id: track.id,
          kind: track.kind,
          name: typeof track.name === 'string' ? track.name : track.id,
          ...(track.role ? { role: track.role } : {}),
          enabled: track.enabled,
          locked: track.locked,
          ...(track.audio ? { muted: track.audio.muted } : {}),
          ...(track.audio && track.audio.solo !== undefined ? { solo: track.audio.solo } : {}),
          ...(track.audio && asNum(track.audio.gainDb) !== undefined ? { gainDb: asNum(track.audio.gainDb) } : {}),
          clips,
        };
      });

    const assetUrls: Record<string, string> = {};
    const assets: VideoAssetInfo[] = Object.values(entry.meta.assets).map((meta) => {
      const streamUrl = this.assetUrl(entry.meta.id, meta.id);
      assetUrls[meta.id] = streamUrl;
      return {
        id: meta.id,
        kind: meta.kind,
        name: meta.name,
        ...(meta.sourcePath ? { sourcePath: meta.sourcePath } : {}),
        ...(meta.attachmentId ? { attachmentId: meta.attachmentId } : {}),
        streamUrl,
        mimeType: meta.mimeType,
        byteLength: meta.byteLength,
        ...(meta.probe?.durationUs !== undefined ? { durationUs: meta.probe.durationUs } : {}),
        ...(meta.probe?.width !== undefined ? { width: meta.probe.width } : {}),
        ...(meta.probe?.height !== undefined ? { height: meta.probe.height } : {}),
        ...(meta.probe?.fps !== undefined ? { fps: meta.probe.fps } : {}),
        ...(meta.probe?.hasAudio !== undefined ? { hasAudio: meta.probe.hasAudio } : {}),
        ...(meta.probe?.sampleRate !== undefined ? { sampleRate: meta.probe.sampleRate } : {}),
        ...(meta.probe?.channels !== undefined ? { channels: meta.probe.channels } : {}),
        ...(meta.probe?.posterDataUrl ? { posterDataUrl: meta.probe.posterDataUrl } : {}),
        ...(meta.probe?.waveform ? { waveform: meta.probe.waveform } : {}),
      };
    });

    const recentExports = this.deps.listExports?.(entry.meta.id);
    return {
      ...summary,
      sequenceId: seqId,
      canUndo: entry.history.state.canUndo,
      canRedo: entry.history.state.canRedo,
      tracks,
      assets,
      projectJson: structuredClone(project) as unknown as Record<string, unknown>,
      assetUrls,
      ...(recentExports && recentExports.length > 0 ? { recentExports } : {}),
    };
  }
}

function partialSdkTextStyle(style: Partial<VideoTextStyle>): JsonObject {
  const out: JsonObject = {};
  if (style.fontFamily !== undefined) out.fontFamilies = [style.fontFamily];
  if (style.fontSizePx !== undefined) out.fontSizePx = style.fontSizePx;
  if (style.fontWeight !== undefined) out.fontWeight = style.fontWeight;
  if (style.fontStyle !== undefined) out.fontStyle = style.fontStyle;
  if (style.fill !== undefined) out.fill = style.fill;
  if (style.stroke !== undefined) out.stroke = style.stroke;
  if (style.strokeWidthPx !== undefined) out.strokeWidthPx = style.strokeWidthPx;
  if (style.align !== undefined) out.align = style.align;
  if (style.backgroundFill !== undefined) out.backgroundFill = style.backgroundFill;
  if (style.backgroundOpacity !== undefined) out.backgroundOpacity = style.backgroundOpacity;
  if (style.backgroundPaddingPx !== undefined) out.backgroundPaddingPx = style.backgroundPaddingPx;
  if (style.backgroundRadiusPx !== undefined) out.backgroundRadiusPx = style.backgroundRadiusPx;
  if (style.lineHeightPx !== undefined) out.lineHeightPx = style.lineHeightPx;
  if (style.letterSpacingPx !== undefined) out.letterSpacingPx = style.letterSpacingPx;
  return out;
}

function buildProbeHint(probe: VideoMediaProbe | undefined): JsonObject | undefined {
  if (!probe) return undefined;
  const hint: JsonObject = {};
  if (Number.isSafeInteger(probe.durationUs) && probe.durationUs > 0) hint.durationUs = probe.durationUs;
  if (probe.width && Number.isInteger(probe.width) && probe.width >= 1 && probe.width <= 65_535) {
    hint.width = probe.width;
  }
  if (probe.height && Number.isInteger(probe.height) && probe.height >= 1 && probe.height <= 65_535) {
    hint.height = probe.height;
  }
  if (probe.codecs?.video) hint.videoCodec = probe.codecs.video.slice(0, 256);
  if (probe.codecs?.audio) hint.audioCodec = probe.codecs.audio.slice(0, 256);
  return Object.keys(hint).length > 0 ? hint : undefined;
}

function shiftTrackAfter(
  draft: AelionProject,
  tx: TransactionBuilder,
  track: TrackEntity,
  pivotUs: number,
  deltaUs: number,
  excludeItemId?: string,
): void {
  for (const otherId of track.itemIds) {
    if (otherId === excludeItemId) continue;
    const other = draft.items[otherId];
    if (other && other.range.startUs >= pivotUs) {
      const shifted = Math.max(0, other.range.startUs + deltaUs);
      other.range = { startUs: shifted, durationUs: other.range.durationUs };
      tx.setField('items', other.id, ['range', 'startUs'], shifted);
    }
  }
  for (const tr of Object.values(draft.transitions)) {
    if (
      tr.trackId === track.id &&
      tr.range.startUs >= pivotUs &&
      tr.fromItemId !== excludeItemId &&
      tr.toItemId !== excludeItemId
    ) {
      const shifted = Math.max(0, tr.range.startUs + deltaUs);
      tr.range = { startUs: shifted, durationUs: tr.range.durationUs };
      tx.setField('transitions', tr.id, ['range', 'startUs'], shifted);
    }
  }
}

function collectTrackSilences(
  draft: AelionProject,
  meta: ProjectMeta,
  trackId: string,
): Array<{ startUs: number; endUs: number }> {
  const track = draft.tracks[trackId];
  if (!track) return [];
  const ranges: Array<{ startUs: number; endUs: number }> = [];
  for (const itemId of track.itemIds) {
    const item = draft.items[itemId];
    const source = asObj(item?.source);
    const assetId = typeof source?.assetId === 'string' ? source.assetId : undefined;
    if (!item || !assetId) continue;
    const silences = meta.assets[assetId]?.probe?.silences;
    if (!silences?.length) continue;
    const srcStart = asNum(asObj(source?.sourceRange)?.startUs, 0)!;
    const srcEnd = srcStart + asNum(asObj(source?.sourceRange)?.durationUs, item.range.durationUs)!;
    for (const seg of silences) {
      const overlapStart = Math.max(srcStart, seg.startUs);
      const overlapEnd = Math.min(srcEnd, seg.endUs);
      if (overlapEnd > overlapStart) {
        ranges.push({
          startUs: item.range.startUs + (overlapStart - srcStart),
          endUs: item.range.startUs + (overlapEnd - srcStart),
        });
      }
    }
  }
  return ranges;
}

function collectSequenceBeatTimesUs(
  draft: AelionProject,
  meta: ProjectMeta,
  audioClipId?: string,
  audioTrackId?: string,
): number[] {
  const candidateItems: ItemEntity[] = [];
  if (audioClipId) {
    const clip = draft.items[audioClipId];
    if (clip) candidateItems.push(clip);
  } else if (audioTrackId) {
    const track = draft.tracks[audioTrackId];
    if (track) {
      for (const id of track.itemIds) {
        const clip = draft.items[id];
        if (clip) candidateItems.push(clip);
      }
    }
  } else {
    for (const trackId of [STANDARD_TRACK_IDS.audioBgm, STANDARD_TRACK_IDS.audioVoice]) {
      const track = draft.tracks[trackId];
      if (!track) continue;
      for (const id of track.itemIds) {
        const clip = draft.items[id];
        if (clip) candidateItems.push(clip);
      }
    }
    if (candidateItems.length === 0) {
      for (const item of Object.values(draft.items)) {
        if (item.type === 'audio') candidateItems.push(item);
      }
    }
  }

  const beats: number[] = [];
  for (const clip of candidateItems) {
    const source = asObj(clip.source);
    const assetId = typeof source?.assetId === 'string' ? source.assetId : undefined;
    if (!assetId) continue;
    const probeBeats = meta.assets[assetId]?.probe?.beats;
    if (!probeBeats?.length) continue;
    const srcStart = asNum(asObj(source?.sourceRange)?.startUs, 0)!;
    const srcEnd = srcStart + asNum(asObj(source?.sourceRange)?.durationUs, clip.range.durationUs)!;
    const timeMapping = asObj(source?.timeMapping);
    const rateObj = timeMapping?.type === 'linear' ? asObj(timeMapping.rate) : undefined;
    const rate =
      rateObj && typeof rateObj.numerator === 'number' && typeof rateObj.denominator === 'number'
        ? rateObj.numerator / rateObj.denominator
        : 1;
    for (const beat of probeBeats) {
      if (beat.timeUs >= srcStart && beat.timeUs <= srcEnd) {
        beats.push(clip.range.startUs + Math.round((beat.timeUs - srcStart) / rate));
      }
    }
  }
  return beats.sort((a, b) => a - b);
}
