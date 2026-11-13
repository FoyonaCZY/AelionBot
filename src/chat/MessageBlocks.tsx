import { Component, useMemo, useState, type ReactNode } from 'react';
import {
  calculate,
  messageBlockSegments,
  type CalculatorSpec,
  type ChartBlock,
  type ChartSpec,
  type MessageBlock,
  type TableBlock,
  type TableSpec,
} from '../../shared/chat/message-blocks';
import { MentionContent } from '../ui/MentionContent';
import { useI18n } from '../i18n';
import './message-blocks.css';

const PALETTE = ['#a98fce', '#639aaf', '#7e9f82', '#d19a69', '#b77734', '#8f9bb3'];

class BlockBoundary extends Component<{ fallback: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="message-block message-block-failed">{this.props.fallback}</div>
    ) : (
      this.props.children
    );
  }
}

export function hasBlockMarkers(content: string) {
  return content.includes('[[block:');
}

/** Text and blocks in the order the model placed them. */
export function MessageBlockContent({ content, blocks }: { content: string; blocks: MessageBlock[] }) {
  const segments = useMemo(() => messageBlockSegments(content, blocks), [content, blocks]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <div className="markdown message-block-text" key={`text-${index}`}>
            <MentionContent content={segment.text} markdown />
          </div>
        ) : (
          <MessageBlockCard key={segment.block.id} block={segment.block} />
        ),
      )}
    </>
  );
}

export function MessageBlocks({ blocks }: { blocks: MessageBlock[] }) {
  return (
    <>
      {blocks.map((block) => (
        <MessageBlockCard key={block.id} block={block} />
      ))}
    </>
  );
}

export function MessageBlockCard({ block }: { block: MessageBlock }) {
  return (
    <BlockBoundary fallback={block.fallback}>
      <section className={`message-block message-block-${block.type}`} aria-label={block.title || block.fallback}>
        {block.title && <h4 className="message-block-title">{block.title}</h4>}
        <BlockBody block={block} />
      </section>
    </BlockBoundary>
  );
}

