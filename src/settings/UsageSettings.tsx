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
const purposes: Record<string, string> = {
  foreground: '任务执行',
  permission_review: '权限审核',
  background_review: '后台整理',
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

function UsageTimeline({
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
    height = 206,
    left = 47,
    right = 14,
    top = 18,
    bottom = 31,
    plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...buckets.map((row) => metricValue(row, metric) || 0)),
    step = 10 ** Math.floor(Math.log10(maximum)) / 5,
    ceiling = Math.ceil(maximum / step) * step;
  const x = (index: number) => left + ((index + 0.5) * plotWidth) / Math.max(1, buckets.length),
    y = (value: number) => top + plotHeight * (1 - value / ceiling);
  const points = buckets.map((row, index) => {
      const value = metricValue(row, metric);
      return value === undefined ? null : { x: x(index), y: y(value) };
    }),
    runs: Array<Array<{ x: number; y: number }>> = [];
  let run: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    if (!point) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(point);
  }
  if (run.length) runs.push(run);
  const line = (points: Array<{ x: number; y: number }>) => {
    let path = `M${points[0].x},${points[0].y}`;
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1],
        current = points[index],
        middle = (previous.x + current.x) / 2;
      path += ` C${middle},${previous.y} ${middle},${current.y} ${current.x},${current.y}`;
    }
    return path;
  };
  const path = runs.map(line).join(' '),
    area = runs
      .filter((points) => points.length > 1)
      .map((points) => `${line(points)} L${points.at(-1)!.x},${height - bottom} L${points[0].x},${height - bottom} Z`)
      .join(' ');
  const selectedRow = selected === undefined ? undefined : buckets[selected],
    selectedValue = selectedRow ? metricValue(selectedRow, metric) : undefined;
  const labelIndices = [
    ...new Set([0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round((buckets.length - 1) * fraction))),
  ].filter((index) => index >= 0 && index < buckets.length);
  return (
    <div className="usage-timeline">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label={t('{metric}时间趋势', { metric: t(metricNames[metric]) })}
        onMouseLeave={() => select(undefined)}
      >
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              className="usage-grid"
              x1={left}
              x2={width - right}
              y1={y(ceiling * fraction)}
              y2={y(ceiling * fraction)}
              strokeDasharray={fraction ? '3 5' : undefined}
            />
            <text x={left - 9} y={y(ceiling * fraction) + 4} textAnchor="end" className="usage-axis">
              {compact(ceiling * fraction)}
            </text>
          </g>
        ))}
        {area && <path className="usage-area" d={area} />}
        <path className="usage-line" d={path} fill="none" strokeWidth="2.25" strokeLinejoin="round" />
        {buckets.length === 1 && metricValue(buckets[0], metric) !== undefined && (
          <circle className="usage-point" cx={x(0)} cy={y(metricValue(buckets[0], metric)!)} r={4} />
        )}
        {selected !== undefined && selectedValue !== undefined && (
          <g>
            <line
              className="usage-cursor"
              x1={x(selected)}
              x2={x(selected)}
              y1={top}
              y2={height - bottom}
              strokeDasharray="3 4"
            />
            <circle className="usage-point" cx={x(selected)} cy={y(selectedValue)} r={4} strokeWidth={2} />
          </g>
        )}
        {labelIndices.map((index) => (
          <text
            key={index}
            x={x(index)}
            y={height - 8}
            textAnchor={index === 0 ? 'start' : index === buckets.length - 1 ? 'end' : 'middle'}
            className="usage-axis"
          >
            {buckets[index].key}
          </text>
        ))}
        {buckets.map((row, index) => (
          <rect
            key={row.key}
            x={left + (index * plotWidth) / buckets.length}
            y={top}
            width={plotWidth / buckets.length}
            height={plotHeight}
            fill="transparent"
            tabIndex={index === (selected ?? 0) ? 0 : -1}
            role="button"
            aria-label={t('{key}，{metric} {value}，{count} 次请求', {
              key: row.key,
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
      <p className="usage-sr-only" aria-live="polite">
        {selectedRow
          ? `${selectedRow.key} ${t(metricNames[metric])} ${
              selectedValue === undefined ? t('未返回用量') : number(selectedValue)
            } ${t('{count} 次请求', { count: selectedRow.requests })}`
          : ''}
      </p>
    </div>
  );
}

function UsageHero({ totals }: { totals: UsageTotals }) {
  const { t } = useI18n();
  const totalReported = totals.reportedRequests > 0 || !totals.requests,
    inputReported = totals.inputReports > 0 || !totals.requests,
    outputReported = totals.outputReports > 0 || !totals.requests,
    cacheReported = totals.cacheReports > 0 || !totals.requests;
  const total = splitCompact(totals.totalTokens),
    cached = cacheReported ? Math.min(totals.cachedTokens, totals.inputTokens) : 0,
    input = inputReported ? totals.inputTokens : 0,
    output = outputReported ? totals.outputTokens : 0,
    barTotal = totalReported ? totals.totalTokens || input + output : input + output,
    newInput = Math.max(0, input - cached),
    composition = inputReported && cacheReported && outputReported,
    cacheShare = composition && barTotal > 0 ? (cached / barTotal) * 100 : 0,
    newShare = composition && barTotal > 0 ? (newInput / barTotal) * 100 : 0,
    outputShare = composition && barTotal > 0 ? (output / barTotal) * 100 : 0,
    hit = inputReported && cacheReported ? cacheHitRatio(totals) : 0,
    avg = totalReported && totals.requests ? compact(totals.totalTokens / totals.requests) : '—',
    failure = totals.requests ? `${((totals.failedRequests / totals.requests) * 100).toFixed(1)}%` : '—';

  return (
    <section className="usage-hero">
      <div className="usage-hero-main">
        <div className="usage-hero-kicker">{t('总 tokens')}</div>
        <div className="usage-hero-number">
          <strong>{totalReported ? total.value : '—'}</strong>
          {totalReported && total.unit && <span>{total.unit}</span>}
        </div>
        <div
          className="usage-river"
          role="img"
          aria-label={`${t('缓存输入')} ${cacheReported ? compact(cached) : '—'}，${t('新增输入')} ${
            inputReported ? compact(newInput) : '—'
          }，${t('输出')} ${outputReported ? compact(output) : '—'}`}
        >
          <i className="is-cache" style={{ width: `${cacheShare}%` }} />
          <i className="is-new" style={{ width: `${newShare}%` }} />
          <i className="is-output" style={{ width: `${outputShare}%` }} />
        </div>
        <dl className="usage-river-legend">
          <div>
            <dt>
              <i className="usage-legend-dot is-cache" />
              {t('缓存输入')}
            </dt>
            <dd>{cacheReported ? compact(cached) : '—'}</dd>
          </div>
          <div>
            <dt>
              <i className="usage-legend-dot is-new" />
              {t('新增输入')}
            </dt>
            <dd>{inputReported ? compact(newInput) : '—'}</dd>
          </div>
          <div>
            <dt>
              <i className="usage-legend-dot is-output" />
              {t('输出')}
            </dt>
            <dd>{outputReported ? compact(output) : '—'}</dd>
          </div>
        </dl>
        <div className="usage-hero-foot">
          <span>
            <strong>{number(totals.requests)}</strong> {t('次请求')}
          </span>
          <i className="usage-dot" aria-hidden="true" />
          <span className="usage-is-bad">
            <strong>{number(totals.failedRequests)}</strong> {t('次失败')}
          </span>
          <i className="usage-dot" aria-hidden="true" />
          <span>
            {t('输入合计')} <strong>{inputReported ? compact(totals.inputTokens) : '—'}</strong>
          </span>
        </div>
      </div>

      <aside className="usage-hero-side">
        <div className="usage-cache-stat">
          <span>{t('缓存命中率')}</span>
          <strong>{inputReported && cacheReported ? `${(hit * 100).toFixed(1)}%` : '—'}</strong>
        </div>
        <div className="usage-cache-track" aria-hidden="true">
          <i style={{ width: `${Math.max(0, Math.min(100, hit * 100))}%` }} />
        </div>
        <dl className="usage-cache-stats">
          <div>
            <dt>{t('平均 / 请求')}</dt>
            <dd>{avg}</dd>
          </div>
          <div>
            <dt>{t('失败率')}</dt>
            <dd>{failure}</dd>
          </div>
        </dl>
      </aside>
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
    <section className="usage-rank-card">
      <header className="usage-rank-head">
        <h3>{title}</h3>
      </header>
      {rows.length ? (
        <div className="usage-rank-list">
          {rows.map((row, index) => {
            const isActive = model ? active === row.model : active === row.providerId,
              share = total > 0 ? (row.totalTokens / total) * 100 : 0;
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
                <span className="usage-rank-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="usage-rank-main">
                  <span className="usage-rank-name">
                    {!model && <i className={`usage-provider-dot p${(index % 4) + 1}`} />}
                    <span title={model ? row.model || row.name : row.name}>
                      {model ? row.model || row.name : row.name}
                    </span>
                    <small>{model ? row.name : `${share.toFixed(1)}%`}</small>
                  </span>
                  <span className="usage-rank-track">
                    <i style={{ width: `${(row.totalTokens / maximum) * 100}%` }} />
                  </span>
                </span>
                <span className="usage-rank-value">
                  {row.reportedRequests ? compact(row.totalTokens) : '—'}
                  <small>{model ? `${share.toFixed(1)}%` : t('{count} 次请求', { count: number(row.requests) })}</small>
                </span>
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
  const totals = JSON.stringify(report?.query) === JSON.stringify(query) ? report?.totals : undefined;
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
      <div className="usage-tabs-row">
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
          <div className="usage-range" role="group" aria-label={t('用量时间范围')}>
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
          </div>
          <button
            type="button"
            className={`usage-icon-button${preset === 'custom' ? ' is-active' : ''}`}
            aria-label={t('自定义')}
            aria-pressed={preset === 'custom'}
            title={t('自定义')}
            onClick={() => applyPreset('custom')}
          >
            <Icon name="clock" size={16} />
          </button>
          <button
            type="button"
            className="usage-icon-button"
            aria-label={t('刷新')}
            title={t('刷新')}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <Icon name="restart" size={16} />
          </button>
        </div>
      </div>

      <div className="usage-filter-row">
        <span className="usage-filter-label">{t('筛选')}</span>
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
        <button type="button" className="usage-reset" onClick={reset}>
          {t('重置筛选')}
        </button>
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
          <span>—</span>
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
        <div className="usage-error" role="alert">
          {error}
        </div>
      ) : !totals ? (
        <div className="usage-loading" role="status">
          <span className="usage-sr-only">{t('正在统计用量…')}</span>
          <div className="usage-skeleton-grid">
            <div className="usage-skeleton" />
            <div className="usage-skeleton" />
          </div>
          <div className="usage-skeleton is-wide" />
          <div className="usage-skeleton-grid">
            <div className="usage-skeleton is-tall" />
            <div className="usage-skeleton is-tall" />
          </div>
        </div>
      ) : !totals.requests ? (
        <div className="usage-empty">
          <span className="usage-empty-icon" aria-hidden="true">
            <Icon name="chart" size={22} />
          </span>
          <h3>{t('这段时间还没有用量记录')}</h3>
          <button type="button" className="primary-button" onClick={reset}>
            {t('最近 30 天')}
          </button>
        </div>
      ) : (
        <>
          {totals.missingUsage > 0 && (
            <p className="usage-missing">
              {t('{count} 次请求未返回 token 用量（可能包括失败或超时请求），不代表零消耗。', {
                count: totals.missingUsage,
              })}
            </p>
          )}
          {tab === 'overview' ? (
            <div id="usage-overview-panel" role="tabpanel" className="usage-tab-panel">
              <UsageHero totals={totals} />
              <section className="usage-chart-card">
                <header className="usage-chart-head">
                  <div className="usage-chart-title">
                    <h3>{t('用量趋势')}</h3>
                    <span className="usage-chart-period">{period}</span>
                  </div>
                  <div className="usage-chart-controls">
                    <div className="usage-metric-seg" role="group" aria-label={t('用量图表指标')}>
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
                <div className="usage-chart-summary">
                  {hovered ? (
                    <>
                      <strong>{hovered.key}</strong>
                      <span>{t(metricNames[metric])}</span>
                      <b>{hoveredValue === undefined ? t('未返回用量') : compact(hoveredValue)}</b>
                      <span>{t('{count} 次请求', { count: hovered.requests })}</span>
                    </>
                  ) : (
                    <>
                      <strong>{chartValues.length ? compact(chartTotal) : '—'}</strong>
                      <span>{t('本周期')}</span>
                      {peak && (
                        <span className="usage-chart-peak">
                          {t('峰值')} {compact(peak.value)} · {peak.key}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <UsageTimeline buckets={report!.buckets} metric={metric} onSelect={setHovered} />
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
            <div id="usage-detail-panel" role="tabpanel" className="usage-tab-panel">
              <section className="usage-ledger-card">
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
                                <strong>{row.model || row.name}</strong>
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
                  <div className="usage-ledger-empty">
                    <strong>{t('没有匹配的模型')}</strong>
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
