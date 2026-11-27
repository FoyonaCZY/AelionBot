// Tool handlers for the 7 AelionSDK Video Studio creative tools.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { AppError } from '../../../../../shared/errors';
import type {
  VideoAspectPreset,
  VideoEditOperation,
  VideoExportFormat,
  VideoExportQuality,
  VideoProjectDetail,
} from '../../../../../shared/types/video-studio-types';
import type { VideoAssetImportExtendedInput } from '../../../video/video-projects';
import { VIDEO_STUDIO_TOOLS as VIDEO_STUDIO_DEFERRED_SET } from '../../tool-loading';
import type { ToolContext, ToolHandler } from '../context';
import { requiredText } from '../validation';
import { attachToReply } from './attachments';

function requireVideoStudio(context: ToolContext) {
  if (!context.deps.videoStudio) {
    throw new AppError('video.engine_unavailable', '视频工作室引擎尚未就绪');
  }
  return context.deps.videoStudio;
}

function assertBotOwnsProject(
  studio: NonNullable<ToolContext['deps']['videoStudio']>,
  botId: string,
  projectId: string,
): VideoProjectDetail {
  const project = studio.getProject(projectId);
  if (project.botId && project.botId !== botId) {
    throw new AppError('video.project_not_found', `未找到视频项目：${projectId}`);
  }
  return project;
}

function summarizeProjectForModel(project: VideoProjectDetail, includeProjectJson = false) {
  return {
    projectId: project.id,
    title: project.title,
    aspect: project.aspect,
    width: project.width,
    height: project.height,
    fps: project.fps,
    sampleRate: project.sampleRate,
    durationUs: project.durationUs,
    durationSec: Number((project.durationUs / 1_000_000).toFixed(3)),
    revision: project.revision,
    canUndo: project.canUndo,
    canRedo: project.canRedo,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      name: track.name,
      role: track.role,
      enabled: track.enabled,
      locked: track.locked,
      ...(track.muted !== undefined ? { muted: track.muted } : {}),
      ...(track.solo !== undefined ? { solo: track.solo } : {}),
      ...(track.gainDb !== undefined ? { gainDb: track.gainDb } : {}),
      clips: track.clips.map((clip) => ({
        id: clip.id,
        kind: clip.kind,
        ...(clip.name ? { name: clip.name } : {}),
        ...(clip.assetId ? { assetId: clip.assetId } : {}),
        startUs: clip.startUs,
        durationUs: clip.durationUs,
        ...(clip.sourceStartUs !== undefined ? { sourceStartUs: clip.sourceStartUs } : {}),
        ...(clip.rate !== undefined && clip.rate !== 1 ? { rate: clip.rate } : {}),
        ...(clip.text !== undefined ? { text: clip.text } : {}),
        ...(clip.effects?.length
          ? { effects: clip.effects.map((e) => ({ preset: e.preset, enabled: e.enabled, intensity: e.intensity })) }
          : {}),
        ...(clip.transitionIn ? { transitionIn: clip.transitionIn } : {}),
        ...(clip.transitionOut ? { transitionOut: clip.transitionOut } : {}),
      })),
    })),
    assets: project.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      ...(asset.durationUs !== undefined ? { durationUs: asset.durationUs } : {}),
      ...(asset.width !== undefined ? { width: asset.width } : {}),
      ...(asset.height !== undefined ? { height: asset.height } : {}),
      ...(asset.fps !== undefined ? { fps: asset.fps } : {}),
      ...(asset.hasAudio !== undefined ? { hasAudio: asset.hasAudio } : {}),
    })),
    ...(project.recentExports?.length ? { recentExports: project.recentExports.slice(0, 5) } : {}),
    ...(includeProjectJson ? { projectJson: project.projectJson } : {}),
  };
}

