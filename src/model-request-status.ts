/** Public transport state only; never provider bodies, prompts or reasoning. */
export interface ModelRequestStatus{
  activity?:'text'|'tool'|'reasoning'|'response';
  receivedBytes?:number;
  toolArgumentChars?:number;
  phase:'waiting'|'streaming'|'retrying';
  startedAt:string;
  updatedAt:string;
  attempt:number;
  maxRetries:number;
  reason?:'rate_limit'|'timeout'|'connect_timeout'|'connection'|'fallback';
}
