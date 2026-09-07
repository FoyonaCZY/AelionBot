export type ModelProtocol='chat'|'responses'|'anthropic'|'gemini';
export interface ModelParameters {protocol?:ModelProtocol;temperature?:number;reasoningEffort?:string;thinkingBudget?:number;fallbackModel?:string;}
export interface NativeAssistant {protocol:ModelProtocol;key:string;data:any;}
