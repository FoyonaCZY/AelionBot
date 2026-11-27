// High-level Video Studio coordinator: manages projects, hidden Chromium render/export queue,
// poster LRU disk cache, quick edits, contact-sheet visual self-checks, and artifact/attachment delivery.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { AelionProject } from '@aelionsdk/project-schema';
import { AppError } from '../../../shared/errors';
import type { ScreenReference } from '../../../shared/types/core';
import {
  VIDEO_ASPECT_DIMENSIONS,
  type VideoAspectPreset,
  type VideoAssetInfo,
  type VideoEditRequest,
  type VideoEditResult,
  type VideoEngineState,
  type VideoExportFormat,
  type VideoExportJob,
  type VideoExportRequest,
  type VideoMediaAnalyzeInput,
  type VideoMediaPosterInput,
  type VideoMediaPosterResult,
  type VideoMediaProbe,
  type VideoMediaSourceRef,
  type VideoProjectCreateInput,
  type VideoProjectDetail,
  type VideoProjectFrameInput,
  type VideoProjectFrameResult,
  type VideoProjectSummary,
  type VideoQuickEditRequest,
  type VideoQuickEditResult,
} from '../../../shared/types/video-studio-types';
import type { EngineAssetRef, EngineCapabilitiesResult } from '../../windows/video-engine-entry';
import type { VideoEngineBackend } from '../../windows/video-engine-window';
import { VideoMediaTokenRegistry } from './video-engine-protocol';
import {
  inferMediaKindAndMime,
  STANDARD_TRACK_IDS,
  VIDEO_ENGINE_SCHEME,
  VideoProjects,
  type VideoAssetImportExtendedInput,
} from './video-projects';

const MAX_POSTER_CACHE_ENTRIES = 200;

interface CachedPosterDiskEntry extends VideoMediaPosterResult {
  key: string;
  accessedAt: number;
}

interface ExportQueueEntry {
  job: VideoExportJob;
  request: VideoExportRequest;
  cancelled: boolean;
  resolveWait: (job: VideoExportJob) => void;
  promise: Promise<VideoExportJob>;
}

export interface VideoStudioServiceDeps {
  dataDir: string;
  projects: VideoProjects;
  engine: VideoEngineBackend;
  mediaTokens: VideoMediaTokenRegistry;
  /** Directory where visual observation PNGs are saved (computer.imageDir). */
  imageDir: string;
  /** Read VM/artifact file into bytes or temp path. */
  readWorkspaceFile?: (botId: string, path: string) => Promise<{ bytes: Buffer; name: string; resolvedPath?: string }>;
  /** Read attachment bytes by ID. */
  readAttachment?: (attachmentId: string) => { bytes: Buffer; name: string; mime?: string };
  /** Import an exported file as a chat attachment for a bot. */
  importAttachmentForBot?: (botId: string, name: string, bytes: Buffer, sourcePath?: string) => { id: string };
  /** Resolve a host path with permission checks if applicable. */
  resolveHostPath?: (rawPath: string) => string;
  /** Notify UI state listeners on project/export changes. */
  changed?: () => void;
}

function extForExportFormat(format: VideoExportFormat): string {
  switch (format) {
    case 'mp4':
      return '.mp4';
    case 'webm':
      return '.webm';
    case 'wav':
      return '.wav';
    case 'gif':
      return '.gif';
    case 'png':
      return '.png';
  }
}

function importSourceFor(source: VideoMediaSourceRef): VideoAssetImportExtendedInput['source'] {
  if (source.kind === 'host') {
    if (!source.path) throw new AppError('video.invalid_operation', '缺少 path');
    return { kind: 'host', path: source.path };
  }
  if (source.kind === 'workspace' || source.kind === 'artifact') {
    if (!source.botId || !source.path) throw new AppError('video.invalid_operation', '缺少 botId 或 path');
    return { kind: source.kind, botId: source.botId, path: source.path };
  }
  if (!source.attachmentId) throw new AppError('video.invalid_operation', '缺少 attachmentId');
  return { kind: 'attachment', attachmentId: source.attachmentId };
}

const ASPECT_PRESETS = Object.keys(VIDEO_ASPECT_DIMENSIONS) as Exclude<VideoAspectPreset, 'custom'>[];

/** Canvas that keeps a source's size, orientation and frame rate; empty when the source has no picture size. */
function canvasForMedia(
  probe: Pick<VideoMediaProbe, 'width' | 'height' | 'fps'> | undefined,
): Pick<VideoProjectCreateInput, 'aspect' | 'width' | 'height' | 'fps'> {
  if (!probe?.width || !probe.height) return {};
  // Encoders need even sizes.
  const width = Math.max(16, Math.min(8192, Math.round(probe.width / 2) * 2));
  const height = Math.max(16, Math.min(8192, Math.round(probe.height / 2) * 2));
  const aspect =
    ASPECT_PRESETS.find((key) => {
      const preset = VIDEO_ASPECT_DIMENSIONS[key];
      return Math.abs(width / height - preset.width / preset.height) < 0.01;
    }) ?? 'custom';
  const fps = probe.fps && probe.fps >= 1 && probe.fps <= 120 ? probe.fps : undefined;
  return { aspect, width, height, ...(fps ? { fps } : {}) };
}

