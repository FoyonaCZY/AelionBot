// What the model requests cost and how that compares with the budgets: prices from the bundled table or set by the
// user, the running spend of the local month and day, and the announcements when a budget is nearly or fully used.
// Spend is an estimate at today's prices from the token counts the services reported; it is not a bill.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import bundledTable from '../../../assets/model-prices.json';
import {
  CURRENCIES,
  DEFAULT_RATES,
  DEFAULT_SPENDING,
  budgetAlertText,
  budgetLevel,
  budgetPeriods,
  builtinPrice,
  formatMoney,
  usageCost,
  type BudgetLevel,
  type BudgetPeriod,
  type BudgetStatus,
  type Currency,
  type CustomPrice,
  type ModelPrice,
  type ModelPriceRow,
  type PriceTable,
  type SpendingSettings,
  type SpendingView,
  type StoredSpending,
} from '../../../shared/model-pricing';
import type { UsageRecord } from '../../../shared/types/runtime-types';
import type { ModelSelection } from '../../../shared/types/core';
import { AppError } from '../../../shared/errors';
import { currentLanguage, translate } from '../../../shared/i18n';
import {
  PRICE_SOURCE_URL,
  parsePriceTable,
  priceTableFrom,
  priceTableModels,
  serializePriceTable,
} from '../model/model-price-source';

/** A budget that was just nearly or fully used; amounts are in `currency`. */
export interface SpendingAlert {
  period: BudgetPeriod;
  level: BudgetLevel;
  spent: number;
  budget: number;
  currency: Currency;
  /** Automations and goals are held back from now on. */
  paused: boolean;
}
interface SpendingData {
  spending?: StoredSpending;
  modelUsage?: UsageRecord[];
  defaultModel?: ModelSelection;
  approvalModel?: ModelSelection;
  memoryModel?: ModelSelection;
  bots: Array<{ model?: ModelSelection }>;
}
interface SpendingDeps {
  store: { data: SpendingData; save(): void };
  /** A provider's API address and name; the address tells which service's prices apply. */
  provider(id: string): { baseUrl?: string; name?: string } | undefined;
  changed(): void;
  onAlert?(alert: SpendingAlert): void;
  /** Where a price table the user refreshed is kept. */
  dataDir?: string;
  fetch?(url: string, init?: RequestInit): Promise<Response>;
  now?(): number;
  /** The price table to use instead of the bundled one, for tests. */
  table?: PriceTable;
}

const REFRESHED_TABLE = 'model-prices.json';
const LEGACY_PROVIDER = 'legacy';
const MAX_AMOUNT = 1e9;
const rank = (level?: BudgetLevel) => (level === 'exceeded' ? 2 : level === 'warning' ? 1 : 0);
const round = (value: number) => Number(value.toPrecision(12));
const amount = (value: unknown, label: string, max = MAX_AMOUNT) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)
    throw new AppError('spending.amount_invalid', `${label}应为 0–${max} 的数字`);
  return value;
};
const scaled = <T extends Omit<ModelPrice, 'tiers'>>(price: T, factor: number): T => ({
  ...price,
  input: round(price.input * factor),
  output: round(price.output * factor),
  ...(price.cacheRead !== undefined ? { cacheRead: round(price.cacheRead * factor) } : {}),
  ...(price.cacheWrite !== undefined ? { cacheWrite: round(price.cacheWrite * factor) } : {}),
});
const flat = ({ input, output, cacheRead, cacheWrite }: ModelPrice): Omit<ModelPrice, 'tiers'> => ({
  input,
  output,
  ...(cacheRead !== undefined ? { cacheRead } : {}),
  ...(cacheWrite !== undefined ? { cacheWrite } : {}),
});

function normalizeSpending(value: unknown): SpendingSettings {
  const v = value && typeof value === 'object' ? (value as Partial<SpendingSettings>) : {};
  const positive = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
  const rates = { ...DEFAULT_RATES };
  for (const key of Object.keys(rates) as Array<keyof typeof rates>)
    rates[key] = positive(v.rates?.[key]) ?? rates[key];
  const prices: CustomPrice[] = [];
  for (const item of Array.isArray(v.prices) ? v.prices : []) {
    if (!item || typeof item.providerId !== 'string' || typeof item.model !== 'string') continue;
    const number = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
    const input = number(item.input),
      output = number(item.output);
    if (input === undefined || output === undefined) continue;
    prices.push({
      providerId: item.providerId,
      model: item.model,
      input,
      output,
      ...(number(item.cacheRead) !== undefined ? { cacheRead: item.cacheRead } : {}),
      ...(number(item.cacheWrite) !== undefined ? { cacheWrite: item.cacheWrite } : {}),
    });
  }
  return {
    currency: CURRENCIES.includes(v.currency as Currency) ? (v.currency as Currency) : DEFAULT_SPENDING.currency,
    rates,
    ...(positive(v.monthlyBudget) ? { monthlyBudget: v.monthlyBudget } : {}),
    ...(positive(v.dailyBudget) ? { dailyBudget: v.dailyBudget } : {}),
    onExceeded: v.onExceeded === 'pause' ? 'pause' : 'notify',
    prices,
  };
}

