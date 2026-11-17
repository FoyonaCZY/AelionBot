// What model requests cost: prices per million tokens, how a model name finds its price in the bundled price table,
// and what a request's token counts come to. The table itself is generated (assets/model-prices.json) and only the
// main process loads it; this file holds the types and arithmetic both processes share.

/** A model's price per million tokens, in one currency. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Cached input read back; charged as input when absent. */
  cacheRead?: number;
  /** Input written to the cache; charged as input when absent. */
  cacheWrite?: number;
  /** Prices of a request whose input is longer than `above` tokens; the largest threshold passed applies. */
  tiers?: PriceTier[];
}
interface PriceTier {
  above: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** A price as the table stores it: input, output, cache read, cache write, then tiers of [above, …the same four]. */
export type PriceTuple = [
  input: number,
  output: number,
  cacheRead?: number | null,
  cacheWrite?: number | null,
  tiers?: Array<[above: number, input: number, output: number, cacheRead?: number | null, cacheWrite?: number | null]>,
];

/** The bundled price table: US dollars per million tokens. */
export interface PriceTable {
  source: string;
  /** The day it was generated, as YYYY-MM-DD. */
  generatedAt: string;
  /** API addresses of known services as [host, path, service]; a host's first entry is its default. */
  endpoints: Array<[host: string, path: string, service: string]>;
  /** Prices by service, then by the model ID that service uses. */
  services: Record<string, Record<string, PriceTuple>>;
  /**
   * List prices by lower-case model ID, for a model served from an address the table does not know: bare IDs from
   * the model's own maker, and `vendor/model` IDs as OpenRouter lists them.
   */
  reference: Record<string, PriceTuple>;
}

const optional = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function priceFromTuple(tuple: PriceTuple): ModelPrice {
  const [input, output, cacheRead, cacheWrite, tiers] = tuple;
  const price: ModelPrice = { input, output };
  if (optional(cacheRead) !== undefined) price.cacheRead = cacheRead!;
  if (optional(cacheWrite) !== undefined) price.cacheWrite = cacheWrite!;
  if (tiers?.length)
    price.tiers = tiers.map(([above, tierInput, tierOutput, tierRead, tierWrite]) => ({
      above,
      input: tierInput,
      output: tierOutput,
      ...(optional(tierRead) !== undefined ? { cacheRead: tierRead! } : {}),
      ...(optional(tierWrite) !== undefined ? { cacheWrite: tierWrite! } : {}),
    }));
  return price;
}

/** The service an API address belongs to: the host must match, and the longest matching path wins. */
export function endpointService(table: PriceTable, baseUrl: string | undefined) {
  if (!baseUrl) return;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl) ? baseUrl : 'https://' + baseUrl);
  } catch {
    return;
  }
  const host = url.host.toLowerCase(),
    path = url.pathname.replace(/\/+$/, '').toLowerCase();
  let fallback: string | undefined, best: { service: string; length: number } | undefined;
  for (const [entryHost, entryPath, service] of table.endpoints) {
    if (entryHost !== host) continue;
    fallback ??= service;
    if ((path === entryPath || path.startsWith(entryPath + '/')) && (!best || entryPath.length > best.length))
      best = { service, length: entryPath.length };
  }
  return best?.service ?? fallback;
}

const lowerIndexes = new WeakMap<object, Map<string, PriceTuple>>();
/** Looks a model ID up without regard to case; IDs differing only by case in one list are left unmatched. */
function findModel(list: Record<string, PriceTuple> | undefined, id: string) {
  if (!list) return;
  if (Object.hasOwn(list, id)) return list[id];
  let index = lowerIndexes.get(list);
  if (!index) {
    index = new Map();
    const twice = new Set<string>();
    for (const [key, value] of Object.entries(list)) {
      const lower = key.toLowerCase();
      if (index.has(lower)) twice.add(lower);
      else index.set(lower, value);
    }
    for (const key of twice) index.delete(key);
    lowerIndexes.set(list, index);
  }
  return index.get(id.toLowerCase());
}

export interface BuiltinPrice {
  price: ModelPrice;
  /** `service`: the price of the service at this address. `reference`: the model's list price elsewhere. */
  basis: 'service' | 'reference';
  service?: string;
}

/**
 * The table's price for a model as a service at `baseUrl` names it. A known address is looked up in that service's
 * own list. Otherwise only an exact ID matches the reference list: the whole name, or what follows its routing
 * prefix (`vendor/model`, `models/model`). Version dates, `:variant` suffixes and aliases are never guessed.
 */
export function builtinPrice(table: PriceTable, baseUrl: string | undefined, model: string): BuiltinPrice | undefined {
  const name = model.trim();
  if (!name) return;
  const service = endpointService(table, baseUrl);
  if (service) {
    const list = table.services[service],
      found = findModel(list, name) ?? (name.startsWith('models/') ? findModel(list, name.slice(7)) : undefined);
    if (found) return { price: priceFromTuple(found), basis: 'service', service };
  }
  const bare = name.slice(name.lastIndexOf('/') + 1);
  const reference =
    (bare && !bare.includes(':') ? findModel(table.reference, bare) : undefined) ??
    (name.includes('/') ? findModel(table.reference, name) : undefined);
  return reference ? { price: priceFromTuple(reference), basis: 'reference' } : undefined;
}

const tokens = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * What one request cost at a price, in the price's currency; undefined when it reported no tokens. Reported input
 * includes what was read from and written to the cache (see model-usage.ts), so those are taken out of the input
 * before each part is charged at its own price.
 */
