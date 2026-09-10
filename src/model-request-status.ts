/** Public transport state only; never provider bodies, prompts or reasoning. */
export interface ModelRequestStatus{
  phase:'waiting'|'streaming'|'retrying';
  startedAt:string;
  updatedAt:string;
  attempt:number;
  maxRetries:number;
  reason?:'rate_limit'|'timeout'|'connection'|'fallback';
}
