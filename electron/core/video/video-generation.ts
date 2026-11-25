import { setTimeout as wait } from 'node:timers/promises';
import { ATTACHMENT_LIMITS } from '../../../shared/types/attachment-types';
import { AppError } from '../../../shared/errors';
import {
  mediaRequest as request,
  mediaJson as json,
  downloadMedia as download,
  mediaDiagnostic as diagnostic,
} from '../model/media-http';
import { uploadHiggsfieldReference } from '../model/higgsfield';
import { videoPlan, type VideoAccess, type VideoJob } from './video-protocols';

const completed = new Set(['completed', 'succeeded', 'succeed', 'success', 'done']);
const pending = new Set([
  'submitted',
  'created',
  'processing',
  'queued',
  'pending',
  'running',
  'in_progress',
  'preparing',
  'queueing',
  'generating',
  'throttled',
  'dreaming',
  'staging',
  'scheduled',
  'in_queue',
  'inprogress',
  'starting',
]);
const terminalErrors = new Set([
  'video.task_failed',
  'video.result_too_large',
  'video.invalid_output',
  'video.missing_output',
  'video.file_failed',
  'video.invalid_download',
]);
const MAX_POLL_NETWORK_RETRIES = 3;
async function pollRequest(
  spec: { url: string; body?: Record<string, unknown> | FormData; headers?: Record<string, string> },
  headers: Record<string, string>,
  signal: AbortSignal,
) {
  let networkErrors = 0;
  for (;;) {
    let response: Response;
    try {
      response = await request(spec, headers, signal);
      networkErrors = 0;
    } catch (error) {
      if (signal.aborted || ++networkErrors > MAX_POLL_NETWORK_RETRIES) throw error;
      await wait(Math.min(5000, 1000 * 2 ** (networkErrors - 1)), undefined, { signal });
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      await wait(5000, undefined, { signal });
      continue;
    }
    return response;
  }
}
export async function generateVideo(access: VideoAccess, job: VideoJob, signal: AbortSignal, resumeId?: string) {
  const origin = new URL(access.baseUrl).origin;
  const budget = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
  if (access.protocol === 'higgsfield' && job.source?.bytes && job.source.mime)
    job = resumeId
      ? { ...job, source: undefined }
      : {
          ...job,
          source: {
            kind: job.source.kind,
            url: await uploadHiggsfieldReference(access, { bytes: job.source.bytes, mime: job.source.mime }, budget),
          },
        };
  const plan = videoPlan(access, job);
  const metadataLimit =
    access.protocol === 'vertex' || access.protocol === 'gemini'
      ? Math.ceil((ATTACHMENT_LIMITS.fileBytes * 4) / 3) + 65536
      : 2 * 1024 * 1024;
  let taskId = resumeId;
  if (!taskId) {
    const data = await json(await request(plan.submit, plan.headers(), budget), 2 * 1024 * 1024, access);
    const id = plan.id(data);
    if (typeof id !== 'string' || !id.trim() || id.length > 2048)
      throw new AppError('video.submission_invalid', '服务未返回视频任务 ID' + diagnostic(data, access));
    taskId = id;
  }
  if (taskId === '.' || taskId === '..' || /[\u0000-\u001f]/.test(taskId))
    throw new AppError('video.task_invalid', '视频任务 ID 无效');
  const id = encodeURIComponent(taskId);
  try {
    for (;;) {
      const response = await pollRequest(plan.poll(id), plan.headers(), budget);
      const data = await json(response, metadataLimit, access);
      const result = plan.result(data, id);
      const state = String(result.status || '').toLowerCase();
      if (completed.has(state)) {
        let bytes: Buffer;
        if (result.contentPath) {
          bytes = await download(result.contentPath, budget, origin, plan.headers());
        } else if (typeof result.base64 === 'string') {
          bytes = Buffer.from(result.base64, 'base64');
        } else {
          let url = result.url;
          if (result.resultPath) {
            const output = await json(
              await request({ url: result.resultPath }, plan.headers(), budget),
              2 * 1024 * 1024,
              access,
            );
            url = output.video?.url || output.videos?.[0]?.url;
          }
          if (result.fileId && access.protocol === 'minimax') {
            const fileUrl = new URL(plan.submit.url);
            fileUrl.pathname = fileUrl.pathname.replace(/\/video_generation$/, '/files/retrieve');
            fileUrl.searchParams.set('file_id', String(result.fileId));
            const file = await json(
              await request({ url: fileUrl.href }, plan.headers(), budget),
              2 * 1024 * 1024,
              access,
            );
            url = file.file?.download_url;
          }
          if (typeof url !== 'string' || !url)
            throw new AppError('video.missing_output', '任务已完成，但服务未返回视频');
          if (access.protocol === 'gemini') {
            const fileId = /^(?:https?:\/\/[^/]+\/v1beta\/)?files\/([a-zA-Z0-9_-]+)$/.exec(url)?.[1];
            if (fileId) {
              const fileBase = plan.submit.url.replace(/\/interactions$/, '/files/' + fileId);
              for (;;) {
                const file = await json(await pollRequest({ url: fileBase }, plan.headers(), budget), 65536, access);
                if (file.state === 'ACTIVE') break;
                if (file.state !== 'PROCESSING') throw new AppError('video.file_failed', '生成文件处理失败');
                await wait(3500, undefined, { signal: budget });
              }
              bytes = await download(fileBase + ':download?alt=media', budget, origin, plan.headers());
            } else bytes = await download(url, budget, origin);
          } else bytes = await download(url, budget, origin);
        }
        if (bytes.length > ATTACHMENT_LIMITS.fileBytes)
          throw new AppError('video.result_too_large', '生成的视频超过单个附件大小限制');
        const mp4 = bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
        const webm = bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
        if (!mp4 && !webm) throw new AppError('video.invalid_output', '返回内容不是可识别的视频文件');
        return { taskId, bytes, extension: mp4 ? 'mp4' : 'webm' };
      }
      if (!pending.has(state))
        throw new AppError(
          'video.task_failed',
          '视频任务失败或状态无效：' + state.replace(/[^a-z0-9_-]/g, '').slice(0, 40) + diagnostic(data, access),
        );
      await wait(3500, undefined, { signal: budget });
    }
  } catch (error) {
    if (signal.aborted || (error instanceof AppError && terminalErrors.has(error.code))) throw error;
    throw new AppError(
      error instanceof AppError ? error.code : 'video.interrupted',
      (error instanceof AppError ? error.message : '视频任务查询中断') +
        '（taskId: ' +
        taskId +
        '）。可以用相同参数和 taskId 查询原任务。',
      { cause: error },
    );
  }
}
