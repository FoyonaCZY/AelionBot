import type { ModelProvider, ProviderModel } from './types/core';
import { speechProtocolFor } from './types/speech-types';
import { usesModel } from './types/media-types';
type CatalogProvider = Pick<
  ModelProvider,
  'baseUrl' | 'protocol' | 'uses' | 'imageProtocol' | 'videoProtocol' | 'speechProtocol' | 'asrProtocol' | 'ttsProtocol'
>;
export type CatalogSource =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'higgsfield'
  | 'sd-webui'
  | 'seedance'
  | 'dashscope'
  | 'xai'
  | 'xai-image'
  | 'fal'
  | 'replicate'
  | 'vertex'
  | 'minimax';
export function officialHiggsfield(baseUrl: string) {
  try {
    return new URL(baseUrl.includes('://') ? baseUrl : 'https://' + baseUrl).hostname === 'api.higgsfield.ai';
  } catch {
    return false;
  }
}
export function catalogSources(p: CatalogProvider): CatalogSource[] {
  const sources = new Set<CatalogSource>();
  const chat = usesModel(p, 'chat'),
    image = usesModel(p, 'image'),
    video = usesModel(p, 'video');
  if (officialHiggsfield(p.baseUrl) && (image || video)) return ['higgsfield'];
  if (chat) sources.add(p.protocol === 'gemini' ? 'gemini' : p.protocol === 'anthropic' ? 'anthropic' : 'openai');
  if (video) {
    const protocol = p.videoProtocol;
    if (
      protocol === 'gemini' ||
      protocol === 'higgsfield' ||
      protocol === 'seedance' ||
      protocol === 'dashscope' ||
      protocol === 'xai' ||
      protocol === 'fal' ||
      protocol === 'replicate' ||
      protocol === 'vertex'
    )
      sources.add(protocol);
    if (protocol === 'minimax' || protocol === 'minimax-v2') sources.add('minimax');
    if (protocol === 'openai') sources.add('openai');
  }
  if (image) {
    if (p.imageProtocol === 'higgsfield-images') sources.add('higgsfield');
    else if (p.imageProtocol === 'sd-webui') sources.add('sd-webui');
    else if (p.imageProtocol === 'gemini-images') sources.add('gemini');
    else if (
      !chat &&
      (p.imageProtocol === 'openai-images' || p.imageProtocol === 'responses-images' || !p.imageProtocol)
    )
      sources.add(
        p.videoProtocol === 'xai' || /^https:\/\/api\.x\.ai(?:\/|$)/i.test(p.baseUrl) ? 'xai-image' : 'openai',
      );
  }
  if (
    !sources.size &&
    ((usesModel(p, 'asr') && speechProtocolFor(p, 'input') !== 'deepseek-tools') ||
      (usesModel(p, 'tts') && speechProtocolFor(p, 'output') !== 'deepseek-tools'))
  )
    sources.add('openai');
  return [...sources];
}
export const catalogMatches = (model: ProviderModel, kind: 'image' | 'video') =>
  !model.catalogOutput || model.catalogOutput === kind;
