import { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from '../ui/Select';
import { Icon } from '../ui/Icon';
import { useSwitchMotion } from '../ui/motion';
import type { Snapshot } from '../../shared/types/core';
import {
  cacheHitRatio,
  type UsageBucket,
  type UsageGroup,
  type UsageQuery,
  type UsageReport,
  type UsageTotals,
} from '../../shared/types/usage-types';
import { currentLanguage, useI18n } from '../i18n';
import './usage-settings.css';

const day = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
function range(days: number) {
  const to = new Date(),
    from = new Date(to);
  from.setDate(from.getDate() - days + 1);
  return { from: day(from), to: day(to) };
}
const number = (value: number) => value.toLocaleString(currentLanguage());
const compact = (value: number) =>
  new Intl.NumberFormat(currentLanguage(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const percent = (value: UsageTotals) => `${(cacheHitRatio(value) * 100).toFixed(1)}%`;
const dateLabel = (value: string) => {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(currentLanguage(), { month: 'short', day: 'numeric' });
};
/** A bucket's key as people read it: days as "11月8日", hours and months as they are. */
const bucketLabel = (key: string) => (/^\d{4}-\d{2}-\d{2}$/.test(key) ? dateLabel(key) : key);
const purposes: Record<string, string> = {
  foreground: '任务执行',
  permission_review: '权限审核',
  background_review: '后台整理',
  memory_capture: '记忆提取',
  memory_consolidate: '记忆整理',
  progress: '进度说明',
  greeting: '问候',
};
type Metric = 'totalTokens' | 'inputTokens' | 'outputTokens' | 'cachedTokens';
type Tab = 'overview' | 'detail';
type SortKey = 'model' | 'totalTokens' | 'requests' | 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'hit';
const metricNames: Record<Metric, string> = {
  totalTokens: '总 tokens',
  inputTokens: '输入 tokens',
  outputTokens: '输出 tokens',
  cachedTokens: '缓存读取 tokens',
};
const metricShortNames: Record<Metric, string> = {
  totalTokens: '总',
  inputTokens: '输入',
  outputTokens: '输出',
  cachedTokens: '缓存',
};
function metricValue(row: UsageTotals, metric: Metric) {
  const reports =
    metric === 'totalTokens'
      ? row.reportedRequests
      : metric === 'inputTokens'
        ? row.inputReports
        : metric === 'outputTokens'
          ? row.outputReports
          : row.cacheReports;
  return !row.requests || reports ? row[metric] : undefined;
}
function splitCompact(value: number) {
  const text = compact(value),
    match = text.match(/^([\d.,]+)\s*(.*)$/);
  return { value: match?.[1] || text, unit: match?.[2] || '' };
}
function sortValue(row: UsageGroup, key: SortKey) {
  if (key === 'model') return row.model || row.name;
  if (key === 'hit') return row.inputReports && row.cacheReports ? cacheHitRatio(row) : -1;
  return row[key];
}
/** A round step that splits 0..maximum into about three gridlines: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(maximum: number) {
  const raw = maximum / 3,
    magnitude = 10 ** Math.floor(Math.log10(raw)),
    fraction = raw / magnitude;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * magnitude;
}

/** One column per bucket from a single baseline; the hovered or focused column darkens and the header reads it out. */
function UsageColumns({
  buckets,
  metric,
  onSelect,
}: {
  buckets: UsageBucket[];
  metric: Metric;
  onSelect?: (row?: UsageBucket) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<number>();
  useEffect(() => setSelected(undefined), [buckets, metric]);
  const select = (index?: number) => {
    setSelected(index);
    onSelect?.(index === undefined ? undefined : buckets[index]);
  };
  const width = 700,
    height = 196,
    left = 48,
    right = 4,
    top = 10,
    bottom = 28,
    plotWidth = width - left - right,
    plotHeight = height - top - bottom,
    base = top + plotHeight;
  const maximum = Math.max(1, ...buckets.map((row) => metricValue(row, metric) || 0)),
    step = niceStep(maximum),
    ceiling = Math.ceil(maximum / step) * step,
    ticks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => index * step);
  const slot = plotWidth / Math.max(1, buckets.length),
    barWidth = Math.max(1.5, Math.min(24, slot - Math.max(2, slot * 0.28))),
    y = (value: number) => top + plotHeight * (1 - value / ceiling);
  const column = (index: number, value: number) => {
    const x = left + index * slot + (slot - barWidth) / 2,
      top = y(value),
      radius = Math.min(4, barWidth / 2, base - top);
    if (base - top < 0.5) return '';
    return `M${x},${base}V${top + radius}Q${x},${top} ${x + radius},${top}H${x + barWidth - radius}Q${x + barWidth},${top} ${x + barWidth},${top + radius}V${base}Z`;
  };
  const labelIndices = [
    ...new Set([0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round((buckets.length - 1) * fraction))),
  ].filter((index) => index >= 0 && index < buckets.length);
  return (
    <div className="usage-columns">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={t('{metric}时间趋势', { metric: t(metricNames[metric]) })}
        onMouseLeave={() => select(undefined)}
      >
        {ticks.map((value) => (
          <g key={value}>
            <line
              className={value ? 'usage-grid' : 'usage-baseline'}
              x1={left}
              x2={width - right}
              y1={y(value)}
              y2={y(value)}
            />
            <text x={left - 10} y={y(value) + 4} textAnchor="end" className="usage-axis">
              {compact(value)}
            </text>
          </g>
        ))}
        {buckets.map((row, index) => {
          const value = metricValue(row, metric);
          return value === undefined ? (
            <line
              key={row.key}
              className="usage-column-missing"
              x1={left + index * slot + slot / 2}
              x2={left + index * slot + slot / 2}
              y1={base - 6}
              y2={base}
            />
          ) : (
            <path
              key={row.key}
              className={`usage-column${selected === index ? ' is-selected' : ''}`}
              d={column(index, value)}
            />
          );
        })}
        {labelIndices.map((index) => (
          <text
            key={index}
            x={left + index * slot + slot / 2}
            y={height - 6}
            textAnchor={
              labelIndices.length > 1 && index === 0
                ? 'start'
                : labelIndices.length > 1 && index === buckets.length - 1
                  ? 'end'
                  : 'middle'
            }
            className="usage-axis"
          >
            {bucketLabel(buckets[index].key)}
          </text>
        ))}
        {buckets.map((row, index) => (
          <rect
            key={row.key}
            className="usage-column-hit"
            x={left + index * slot}
            y={top}
            width={slot}
            height={plotHeight}
            tabIndex={index === (selected ?? 0) ? 0 : -1}
            role="button"
            aria-label={t('{key}，{metric} {value}，{count} 次请求', {
              key: bucketLabel(row.key),
              metric: t(metricNames[metric]),
              value: metricValue(row, metric) === undefined ? t('未返回') : number(row[metric]),
              count: row.requests,
            })}
            onMouseEnter={() => select(index)}
            onFocus={() => select(index)}
            onBlur={() => select(undefined)}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buckets.length - 1
                    : Math.max(0, Math.min(buckets.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
              (event.currentTarget.parentElement?.querySelectorAll('rect')[next] as SVGElement)?.focus();
            }}
          />
        ))}
      </svg>
    </div>
  );
}

/** The headline: total tokens, what they are made of, and the request counts beside them. */
function UsageSummary({ totals, period }: { totals: UsageTotals; period: string }) {
  const { t } = useI18n();
  const totalReported = totals.reportedRequests > 0 || !totals.requests,
    inputReported = totals.inputReports > 0 || !totals.requests,
    outputReported = totals.outputReports > 0 || !totals.requests,
    cacheReported = totals.cacheReports > 0 || !totals.requests;
  const total = splitCompact(totals.totalTokens),
    cached = cacheReported ? Math.min(totals.cachedTokens, totals.inputTokens) : 0,
    input = inputReported ? totals.inputTokens : 0,
    output = outputReported ? totals.outputTokens : 0,
    newInput = Math.max(0, input - cached),
    composition = inputReported && cacheReported && outputReported,
    whole = cached + newInput + output;
  const parts = [
    { key: 'cache', label: t('缓存输入'), value: cached, reported: cacheReported },
    { key: 'new', label: t('新增输入'), value: newInput, reported: inputReported },
    { key: 'output', label: t('输出'), value: output, reported: outputReported },
  ];
  const share = (value: number) => (whole > 0 ? (value / whole) * 100 : 0);
  const failureRate = totals.requests ? `${((totals.failedRequests / totals.requests) * 100).toFixed(1)}%` : '—';
  return (
    <section className="usage-summary">
      <div className="usage-summary-total">
        <span className="usage-label">
          {t('总 tokens')} · {period}
        </span>
        <div className="usage-hero-number">
          <strong>{totalReported ? total.value : '—'}</strong>
          {totalReported && total.unit && <span>{total.unit}</span>}
        </div>
      </div>
      {composition && whole > 0 && (
        <div
          className="usage-mix"
          role="img"
          aria-label={parts.map((part) => `${part.label} ${compact(part.value)}`).join('，')}
        >
          {parts.map(
            (part) =>
              part.value > 0 && <i key={part.key} className={`is-${part.key}`} style={{ flexGrow: part.value }} />,
          )}
        </div>
      )}
      <dl className="usage-mix-legend">
        {parts.map((part) => (
          <div key={part.key}>
            <dt>
              <i className={`usage-swatch is-${part.key}`} aria-hidden="true" />
              {part.label}
            </dt>
            <dd>
              {part.reported ? compact(part.value) : '—'}
              {composition && whole > 0 && <small>{share(part.value).toFixed(1)}%</small>}
            </dd>
          </div>
        ))}
      </dl>
      <dl className="usage-stats">
        <div>
          <dt>{t('请求')}</dt>
          <dd>{number(totals.requests)}</dd>
          <dd className={`usage-stat-note${totals.failedRequests ? ' is-bad' : ''}`}>
            {t('{count} 次失败', { count: number(totals.failedRequests) })} · {failureRate}
          </dd>
        </div>
        <div>
          <dt>{t('缓存命中率')}</dt>
          <dd>{inputReported && cacheReported ? percent(totals) : '—'}</dd>
          <dd className="usage-stat-note">
            {t('输入合计')} {inputReported ? compact(totals.inputTokens) : '—'}
          </dd>
        </div>
        <div>
          <dt>{t('平均每次请求')}</dt>
          <dd>
            {totalReported && totals.reportedRequests ? compact(totals.totalTokens / totals.reportedRequests) : '—'}
          </dd>
          <dd className="usage-stat-note">tokens</dd>
        </div>
      </dl>
      {totals.missingUsage > 0 && (
        <p className="usage-missing">
          <Icon name="info" size={14} />
          {t('{count} 次请求未返回 token 用量（可能包括失败或超时请求），不代表零消耗。', {
            count: totals.missingUsage,
          })}
        </p>
      )}
    </section>
  );
}

function UsageRankList({
  title,
  groups,
  total,
  active,
  model = false,
  onChoose,
}: {
  title: string;
  groups: UsageGroup[];
  total: number;
  active?: string;
  model?: boolean;
  onChoose: (row: UsageGroup) => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? groups : groups.slice(0, 5),
    maximum = Math.max(1, ...groups.map((row) => row.totalTokens));
  return (
    <section className="usage-card usage-rank-card">
      <h3>{title}</h3>
      {rows.length ? (
        <div className="usage-rank-list">
          {rows.map((row) => {
            const isActive = model ? active === row.model : active === row.providerId,
              share = total > 0 ? (row.totalTokens / total) * 100 : 0,
              name = model ? row.model || row.name : row.name;
            return (
              <button
                key={row.key}
                type="button"
                className={`usage-rank-row${isActive ? ' is-active' : ''}`}
                onClick={() => onChoose(row)}
                aria-pressed={isActive}
                aria-label={t('筛选{kind} {name}', {
                  kind: model ? t('模型') : 'Provider',
                  name: model ? `${row.model} · ${row.name}` : row.name,
                })}
              >
                <span className="usage-rank-name" title={name}>
                  <span>{name}</span>
                  <small>{model ? row.name : t('{count} 次请求', { count: number(row.requests) })}</small>
                </span>
                <span className="usage-rank-value">{row.reportedRequests ? compact(row.totalTokens) : '—'}</span>
                <span className="usage-rank-track" aria-hidden="true">
                  <i style={{ width: `${(row.totalTokens / maximum) * 100}%` }} />
                </span>
                <span className="usage-rank-share">{share.toFixed(1)}%</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="usage-muted">{t('暂无记录')}</p>
      )}
      {groups.length > 5 && (
        <button type="button" className="usage-rank-more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t('收起') : t('展开全部 {count} 项', { count: groups.length })}
        </button>
      )}
    </section>
  );
}

export function UsageSettings({ state }: { state: Snapshot }) {
  const { t } = useI18n();
  const [preset, setPreset] = useState('30'),
    [query, setQuery] = useState<UsageQuery>(() => ({ ...range(30), granularity: 'day' })),
    [metric, setMetric] = useState<Metric>('totalTokens'),
    [report, setReport] = useState<UsageReport>(),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0),
    [tab, setTab] = useState<Tab>('overview'),
    [hovered, setHovered] = useState<UsageBucket>(),
    [search, setSearch] = useState(''),
    [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'totalTokens', dir: 'desc' });
  const revision = state.modelUsage?.at(-1)?.id,
    providerRevision = (state.providers || []).map((provider) => provider.id + provider.name).join('|');
  const root = useRef<HTMLDivElement>(null);
  useSwitchMotion(root, tab, '.usage-tab-panel');

  useEffect(() => {
    let active = true;
    setError('');
    const timer = setTimeout(() => {
      void window.aelion
        .queryUsage(query)
        .then((value) => {
          if (active) setReport(value);
        })
        .catch((error) => {
          if (active) setError(String(error.message).replace(/^Error invoking remote method '[^']+': Error: /, ''));
        });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [JSON.stringify(query), revision, providerRevision, refresh]);

  useEffect(() => setHovered(undefined), [report, metric]);

  const update = (patch: Partial<UsageQuery>) =>
    setQuery((value) => {
      const next = { ...value, ...patch };
      if (next.granularity === 'hour' && new Date(next.to).getTime() - new Date(next.from).getTime() > 30 * 86400000)
        next.granularity = 'day';
      return next;
    });
  const applyPreset = (value: string) => {
    setPreset(value);
    setHovered(undefined);
    if (value === 'custom') {
      update({ granularity: 'day' });
      return;
    }
    update({ ...range(Number(value)), granularity: value === '1' ? 'hour' : 'day' });
  };
  const reset = () => {
    setPreset('30');
    setSearch('');
    setHovered(undefined);
    setQuery({ ...range(30), granularity: 'day' });
  };
  // While a new range or filter loads, the last result stays on screen, dimmed, so nothing jumps.
  const stale = Boolean(report) && JSON.stringify(report?.query) !== JSON.stringify(query),
    totals = report?.totals,
    filtered = Boolean(query.providerId || query.model || query.purpose);
  const period =
    preset === 'custom'
      ? `${dateLabel(query.from)} – ${dateLabel(query.to)}`
      : preset === '1'
        ? t('今天')
        : preset === '7'
          ? t('最近 7 天')
          : preset === '90'
            ? t('最近 90 天')
            : t('最近 30 天');
  const chartRows = report?.buckets ?? [],
    chartValues = chartRows
      .map((row) => metricValue(row, metric))
      .filter((value): value is number => value !== undefined);
  const chartTotal = chartValues.reduce((sum, value) => sum + value, 0);
  const peak = chartRows.reduce<{ value: number; key: string } | undefined>((best, row) => {
    const value = metricValue(row, metric);
    return value !== undefined && (!best || value > best.value) ? { value, key: row.key } : best;
  }, undefined);
  const hoveredValue = hovered ? metricValue(hovered, metric) : undefined;
  const tableRows = useMemo(() => {
    const needle = search.trim().toLowerCase(),
      rows = (report?.byModel ?? []).filter(
        (row) => !needle || `${row.model || ''} ${row.name || ''}`.toLowerCase().includes(needle),
      );
    return [...rows].sort((a, b) => {
      const left = sortValue(a, sort.key),
        right = sortValue(b, sort.key);
      const comparison =
        typeof left === 'string' || typeof right === 'string'
          ? String(left).localeCompare(String(right))
          : left - right;
      return sort.dir === 'asc' ? comparison : -comparison;
    });
  }, [report?.byModel, search, sort]);

  const columns: Array<{ key: SortKey; label: string }> = [
    { key: 'model', label: t('模型 / Provider') },
    { key: 'totalTokens', label: t('总 tokens') },
    { key: 'requests', label: t('请求') },
    { key: 'inputTokens', label: t('输入') },
    { key: 'outputTokens', label: t('输出') },
    { key: 'cachedTokens', label: t('缓存读取') },
    { key: 'hit', label: t('命中率') },
  ];

  return (
    <div ref={root} className="usage-settings">
      <div className="usage-toolbar">
        <div className="usage-tabs" role="tablist" aria-label={t('用量')}>
          <button
            type="button"
            role="tab"
            className={`usage-tab${tab === 'overview' ? ' is-active' : ''}`}
            aria-selected={tab === 'overview'}
            aria-controls="usage-overview-panel"
            onClick={() => setTab('overview')}
          >
            {t('概览')}
          </button>
          <button
            type="button"
            role="tab"
            className={`usage-tab${tab === 'detail' ? ' is-active' : ''}`}
            aria-selected={tab === 'detail'}
            aria-controls="usage-detail-panel"
            onClick={() => setTab('detail')}
          >
            {t('模型明细')}
          </button>
        </div>
        <div className="usage-range-row">
          <div className="usage-segmented" role="group" aria-label={t('用量时间范围')}>
            {[
              ['1', t('今天')],
              ['7', t('{count} 天', { count: 7 })],
              ['30', t('{count} 天', { count: 30 })],
              ['90', t('{count} 天', { count: 90 })],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={preset === value ? 'is-active' : ''}
                aria-pressed={preset === value}
                onClick={() => applyPreset(value)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={`usage-segment-icon${preset === 'custom' ? ' is-active' : ''}`}
              aria-label={t('自定义')}
              aria-pressed={preset === 'custom'}
              title={t('自定义')}
              onClick={() => applyPreset('custom')}
            >
              <Icon name="clock" size={15} />
            </button>
          </div>
          <button
            type="button"
            className="usage-icon-button"
            aria-label={t('刷新')}
            title={t('刷新')}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <Icon name="restart" size={15} />
          </button>
        </div>
      </div>

      <div className="usage-filter-row">
        <label className="usage-filter">
          <span>Provider</span>
          <Select
            className="usage-select"
            aria-label={t('用量 Provider')}
            value={query.providerId || ''}
            onChange={(event) => update({ providerId: event.target.value || undefined, model: undefined })}
          >
            <option value="">{t('全部')}</option>
            {(report?.providers || state.providers || []).map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="usage-filter">
          <span>{t('模型')}</span>
          <Select
            className="usage-select"
            aria-label={t('用量模型')}
            value={query.model || ''}
            onChange={(event) => update({ model: event.target.value || undefined })}
          >
            <option value="">{t('全部')}</option>
            {[...new Set([...(report?.models || []), ...(query.model ? [query.model] : [])])].map((model) => (
              <option key={model}>{model}</option>
            ))}
          </Select>
        </label>
        <label className="usage-filter">
          <span>{t('用途')}</span>
          <Select
            className="usage-select"
            aria-label={t('用量用途')}
            value={query.purpose || ''}
            onChange={(event) => update({ purpose: event.target.value || undefined })}
          >
            <option value="">{t('全部')}</option>
            {[...new Set([...(report?.purposes || []), ...(query.purpose ? [query.purpose] : [])])].map((purpose) => (
              <option key={purpose} value={purpose}>
                {t(purposes[purpose] || purpose)}
              </option>
            ))}
          </Select>
        </label>
        {(filtered || preset !== '30') && (
          <button type="button" className="usage-reset" onClick={reset}>
            {t('重置筛选')}
          </button>
        )}
      </div>

      {preset === 'custom' && (
        <div className="usage-dates">
          <label>
            {t('开始日期')}
            <input
              type="date"
              aria-label={t('用量开始日期')}
              value={query.from}
              onChange={(event) => update({ from: event.target.value })}
            />
          </label>
          <span aria-hidden="true">–</span>
          <label>
            {t('结束日期')}
            <input
              type="date"
              aria-label={t('用量结束日期')}
              value={query.to}
              onChange={(event) => update({ to: event.target.value })}
            />
          </label>
        </div>
      )}

      {error ? (
        <div className="usage-card usage-error" role="alert">
          {error}
        </div>
      ) : !totals ? (
        <div className="usage-loading" role="status">
          <span className="usage-sr-only">{t('正在统计用量…')}</span>
          <div className="usage-skeleton" />
          <div className="usage-skeleton is-wide" />
        </div>
      ) : !totals.requests ? (
        <div className={`usage-card usage-empty${stale ? ' is-stale' : ''}`}>
          <span className="usage-empty-icon" aria-hidden="true">
            <Icon name="chart" size={22} />
          </span>
          <h3>{t('这段时间还没有用量记录')}</h3>
          {(filtered || preset !== '30') && (
            <button type="button" className="secondary-button" onClick={reset}>
              {t('重置筛选')}
            </button>
          )}
        </div>
      ) : tab === 'overview' ? (
        <div
          id="usage-overview-panel"
          role="tabpanel"
          className={`usage-tab-panel${stale ? ' is-stale' : ''}`}
          aria-busy={stale}
        >
          <UsageSummary totals={totals} period={period} />
          <section className="usage-card usage-chart-card">
            <header className="usage-chart-head">
              <h3>{t('用量趋势')}</h3>
              <div className="usage-chart-controls">
                <div className="usage-segmented is-small" role="group" aria-label={t('用量图表指标')}>
                  {(Object.keys(metricShortNames) as Metric[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={metric === value ? 'is-active' : ''}
                      aria-pressed={metric === value}
                      onClick={() => setMetric(value)}
                    >
                      {t(metricShortNames[value])}
                    </button>
                  ))}
                </div>
                <Select
                  className="usage-granularity"
                  aria-label={t('用量时间粒度')}
                  value={query.granularity}
                  onChange={(event) => update({ granularity: event.target.value as UsageQuery['granularity'] })}
                >
                  <option
                    value="hour"
                    disabled={new Date(query.to).getTime() - new Date(query.from).getTime() > 30 * 86400000}
                  >
                    {t('按小时')}
                  </option>
                  <option value="day">{t('按天')}</option>
                  <option value="month">{t('按月')}</option>
                </Select>
              </div>
            </header>
            <p className="usage-readout" aria-live="polite">
              {hovered ? (
                <>
                  <strong>{hoveredValue === undefined ? t('未返回用量') : compact(hoveredValue)}</strong>
                  <span>
                    {bucketLabel(hovered.key)} · {t('{count} 次请求', { count: number(hovered.requests) })}
                  </span>
                </>
              ) : (
                <>
                  <strong>{chartValues.length ? compact(chartTotal) : '—'}</strong>
                  <span>
                    {t(metricNames[metric])} · {t('本周期')}
                  </span>
                  {peak && (
                    <span className="usage-readout-peak">
                      {t('峰值')} {compact(peak.value)} · {bucketLabel(peak.key)}
                    </span>
                  )}
                </>
              )}
            </p>
            <UsageColumns buckets={report!.buckets} metric={metric} onSelect={setHovered} />
          </section>
          <div className="usage-split">
            <UsageRankList
              title={t('按 Provider')}
              groups={report!.byProvider}
              total={totals.totalTokens}
              active={query.providerId}
              onChoose={(row) => update({ providerId: row.providerId, model: undefined })}
            />
            <UsageRankList
              title={t('按模型')}
              groups={report!.byModel}
              total={totals.totalTokens}
              active={query.model}
              model
              onChoose={(row) => update({ providerId: row.providerId, model: row.model })}
            />
          </div>
        </div>
      ) : (
        <div
          id="usage-detail-panel"
          role="tabpanel"
          className={`usage-tab-panel${stale ? ' is-stale' : ''}`}
          aria-busy={stale}
        >
          <section className="usage-card usage-ledger-card">
            <header className="usage-ledger-head">
              <h3>{t('模型明细')}</h3>
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
            {tableRows.length ? (
              <div className="usage-table-scroll">
                <table className="usage-ledger">
                  <caption className="usage-sr-only">{t('模型明细')}</caption>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <th
                          key={column.key}
                          scope="col"
                          aria-sort={
                            sort.key === column.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                          }
                        >
                          <button
                            type="button"
                            className="usage-sort-button"
                            onClick={() =>
                              setSort((value) => ({
                                key: column.key,
                                dir: value.key === column.key && value.dir === 'desc' ? 'asc' : 'desc',
                              }))
                            }
                          >
                            {column.label}
                            <Icon name="down" size={12} />
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <span className="usage-model-cell">
                            <strong title={row.model || row.name}>{row.model || row.name}</strong>
                            {row.model && <small>{row.name}</small>}
                          </span>
                        </td>
                        <td>{row.reportedRequests ? compact(row.totalTokens) : '—'}</td>
                        <td>{number(row.requests)}</td>
                        <td>{row.inputReports ? compact(row.inputTokens) : '—'}</td>
                        <td>{row.outputReports ? compact(row.outputTokens) : '—'}</td>
                        <td>{row.cacheReports ? compact(row.cachedTokens) : '—'}</td>
                        <td>{row.inputReports && row.cacheReports ? percent(row) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="usage-ledger-empty">{t('没有匹配的模型')}</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
