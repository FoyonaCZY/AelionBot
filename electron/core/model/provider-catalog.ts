import { translate } from '../../../shared/i18n';
import type { ModelProvider, ProviderModel } from '../../../shared/types/core';
import type { CatalogSource } from '../../../shared/model-catalog';
import { usesModel } from '../../../shared/types/media-types';
import { AppError } from '../../../shared/errors';
import { modelEndpoint } from './model';
import { modelFetch } from './model-http';
import { imageCapability } from './model-vision';
import { nativeEndpoint, geminiBaseUrl } from './native-endpoint';

const badCatalog = () => new AppError('provider.catalog_invalid', translate('模型目录格式无效'));
function array(value: unknown): any[] {
  if (!Array.isArray(value)) throw badCatalog();
  return value;
}
function published(id: unknown, output?: ProviderModel['catalogOutput']): ProviderModel {
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f]/.test(id)) throw badCatalog();
  return { id: id.trim(), ...(output ? { catalogOutput: output } : {}) };
}
interface CatalogPage {
  models: ProviderModel[];
  next?: string;
}
async function pageJson(url: string, headers: Record<string, string>, signal: AbortSignal) {
  const response = await modelFetch(url, {
    headers,
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      'provider.catalog_http',
      translate('获取模型列表失败 HTTP {status}', { status: response.status }),
    );
  }
  if (!response.body) throw badCatalog();
  if (response.headers.get('content-type')?.includes('text/html')) {
    await response.body.cancel();
    throw new AppError('provider.html_response', '服务返回了网页而不是模型列表，请检查 Base URL');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024) throw badCatalog();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function withParam(uri: string, key: string, value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 4000) throw badCatalog();
  const next = new URL(uri);
  next.searchParams.set(key, value);
  return next.href;
}
async function pages(
  first: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  parse: (body: any, url: string) => CatalogPage,
) {
  const budget = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const entries: ProviderModel[] = [],
    seen = new Set<string>(),
    initial = new URL(first);
  let url = first;
  while (url) {
    if (seen.has(url) || seen.size >= 60) throw badCatalog();
    seen.add(url);
    const page = parse(await pageJson(url, headers, budget), url);
    entries.push(...page.models);
    if (entries.length > 5000) throw badCatalog();
    if (!page.next) break;
    if (typeof page.next !== 'string' || page.next.length > 4000) throw badCatalog();
    const next = new URL(page.next, url);
    if (
      next.origin !== initial.origin ||
      next.pathname !== initial.pathname ||
      next.username ||
      next.password ||
      next.hash
    )
      throw badCatalog();
    url = next.href;
  }
  return entries;
}

