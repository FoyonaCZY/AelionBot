export interface ToolExecution {
  id:string;callId:string;botId:string;runId:string;tool:string;target:string;targetKey:string;
  status:'running'|'succeeded'|'failed'|'cancelled'|'unknown';startedAt:string;endedAt?:string;resultId?:string;error?:string;
  resolution?:{kind:'resolved'|'unnecessary';reason:string;evidenceIds:string[];at:string};
}
