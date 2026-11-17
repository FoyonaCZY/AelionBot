type UsageGranularity = 'hour' | 'day' | 'month';
export interface UsageQuery {
  from: string;
  to: string;
  granularity: UsageGranularity;
  providerId?: string;
  model?: string;
  purpose?: string;
}
export interface UsageTotals {
  requests: number;
  failedRequests: number;
  reportedRequests: number;
  missingUsage: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  inputReports: number;
  outputReports: number;
  cacheReports: number;
  cacheWriteReports: number;
  reasoningReports: number;
  cacheInputTokens: number;
  /** Estimated spend at today's prices, in the report's currency. */
  cost: number;
  /** Requests whose tokens were priced. */
  costRequests: number;
  /** Requests that reported tokens for a model without a price: their cost is missing from `cost`. */
  unpricedRequests: number;
}
export function cacheHitRatio(value: Pick<UsageTotals, 'cachedTokens' | 'inputTokens'>) {
  return value.inputTokens > 0 ? value.cachedTokens / value.inputTokens : 0;
}
export interface UsageBucket extends UsageTotals {
  key: string;
}
export interface UsageGroup extends UsageTotals {
  key: string;
  name: string;
  providerId?: string;
  model?: string;
  /** The price a model's requests are charged at, per million tokens; absent for a model without one. */
  price?: Omit<import('../model-pricing').ModelPrice, 'tiers'>;
  /** The price is the user's own rather than the bundled table's. */
  customPrice?: boolean;
}
export interface UsageReport {
  query: UsageQuery;
  timeZone: string;
  totals: UsageTotals;
  buckets: UsageBucket[];
  byProvider: UsageGroup[];
  byModel: UsageGroup[];
  providers: Array<{ id: string; name: string }>;
  models: string[];
  purposes: string[];
  /** The currency of every cost in the report. */
  currency: import('../model-pricing').Currency;
  /** Models that reported tokens but have no price, so the costs are too low. */
  unpricedModels: number;
}