export function usageCost(
  price: ModelPrice,
  usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number; cacheWriteTokens?: number } | undefined,
) {
  const input = tokens(usage?.inputTokens),
    output = tokens(usage?.outputTokens);
  if (input === undefined && output === undefined) return;
  const total = input ?? 0,
    read = Math.min(tokens(usage?.cachedTokens) ?? 0, total),
    write = Math.min(tokens(usage?.cacheWriteTokens) ?? 0, total - read),
    fresh = total - read - write;
  let rate: Omit<ModelPrice, 'tiers'> = price,
    passed = -1;
  for (const tier of price.tiers || [])
    if (total > tier.above && tier.above > passed) {
      rate = tier;
      passed = tier.above;
    }
  return (
    (fresh * rate.input +
      read * (rate.cacheRead ?? rate.input) +
      write * (rate.cacheWrite ?? rate.input) +
      (output ?? 0) * rate.output) /
    1_000_000
  );
}

export const CURRENCIES = ['USD', 'CNY', 'EUR'] as const;
export type Currency = (typeof CURRENCIES)[number];
/** How much of each currency one US dollar buys, until the user types their own: the app never fetches rates. */
export const DEFAULT_RATES: Record<Exclude<Currency, 'USD'>, number> = { CNY: 7.1, EUR: 0.86 };

/** A price the user set for one model of one provider, in the chosen currency per million tokens. */
export interface CustomPrice {
  providerId: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
type BudgetAction = 'notify' | 'pause';
export interface SpendingSettings {
  currency: Currency;
  rates: Record<Exclude<Currency, 'USD'>, number>;
  /** Budgets in the chosen currency; absent means no limit. */
  monthlyBudget?: number;
  dailyBudget?: number;
  /** Past a budget: only tell the user, or also hold automations and goals back. */
  onExceeded: BudgetAction;
  prices: CustomPrice[];
}
export const DEFAULT_SPENDING: SpendingSettings = {
  currency: 'USD',
  rates: { ...DEFAULT_RATES },
  onExceeded: 'notify',
  prices: [],
};
export type BudgetLevel = 'warning' | 'exceeded';
export type BudgetPeriod = 'month' | 'day';
/** A budget is announced at this share of it, and again when it is used up. */
const BUDGET_WARNING = 0.8;
export interface BudgetStatus {
  /** The local month (YYYY-MM) or day (YYYY-MM-DD) it counts. */
  key: string;
  spent: number;
  budget?: number;
  level?: BudgetLevel;
}
export interface SpendingView {
  settings: SpendingSettings;
  month: BudgetStatus;
  day: BudgetStatus;
  /** Automations and goals are held back because a budget ran out. */
  paused: boolean;
  /** The latest budget announcement; the interface shows each once. */
  alert?: { id: string; period: BudgetPeriod; level: BudgetLevel; at: string };
  priceTable: { source: string; generatedAt: string; models: number };
}
/** The settings as the app keeps them, with the budget announcements it already made. */
export interface StoredSpending extends SpendingSettings {
  announced?: Partial<Record<BudgetPeriod, { key: string; level?: BudgetLevel }>>;
  alert?: SpendingView['alert'];
}
export interface SpendingInput {
  currency?: Currency;
  /** How much of the chosen currency one US dollar buys. */
  rate?: number;
  monthlyBudget?: number | null;
  dailyBudget?: number | null;
  onExceeded?: BudgetAction;
}
/** One model in the price list: what it is charged at now and what the bundled table says. */
export interface ModelPriceRow {
  providerId: string;
  providerName: string;
  model: string;
  /** The price in use, in the chosen currency. */
  price?: Omit<ModelPrice, 'tiers'>;
  /** The table's price in the chosen currency, also while a custom one overrides it. */
  builtin?: Omit<ModelPrice, 'tiers'>;
  custom: boolean;
}

/**
 * An amount as people read it: two decimals, and up to `digits` when it is smaller than one unit, so a request of
 * a fraction of a cent or a price per million tokens does not read as zero.
 */
export function formatMoney(value: number, currency: Currency, locale?: string, digits = 4) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? Math.max(2, digits) : 2,
  }).format(value);
}

/** The source text of a budget announcement, a translation key with {spent} and {budget} to fill in. */
export function budgetAlertText(period: BudgetPeriod, level: BudgetLevel, paused: boolean) {
  const month = period === 'month';
  if (level === 'warning')
    return month ? '本月花费已达预算的 80%：{spent} / {budget}' : '今日花费已达预算的 80%：{spent} / {budget}';
  if (paused)
    return month
      ? '本月花费已超出预算，自动运行已暂停：{spent} / {budget}'
      : '今日花费已超出预算，自动运行已暂停：{spent} / {budget}';
  return month ? '本月花费已超出预算：{spent} / {budget}' : '今日花费已超出预算：{spent} / {budget}';
}

export const budgetLevel = (spent: number, budget: number | undefined): BudgetLevel | undefined =>
  !budget || budget <= 0
    ? undefined
    : spent >= budget
      ? 'exceeded'
      : spent >= budget * BUDGET_WARNING
        ? 'warning'
        : undefined;

/** The local month and day a moment falls in, as budget periods are counted. */
export function budgetPeriods(time: number | Date) {
  const date = new Date(time),
    month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  return { month, day: `${month}-${String(date.getDate()).padStart(2, '0')}` };
}
