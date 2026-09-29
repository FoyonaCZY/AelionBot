import type { ImageAspect, ImageProtocol, ImageQuality } from './image-types';
export type ModelProtocol = 'chat' | 'responses' | 'anthropic' | 'gemini';
/** Protocols whose providers can run web search themselves (Responses web_search, Claude web_search_20250305). */
export const hostedSearchProtocol = (protocol?: ModelProtocol) => protocol === 'responses' || protocol === 'anthropic';
export interface ModelParameters {
  protocol?: ModelProtocol;
  responsesTransport?: 'auto' | 'http' | 'websocket';
  temperature?: number;
  reasoningEffort?: string;
  thinkingBudget?: number;
  fallbackModel?: string;
  hostedWebSearch?: boolean;
  hostedImageGeneration?: boolean;
  imageProtocol?: ImageProtocol;
  imageAspect?: ImageAspect;
  imageQuality?: ImageQuality;
}
export interface NativeAssistant {
  protocol: ModelProtocol;
  key: string;
  data: any;
}