export const VIDEO_STUDIO_HANDLERS: Record<string, ToolHandler> = {
  video_project_create: (context) => {
    const studio = requireVideoStudio(context);
    const { bot, args, run, runId, deps } = context;
    const project = studio.createProject({
      botId: bot.id,
      ...(run?.sessionId ? { sessionId: run.sessionId } : {}),
      ...(typeof args.title === 'string' && args.title.trim() ? { title: args.title.trim() } : {}),
      ...(typeof args.aspect === 'string' ? { aspect: args.aspect as VideoAspectPreset } : {}),
      ...(typeof args.width === 'number' ? { width: args.width } : {}),
      ...(typeof args.height === 'number' ? { height: args.height } : {}),
      ...(typeof args.fps === 'number' ? { fps: args.fps } : {}),
      ...(args.sampleRate === 44100 || args.sampleRate === 48000 || args.sampleRate === 96000
        ? { sampleRate: args.sampleRate }
        : {}),
      ...(typeof args.backgroundColor === 'string' ? { backgroundColor: args.backgroundColor } : {}),
    });
    const activated = deps.activateTools?.(runId, VIDEO_STUDIO_DEFERRED_SET) ?? [];
    return {
      ...summarizeProjectForModel(project),
      ...(activated.length ? { activatedTools: activated } : {}),
      message:
        'Video project created. Import assets with video_asset_import, edit timeline with video_edit, visually check frames with video_preview_frame, and open interactively with open_preview(videoProjectId).',
    };
  },

  video_project_inspect: (context) => {
    const studio = requireVideoStudio(context);
    const projectId = requiredText(context.args, 'projectId', 128);
    const project = assertBotOwnsProject(studio, context.bot.id, projectId);
    return summarizeProjectForModel(project, Boolean(context.args.includeProjectJson));
  },

  video_asset_import: async (context) => {
    const studio = requireVideoStudio(context);
    const { bot, args, workspace, signal, runId, deps } = context;
    const projectId = requiredText(args, 'projectId', 128);
    assertBotOwnsProject(studio, bot.id, projectId);
    const rawKind = typeof args.sourceKind === 'string' ? args.sourceKind : undefined;
    const rawPath = typeof args.path === 'string' ? args.path.trim() : undefined;
    const attachmentId = typeof args.attachmentId === 'string' ? args.attachmentId.trim() : undefined;
    const designSessionId = typeof args.designSessionId === 'string' ? args.designSessionId.trim() : undefined;

    let source: VideoAssetImportExtendedInput['source'];
    if (rawKind === 'attachment' || (!rawKind && attachmentId)) {
      if (!attachmentId) throw new AppError('video.invalid_operation', '导入附件素材需要 attachmentId');
      try {
        deps.attachments.forBot(bot.id, [attachmentId]);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError('video.asset_not_found', `未找到附件素材：${attachmentId}`);
      }
      source = { kind: 'attachment', attachmentId };
    } else if (rawKind === 'design' || (!rawKind && designSessionId)) {
      if (!rawPath) throw new AppError('video.invalid_operation', '导入设计稿需要 path');
      source = {
        kind: 'design',
        path: rawPath,
        botId: bot.id,
        ...(designSessionId ? { sessionId: designSessionId } : {}),
      };
    } else if (rawKind === 'workspace' || rawKind === 'artifact') {
      if (!rawPath) throw new AppError('video.invalid_operation', '导入工作区素材需要 path');
      const prefix = `/work/${bot.id}/`;
      const rel = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
      source = { kind: rawKind, botId: bot.id, path: rel };
    } else if (rawKind === 'host' || rawPath) {
      if (!rawPath) throw new AppError('video.invalid_operation', '请提供 path 或 attachmentId');
      const prefix = `/work/${bot.id}/`;
      if (!rawKind && rawPath.startsWith(prefix)) {
        source = { kind: 'workspace', botId: bot.id, path: rawPath.slice(prefix.length) };
      } else {
        const resolved = deps.host ? deps.host.resolveFilePath(rawPath, workspace) : rawPath;
        if (deps.interactions) {
          await deps.interactions.permission(
            bot.id,
            runId,
            { operation: 'read_file', reason: '导入本机素材到视频项目', path: resolved, tool: 'video_asset_import' },
            signal,
          );
          signal.throwIfAborted();
        }
        source = { kind: 'host', path: resolved };
      }
    } else {
      throw new AppError('video.invalid_operation', '请提供 path 或 attachmentId');
    }

    const { asset, project } = await studio.importAsset({
      projectId,
      source,
      ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name.trim() } : {}),
      ...(typeof args.assetId === 'string' && args.assetId.trim() ? { assetId: args.assetId.trim() } : {}),
      ...(typeof args.analyze === 'boolean' ? { analyze: args.analyze } : {}),
    });

    return {
      projectId: project.id,
      revision: project.revision,
      asset: {
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        mimeType: asset.mimeType,
        byteLength: asset.byteLength,
        ...(asset.durationUs !== undefined ? { durationUs: asset.durationUs } : {}),
        ...(asset.width !== undefined ? { width: asset.width } : {}),
        ...(asset.height !== undefined ? { height: asset.height } : {}),
        ...(asset.fps !== undefined ? { fps: asset.fps } : {}),
        ...(asset.hasAudio !== undefined ? { hasAudio: asset.hasAudio } : {}),
      },
    };
  },

  video_edit: async (context) => {
    const studio = requireVideoStudio(context);
    const { bot, args } = context;
    const projectId = requiredText(args, 'projectId', 128);
    assertBotOwnsProject(studio, bot.id, projectId);
    if (!Array.isArray(args.operations) || args.operations.length === 0) {
      throw new AppError('video.invalid_operation', 'operations 必须是非空数组');
    }
    const result = await studio.editProject({
      projectId,
      ...(args.expectedRevision !== undefined ? { expectedRevision: String(args.expectedRevision) } : {}),
      ...(typeof args.historyLabel === 'string' ? { historyLabel: args.historyLabel } : {}),
      operations: args.operations as VideoEditOperation[],
    });
    return {
      ...summarizeProjectForModel(result.project),
      applied: result.applied,
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    };
  },

  video_preview_frame: async (context) => {
    const studio = requireVideoStudio(context);
    const { bot, args } = context;
    const projectId = requiredText(args, 'projectId', 128);
    const detail = assertBotOwnsProject(studio, bot.id, projectId);

    let timestampsUs: number[];
    if (Array.isArray(args.timestampsSec) && args.timestampsSec.length > 0) {
      timestampsUs = (args.timestampsSec as number[]).slice(0, 9).map((sec) => {
        if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) {
          throw new AppError('video.invalid_operation', 'timestampsSec 必须是非负数字');
        }
        return Math.round(sec * 1_000_000);
      });
    } else {
      const dur = Math.max(1_000_000, detail.durationUs);
      const count = detail.durationUs > 2_000_000 ? 4 : 2;
      timestampsUs = Array.from({ length: count }, (_, idx) =>
        Math.round(((idx + 0.5) / count) * Math.max(1, dur - 1)),
      );
    }

    const maxWidth = typeof args.maxWidth === 'number' ? Math.max(160, Math.min(1280, Math.round(args.maxWidth))) : 480;
    const sheet = await studio.renderContactSheet({
      projectId,
      timestampsUs,
      maxWidth,
    });

    return {
      projectId: sheet.projectId,
      revision: sheet.revision,
      frameCount: sheet.frameCount,
      timestampsSec: sheet.timestampsSec,
      images: [sheet.image],
      message: `Rendered ${sheet.frameCount} composited frame(s) into a timestamped contact sheet for visual verification.`,
    };
  },

  video_export: async (context) => {
    const studio = requireVideoStudio(context);
    const { bot, args, workspace, signal, runId, deps } = context;
    const projectId = requiredText(args, 'projectId', 128);
    assertBotOwnsProject(studio, bot.id, projectId);
    const format = (typeof args.format === 'string' ? args.format : 'mp4') as VideoExportFormat;
    const quality = (typeof args.quality === 'string' ? args.quality : 'standard') as VideoExportQuality;
    const outputPath =
      typeof args.outputPath === 'string' && args.outputPath.trim()
        ? deps.host
          ? deps.host.resolveFilePath(args.outputPath.trim(), workspace)
          : args.outputPath.trim()
        : undefined;
    if (outputPath && deps.interactions) {
      await deps.interactions.permission(
        bot.id,
        runId,
        {
          operation: 'write_file',
          reason: '导出视频文件到本机路径',
          path: outputPath,
          overwrite: true,
          tool: 'video_export',
        },
        signal,
      );
      signal.throwIfAborted();
    }
    const attachToChat = Boolean(args.attachToChat);

    const started = studio.startExport({
      projectId,
      format,
      quality,
      ...(outputPath ? { outputPath } : {}),
      attachToChat: false, // Attach cleanly to this run's reply below if requested
      ...(typeof args.timeSec === 'number' ? { timeUs: Math.max(0, Math.round(args.timeSec * 1_000_000)) } : {}),
      ...(typeof args.fps === 'number' ? { fps: args.fps } : {}),
      ...(typeof args.width === 'number' ? { width: args.width } : {}),
      ...(typeof args.height === 'number' ? { height: args.height } : {}),
    });

    let job = started;
    if (args.wait !== false) {
      const waitPromise = studio.waitForExport(started.id);
      const timeoutPromise = new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 15_000);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(null);
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const finished = await Promise.race([waitPromise, timeoutPromise]);
      if (finished) job = finished;
      else job = studio.exportStatus(started.id) ?? started;
    }

    let attachmentId: string | undefined;
    let attachedToReply = false;
    if (attachToChat && job.status === 'completed' && job.outputPath) {
      try {
        const st = statSync(job.outputPath);
        if (st.size <= 100 * 1024 * 1024) {
          const bytes = readFileSync(job.outputPath);
          const { file, attached } = attachToReply(context, basename(job.outputPath), bytes);
          deps.store.save();
          attachmentId = file.id;
          attachedToReply = attached;
        }
      } catch {
        // Export output remains available at job.outputPath
      }
    }

    return {
      job,
      ...(attachmentId ? { attachmentId, attachedToReply } : {}),
      ...(job.status === 'queued' || job.status === 'running'
        ? { message: `Export job ${job.id} is ${job.status}. Poll progress with video_export_status.` }
        : job.status === 'completed'
          ? { message: `Export completed: ${job.outputPath}` }
          : { message: `Export ${job.status}: ${job.error || ''}`.trim() }),
    };
  },

  video_export_status: (context) => {
    const studio = requireVideoStudio(context);
    const jobId = requiredText(context.args, 'jobId', 128);
    const existing = studio.exportStatus(jobId);
    if (!existing) throw new AppError('video.invalid_operation', `未找到导出任务：${jobId}`);
    assertBotOwnsProject(studio, context.bot.id, existing.projectId);
    if (context.args.cancel === true) {
      studio.cancelExport(jobId);
    }
    const status = studio.exportStatus(jobId);
    if (!status) throw new AppError('video.invalid_operation', `未找到导出任务：${jobId}`);
    return { job: status };
  },
};
