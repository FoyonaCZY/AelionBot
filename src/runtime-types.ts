export interface RuntimeSettings {maxTurns:number;maxMinutes:number;maxTokens:number;modelRetries:number;requestTimeoutMs:number;maxOutputTokens:number;parallelReads:number;progressSeconds:number;fileCheckpoints:boolean;}
export const DEFAULT_RUNTIME:RuntimeSettings={maxTurns:120,maxMinutes:60,maxTokens:500000,modelRetries:2,requestTimeoutMs:180000,maxOutputTokens:8192,parallelReads:4,progressSeconds:60,fileCheckpoints:false};
export interface TaskStep {id:string;title:string;acceptance:string;status:'pending'|'working'|'done'|'skipped';evidenceIds:string[];note?:string;}
export interface TaskPlan {revision:number;goal:string;steps:TaskStep[];}
export interface ModelUsage {inputTokens:number;outputTokens:number;cachedTokens:number;reasoningTokens?:number;latencyMs?:number;attempts?:number;}
export interface UsageRecord {estimatedTokens?:number;id:string;botId?:string;runId?:string;purpose:string;model:string;providerId?:string;time:string;usage?:ModelUsage;error?:string;}
