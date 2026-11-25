import { AppError } from '../../../shared/errors';
import { requestPublicBytes } from '../tools/web-tools';
import { nativeEndpoint } from './native-endpoint';
import { mediaRequest, mediaJson, type MediaConnection } from './media-http';
import { modelFetch } from './model-http';
/** Upload local references to the provider's signed storage URL before submitting the model request. */
export async function uploadHiggsfieldReference(
  access: MediaConnection,
  source: { bytes: Buffer; mime: string },
  signal: AbortSignal,
): Promise<string> {
  const signed = await mediaJson(
    await mediaRequest(
      { url: nativeEndpoint(access.baseUrl, '') + '/files/generate-upload-url', body: { content_type: source.mime } },
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
  return output.href;
}
