import { translate } from '../../../shared/i18n';
import { ATTACHMENT_LIMITS } from '../../../shared/types/attachment-types';
import { AppError } from '../../../shared/errors';
import { requestPublicBytes } from '../tools/web-tools';
import { modelFetch } from './model-http';
export interface MediaConnection {
  baseUrl: string;
  key: string;
  protocol: string;
}
export interface MediaRequest {
  url: string;
  body?: Record<string, unknown> | FormData;
  headers?: Record<string, string>;
}
async function readBytes(response: Response, limit: number) {
  if (!response.body) throw new AppError('video.empty_response', translate('模型服务返回空响应'));
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new AppError('video.result_too_large', translate('模型服务返回的数据超过附件大小限制'));
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function mediaRequest(spec: MediaRequest, headers: Record<string, string>, signal: AbortSignal) {
  const form = spec.body instanceof FormData;
  return modelFetch(spec.url, {
    method: spec.body ? 'POST' : 'GET',
    redirect: 'manual',
    signal,
    headers: { ...headers, ...(spec.body && !form ? { 'content-type': 'application/json' } : {}), ...spec.headers },
    body: form ? (spec.body as FormData) : spec.body ? JSON.stringify(spec.body) : undefined,
  });
}
export function mediaDiagnostic(data: any, access: MediaConnection) {
  const reason =
    data?.error?.message ||
    (typeof data?.error === 'string' ? data.error : undefined) ||
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
    ...(['kling', 'higgsfield', 'higgsfield-images'].includes(access.protocol) ? access.key.split(':') : []),
  ])
    if (secret) text = text.replaceAll(secret, '***');
  return ' · ' + text.replace(/[\r\n]/g, ' ').slice(0, 350);
}
export async function mediaJson(response: Response, limit: number, access: MediaConnection) {
  if (!response.ok) {
    let detail = '';
    try {
      detail = mediaDiagnostic(JSON.parse((await readBytes(response, 65536)).toString('utf8')), access);
    } catch {}
    throw new AppError(
      'video.http_error',
      translate('模型服务返回 HTTP {status}', { status: response.status }) + detail,
    );
  }
  const bytes = await readBytes(response, limit);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new AppError('video.invalid_response', translate('模型服务返回了无效的 JSON'));
  }
}
export async function downloadMedia(
  url: string,
  signal: AbortSignal,
  origin: string,
  headers: Record<string, string> = {},
  limit: number = ATTACHMENT_LIMITS.fileBytes,
) {
  // Only an adapter-constructed content endpoint carries credentials. CDN redirects never inherit them.
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.origin === origin))
    )
      throw new AppError('video.invalid_download', translate('媒体下载地址无效'));
    if (parsed.origin !== origin) {
      const response = await requestPublicBytes(url, {}, signal, limit, 120000);
      if (response.status < 200 || response.status >= 300)
        throw new AppError(
          'video.download_failed',
          translate('下载媒体文件失败 HTTP {status}', { status: response.status }),
        );
      return response.bytes;
    }
    const response = await mediaRequest({ url }, headers, signal);
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
      throw new AppError(
        'video.download_failed',
        translate('下载媒体文件失败 HTTP {status}', { status: response.status }),
      );
    }
    return readBytes(response, limit);
  }
  throw new AppError('video.invalid_download', translate('媒体下载重定向无效'));
}
