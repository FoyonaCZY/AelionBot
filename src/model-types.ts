import type {ImageAspect,ImageProtocol,ImageQuality} from './image-types';
export type ModelProtocol='chat'|'responses'|'anthropic'|'gemini';
export interface ModelParameters {protocol?:ModelProtocol;responsesTransport?:'auto'|'http'|'websocket';temperature?:number;reasoningEffort?:string;thinkingBudget?:number;fallbackModel?:string;hostedWebSearch?:boolean;hostedImageGeneration?:boolean;imageProtocol?:ImageProtocol;imageAspect?:ImageAspect;imageQuality?:ImageQuality;}
export interface NativeAssistant {protocol:ModelProtocol;key:string;data:any;}
