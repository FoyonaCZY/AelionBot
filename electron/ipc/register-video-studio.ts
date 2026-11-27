// Registers all 13 Video Studio IPC handlers (video:*) against IpcContext.
import { AppError } from '../../shared/errors';
import type { IpcContext } from './context';

function requireVideoStudio(ctx: IpcContext) {
  if (!ctx.videoStudio) throw new AppError('video.engine_unavailable', '视频工作室引擎尚未就绪');
  return ctx.videoStudio;
}

export function registerVideoStudio(ctx: IpcContext) {
  ctx.handle('videoProjectsList', (input) => requireVideoStudio(ctx).listProjects(input));
  ctx.handle('videoProjectGet', (id) => requireVideoStudio(ctx).getProject(id));
  ctx.handle('videoProjectCreate', (input) => requireVideoStudio(ctx).createProject(input));
  ctx.handle('videoProjectDelete', (id) => requireVideoStudio(ctx).deleteProject(id));
  ctx.handle('videoAssetImport', (input) => requireVideoStudio(ctx).importAsset(input));
  ctx.handle('videoProjectEdit', (input) => requireVideoStudio(ctx).editProject(input));
  ctx.handle('videoProjectExport', (input) => requireVideoStudio(ctx).startExport(input));
  ctx.handle('videoExportStatus', (jobId) => requireVideoStudio(ctx).exportStatus(jobId));
  ctx.handle('videoExportCancel', (jobId) => requireVideoStudio(ctx).cancelExport(jobId));
  ctx.handle('videoMediaAnalyze', (input) => requireVideoStudio(ctx).analyzeMedia(input));
  ctx.handle('videoQuickEdit', (input) => requireVideoStudio(ctx).quickEdit(input));
  ctx.handle('videoProjectFrame', (input) => requireVideoStudio(ctx).renderFrames(input));
  ctx.handle('videoMediaPoster', (input) => requireVideoStudio(ctx).mediaPoster(input));
}
