export const MODEL_USES = {
  chat: '对话模型',
  image: '图像生成',
  asr: '语音识别',
  tts: '语音合成',
  video: '视频生成',
} as const;
export type ModelUse = keyof typeof MODEL_USES;
export const VIDEO_PROTOCOLS = {
  dashscope: 'DashScope / Wan',
  seedance: 'Volcengine Ark / Seedance',
  kling: 'Kling AI',
  minimax: 'MiniMax / Hailuo',
  'minimax-v2': 'MiniMax H3 (v2)',
  vidu: 'Vidu',
  runway: 'Runway',
  luma: 'Luma Dream Machine',
  openai: 'OpenAI Videos',
  fal: 'fal Queue',
  replicate: 'Replicate Predictions',
  gemini: 'Gemini Omni',
  vertex: 'Vertex AI / Veo',
  xai: 'xAI / Grok Imagine',
} as const;
export type VideoProtocol = keyof typeof VIDEO_PROTOCOLS;
interface MediaSelection {
  providerId: string;
  model: string;
}
export interface VideoSpecs {
  aspect?: string;
  resolution?: string;
  duration?: string;
}
export interface VideoSelection extends MediaSelection, VideoSpecs {}
export interface MediaDefaults {
  image?: MediaSelection & Pick<VideoSpecs, 'aspect' | 'resolution'>;
  video?: VideoSelection;
}
export interface MediaParameters {
  uses?: ModelUse[];
  videoProtocol?: VideoProtocol;
}
export function usesModel(provider: MediaParameters, use: ModelUse) {
  return provider.uses ? provider.uses.includes(use) : use === 'video' ? Boolean(provider.videoProtocol) : true;
}