function BlockBody({ block }: { block: MessageBlock }) {
  switch (block.type) {
    case 'chart':
      return <ChartView block={block} />;
    case 'metrics':
      return (
        <div className="message-block-metrics">
          {block.spec.items.map((item, index) => (
            <div className="message-metric" key={`${item.label}-${index}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              {item.delta && <small data-tone={item.tone || 'flat'}>{item.delta}</small>}
            </div>
          ))}
        </div>
      );
    case 'table':
      return <TableView block={block} />;
    case 'timeline':
      return (
        <ol className="message-block-timeline">
          {block.spec.items.map((item, index) => (
            <li key={`${item.title}-${index}`} data-state={item.state || 'pending'}>
              <i aria-hidden="true" />
              <div>
                <div className="message-timeline-head">
                  <strong>{item.title}</strong>
                  {item.time && <time>{item.time}</time>}
                </div>
                {item.detail && <p>{item.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      );
    case 'callout':
      return (
        <div className="message-block-callout" data-tone={block.spec.tone}>
          {block.spec.title && <strong>{block.spec.title}</strong>}
          <p>{block.spec.text}</p>
        </div>
      );
    case 'calculator':
      return <CalculatorView spec={block.spec} />;
    default:
      return null;
  }
}

const compact = (value: number, language: string) =>
  new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

function ChartView({ block }: { block: ChartBlock }) {
  const { spec } = block,
    { language } = useI18n();
  if (spec.chartType === 'pie' || spec.chartType === 'donut') return <PieChart spec={spec} label={block.fallback} />;
  const sparkline = spec.chartType === 'sparkline',
    width = 640,
    height = sparkline ? 90 : 230,
    margin = sparkline ? { top: 8, right: 8, bottom: 8, left: 8 } : { top: 18, right: 18, bottom: 30, left: 46 },
    plotWidth = width - margin.left - margin.right,
    plotHeight = height - margin.top - margin.bottom,
    stacked = spec.chartType === 'stacked-bar',
    totals = spec.categories.map((_, index) =>
      spec.series.reduce((sum, series) => sum + Math.max(0, series.values[index] ?? 0), 0),
    ),
    values = spec.series.flatMap((series) => series.values.filter((value): value is number => value !== null)),
    peak = stacked ? Math.max(0, ...totals) : Math.max(0, ...values),
    max = spec.yAxis?.max ?? (peak || 1) * 1.08,
    min = spec.yAxis?.min ?? 0,
    y = (value: number) => margin.top + plotHeight * (1 - (value - min) / (max - min || 1)),
    x = (index: number) => margin.left + plotWidth * ((index + 0.5) / spec.categories.length),
    group = plotWidth / spec.categories.length,
    barWidth = Math.max(4, (group * 0.62) / spec.series.length),
    ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div className="message-block-chart">
      <div className="message-chart-legend">
        {spec.series.map((series, index) => (
          <span key={`${series.name}-${index}`}>
            <i style={{ background: series.color || PALETTE[index % PALETTE.length] }} />
            {series.name}
          </span>
        ))}
        {spec.unit && <em>{spec.unit}</em>}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={block.fallback}>
        {!sparkline &&
          ticks.map((tick) => {
            const value = min + (max - min) * tick,
              lineY = y(value);
            return (
              <g key={tick}>
                <line className="chart-grid" x1={margin.left} x2={width - margin.right} y1={lineY} y2={lineY} />
                <text x={margin.left - 8} y={lineY + 3} textAnchor="end">
                  {compact(value, language)}
                </text>
              </g>
            );
          })}
        {spec.chartType === 'bar' &&
          spec.series.map((series, seriesIndex) =>
            series.values.map((value, index) => {
              if (value === null) return null;
              const barX = margin.left + group * index + group * 0.19 + seriesIndex * barWidth,
                top = y(Math.max(0, value));
              return (
                <rect
                  key={`${seriesIndex}-${index}`}
                  className={spec.highlight === index ? 'chart-bar is-highlight' : 'chart-bar'}
                  style={{ fill: series.color || PALETTE[seriesIndex % PALETTE.length] }}
                  x={barX}
                  y={top}
                  width={barWidth * 0.86}
                  height={Math.max(1, margin.top + plotHeight - top)}
                  rx={3}
                />
              );
            }),
          )}
        {stacked &&
          spec.categories.map((_, index) => {
            let base = 0;
            return spec.series.map((series, seriesIndex) => {
              const value = Math.max(0, series.values[index] ?? 0),
                bottom = y(base),
                top = y(base + value);
              base += value;
              return (
                <rect
                  key={`${seriesIndex}-${index}`}
                  className="chart-bar"
                  style={{ fill: series.color || PALETTE[seriesIndex % PALETTE.length] }}
                  x={margin.left + group * index + group * 0.19}
                  y={top}
                  width={group * 0.62}
                  height={Math.max(0, bottom - top)}
                />
              );
            });
          })}
        {['line', 'area', 'sparkline'].includes(spec.chartType) &&
          spec.series.map((series, seriesIndex) => {
            const points = series.values.map((value, index) => (value === null ? null : { x: x(index), y: y(value) }));
            let path = '',
              area = '';
            for (const [index, point] of points.entries()) {
              if (!point) {
                path = '';
                continue;
              }
              path += `${path ? 'L' : 'M'}${point.x} ${point.y}`;
              if (spec.chartType === 'area')
                area += `${area ? 'L' : `M${point.x} ${margin.top + plotHeight}L`}${point.x} ${point.y}`;
              if (index === points.length - 1 && area) area += `L${point.x} ${margin.top + plotHeight}Z`;
            }
            return (
              <g key={`${series.name}-${seriesIndex}`}>
                {area && (
                  <path
                    className="chart-area"
                    style={{ fill: series.color || PALETTE[seriesIndex % PALETTE.length] }}
                    d={area}
                  />
                )}
                {path && (
                  <path
                    className="chart-line"
                    style={{ stroke: series.color || PALETTE[seriesIndex % PALETTE.length] }}
                    d={path}
                  />
                )}
                {!sparkline &&
                  points.map((point, index) =>
                    point && (spec.series.length <= 2 || spec.highlight === index) ? (
                      <circle
                        key={index}
                        className={spec.highlight === index ? 'chart-dot is-highlight' : 'chart-dot'}
                        style={{ stroke: series.color || PALETTE[seriesIndex % PALETTE.length] }}
                        cx={point.x}
                        cy={point.y}
                        r={3.2}
                      />
                    ) : null,
                  )}
              </g>
            );
          })}
        {!sparkline &&
          spec.categories.map((category, index) => (
            <text key={category} x={x(index)} y={height - 9} textAnchor="middle">
              {category}
            </text>
          ))}
      </svg>
    </div>
  );
}

function PieChart({ spec, label }: { spec: ChartSpec; label: string }) {
  const { language } = useI18n(),
    values = spec.series[0]?.values.map((value) => Math.max(0, value ?? 0)) || [],
    total = values.reduce((sum, value) => sum + value, 0),
    donut = spec.chartType === 'donut',
    center = 100,
    radius = 78,
    inner = donut ? 46 : 0;
  let angle = -Math.PI / 2;
  const point = (r: number, a: number) => [center + r * Math.cos(a), center + r * Math.sin(a)];
  const arc = (start: number, end: number) => {
    const [x1, y1] = point(radius, start),
      [x2, y2] = point(radius, end),
      large = end - start > Math.PI ? 1 : 0;
    if (!inner) return `M${center} ${center}L${x1} ${y1}A${radius} ${radius} 0 ${large} 1 ${x2} ${y2}Z`;
    const [x3, y3] = point(inner, end),
      [x4, y4] = point(inner, start);
    return `M${x1} ${y1}A${radius} ${radius} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${inner} ${inner} 0 ${large} 0 ${x4} ${y4}Z`;
  };
  return (
    <div className="message-block-pie">
      <svg viewBox="0 0 200 200" role="img" aria-label={label}>
        {values.map((value, index) => {
          const start = angle,
            end = angle + (total ? (value / total) * Math.PI * 2 : 0);
          angle = end;
          return (
            <path
              key={index}
              d={arc(start, end)}
              style={{ fill: spec.series[0]?.color || PALETTE[index % PALETTE.length] }}
            />
          );
        })}
      </svg>
      <ul>
        {spec.categories.map((category, index) => (
          <li key={category}>
            <i style={{ background: PALETTE[index % PALETTE.length] }} />
            <span>{category}</span>
            <b>{new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(values[index] || 0)}</b>
            <small>{total ? Math.round(((values[index] || 0) / total) * 100) + '%' : '—'}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function cellText(value: string | number | null, format: TableSpec['columns'][number]['format'], language: string) {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  if (format === 'percent')
    return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value * 100) + '%';
  if (format === 'currency')
    return new Intl.NumberFormat(language, { style: 'currency', currency: 'CNY', maximumFractionDigits: 0 }).format(
      value,
    );
  return new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
}

function TableView({ block }: { block: TableBlock }) {
  const { language, t } = useI18n(),
    [sort, setSort] = useState<{ index: number; direction: 1 | -1 }>(),
    rows = useMemo(() => {
      if (!sort) return block.spec.rows;
      return [...block.spec.rows].sort((a, b) => {
        const left = a[sort.index],
          right = b[sort.index];
        if (left === right) return 0;
        if (left === null || left === undefined) return 1;
        if (right === null || right === undefined) return -1;
        return (
          (typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left).localeCompare(String(right), language)) * sort.direction
        );
      });
    }, [block.spec.rows, sort, language]);
  return (
    <div className="message-block-table-scroll" tabIndex={0} role="region" aria-label={t('表格')}>
      <table className="message-block-table">
        <thead>
          <tr>
            {block.spec.columns.map((column, index) => (
              <th key={column.label} style={{ textAlign: column.align || (index ? 'right' : 'left') }}>
                <button
                  type="button"
                  onClick={() =>
                    setSort((current) =>
                      current?.index === index
                        ? current.direction === 1
                          ? { index, direction: -1 }
                          : undefined
                        : { index, direction: 1 },
                    )
                  }
                  aria-label={t('按 {column} 排序', { column: column.label })}
                >
                  {column.label}
                  {sort?.index === index && <span aria-hidden="true">{sort.direction === 1 ? ' ↑' : ' ↓'}</span>}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {block.spec.columns.map((column, index) => (
                <td key={index} style={{ textAlign: column.align || (index ? 'right' : 'left') }}>
                  {cellText(row[index] ?? null, column.format, language)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CalculatorView({ spec }: { spec: CalculatorSpec }) {
  const { language, t } = useI18n(),
    [values, setValues] = useState<Record<string, number>>(() =>
      Object.fromEntries(spec.inputs.map((input) => [input.id, input.value])),
    ),
    [copied, setCopied] = useState(false);
  let result: ReturnType<typeof calculate> | undefined;
  try {
    result = calculate(spec, values);
  } catch {
    result = undefined;
  }
  const primary = result?.outputs[0],
    breakdown = result?.outputs.slice(1) || [],
    format = (value: number, unit?: string, kind?: string) => {
      if (kind === 'percent')
        return new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value * 100) + '%';
      const text = new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
      return unit ? `${text} ${unit}` : text;
    },
    copy = async () => {
      if (!result) return;
      const lines = [primary && `${primary.label}: ${format(primary.value, primary.unit, primary.format)}`]
        .concat(breakdown.map((output) => `${output.label}: ${format(output.value, output.unit, output.format)}`))
        .filter(Boolean)
        .join('\n');
      try {
        await navigator.clipboard.writeText(lines);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      } catch {
        setCopied(false);
      }
    };
  return (
    <div className="message-block-calculator">
      <div className="message-calculator-inputs">
        {spec.inputs.map((input) => (
          <label key={input.id}>
            <span>{input.label}</span>
            <span className="message-calculator-control">
              <input
                type="number"
                value={values[input.id] ?? input.value}
                min={input.min}
                max={input.max}
                step={input.step ?? (input.type === 'percent' ? 0.1 : 1)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setValues((current) => ({
                    ...current,
                    [input.id]: Number.isFinite(next) ? next : input.value,
                  }));
                }}
              />
              <em>{input.unit || (input.type === 'percent' ? '%' : input.type === 'money' ? '元' : '')}</em>
            </span>
          </label>
        ))}
      </div>
      {primary && (
        <div className="message-calculator-result">
          <div>
            <span>{primary.label}</span>
            <strong>{format(primary.value, primary.unit, primary.format)}</strong>
          </div>
          {breakdown.length > 0 && (
            <dl>
              {breakdown.map((output) => (
                <div key={output.label}>
                  <dt>{output.label}</dt>
                  <dd>{format(output.value, output.unit, output.format)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      <div className="message-calculator-actions">
        <button type="button" onClick={() => void copy()} disabled={!result}>
          {copied ? t('已复制') : t('复制结果')}
        </button>
        {spec.note && <p>{spec.note}</p>}
      </div>
    </div>
  );
}
