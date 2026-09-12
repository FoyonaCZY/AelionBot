export const CONTEXT_PARTS=['system','conversation','skills','tools','mcp'] as const;
export type ContextPart=typeof CONTEXT_PARTS[number];
export interface ContextOverview {
  model:string;providerId?:string;capacity:number;tokens:number;
  parts:Record<ContextPart,number>;measuredAt:string;
  estimateSource:'tokenizer'|'usage-anchor';
}
export function foldContextParts(parts?:Partial<Record<string,number>>):Record<ContextPart,number>{
  const next=Object.fromEntries(CONTEXT_PARTS.map(key=>[key,Math.max(0,parts?.[key]||0)])) as Record<ContextPart,number>;
  next.conversation+=(parts?.results||0)+(parts?.images||0);
  return next;
}
