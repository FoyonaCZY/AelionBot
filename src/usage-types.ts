export type UsageGranularity='hour'|'day'|'month';
export interface UsageQuery {from:string;to:string;granularity:UsageGranularity;providerId?:string;model?:string;purpose?:string;}
export interface UsageTotals {
  requests:number;failedRequests:number;reportedRequests:number;missingUsage:number;
  totalTokens:number;inputTokens:number;outputTokens:number;cachedTokens:number;cacheWriteTokens:number;reasoningTokens:number;
  inputReports:number;outputReports:number;cacheReports:number;cacheWriteReports:number;reasoningReports:number;cacheInputTokens:number;
}
export interface UsageBucket extends UsageTotals {key:string;}
export interface UsageGroup extends UsageTotals {key:string;name:string;providerId?:string;model?:string;}
export interface UsageReport {
  query:UsageQuery;timeZone:string;totals:UsageTotals;buckets:UsageBucket[];byProvider:UsageGroup[];byModel:UsageGroup[];
  providers:Array<{id:string;name:string}>;models:string[];purposes:string[];
}
