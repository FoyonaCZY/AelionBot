import type { ModelConfig } from '../../../shared/types/core';
import { hostedSearchProtocol } from '../../../shared/types/model-types';

/** Upper bound on server-side searches Claude may run in one request. */
const ANTHROPIC_WEB_SEARCH_MAX_USES = 5;

export function hiddenClientTools(config: Pick<ModelConfig, 'protocol' | 'hostedWebSearch' | 'hostedImageGeneration'>) {
  const hidden = new Set<string>();
  // The hosted tool takes over the client tool's name, so both cannot be offered together.
  if (hostedSearchProtocol(config.protocol) && config.hostedWebSearch) hidden.add('web_search');
  return hidden;
}

export function hostedAnthropicTools(config: Pick<ModelConfig, 'protocol' | 'hostedWebSearch'>) {
  if (config.protocol !== 'anthropic' || !config.hostedWebSearch) return [] as Array<Record<string, unknown>>;
  return [{ type: 'web_search_20250305', name: 'web_search', max_uses: ANTHROPIC_WEB_SEARCH_MAX_USES }] as Array<
    Record<string, unknown>
  >;
}

export function hostedResponseTools(
  config: Pick<
    ModelConfig,
    'protocol' | 'hostedWebSearch' | 'hostedImageGeneration' | 'hostedImageSize' | 'hostedImageQuality'
  >,
) {
  if ((config.protocol || 'chat') !== 'responses') return [] as Array<Record<string, unknown>>;
  return [
    ...(config.hostedWebSearch ? [{ type: 'web_search' }] : []),
    ...(config.hostedImageGeneration
      ? [
          {
            type: 'image_generation',
            ...(config.hostedImageSize ? { size: config.hostedImageSize } : {}),
            ...(config.hostedImageQuality ? { quality: config.hostedImageQuality } : {}),
          },
        ]
      : []),
  ] as Array<Record<string, unknown>>;
}

export function hostedGeneratedImages(output: unknown) {
  if (!Array.isArray(output)) return [] as Buffer[];
  const images: Buffer[] = [];
  for (const item of output) {
    if (!item || item.type !== 'image_generation_call') continue;
    const raw =
      typeof item.result === 'string'
        ? item.result
        : typeof item.result?.b64_json === 'string'
          ? item.result.b64_json
          : undefined;
    if (!raw) continue;
    try {
      const bytes = Buffer.from(raw, 'base64');
      if (bytes.length) images.push(bytes);
    } catch {}
  }
  return images;
}
