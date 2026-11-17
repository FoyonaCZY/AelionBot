import { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import { ipcErrorText } from '../ui/ipc-error';
import {
  CURRENCIES,
  formatMoney,
  type BudgetStatus,
  type Currency,
  type ModelPrice,
  type ModelPriceRow,
  type SpendingInput,
  type SpendingView,
} from '../../shared/model-pricing';
import { currentLanguage, useI18n } from '../i18n';
import './usage-spending.css';

const CURRENCY_NAMES: Record<Currency, string> = { USD: '美元', CNY: '人民币', EUR: '欧元' };
const PRICE_FIELDS = [
  { key: 'input', label: '输入', required: true },
  { key: 'output', label: '输出', required: true },
  { key: 'cacheRead', label: '缓存读取', required: false },
  { key: 'cacheWrite', label: '缓存写入', required: false },
] as const;
type PriceField = (typeof PRICE_FIELDS)[number]['key'];
type PriceDraft = { key: string } & Record<PriceField, string>;

export const priceRowKey = (row: { providerId?: string; model?: string }) =>
  JSON.stringify([row.providerId, row.model]);
/** A typed amount: empty is none (null), anything else must be a number from zero up (undefined when it is not). */
function parseAmount(text: string) {
  const value = text.trim().replace(',', '.');
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
const amountText = (value?: number) => (value === undefined ? '' : String(Number(value.toFixed(6))));

/** A chip holding one amount; it saves when the field is left or Enter is pressed, and reverts what is not a number. */
function AmountField({
  label,
  unit,
  value,
  placeholder,
  ariaLabel,
  onCommit,
}: {
  label: string;
  unit?: string;
  value?: number;
  placeholder?: string;
  ariaLabel: string;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(amountText(value));
  useEffect(() => setDraft(amountText(value)), [value]);
  const commit = () => {
    const parsed = parseAmount(draft);
    if (parsed === undefined) setDraft(amountText(value));
    else if ((parsed ?? undefined) !== value) onCommit(parsed);
  };
  return (
    <label className="usage-filter usage-amount">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
      {unit && <span>{unit}</span>}
    </label>
  );
}

/** One period: what it has spent, its budget to type, and how much of the budget is used. */
function BudgetMeter({
  label,
  budgetLabel,
  status,
  currency,
  onBudget,
}: {
  label: string;
  budgetLabel: string;
  status: BudgetStatus;
  currency: Currency;
  onBudget: (value: number | null) => void;
}) {
  const { t } = useI18n();
  const money = (value: number) => formatMoney(value, currency, currentLanguage()),
    share = status.budget ? Math.min(1, status.spent / status.budget) : 0;
  return (
    <div className={`usage-budget-meter${status.level ? ` is-${status.level}` : ''}`}>
      <div className="usage-budget-head">
        <span className="usage-label">{label}</span>
        <AmountField
          label={t('预算')}
          unit={currency}
          value={status.budget}
          placeholder={t('不限')}
          ariaLabel={budgetLabel}
          onCommit={onBudget}
        />
      </div>
      <p className="usage-budget-spent">
        <strong>{money(status.spent)}</strong>
        {status.budget !== undefined && <span>/ {money(status.budget)}</span>}
        {status.level === 'exceeded' && <em>{t('已超出')}</em>}
      </p>
      {status.budget !== undefined && (
        <div
          className="usage-rank-track usage-budget-track"
          role="progressbar"
          aria-label={budgetLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
        >
          <i style={{ width: `${share * 100}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * The usage page's budget tab: the month's and the day's spend against their budgets, what happens past them, the
 * currency, and the price of every model. `focus` opens one model's price for editing.
 */
export function UsageBudget({
  spending,
  focus,
  onFocused,
}: {
  spending: SpendingView;
  focus?: string;
  onFocused: () => void;
}) {
  const { t } = useI18n();
  const settings = spending.settings,
    currency = settings.currency;
  const [error, setError] = useState(''),
    [rows, setRows] = useState<ModelPriceRow[]>(),
    [search, setSearch] = useState(''),
    [draft, setDraft] = useState<PriceDraft>(),
    [saving, setSaving] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [refreshed, setRefreshed] = useState('');
  const table = useRef<HTMLTableElement>(null);
  const revision = JSON.stringify([currency, settings.rates, settings.prices, spending.priceTable.generatedAt]);
  useEffect(() => {
    let active = true;
    void window.aelion.listModelPrices().then(
      (value) => active && setRows(value),
      (reason) => active && setError(ipcErrorText(reason)),
    );
    return () => {
      active = false;
    };
  }, [revision]);
  const save = (input: SpendingInput) => {
    setError('');
    void window.aelion.saveSpending(input).catch((reason) => setError(ipcErrorText(reason)));
  };
  const price = (value?: number) => (value === undefined ? '—' : formatMoney(value, currency, currentLanguage(), 6));
  const edit = (row: ModelPriceRow) => {
    const from: Partial<Omit<ModelPrice, 'tiers'>> = row.price || {};
    setError('');
    setDraft({
      key: priceRowKey(row),
      input: amountText(from.input),
      output: amountText(from.output),
      cacheRead: amountText(from.cacheRead),
      cacheWrite: amountText(from.cacheWrite),
    });
  };
  // Opened from the model table for one model: its row goes into editing and into view.
  useEffect(() => {
    if (!focus || !rows) return;
    const row = rows.find((item) => priceRowKey(item) === focus);
    if (row) {
      setSearch('');
      edit(row);
      requestAnimationFrame(() =>
        table.current?.querySelector('tr.is-editing')?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      );
    }
    onFocused();
  }, [focus, rows]);
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (rows || [])
      .filter((row) => !needle || `${row.model} ${row.providerName}`.toLowerCase().includes(needle))
      .sort((a, b) => Number(Boolean(a.price)) - Number(Boolean(b.price)));
  }, [rows, search]);
  const parsed = draft && Object.fromEntries(PRICE_FIELDS.map((field) => [field.key, parseAmount(draft[field.key])])),
    valid =
      parsed &&
      PRICE_FIELDS.every((field) =>
        field.required ? typeof parsed[field.key] === 'number' : parsed[field.key] !== undefined,
      );
  const setPrice = async (row: ModelPriceRow, value: Omit<ModelPrice, 'tiers'> | null) => {
    setSaving(true);
    setError('');
    try {
      await window.aelion.setModelPrice({ providerId: row.providerId, model: row.model, price: value });
      setDraft(undefined);
    } catch (reason) {
      setError(ipcErrorText(reason));
    } finally {
      setSaving(false);
    }
  };
  const refreshPrices = async () => {
    setRefreshing(true);
    setRefreshed('');
    setError('');
    try {
      const result = await window.aelion.refreshModelPrices();
      setRefreshed(t('已更新，{count} 个模型', { count: result.models.toLocaleString(currentLanguage()) }));
    } catch (reason) {
      setError(ipcErrorText(reason));
    } finally {
      setRefreshing(false);
    }
  };
  let source = spending.priceTable.source;
  try {
    source = new URL(source).host;
  } catch {
    // A source that is not an address is shown as it is.
  }
  return (
    <div id="usage-budget-panel" role="tabpanel" className="usage-tab-panel">
      {error && (
        <div className="usage-card usage-error" role="alert">
          {error}
        </div>
      )}
      <section className="usage-card usage-budget-card">
        <header className="usage-chart-head">
          <h3>{t('预算')}</h3>
          <div className="usage-chart-controls">
            <span className="usage-label">{t('超出后')}</span>
            <div className="usage-segmented is-small" role="group" aria-label={t('超出预算后')}>
              {(
                [
                  ['notify', '只提醒'],
                  ['pause', '暂停自动运行'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={settings.onExceeded === value ? 'is-active' : ''}
                  aria-pressed={settings.onExceeded === value}
                  onClick={() => settings.onExceeded !== value && save({ onExceeded: value })}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="usage-budget-grid">
          <BudgetMeter
            label={t('本月')}
            budgetLabel={t('每月预算')}
            status={spending.month}
            currency={currency}
            onBudget={(value) => save({ monthlyBudget: value })}
          />
          <BudgetMeter
            label={t('今天')}
            budgetLabel={t('每日预算')}
            status={spending.day}
            currency={currency}
            onBudget={(value) => save({ dailyBudget: value })}
          />
        </div>
        {spending.paused && (
          <p className="usage-budget-note">
            <Icon name="pause" size={14} />
            {t('自动化和持续目标已暂停，你发的消息照常执行。')}
          </p>
        )}
      </section>

      <section className="usage-card usage-ledger-card">
        <header className="usage-ledger-head">
          <h3>{t('模型价格')}</h3>
          <label className="usage-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={search}
              placeholder={t('搜索模型或 Provider')}
              aria-label={t('搜索模型或 Provider')}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </header>
        <div className="usage-filter-row">
          <label className="usage-filter">
            <span>{t('货币')}</span>
            <Select
              className="usage-select"
              aria-label={t('货币')}
              value={currency}
              onChange={(event) => save({ currency: event.target.value as Currency })}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code} · {t(CURRENCY_NAMES[code])}
                </option>
              ))}
            </Select>
          </label>
          {currency !== 'USD' && (
            <AmountField
              label={`${t('汇率（手动）')} 1 USD =`}
              unit={currency}
              value={settings.rates[currency]}
              ariaLabel={t('汇率（手动）')}
              onCommit={(value) => value && save({ rate: value })}
            />
          )}
          <span className="usage-price-source">
            {refreshed || t('内置价格：{source}，{date}', { source, date: spending.priceTable.generatedAt })}
          </span>
          <button type="button" className="usage-reset" disabled={refreshing} onClick={() => void refreshPrices()}>
            {refreshing ? t('正在更新…') : t('更新价格表')}
          </button>
        </div>
        <p className="usage-price-note">{t('价格按每百万 tokens 计。花费按当前价格估算，不是账单。')}</p>
        {!rows ? (
          <div className="usage-ledger-empty" role="status">
            {t('正在读取价格…')}
          </div>
        ) : shown.length ? (
          <div className="usage-table-scroll">
            <table ref={table} className="usage-ledger usage-price-table">
              <caption className="usage-sr-only">{t('模型价格')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('模型 / Provider')}</th>
                  {PRICE_FIELDS.map((field) => (
                    <th key={field.key} scope="col">
                      {t(field.label)}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="usage-sr-only">{t('操作')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const key = priceRowKey(row),
                    editing = draft?.key === key ? draft : undefined;
                  return (
                    <tr key={key} className={editing ? 'is-editing' : undefined}>
                      <td>
                        <span className="usage-model-cell">
                          <strong title={row.model}>{row.model}</strong>
                          <small>
                            {row.providerName}
                            {row.custom && ` · ${t('自定义')}`}
                            {!row.price && <span className="usage-price-missing"> · {t('未定价')}</span>}
                          </small>
                        </span>
                      </td>
                      {PRICE_FIELDS.map((field) => (
                        <td key={field.key}>
                          {editing ? (
                            <input
                              className="settings-field usage-price-input"
                              type="text"
                              inputMode="decimal"
                              value={editing[field.key]}
                              placeholder={
                                row.builtin?.[field.key] === undefined ? '' : amountText(row.builtin[field.key])
                              }
                              aria-label={`${row.model} ${t(field.label)}`}
                              aria-invalid={
                                field.required
                                  ? typeof parsed?.[field.key] !== 'number'
                                  : parsed?.[field.key] === undefined
                              }
                              onChange={(event) => setDraft({ ...editing, [field.key]: event.target.value })}
                            />
                          ) : (
                            price(row.price?.[field.key])
                          )}
                        </td>
                      ))}
                      <td>
                        <span className="usage-price-actions">
                          {editing ? (
                            <>
                              <button
                                type="button"
                                className="secondary-button"
                                disabled={!valid || saving}
                                onClick={() =>
                                  void setPrice(row, {
                                    input: parsed!.input as number,
                                    output: parsed!.output as number,
                                    ...(typeof parsed!.cacheRead === 'number' ? { cacheRead: parsed!.cacheRead } : {}),
                                    ...(typeof parsed!.cacheWrite === 'number'
                                      ? { cacheWrite: parsed!.cacheWrite }
                                      : {}),
                                  })
                                }
                              >
                                {t('保存')}
                              </button>
                              {row.custom && (
                                <button
                                  type="button"
                                  className="usage-reset"
                                  disabled={saving}
                                  onClick={() => void setPrice(row, null)}
                                >
                                  {t(row.builtin ? '恢复内置' : '清除')}
                                </button>
                              )}
                              <button type="button" className="usage-reset" onClick={() => setDraft(undefined)}>
                                {t('取消')}
                              </button>
                            </>
                          ) : (
                            <button type="button" className="usage-reset" onClick={() => edit(row)}>
                              {t(row.price ? '编辑' : '设置价格')}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="usage-ledger-empty">{t(rows.length ? '没有匹配的模型' : '还没有用过的模型')}</div>
        )}
      </section>
    </div>
  );
}