/**
 * A video's picture and its sound sit on two tracks as two clips of the same asset at the same place. Removing silence
 * from one of them also removes it from the other, so they stay in sync.
 */
function withSilencePartners(
  operations: VideoEditRequest['operations'],
  project: () => VideoProjectDetail,
): VideoEditRequest['operations'] {
  if (!operations.some((op) => op.op === 'remove_silence')) return operations;
  const clips = project().tracks.flatMap((track) => track.clips.map((clip) => ({ ...clip, trackId: track.id })));
  const targeted = new Set(operations.flatMap((op) => (op.op === 'remove_silence' ? [op.clipId] : [])));
  const partners: VideoEditRequest['operations'] = [];
  for (const op of operations) {
    if (op.op !== 'remove_silence') continue;
    const clip = clips.find((item) => item.id === op.clipId);
    if (!clip?.assetId) continue;
    for (const other of clips) {
      if (
        targeted.has(other.id) ||
        other.trackId === clip.trackId ||
        other.assetId !== clip.assetId ||
        other.startUs !== clip.startUs ||
        other.durationUs !== clip.durationUs ||
        (other.sourceStartUs ?? 0) !== (clip.sourceStartUs ?? 0) ||
        (other.rate ?? 1) !== (clip.rate ?? 1)
      )
        continue;
      targeted.add(other.id);
      partners.push({ ...op, clipId: other.id });
    }
  }
  return [...operations, ...partners];
}

export class VideoStudioService {
  private readonly posterDir: string;
  private readonly posterMemory = new Map<string, CachedPosterDiskEntry>();
  private readonly jobs = new Map<string, ExportQueueEntry>();
  private readonly queue: ExportQueueEntry[] = [];
  private runningJob?: ExportQueueEntry;
  private cachedCapabilities?: EngineCapabilitiesResult;

  constructor(private readonly deps: VideoStudioServiceDeps) {
    this.posterDir = join(deps.dataDir, 'video-posters');
    mkdirSync(this.posterDir, { recursive: true });
  }

  get projects(): VideoProjects {
    return this.deps.projects;
  }

  get mediaTokens(): VideoMediaTokenRegistry {
    return this.deps.mediaTokens;
  }

  listProjects(filter?: { botId?: string; sessionId?: string }): VideoProjectSummary[] {
    return this.deps.projects.list(filter);
  }

  hasProjectsForBot(botId: string): boolean {
    return this.deps.projects.list({ botId }).length > 0;
  }

  getProject(id: string): VideoProjectDetail {
    return this.deps.projects.get(id);
  }

  createProject(input: VideoProjectCreateInput): VideoProjectDetail {
    const project = this.deps.projects.create(input);
    this.deps.changed?.();
    return project;
  }

  /** Canvas matching a source video or image; the default canvas when it cannot be read. */
  private async canvasFor(source: VideoMediaSourceRef): Promise<ReturnType<typeof canvasForMedia>> {
    try {
      return canvasForMedia(await this.analyzeMedia({ source }));
    } catch {
      return {};
    }
  }

