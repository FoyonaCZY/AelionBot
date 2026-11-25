import { translate } from '../../../shared/i18n';
import { setTimeout as wait } from 'node:timers/promises';
import type { ImageJob } from './image-protocols';
import { ImageGenerationError, classifyImageResponse } from './image-errors';
import { mediaRequest, mediaJson, mediaDiagnostic, downloadMedia } from '../model/media-http';
import { uploadHiggsfieldReference } from '../model/higgsfield';
import { nativeEndpoint } from '../model/native-endpoint';

export async function generateHiggsfieldImage(
  baseUrl: string,
  model: string,
  key: string,
  job: ImageJob,
  callerSignal: AbortSignal,
) {
  const protocol = 'higgsfield-images',
    access = { baseUrl, key, protocol };
  const parts = model.split('/');
  if (parts.length < 2 || parts.some((p) => !/^[-\w.]+$/.test(p) || p === '.' || p === '..'))
    throw new ImageGenerationError('switch-model', {
      protocol,
      detail: translate('请输入 Higgsfield 图片模型的端点路径'),
    });
  const endpoint = parts.map(encodeURIComponent).join('/'),
    base = nativeEndpoint(baseUrl, ''),
    headers = { Authorization: 'Key ' + key };
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(10 * 60000)]);
  const body: Record<string, unknown> = {
    prompt: job.prompt,
    aspect_ratio: job.aspect,
    resolution: job.resolution,
    quality: job.quality === 'auto' ? undefined : job.quality,
    negative_prompt: job.negativePrompt,
    seed: job.seed,
    ...job.input,
  };
  if (job.reference?.length) {
    // The same provider uses image_url for Soul and image_urls for Seedream/Kling. Check the endpoint schema before uploading.
    const schemaResponse = await mediaRequest(
      { url: 'https://dash.higgsfield.ai/api/v2/app-models/' + endpoint + '/' },
      {},
      signal,
    );
    const detail = await mediaJson(schemaResponse, 2 * 1024 * 1024, access),
      properties = detail?.input_schema?.properties;
    const field = ['image_urls', 'image_url'].find((name) => properties && Object.hasOwn(properties, name));
    if (!field || (field === 'image_url' && job.reference.length !== 1))
      throw new ImageGenerationError('unsupported', {
        protocol,
        detail: translate('所选图片模型不支持此数量的参考图'),
      });
    const urls: string[] = [];
    for (const ref of job.reference)
      urls.push(await uploadHiggsfieldReference(access, { bytes: ref.bytes, mime: ref.mediaType }, signal));
    body[field] = field === 'image_urls' ? urls : urls[0];
  }
  const created = await mediaRequest({ url: base + '/' + endpoint, body }, headers, signal);
  if (!created.ok) {
    let detail = '';
    try {
      await mediaJson(created, 65536, access);
    } catch (error) {
      detail = (error as Error).message;
    }
    throw new ImageGenerationError(classifyImageResponse(created.status, detail, Boolean(key)).nextStep, {
      protocol,
      status: created.status,
      detail,
    });
  }
  const submitted = await mediaJson(created, 2 * 1024 * 1024, access);
  const id = submitted?.request_id;
  if (typeof id !== 'string' || !/^[-\w.]{1,256}$/.test(id) || id === '.' || id === '..')
    throw new ImageGenerationError('contact-support', { protocol, detail: translate('服务未返回有效的图片任务 ID') });
  for (;;) {
    const response = await mediaRequest(
      { url: base + '/requests/' + encodeURIComponent(id) + '/status' },
      headers,
      signal,
    );
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      await wait(3500, undefined, { signal });
      continue;
    }
    const state = await mediaJson(response, 2 * 1024 * 1024, access);
    if (state.status === 'completed') {
      const url = state.images?.[0]?.url;
      if (typeof url !== 'string')
        throw new ImageGenerationError('contact-support', {
          protocol,
          detail: translate('图片任务完成但未返回图片地址'),
        });
      const bytes = await downloadMedia(url, signal, new URL(base).origin, {}, 24 * 1024 * 1024);
      const signature = bytes.subarray(0, 12);
      if (!(
        signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        signature.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        (signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP') ||
        /^GIF8[79]a/.test(signature.toString('ascii'))
      ))
        throw new ImageGenerationError('contact-support', {
          protocol,
          detail: translate('返回的文件不是可识别的图片'),
        });
      return bytes;
    }
    if (state.status !== 'queued' && state.status !== 'in_progress')
      throw new ImageGenerationError(state.status === 'nsfw' ? 'revise-request' : 'contact-support', {
        protocol,
        detail: translate('图片任务未完成') + mediaDiagnostic(state, access),
      });
    await wait(2500, undefined, { signal });
  }
}
