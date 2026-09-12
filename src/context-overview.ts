export const CONTEXT_PARTS=['system','conversation','skills','tools','mcp','results','images'] as const;
export type ContextPart=typeof CONTEXT_PARTS[number];
export interface ContextOverview {
  model:string;providerId?:string;capacity:number;tokens:number;
  parts:Record<ContextPart,number>;measuredAt:string;
  estimateSource:'tokenizer'|'usage-anchor';
}