export async function loadProviderCatalog(
  source: CatalogSource,
  p: Pick<ModelProvider, 'baseUrl' | 'uses' | 'protocol'>,
  key: string,
  signal: AbortSignal,
): Promise<ProviderModel[]> {
  const bearer: Record<string, string> = key ? { Authorization: 'Bearer ' + key } : {};
  const list = (url: string, headers: Record<string, string>, parse: (body: any, url: string) => CatalogPage) =>
    pages(url, headers, signal, parse);
  const media = (output: unknown): output is 'image' | 'video' =>
    (output === 'image' || output === 'video') && usesModel(p, output);
  switch (source) {
    case 'higgsfield':
      return list('https://dash.higgsfield.ai/api/v2/app-models/?page_size=100', {}, (d) => ({
        models: array(d.results)
          .filter((m) => media(m.output_type) && m.availability_state === 'available')
          .map((m) => published(m.slug, m.output_type)),
        next: d.next,
      }));
    case 'fal': {
      const result = await Promise.all(
        ['text-to-video', 'image-to-video', 'video-to-video'].map((category) =>
          list('https://api.fal.ai/v1/models?limit=100&category=' + category, {}, (d, url) => ({
            models: array(d.models)
              .filter((m) => !m.metadata?.status || m.metadata.status === 'active')
              .map((m) => published(m.endpoint_id, 'video')),
            next: d.has_more ? withParam(url, 'cursor', d.next_cursor) : undefined,
          })),
        ),
      );
      return result.flat();
    }
    case 'replicate':
      return list(nativeEndpoint(p.baseUrl, '/v1/collections/text-to-video'), bearer, (d) => ({
        models: array(d.models).map((m) => {
          if (typeof m.owner !== 'string' || typeof m.name !== 'string') throw badCatalog();
          return published(m.owner + '/' + m.name + (m.latest_version?.id ? ':' + m.latest_version.id : ''), 'video');
        }),
      }));
    case 'sd-webui':
      return list(nativeEndpoint(p.baseUrl, '/sdapi/v1/sd-models'), bearer, (d) => ({
        models: array(d).map((m) => published(m.title || m.model_name, 'image')),
      }));
    case 'xai-image':
      return list(nativeEndpoint(p.baseUrl, '/v1/image-generation-models'), bearer, (d) => ({
        models: array(d.models).map((m) => published(m.id, 'image')),
      }));
    case 'xai':
      return list(nativeEndpoint(p.baseUrl, '/v1/video-generation-models'), bearer, (d) => ({
        models: array(d.models).map((m) => published(m.id, 'video')),
      }));
    case 'minimax':
      return list(nativeEndpoint(p.baseUrl, '/v1/models'), bearer, (d) => ({
        models: array(d.data).map((m) => published(m.id)),
      }));
    case 'seedance':
      return list(nativeEndpoint(p.baseUrl, '/api/v3/models'), bearer, (d) => ({
        models: array(d.data)
          .filter((m) => !m.domain || m.domain === 'VideoGeneration')
          .map((m) => published(m.id, 'video')),
      }));
    case 'dashscope':
      return list(nativeEndpoint(p.baseUrl, '/api/v1/models') + '?page_no=1&page_size=100', bearer, (d, url) => {
        const out = d.output,
          items = array(out?.models);
        const page = Number(new URL(url).searchParams.get('page_no'));
        if (
          !Number.isSafeInteger(out.total) ||
          out.total < 0 ||
          out.page_no !== page ||
          !Number.isInteger(out.page_size) ||
          out.page_size <= 0
        )
          throw badCatalog();
        return {
          models: items
            .filter((m) =>
              m.inference_metadata?.response_modality?.some(
                (v: unknown) => typeof v === 'string' && v.toLowerCase() === 'video',
              ),
            )
            .map((m) => published(m.model, 'video')),
          next: page * out.page_size < out.total ? withParam(url, 'page_no', String(page + 1)) : undefined,
        };
      });
    case 'vertex': {
      const base = new URL(p.baseUrl);
      const project = base.pathname.match(
        /^(.*?)\/v1(?:beta1)?\/projects\/[^/]+\/locations\/[^/]+\/publishers\/google(?:\/models)?\/?$/,
      );
      if (!project)
        throw new AppError(
          'provider.vertex_endpoint',
          translate('Vertex AI 地址需要包含项目、区域和 publishers/google'),
        );
      return list(base.origin + project[1] + '/v1beta1/publishers/google/models?pageSize=100', bearer, (d, url) => ({
        models: array(d.publisherModels ?? [])
          .map((m) => (typeof m.name === 'string' ? m.name.split('/').at(-1) : ''))
          .filter((name) => /^veo[-.\d]/i.test(name))
          .map((name) => published(name, 'video')),
        next: d.nextPageToken ? withParam(url, 'pageToken', d.nextPageToken) : undefined,
      }));
    }
    case 'gemini':
      return list(geminiBaseUrl(p.baseUrl) + '/models', key ? { 'x-goog-api-key': key } : {}, (d, url) => ({
        models: array(d.models)
          .filter(
            (m) =>
              !m.supportedGenerationMethods ||
              m.supportedGenerationMethods.includes('generateContent') ||
              (usesModel(p, 'video') && /omni|veo/i.test(m.name)),
          )
          .map((m) => published(m.name?.replace(/^models\//, ''))),
        next: d.nextPageToken ? withParam(url, 'pageToken', d.nextPageToken) : undefined,
      }));
    case 'anthropic':
    case 'openai': {
      const headers =
        source === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } : bearer;
      return list(
        modelEndpoint(
          p.baseUrl,
          source === 'anthropic' ? 'anthropic' : p.protocol === 'responses' ? 'responses' : 'chat',
        ) + '/models',
        headers,
        (d, url) => ({
          models: array(d.data).map((m) => {
            const supports = imageCapability(m);
            return { ...published(m.id), ...(supports !== undefined ? { supportsImages: supports } : {}) };
          }),
          next: source === 'anthropic' && d.has_more ? withParam(url, 'after_id', d.last_id) : undefined,
        }),
      );
    }
  }
}