export class Spending {
  private tableValue?: PriceTable;
  private tableModels?: number;
  private matches = new Map<string, { price: ModelPrice; builtin?: ModelPrice; custom: boolean } | null>();
  private totals?: { month: string; day: string; monthSpent: number; daySpent: number };
  private refreshing?: Promise<{ models: number; generatedAt: string }>;
  constructor(private deps: SpendingDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  settings() {
    return normalizeSpending(this.deps.store.data.spending);
  }
  /** How much of the chosen currency one US dollar buys. */
  private rate(settings = this.settings()) {
    return settings.currency === 'USD' ? 1 : settings.rates[settings.currency];
  }
  private table() {
    if (this.tableValue) return this.tableValue;
    let table = this.deps.table ?? parsePriceTable(bundledTable);
    const file = this.deps.dataDir && join(this.deps.dataDir, REFRESHED_TABLE);
    if (!this.deps.table && file && existsSync(file))
      try {
        const refreshed = parsePriceTable(JSON.parse(readFileSync(file, 'utf8')));
        // A newer app brings a newer bundled table than a copy refreshed long ago.
        if (refreshed.generatedAt > table.generatedAt) table = refreshed;
      } catch {
        // An unreadable copy is ignored; the bundled table still prices everything.
      }
    return (this.tableValue = table);
  }
  private reset() {
    this.matches.clear();
    this.totals = undefined;
  }

  /** The price in use for a model of a provider, in the chosen currency; undefined when it has none. */
  private match(providerId: string | undefined, model: string) {
    const id = providerId || LEGACY_PROVIDER,
      baseUrl = this.deps.provider(id)?.baseUrl || '',
      key = `${id}\n${baseUrl}\n${model}`;
    const cached = this.matches.get(key);
    if (cached !== undefined) return cached || undefined;
    const settings = this.settings(),
      found = builtinPrice(this.table(), baseUrl, model),
      builtin = found && {
        ...scaled(found.price, this.rate(settings)),
        tiers: found.price.tiers?.map((tier) => scaled(tier, this.rate(settings))),
      },
      custom = settings.prices.find((price) => price.providerId === id && price.model === model);
    const result = custom
      ? { price: flat(custom), builtin, custom: true }
      : builtin
        ? { price: builtin, builtin, custom: false }
        : null;
    if (this.matches.size > 5000) this.matches.clear();
    this.matches.set(key, result);
    return result || undefined;
  }
  /** What a request cost in the chosen currency; `priced` is false when its model has no price. */
  cost(record: Pick<UsageRecord, 'providerId' | 'model' | 'usage'>) {
    const match = this.match(record.providerId, record.model);
    return match ? { priced: true, cost: usageCost(match.price, record.usage) } : { priced: false };
  }
  /** The price a model's requests are charged at, for the usage report. */
  priceOf(providerId: string | undefined, model: string) {
    const match = this.match(providerId, model);
    return match && { price: flat(match.price), custom: match.custom };
  }

  /** The spend of the current local month and day. Recounted from the records when the period or a price changes. */
  private current() {
    const periods = budgetPeriods(this.now());
    if (this.totals?.month === periods.month && this.totals.day === periods.day) return this.totals;
    const totals = { ...periods, monthSpent: 0, daySpent: 0 },
      records = this.deps.store.data.modelUsage || [],
      [year, month] = periods.month.split('-').map(Number),
      start = new Date(year, month - 1, 1).getTime();
    // Records are appended in time order; a day's slack covers a clock that was set back.
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index],
        time = Date.parse(record.time);
      if (!Number.isFinite(time)) continue;
      if (time < start - 86400000) break;
      if (time < start) continue;
      const cost = this.cost(record).cost;
      if (!cost) continue;
      totals.monthSpent += cost;
      if (budgetPeriods(time).day === periods.day) totals.daySpent += cost;
    }
    return (this.totals = totals);
  }
  private statuses(settings = this.settings()): Record<BudgetPeriod, BudgetStatus> {
    const totals = this.current(),
      status = (key: string, spent: number, budget?: number): BudgetStatus => ({
        key,
        spent: round(spent),
        ...(budget ? { budget, level: budgetLevel(spent, budget) } : {}),
      });
    return {
      month: status(totals.month, totals.monthSpent, settings.monthlyBudget),
      day: status(totals.day, totals.daySpent, settings.dailyBudget),
    };
  }
  /** Why automations and goals are held back, when a used-up budget says so. */
  pausedReason() {
    const settings = this.settings();
    if (settings.onExceeded !== 'pause' || (!settings.monthlyBudget && !settings.dailyBudget)) return;
    const { month, day } = this.statuses(settings);
    return day.level === 'exceeded'
      ? translate('今日花费已超出预算，自动运行已暂停')
      : month.level === 'exceeded'
        ? translate('本月花费已超出预算，自动运行已暂停')
        : undefined;
  }
  /** A budget announcement as a sentence in the interface language. */
  alertText(alert: SpendingAlert) {
    const money = (value: number) => formatMoney(value, alert.currency, currentLanguage(), 2);
    return translate(budgetAlertText(alert.period, alert.level, alert.paused), {
      spent: money(alert.spent),
      budget: money(alert.budget),
    });
  }
  view(): SpendingView {
    const settings = this.settings(),
      { month, day } = this.statuses(settings),
      table = this.table();
    return {
      settings,
      month,
      day,
      paused: settings.onExceeded === 'pause' && (month.level === 'exceeded' || day.level === 'exceeded'),
      ...(this.deps.store.data.spending?.alert ? { alert: this.deps.store.data.spending.alert } : {}),
      priceTable: {
        source: table.source,
        generatedAt: table.generatedAt,
        models: (this.tableModels ??= priceTableModels(table)),
      },
    };
  }

  /**
   * Counts the cost of a request that was just added to the store's records, and announces a budget it nearly or
   * fully used up.
   */
  record(record: UsageRecord) {
    try {
      const periods = budgetPeriods(this.now()),
        counted = this.totals?.month === periods.month && this.totals.day === periods.day,
        totals = this.current(),
        cost = this.cost(record).cost;
      // Totals counted just now from the records already include this one.
      if (counted && cost) {
        const when = budgetPeriods(Date.parse(record.time));
        if (when.month === totals.month) totals.monthSpent += cost;
        if (when.day === totals.day) totals.daySpent += cost;
      }
      if (cost) this.announce();
    } catch {
      // Pricing must never get in the way of the request that was just made; the next count starts over.
      this.totals = undefined;
    }
  }
  /**
   * Announces each level of each period once: what was announced is saved with the period it was for, so neither a
   * restart nor more spending repeats it. `quiet` only notes the levels as they are, after the user changed a
   * budget or a price themselves.
   */
  private announce(quiet = false) {
    const settings = this.settings(),
      statuses = this.statuses(settings);
    let dirty = false;
    for (const period of ['month', 'day'] as const) {
      const status = statuses[period],
        stored: StoredSpending = (this.deps.store.data.spending ??= { ...settings }),
        previous = stored.announced?.[period],
        before = previous?.key === status.key ? previous.level : undefined;
      if (quiet ? previous?.key === status.key && previous.level === status.level : rank(status.level) <= rank(before))
        continue;
      stored.announced = { ...stored.announced, [period]: { key: status.key, level: status.level } };
      dirty = true;
      if (quiet || !status.level || !status.budget) continue;
      stored.alert = {
        id: `${period}:${status.key}:${status.level}`,
        period,
        level: status.level,
        at: new Date(this.now()).toISOString(),
      };
      this.deps.onAlert?.({
        period,
        level: status.level,
        spent: status.spent,
        budget: status.budget,
        currency: settings.currency,
        paused: settings.onExceeded === 'pause' && status.level === 'exceeded',
      });
    }
    if (dirty) this.deps.store.save();
  }

  private write(settings: SpendingSettings) {
    const stored = this.deps.store.data.spending;
    this.deps.store.data.spending = {
      ...settings,
      ...(stored?.announced ? { announced: stored.announced } : {}),
      ...(stored?.alert ? { alert: stored.alert } : {}),
    };
    this.reset();
    this.announce(true);
    this.deps.store.save();
    this.deps.changed();
  }
  /** Saves the currency, its rate, the budgets and what happens past them. */
  save(input: unknown) {
    if (!input || typeof input !== 'object') throw new AppError('spending.input_invalid', '预算设置无效');
    const value = input as Record<string, unknown>,
      current = this.settings(),
      next: SpendingSettings = {
        ...current,
        rates: { ...current.rates },
        prices: current.prices.map((price) => ({ ...price })),
      };
    if (value.currency !== undefined) {
      if (!CURRENCIES.includes(value.currency as Currency))
        throw new AppError('spending.currency_invalid', '不支持这种货币');
      next.currency = value.currency as Currency;
    }
    if (value.rate !== undefined && next.currency !== 'USD') {
      const rate = amount(value.rate, '汇率', 1e6);
      if (!rate) throw new AppError('spending.amount_invalid', '汇率应大于 0');
      next.rates[next.currency] = rate;
    }
    // Amounts the user typed are in the chosen currency: they follow it to the new one.
    if (next.currency !== current.currency) {
      const factor = this.rate(next) / this.rate(current);
      if (next.monthlyBudget) next.monthlyBudget = Number((next.monthlyBudget * factor).toFixed(2));
      if (next.dailyBudget) next.dailyBudget = Number((next.dailyBudget * factor).toFixed(2));
      next.prices = next.prices.map((price) => scaled(price, factor));
    }
    for (const key of ['monthlyBudget', 'dailyBudget'] as const) {
      if (value[key] === undefined) continue;
      const budget = value[key] === null ? 0 : amount(value[key], key === 'monthlyBudget' ? '每月预算' : '每日预算');
      if (budget) next[key] = budget;
      else delete next[key];
    }
    if (value.onExceeded !== undefined) {
      if (value.onExceeded !== 'notify' && value.onExceeded !== 'pause')
        throw new AppError('spending.input_invalid', '预算设置无效');
      next.onExceeded = value.onExceeded;
    }
    this.write(next);
  }
  /** Sets the user's own price for a model of a provider, in the chosen currency; null goes back to the table's. */
  setPrice(input: unknown) {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
      providerId = value.providerId,
      model = value.model;
    if (typeof providerId !== 'string' || !providerId || providerId.length > 200)
      throw new AppError('spending.input_invalid', '价格设置无效');
    if (typeof model !== 'string' || !model.trim() || model.length > 256)
      throw new AppError('spending.input_invalid', '价格设置无效');
    const settings = this.settings(),
      prices = settings.prices.filter((price) => !(price.providerId === providerId && price.model === model));
    if (value.price !== null) {
      const price = value.price && typeof value.price === 'object' ? (value.price as Record<string, unknown>) : {};
      prices.push({
        providerId,
        model,
        input: amount(price.input, '输入价格', 1e6),
        output: amount(price.output, '输出价格', 1e6),
        ...(price.cacheRead === undefined || price.cacheRead === null
          ? {}
          : { cacheRead: amount(price.cacheRead, '缓存读取价格', 1e6) }),
        ...(price.cacheWrite === undefined || price.cacheWrite === null
          ? {}
          : { cacheWrite: amount(price.cacheWrite, '缓存写入价格', 1e6) }),
      });
    }
    this.write({ ...settings, prices });
  }
  /** Every model that was used, is chosen somewhere or has a price of the user's, with the price in use. */
  prices(): ModelPriceRow[] {
    const data = this.deps.store.data,
      rows = new Map<string, ModelPriceRow>();
    const add = (providerId: string | undefined, model: string, recordedName?: string) => {
      const id = providerId || LEGACY_PROVIDER,
        key = JSON.stringify([id, model]);
      if (!model || rows.has(key)) return;
      const match = this.match(id, model);
      rows.set(key, {
        providerId: id,
        providerName:
          this.deps.provider(id)?.name ||
          recordedName ||
          (id === LEGACY_PROVIDER ? '早期记录' : '已删除的 Provider · ' + id.slice(0, 8)),
        model,
        ...(match ? { price: flat(match.price) } : {}),
        ...(match?.builtin ? { builtin: flat(match.builtin) } : {}),
        custom: Boolean(match?.custom),
      });
    };
    for (const selection of [
      data.defaultModel,
      data.approvalModel,
      data.memoryModel,
      ...data.bots.map((bot) => bot.model),
    ])
      if (selection) add(selection.providerId, selection.model);
    for (const price of this.settings().prices) add(price.providerId, price.model);
    for (const record of data.modelUsage || []) add(record.providerId, record.model, record.providerName);
    return [...rows.values()].sort(
      (a, b) => a.providerName.localeCompare(b.providerName) || a.model.localeCompare(b.model),
    );
  }

  /** Fetches today's prices and keeps them in the data folder; the bundled table stays in use when that fails. */
  refreshPrices() {
    return (this.refreshing ??= (async () => {
      try {
        const response = await (this.deps.fetch ?? fetch)(PRICE_SOURCE_URL, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new AppError('pricing.refresh_failed', `价格表下载失败（${response.status}）`);
        const text = serializePriceTable(priceTableFrom(await response.json(), budgetPeriods(this.now()).day)),
          table = parsePriceTable(JSON.parse(text));
        if (this.deps.dataDir) {
          const file = join(this.deps.dataDir, REFRESHED_TABLE),
            temp = `${file}.${process.pid}.tmp`;
          writeFileSync(temp, text);
          renameSync(temp, file);
        }
        this.tableValue = table;
        this.tableModels = undefined;
        this.reset();
        this.announce(true);
        this.deps.changed();
        return { models: priceTableModels(table), generatedAt: table.generatedAt };
      } finally {
        this.refreshing = undefined;
      }
    })());
  }
}