  /**
   * Starts a project for editing an existing video, audio file or image: the canvas keeps the source's size and frame
   * rate (explicit `canvas` values win), the picture goes on the main video track and the sound on the voice track.
   */
  async createProjectFromMedia(input: {
    source: VideoMediaSourceRef;
    title?: string;
    botId?: string;
    sessionId?: string;
    canvas?: Omit<VideoProjectCreateInput, 'title' | 'botId' | 'sessionId'>;
  }): Promise<VideoProjectDetail> {
    const { source } = input;
    const project = this.createProject({
      title: input.title || (source.path ? basename(source.path, extname(source.path)) : 'Video Project'),
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(await this.canvasFor(source)),
      ...input.canvas,
    });
    try {
      const { asset } = await this.importAsset({
        projectId: project.id,
        source: importSourceFor(source),
        analyze: true,
      });
      const operations: VideoEditRequest['operations'] = [];
      if (asset.kind !== 'audio') {
        operations.push({ op: 'add_clip', trackId: STANDARD_TRACK_IDS.videoMain, assetId: asset.id, startUs: 0 });
      }
      if (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio)) {
        operations.push({
          op: 'add_clip',
          trackId: STANDARD_TRACK_IDS.audioVoice,
          assetId: asset.id,
          kind: 'audio',
          startUs: 0,
        });
      }
      const edited = await this.editProject({
        projectId: project.id,
        operations,
        historyLabel: 'Promote media to project',
      });
      return edited.project;
    } catch (error) {
      this.deleteProject(project.id);
      throw error;
    }
  }

  deleteProject(id: string): void {
    this.deps.projects.delete(id);
    this.deps.changed?.();
  }

  listExportsForProject(projectId: string): VideoExportJob[] {
    return [...this.jobs.values()]
      .filter((entry) => entry.job.projectId === projectId)
      .map((entry) => ({ ...entry.job }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async importAsset(
    input: VideoAssetImportExtendedInput,
  ): Promise<{ asset: VideoAssetInfo; project: VideoProjectDetail }> {
    const imported = await this.deps.projects.importAsset(input);
    if (input.analyze !== false && imported.asset.kind !== 'font' && imported.asset.kind !== 'image-sequence') {
      try {
        await this.analyzeProjectAsset(input.projectId, imported.asset.id, {
          includeWaveform: imported.asset.kind === 'audio' || imported.asset.kind === 'video',
        });
      } catch {
        // Non-fatal: import still succeeds even if Chromium engine is unavailable (e.g. headless tests)
      }
    }
    const project = this.deps.projects.get(input.projectId);
    const asset = project.assets.find((a) => a.id === imported.asset.id) ?? imported.asset;
    this.deps.changed?.();
    return { asset, project };
  }

  private async analyzeProjectAsset(
    projectId: string,
    assetId: string,
    options: {
      includeWaveform?: boolean;
      detectSilence?: boolean;
      detectBeats?: boolean;
      measureLoudness?: boolean;
    } = {},
  ): Promise<VideoMediaProbe> {
    const resolved = this.deps.projects.resolveAssetPath(projectId, assetId);
    const url = this.deps.projects.assetUrl(projectId, assetId);
    const size = statSync(resolved.path).size;
    const probe = await this.deps.engine.analyzeMedia({
      url,
      mimeType: resolved.mimeType,
      byteLength: size,
      includeWaveform: options.includeWaveform,
      detectSilence: options.detectSilence,
      detectBeats: options.detectBeats,
      measureLoudness: options.measureLoudness,
    });
    this.deps.projects.updateAssetProbe(projectId, assetId, probe);
    return probe;
  }

  async editProject(input: VideoEditRequest): Promise<VideoEditResult> {
    const request = {
      ...input,
      operations: withSilencePartners(input.operations, () => this.getProject(input.projectId)),
    };
    // Auto-run silence / beat analysis if requested operations rely on probe metadata that hasn't been gathered yet
    const needsSilence = request.operations.some((op) => op.op === 'remove_silence');
    const needsBeats = request.operations.some((op) => op.op === 'snap_to_beats');
    if (needsSilence || needsBeats) {
      try {
        const detail = this.deps.projects.get(request.projectId);
        const clipById = new Map(detail.tracks.flatMap((t) => t.clips.map((c) => [c.id, c])));
        const assetIdsToAnalyze = new Set<string>();
        for (const op of request.operations) {
          if (op.op === 'remove_silence') {
            const clip = clipById.get(op.clipId);
            if (clip?.assetId && !this.deps.projects.getAssetProbe(request.projectId, clip.assetId)?.silences) {
              assetIdsToAnalyze.add(clip.assetId);
            }
          } else if (op.op === 'snap_to_beats') {
            if (op.audioClipId) {
              const clip = clipById.get(op.audioClipId);
              if (clip?.assetId && !this.deps.projects.getAssetProbe(request.projectId, clip.assetId)?.beats) {
                assetIdsToAnalyze.add(clip.assetId);
              }
            } else {
              for (const track of detail.tracks) {
                if (track.kind !== 'audio') continue;
                if (op.audioTrackId && track.id !== op.audioTrackId) continue;
                for (const clip of track.clips) {
                  if (clip.assetId && !this.deps.projects.getAssetProbe(request.projectId, clip.assetId)?.beats) {
                    assetIdsToAnalyze.add(clip.assetId);
                  }
                }
              }
            }
          }
        }
        for (const assetId of assetIdsToAnalyze) {
          await this.analyzeProjectAsset(request.projectId, assetId, {
            detectSilence: needsSilence,
            detectBeats: needsBeats,
          });
        }
      } catch {
        // Proceed even if engine analysis fails; edit() will emit a clean warning if no silences/beats exist
      }
    }

    const result = this.deps.projects.edit(request);
    this.deps.changed?.();
    return result;
  }

  async renderFrames(input: VideoProjectFrameInput): Promise<VideoProjectFrameResult> {
    if (!Array.isArray(input.timestampsUs) || input.timestampsUs.length === 0 || input.timestampsUs.length > 24) {
      throw new AppError('video.invalid_operation', 'timestampsUs 需提供 1–24 个时间点');
    }
    const { project, revision, assets } = this.deps.projects.readProjectJson(input.projectId);
    const assetRefs: Record<string, EngineAssetRef> = {};
    for (const [id, info] of Object.entries(assets)) {
      assetRefs[id] = { url: info.url, kind: info.kind, mime: info.mime };
    }
    const rendered = await this.deps.engine.renderFrames({
      projectJson: project,
      assets: assetRefs,
      timestampsUs: input.timestampsUs,
      maxWidth: input.maxWidth ?? 640,
      contactSheet: false,
    });
    if (rendered.frames[0]?.dataUrl) {
      this.deps.projects.setProjectPoster(input.projectId, rendered.frames[0].dataUrl);
    }
    return {
      projectId: input.projectId,
      revision,
      frames: rendered.frames,
    };
  }

  async renderContactSheet(input: { projectId: string; timestampsUs: number[]; maxWidth?: number }): Promise<{
    projectId: string;
    revision: string;
    image: ScreenReference;
    frameCount: number;
    timestampsSec: number[];
  }> {
    if (!Array.isArray(input.timestampsUs) || input.timestampsUs.length === 0 || input.timestampsUs.length > 9) {
      throw new AppError('video.invalid_operation', 'timestamps 需提供 1–9 个时间点');
    }
    const { project, revision, assets } = this.deps.projects.readProjectJson(input.projectId);
    const assetRefs: Record<string, EngineAssetRef> = {};
    for (const [id, info] of Object.entries(assets)) {
      assetRefs[id] = { url: info.url, kind: info.kind, mime: info.mime };
    }
    const rendered = await this.deps.engine.renderFrames({
      projectJson: project,
      assets: assetRefs,
      timestampsUs: input.timestampsUs,
      maxWidth: input.maxWidth ?? 480,
      contactSheet: true,
    });
    if (!rendered.contactSheetPng || !rendered.contactSheetWidth || !rendered.contactSheetHeight) {
      throw new AppError('video.export_failed', '未能渲染预览帧拼图');
    }

    const outDir = join(this.deps.imageDir, 'video-frames');
    mkdirSync(outDir, { recursive: true });
    const id = randomUUID();
    writeFileSync(join(outDir, `${id}.png`), rendered.contactSheetPng);

    if (rendered.frames[0]?.dataUrl) {
      this.deps.projects.setProjectPoster(input.projectId, rendered.frames[0].dataUrl);
    }

    return {
      projectId: input.projectId,
      revision,
      image: {
        id,
        width: rendered.contactSheetWidth,
        height: rendered.contactSheetHeight,
      },
      frameCount: rendered.frames.length,
      timestampsSec: rendered.frames.map((f) => Number((f.timeUs / 1_000_000).toFixed(3))),
    };
  }

  startExport(request: VideoExportRequest): VideoExportJob {
    // Validate project exists up front
    const detail = this.deps.projects.get(request.projectId);
    const jobId = `exp_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const quality = request.quality ?? 'standard';
    const job: VideoExportJob = {
      id: jobId,
      projectId: request.projectId,
      status: 'queued',
      format: request.format,
      quality,
      progress: 0,
      stage: 'queued',
      startedAt: new Date().toISOString(),
    };
    let resolveWait!: (j: VideoExportJob) => void;
    const promise = new Promise<VideoExportJob>((resolveFn) => {
      resolveWait = resolveFn;
    });
    const entry: ExportQueueEntry = {
      job,
      request: { ...request, quality },
      cancelled: false,
      resolveWait,
      promise,
    };
    this.jobs.set(jobId, entry);
    this.queue.push(entry);
    void detail;
    this.deps.changed?.();
    this.drainExportQueue();
    return { ...job };
  }

  waitForExport(jobId: string): Promise<VideoExportJob | null> {
    const entry = this.jobs.get(jobId);
    return entry ? entry.promise : Promise.resolve(null);
  }

  exportStatus(jobId: string): VideoExportJob | null {
    const entry = this.jobs.get(jobId);
    return entry ? { ...entry.job } : null;
  }

  cancelExport(jobId: string): void {
    const entry = this.jobs.get(jobId);
    if (!entry) return;
    if (entry.job.status === 'completed' || entry.job.status === 'failed' || entry.job.status === 'cancelled') return;
    entry.cancelled = true;
    if (entry.job.status === 'queued') {
      const idx = this.queue.indexOf(entry);
      if (idx >= 0) this.queue.splice(idx, 1);
      entry.job.status = 'cancelled';
      entry.job.stage = 'cancelled';
      entry.job.endedAt = new Date().toISOString();
      entry.resolveWait({ ...entry.job });
      this.deps.changed?.();
      return;
    }
    this.deps.engine.cancelExport(jobId);
  }

  private drainExportQueue(): void {
    if (this.runningJob || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    if (next.cancelled) {
      this.drainExportQueue();
      return;
    }
    this.runningJob = next;
    void this.runExportEntry(next).finally(() => {
      if (this.runningJob === next) this.runningJob = undefined;
      this.drainExportQueue();
    });
  }

  private async runExportEntry(entry: ExportQueueEntry): Promise<void> {
    const { job, request } = entry;
    job.status = 'running';
    job.stage = 'preparing';
    this.deps.changed?.();

    try {
      const detail = this.deps.projects.get(request.projectId);
      const { project, assets } = this.deps.projects.readProjectJson(request.projectId);
      const assetRefs: Record<string, EngineAssetRef> = {};
      for (const [id, info] of Object.entries(assets)) {
        assetRefs[id] = { url: info.url, kind: info.kind, mime: info.mime };
      }

      const defaultName = `${detail.title.replace(/[^A-Za-z0-9\u4e00-\u9fff._-]+/g, '_').slice(0, 60) || 'video'}-${job.id}${extForExportFormat(request.format)}`;
      const outputPath = request.outputPath
        ? this.deps.resolveHostPath
          ? this.deps.resolveHostPath(request.outputPath)
          : resolve(request.outputPath)
        : join(this.deps.projects.exportsDir(request.projectId), defaultName);

      const res = await this.deps.engine.exportProjectToFile({
        jobId: job.id,
        projectJson: project as AelionProject,
        assets: assetRefs,
        format: request.format,
        quality: request.quality ?? 'standard',
        outputPath,
        ...(request.timeUs !== undefined ? { timeUs: request.timeUs } : {}),
        ...(request.fps !== undefined ? { fps: request.fps } : {}),
        ...(request.width !== undefined ? { width: request.width } : {}),
        ...(request.height !== undefined ? { height: request.height } : {}),
        onProgress: (evt) => {
          job.progress = Math.max(0, Math.min(1, evt.progress));
          job.stage = evt.stage;
          this.deps.changed?.();
        },
      });

      job.format = res.negotiatedFormat;
      job.negotiatedCodec = res.negotiatedCodec;
      job.outputPath = res.outputPath;
      job.progress = 1;
      job.stage = 'completed';
      job.status = 'completed';
      job.endedAt = new Date().toISOString();

      if (request.attachToChat && detail.botId && this.deps.importAttachmentForBot) {
        try {
          const st = statSync(res.outputPath);
          if (st.size <= 100 * 1024 * 1024) {
            const bytes = readFileSync(res.outputPath);
            const att = this.deps.importAttachmentForBot(detail.botId, basename(res.outputPath), bytes, res.outputPath);
            job.artifactId = att.id;
          }
        } catch {
          // Export still succeeded on disk even if attachment copy skipped
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (entry.cancelled || /abort|cancel/i.test(msg)) {
        job.status = 'cancelled';
        job.stage = 'cancelled';
      } else {
        job.status = 'failed';
        job.stage = 'failed';
        job.error = msg;
      }
      job.endedAt = new Date().toISOString();
    }

    this.deps.changed?.();
    entry.resolveWait({ ...job });
  }

  private async resolveSourceToToken(source: VideoMediaSourceRef): Promise<{
    url: string;
    mimeType: string;
    byteLength: number;
    cacheKey: string;
    release: () => void;
    hostPath?: string;
    name: string;
  }> {
    if (source.kind === 'host') {
      if (!source.path) throw new AppError('video.invalid_operation', '缺少本机文件路径');
      const full = this.deps.resolveHostPath ? this.deps.resolveHostPath(source.path) : resolve(source.path);
      if (!existsSync(full)) throw new AppError('video.asset_not_found', `文件不存在：${source.path}`);
      const st = statSync(full);
      const { mime } = inferMediaKindAndMime(full);
      const reg = this.deps.mediaTokens.registerFile(full, mime);
      const key = createHash('sha256')
        .update(`host:${full}:${st.size}:${Math.floor(st.mtimeMs)}`)
        .digest('hex');
      return {
        url: reg.url,
        mimeType: mime,
        byteLength: st.size,
        cacheKey: key,
        release: reg.release,
        hostPath: full,
        name: basename(full),
      };
    }
    if (source.kind === 'workspace' || source.kind === 'artifact') {
      if (!source.botId || !source.path) throw new AppError('video.invalid_operation', '缺少 botId 或 path');
      if (!this.deps.readWorkspaceFile) throw new AppError('video.invalid_operation', '工作区文件服务尚未就绪');
      const file = await this.deps.readWorkspaceFile(source.botId, source.path);
      const { mime } = inferMediaKindAndMime(file.name);
      const reg =
        file.resolvedPath && existsSync(file.resolvedPath)
          ? this.deps.mediaTokens.registerFile(file.resolvedPath, mime)
          : this.deps.mediaTokens.registerBuffer(file.bytes, mime);
      const hash = createHash('sha256').update(file.bytes).digest('hex');
      return {
        url: reg.url,
        mimeType: mime,
        byteLength: file.bytes.byteLength,
        cacheKey: `ws_${hash}`,
        release: reg.release,
        hostPath: file.resolvedPath,
        name: file.name,
      };
    }
    if (source.kind === 'attachment') {
      if (!source.attachmentId) throw new AppError('video.invalid_operation', '缺少 attachmentId');
      if (!this.deps.readAttachment) throw new AppError('video.invalid_operation', '附件服务尚未就绪');
      const att = this.deps.readAttachment(source.attachmentId);
      const { mime } = inferMediaKindAndMime(att.name, att.mime);
      const reg = this.deps.mediaTokens.registerBuffer(att.bytes, mime);
      const key = createHash('sha256').update(`att:${source.attachmentId}:${att.bytes.byteLength}`).digest('hex');
      return {
        url: reg.url,
        mimeType: mime,
        byteLength: att.bytes.byteLength,
        cacheKey: key,
        release: reg.release,
        name: att.name,
      };
    }
    throw new AppError('video.invalid_operation', '不支持的媒体来源');
  }

  async analyzeMedia(input: VideoMediaAnalyzeInput): Promise<VideoMediaProbe> {
    const resolved = await this.resolveSourceToToken(input.source);
    try {
      const probe = await this.deps.engine.analyzeMedia({
        url: resolved.url,
        mimeType: resolved.mimeType,
        byteLength: resolved.byteLength,
        includeFilmstrip: input.includeFilmstrip,
        filmstripCount: input.filmstripCount,
        includeWaveform: input.includeWaveform,
        waveformPoints: input.waveformPoints,
        detectSilence: input.detectSilence,
        detectBeats: input.detectBeats,
        measureLoudness: input.measureLoudness,
      });
      if (probe.posterDataUrl) {
        this.writePosterCache(resolved.cacheKey, {
          posterDataUrl: probe.posterDataUrl,
          durationSec: probe.durationUs ? Number((probe.durationUs / 1_000_000).toFixed(3)) : undefined,
          width: probe.width,
          height: probe.height,
          hasAudio: probe.hasAudio,
        });
      }
      return {
        ...probe,
        ...(input.source.path ? { path: input.source.path } : {}),
        ...(input.source.attachmentId ? { attachmentId: input.source.attachmentId } : {}),
      };
    } finally {
      resolved.release();
    }
  }

  private safeCacheKey(key: string): string {
    return key.replace(/[^A-Za-z0-9_-]/g, '_');
  }

  private readPosterCache(rawKey: string): VideoMediaPosterResult | undefined {
    const key = this.safeCacheKey(rawKey);
    const mem = this.posterMemory.get(key);
    if (mem) {
      mem.accessedAt = Date.now();
      return {
        posterDataUrl: mem.posterDataUrl,
        ...(mem.durationSec !== undefined ? { durationSec: mem.durationSec } : {}),
        ...(mem.width !== undefined ? { width: mem.width } : {}),
        ...(mem.height !== undefined ? { height: mem.height } : {}),
        ...(mem.hasAudio !== undefined ? { hasAudio: mem.hasAudio } : {}),
      };
    }
    const file = join(this.posterDir, `${key}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as CachedPosterDiskEntry;
      if (!parsed?.posterDataUrl) return undefined;
      parsed.accessedAt = Date.now();
      this.posterMemory.set(key, parsed);
      return {
        posterDataUrl: parsed.posterDataUrl,
        ...(parsed.durationSec !== undefined ? { durationSec: parsed.durationSec } : {}),
        ...(parsed.width !== undefined ? { width: parsed.width } : {}),
        ...(parsed.height !== undefined ? { height: parsed.height } : {}),
        ...(parsed.hasAudio !== undefined ? { hasAudio: parsed.hasAudio } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private writePosterCache(rawKey: string, value: VideoMediaPosterResult): void {
    const key = this.safeCacheKey(rawKey);
    const entry: CachedPosterDiskEntry = { ...value, key, accessedAt: Date.now() };
    this.posterMemory.set(key, entry);
    try {
      writeFileSync(join(this.posterDir, `${key}.json`), JSON.stringify(entry), 'utf8');
      this.prunePosterCache();
    } catch {
      // Cache write failure is non-fatal
    }
  }

  private prunePosterCache(): void {
    try {
      const files = readdirSync(this.posterDir).filter((f) => f.endsWith('.json'));
      if (files.length <= MAX_POSTER_CACHE_ENTRIES) return;
      const stats = files
        .map((f) => {
          const p = join(this.posterDir, f);
          return { p, key: f.slice(0, -5), mtime: statSync(p).mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
      for (const old of stats.slice(0, stats.length - MAX_POSTER_CACHE_ENTRIES)) {
        this.posterMemory.delete(old.key);
        try {
          unlinkSync(old.p);
        } catch {}
      }
    } catch {}
  }

  getCachedMediaMetaForFile(filePath: string): VideoMediaPosterResult | undefined {
    try {
      if (!existsSync(filePath)) return undefined;
      const st = statSync(filePath);
      const key = createHash('sha256')
        .update(`host:${filePath}:${st.size}:${Math.floor(st.mtimeMs)}`)
        .digest('hex');
      return this.readPosterCache(key);
    } catch {
      return undefined;
    }
  }

  async mediaPoster(input: VideoMediaPosterInput): Promise<VideoMediaPosterResult | null> {
    const resolved = await this.resolveSourceToToken(input.source);
    const cacheKey =
      input.timeSec === undefined && (input.maxWidth === undefined || input.maxWidth === 480)
        ? resolved.cacheKey
        : createHash('sha256')
            .update(`${resolved.cacheKey}:${input.timeSec ?? 'auto'}:${input.maxWidth ?? 480}`)
            .digest('hex');
    const cached = this.readPosterCache(cacheKey);
    if (cached) {
      resolved.release();
      return cached;
    }
    try {
      const probe = await this.deps.engine.analyzeMedia({
        url: resolved.url,
        mimeType: resolved.mimeType,
        byteLength: resolved.byteLength,
        posterTimeSec: input.timeSec,
        maxPosterWidth: input.maxWidth ?? 480,
      });
      if (!probe.posterDataUrl) return null;
      const result: VideoMediaPosterResult = {
        posterDataUrl: probe.posterDataUrl,
        ...(probe.durationUs ? { durationSec: Number((probe.durationUs / 1_000_000).toFixed(3)) } : {}),
        ...(probe.width !== undefined ? { width: probe.width } : {}),
        ...(probe.height !== undefined ? { height: probe.height } : {}),
        hasAudio: probe.hasAudio,
      };
      this.writePosterCache(cacheKey, result);
      return result;
    } catch {
      return null;
    } finally {
      resolved.release();
    }
  }

  async quickEdit(request: VideoQuickEditRequest): Promise<VideoQuickEditResult> {
    const { source, edit } = request;

    if (edit.action === 'promote_to_project') {
      const project = await this.createProjectFromMedia({
        source,
        ...(edit.title ? { title: edit.title } : {}),
        ...((edit.botId ?? source.botId) ? { botId: edit.botId ?? source.botId } : {}),
        ...(edit.sessionId ? { sessionId: edit.sessionId } : {}),
      });
      return { action: 'promote_to_project', project };
    }

    if (edit.action === 'capture_frame') {
      const poster = await this.mediaPoster({ source, timeSec: edit.timeSec, maxWidth: 1920 });
      if (!poster) throw new AppError('video.export_failed', '未能提取视频帧');
      let outputPath: string | undefined;
      if (edit.outputPath) {
        const resolvedOut = this.deps.resolveHostPath
          ? this.deps.resolveHostPath(edit.outputPath)
          : resolve(edit.outputPath);
        mkdirSync(join(resolvedOut, '..'), { recursive: true });
        const b64 = poster.posterDataUrl.replace(/^data:image\/\w+;base64,/, '');
        writeFileSync(resolvedOut, Buffer.from(b64, 'base64'));
        outputPath = resolvedOut;
      }
      return { action: 'capture_frame', outputPath, posterDataUrl: poster.posterDataUrl };
    }

    // For trim / remove_silence: create a temporary project, edit, export, and clean up temp project
    const tmpProject = this.deps.projects.create({
      title: `quick-${edit.action}`,
      botId: source.botId,
      ...(await this.canvasFor(source)),
    });
    try {
      const { asset } = await this.importAsset({
        projectId: tmpProject.id,
        source: importSourceFor(source),
        analyze: true,
      });
      const durationUs = asset.durationUs ?? 3_000_000;
      let removedSec: number | undefined;

      if (edit.action === 'trim') {
        const startUs = Math.max(0, Math.round(edit.startSec * 1_000_000));
        const endUs = Math.min(durationUs, Math.round(edit.endSec * 1_000_000));
        if (endUs <= startUs) throw new AppError('video.invalid_operation', '结束时间必须大于开始时间');
        const trimDur = endUs - startUs;
        const ops: VideoEditRequest['operations'] = [];
        if (asset.kind === 'audio') {
          ops.push({
            op: 'add_clip',
            trackId: STANDARD_TRACK_IDS.audioVoice,
            assetId: asset.id,
            kind: 'audio',
            startUs: 0,
            sourceStartUs: startUs,
            durationUs: trimDur,
          });
        } else {
          ops.push({
            op: 'add_clip',
            trackId: STANDARD_TRACK_IDS.videoMain,
            assetId: asset.id,
            startUs: 0,
            sourceStartUs: startUs,
            durationUs: trimDur,
          });
          if (asset.hasAudio) {
            ops.push({
              op: 'add_clip',
              trackId: STANDARD_TRACK_IDS.audioVoice,
              assetId: asset.id,
              kind: 'audio',
              startUs: 0,
              sourceStartUs: startUs,
              durationUs: trimDur,
            });
          }
        }
        await this.editProject({ projectId: tmpProject.id, operations: ops });
      } else {
        // remove_silence
        await this.analyzeProjectAsset(tmpProject.id, asset.id, { detectSilence: true });
        const ops: VideoEditRequest['operations'] = [];
        if (asset.kind === 'audio') {
          ops.push({
            op: 'add_clip',
            clipId: 'main_audio',
            trackId: STANDARD_TRACK_IDS.audioVoice,
            assetId: asset.id,
            kind: 'audio',
            startUs: 0,
          });
          ops.push({
            op: 'remove_silence',
            clipId: 'main_audio',
            thresholdDb: edit.thresholdDb,
            minimumSilenceUs: edit.minimumSilenceMs !== undefined ? edit.minimumSilenceMs * 1000 : undefined,
            paddingUs: edit.paddingMs !== undefined ? edit.paddingMs * 1000 : undefined,
          });
        } else {
          ops.push({
            op: 'add_clip',
            clipId: 'main_video',
            trackId: STANDARD_TRACK_IDS.videoMain,
            assetId: asset.id,
            startUs: 0,
          });
          ops.push({
            op: 'remove_silence',
            clipId: 'main_video',
            thresholdDb: edit.thresholdDb,
            minimumSilenceUs: edit.minimumSilenceMs !== undefined ? edit.minimumSilenceMs * 1000 : undefined,
            paddingUs: edit.paddingMs !== undefined ? edit.paddingMs * 1000 : undefined,
          });
          if (asset.hasAudio) {
            ops.push({
              op: 'add_clip',
              clipId: 'main_audio',
              trackId: STANDARD_TRACK_IDS.audioVoice,
              assetId: asset.id,
              kind: 'audio',
              startUs: 0,
            });
            ops.push({
              op: 'remove_silence',
              clipId: 'main_audio',
              thresholdDb: edit.thresholdDb,
              minimumSilenceUs: edit.minimumSilenceMs !== undefined ? edit.minimumSilenceMs * 1000 : undefined,
              paddingUs: edit.paddingMs !== undefined ? edit.paddingMs * 1000 : undefined,
            });
          }
        }
        const edited = await this.editProject({ projectId: tmpProject.id, operations: ops });
        removedSec = Math.max(0, Number(((durationUs - edited.project.durationUs) / 1_000_000).toFixed(3)));
      }

      const fmt = edit.format ?? (asset.kind === 'audio' ? 'wav' : 'mp4');
      const fallbackOut = join(
        this.deps.dataDir,
        'video-quick-exports',
        `${edit.action}-${randomUUID().slice(0, 8)}${extForExportFormat(fmt)}`,
      );
      const started = this.startExport({
        projectId: tmpProject.id,
        format: fmt,
        quality: edit.quality ?? 'standard',
        outputPath: edit.outputPath ?? fallbackOut,
      });
      const finished = (await this.waitForExport(started.id)) ?? started;
      if (finished.status !== 'completed') {
        throw new AppError('video.export_failed', finished.error || '快捷导出失败');
      }
      return {
        action: edit.action,
        outputPath: finished.outputPath,
        job: finished,
        ...(removedSec !== undefined ? { removedSec } : {}),
      };
    } finally {
      try {
        this.deps.projects.delete(tmpProject.id);
      } catch {}
    }
  }

  async engineState(): Promise<VideoEngineState> {
    let caps = this.cachedCapabilities;
    if (!caps) {
      try {
        caps = await this.deps.engine.capabilities();
        this.cachedCapabilities = caps;
      } catch {
        caps = {
          supportedExportFormats: ['wav', 'gif', 'png'],
          codecs: { h264: false, vp9: false, av1: false, hevc: false, aac: false, opus: false },
        };
      }
    }
    return {
      ready: this.deps.engine.isReady(),
      runtimeOrigin: `${VIDEO_ENGINE_SCHEME}://engine`,
      supportedExportFormats: caps.supportedExportFormats,
      codecs: caps.codecs,
      activeExports: [...this.jobs.values()]
        .filter((e) => e.job.status === 'queued' || e.job.status === 'running')
        .map((e) => ({ ...e.job })),
      projectCount: this.deps.projects.list().length,
    };
  }

  dispose(): void {
    for (const entry of this.jobs.values()) {
      if (entry.job.status === 'queued' || entry.job.status === 'running') {
        this.cancelExport(entry.job.id);
      }
    }
    this.deps.engine.dispose();
    this.deps.mediaTokens.clear();
  }
}
