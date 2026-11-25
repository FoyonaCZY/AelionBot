import { setTimeout as wait } from 'node:timers/promises';
import { ATTACHMENT_LIMITS } from '../../../shared/types/attachment-types';
import { AppError } from '../../../shared/errors';
import { requestPublicBytes } from '../tools/web-tools';
import { modelFetch } from '../model/model-http';
import { higgsfieldBaseUrl, videoPlan, type VideoAccess, type VideoJob, type VideoRequest } from './video-protocols';

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
async function readBytes(response: Response, limit: number) {
  if (!response.body) throw new AppError('video.empty_response', '视频服务返回空响应');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new AppError('video.result_too_large', '视频服务返回的数据超过附件大小限制');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
async function request(spec: VideoRequest, headers: Record<string, string>, signal: AbortSignal) {
  const form = spec.body instanceof FormData;
  return modelFetch(spec.url, {
    method: spec.body ? 'POST' : 'GET',
    redirect: 'manual',
    signal,
    headers: { ...headers, ...(spec.body && !form ? { 'content-type': 'application/json' } : {}), ...spec.headers },
    body: form ? (spec.body as FormData) : spec.body ? JSON.stringify(spec.body) : undefined,
  });
}
function diagnostic(data: any, access: VideoAccess) {
  const reason =
    data?.error?.message ||
    data?.base_resp?.status_msg ||
    data?.message ||
    data?.task?.error?.message ||
    data?.data?.task_status_msg ||
    data?.output?.message ||
    data?.failure ||
    data?.failure_reason;
  if (typeof reason !== 'string') return '';
  let text = reason.replace(/https?:\/\/\S+|data:[^\s]+/gi, '[URL]');
  for (const secret of [
    access.key,
    ...(['kling', 'higgsfield'].includes(access.protocol) ? access.key.split(':') : []),
  ])
    if (secret) text = text.replaceAll(secret, '***');
  return ' · ' + text.replace(/[\r\n]/g, ' ').slice(0, 350);
}
async function json(response: Response, limit: number, access: VideoAccess) {
  if (!response.ok) {
    let detail = '';
    try {
      detail = diagnostic(JSON.parse((await readBytes(response, 65536)).toString('utf8')), access);
    } catch {}
    throw new AppError('video.http_error', '视频服务返回 HTTP ' + response.status + detail);
  }
  const bytes = await readBytes(response, limit);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AppError('video.invalid_response', '视频服务返回了无效的 JSON');
  }
}
async function download(url: string, signal: AbortSignal, origin: string, headers: Record<string, string> = {}) {
  // Only an adapter-constructed content endpoint carries credentials. CDN redirects never inherit them.
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.origin === origin))
    )
      throw new AppError('video.invalid_download', '视频下载地址无效');
    if (parsed.origin !== origin) {
      const response = await requestPublicBytes(url, {}, signal, ATTACHMENT_LIMITS.fileBytes, 120000);
      if (response.status < 200 || response.status >= 300)
        throw new AppError('video.download_failed', '下载视频失败 HTTP ' + response.status);
      return response.bytes;
    }
    const response = await request({ url }, headers, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) break;
      url = new URL(location, url).href;
      if (new URL(url).origin !== origin) headers = {};
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError('video.download_failed', '下载视频失败 HTTP ' + response.status);
    }
    return readBytes(response, ATTACHMENT_LIMITS.fileBytes);
  }
  throw new AppError('video.invalid_download', '视频下载重定向无效');
}

/** Upload local references to the provider's signed storage URL before submitting the model request. */
async function uploadHiggsfieldSource(access: VideoAccess, job: VideoJob, signal: AbortSignal): Promise<VideoJob> {
  const source = job.source;
  if (!source?.bytes || !source.mime) return job;
  const signed = await json(
    await request(
      { url: higgsfieldBaseUrl(access.baseUrl) + '/files/generate-upload-url', body: { content_type: source.mime } },
      { Authorization: 'Key ' + access.key },
      signal,
    ),
    65536,
    access,
  );
  const origin = new URL(access.baseUrl).origin;
  const validate = (value: unknown) => {
    if (typeof value !== 'string' || !URL.canParse(value))
      throw new AppError('video.upload_invalid', '视频素材上传地址无效');
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && url.origin === origin))
    )
      throw new AppError('video.upload_invalid', '视频素材上传地址无效');
    return url;
  };
  const upload = validate(signed.upload_url),
    output = validate(signed.public_url);
  const headers = new Headers(signed.upload_headers);
  for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
  let status: number;
  if (upload.origin === origin) {
    const response = await modelFetch(upload.href, {
      method: 'PUT',
      headers,
      body: new Uint8Array(source.bytes),
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
    status = response.status;
    await response.body?.cancel();
  } else {
    const response = await requestPublicBytes(
      upload.href,
      { method: 'PUT', headers: Object.fromEntries(headers), body: source.bytes },
      signal,
      65536,
      120000,
    );
    status = response.status;
  }
  if (status < 200 || status >= 300) throw new AppError('video.upload_failed', '上传视频素材失败 HTTP ' + status);
  return { ...job, source: { kind: source.kind, url: output.href } };
}

export async function generateVideo(access: VideoAccess, job: VideoJob, signal: AbortSignal, resumeId?: string) {
  const origin = new URL(access.baseUrl).origin;
  const budget = AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]);
  if (access.protocol === 'higgsfield' && job.source?.bytes)
    job = resumeId ? { ...job, source: undefined } : await uploadHiggsfieldSource(access, job, budget);
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
      const response = await request(plan.poll(id), plan.headers(), budget);
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        await wait(5000, undefined, { signal: budget });
        continue;
      }
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
                const file = await json(await request({ url: fileBase }, plan.headers(), budget), 65536, access);
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
    if (signal.aborted || (error instanceof AppError && error.code === 'video.task_failed')) throw error;
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
