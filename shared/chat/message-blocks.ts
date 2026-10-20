import { AppError } from '../errors';

const BLOCK_TYPES = ['chart', 'metrics', 'table', 'timeline', 'callout', 'calculator'] as const;

const CHART_TYPES = ['line', 'bar', 'area', 'stacked-bar', 'pie', 'donut', 'sparkline'] as const;
type ChartType = (typeof CHART_TYPES)[number];

interface ChartSeries {
  name: string;
  values: Array<number | null>;
  color?: string;
}
export interface ChartSpec {
  chartType: ChartType;
  categories: string[];
  series: ChartSeries[];
  unit?: string;
  yAxis?: { min?: number; max?: number };
  highlight?: number;
}
interface MetricsSpec {
  items: Array<{ label: string; value: string; delta?: string; tone?: 'up' | 'down' | 'flat' }>;
}
export interface TableSpec {
  columns: Array<{ label: string; align?: 'left' | 'right' | 'center'; format?: 'number' | 'percent' | 'currency' }>;
  rows: Array<Array<string | number | null>>;
}
interface TimelineSpec {
  items: Array<{ time?: string; title: string; detail?: string; state?: 'done' | 'current' | 'pending' }>;
}
interface CalloutSpec {
  tone: 'info' | 'warning' | 'success' | 'danger';
  title?: string;
  text: string;
}
interface CalculatorInput {
  id: string;
  label: string;
  type: 'number' | 'percent' | 'money';
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}
export interface CalculatorSpec {
  inputs: CalculatorInput[];
  /** Expression over the inputs; its value is the amount brackets apply to. */
  taxableFormula?: string;
  /** Progressive table: the first bracket whose upTo is null or >= the taxable amount applies. */
  brackets?: Array<{ upTo: number | null; rate: number; quickDeduction?: number }>;
  /** Used when brackets are absent. */
  formula?: string;
  /** The first output is the main result; the rest are shown as a breakdown. */
  outputs: Array<{
    label: string;
    formula: string;
    unit?: string;
    format?: 'number' | 'money' | 'percent';
  }>;
  note?: string;
  action?: { label: string; template: string };
}

interface BlockBase {
  id: string;
  version: 1;
  title?: string;
  /** Plain text used by connectors, copy, export and a failed render. */
  fallback: string;
  createdAt: string;
}
export interface ChartBlock extends BlockBase {
  type: 'chart';
  spec: ChartSpec;
}
interface MetricsBlock extends BlockBase {
  type: 'metrics';
  spec: MetricsSpec;
}
export interface TableBlock extends BlockBase {
  type: 'table';
  spec: TableSpec;
}
interface TimelineBlock extends BlockBase {
  type: 'timeline';
  spec: TimelineSpec;
}
interface CalloutBlock extends BlockBase {
  type: 'callout';
  spec: CalloutSpec;
}
interface CalculatorBlock extends BlockBase {
  type: 'calculator';
  spec: CalculatorSpec;
}
export type MessageBlock = ChartBlock | MetricsBlock | TableBlock | TimelineBlock | CalloutBlock | CalculatorBlock;

const BLOCK_MARKER = /\[\[block:([A-Za-z0-9_-]+)\]\]/g;
export const blockMarker = (id: string) => `[[block:${id}]]`;
export const stripBlockMarkers = (content: string) =>
  content
    .replace(BLOCK_MARKER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
/** Placement markers stand on their own line; a marker inside a sentence is just text. */
const PLACEMENT_MARKER = /(^|\n)[ \t]*\[\[block:[A-Za-z0-9_-]+\]\][ \t]*(?=\n|$)/g;
export const stripBlockPlacements = (content: string) =>
  content
    .replace(PLACEMENT_MARKER, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export type MessageBlockSegment = { kind: 'text'; text: string } | { kind: 'block'; block: MessageBlock };

/**
 * Splits an answer at its `[[block:id]]` markers. Blocks without a marker follow the text, in creation order, so a
 * model that forgets the marker still shows its work.
 */
export function messageBlockSegments(content: string, blocks: MessageBlock[]): MessageBlockSegment[] {
  // A model can write a marker without storing a block; never show the raw marker.
  if (!blocks.length) {
    const text = stripBlockPlacements(content);
    return text ? [{ kind: 'text', text }] : [];
  }
  const byId = new Map(blocks.map((block) => [block.id, block])),
    segments: MessageBlockSegment[] = [],
    used = new Set<string>();
  // A marker the model named itself (`[[block:rates]]`) anchors the next stored block in order.
  const take = (id: string) => {
    const exact = byId.get(id);
    if (exact) {
      if (used.has(exact.id)) return undefined;
      used.add(exact.id);
      return exact;
    }
    const next = blocks.find((block) => !used.has(block.id));
    if (next) used.add(next.id);
    return next;
  };
  let last = 0;
  for (const match of content.matchAll(BLOCK_MARKER)) {
    const text = content.slice(last, match.index);
    if (text.trim()) segments.push({ kind: 'text', text });
    const block = take(match[1]);
    if (block) segments.push({ kind: 'block', block });
    last = (match.index || 0) + match[0].length;
  }
  const tail = content.slice(last);
  if (tail.trim()) segments.push({ kind: 'text', text: tail });
  for (const block of blocks) if (!used.has(block.id)) segments.push({ kind: 'block', block });
  return segments;
}

const fail = (path: string, message: string): never => {
  throw new AppError('block.invalid', `${path} ${message}`);
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asObject = (value: unknown, path: string) => (isObject(value) ? value : fail(path, '必须是对象'));
const asArray = (value: unknown, path: string) => (Array.isArray(value) ? value : fail(path, '必须是数组'));
const asText = (value: unknown, path: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(path, `必须是非空文本且不超过 ${max} 字`);
  return value as string;
};
const asNumber = (value: unknown, path: string, options: { min?: number; max?: number; integer?: boolean } = {}) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数字');
  const number = value as number;
  if (options.integer && !Number.isSafeInteger(number)) fail(path, '必须是整数');
  if (options.min !== undefined && number < options.min) fail(path, `不能小于 ${options.min}`);
  if (options.max !== undefined && number > options.max) fail(path, `不能大于 ${options.max}`);
  return number;
};
const oneOf = <T extends string>(value: unknown, values: readonly T[], path: string): T => {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(path, `必须是 ${values.join(' / ')} 之一`);
  return value as T;
};

/** A small expression language: numbers, input names, + - * /, parentheses and min/max/round/floor/ceil/abs. */
type Token = { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(source.slice(index));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (name) {
      tokens.push({ kind: 'name', value: name[0] });
      index += name[0].length;
      continue;
    }
    if ('+-*/(),'.includes(char)) {
      tokens.push({ kind: 'op', value: char });
      index++;
      continue;
    }
    fail('formula', `包含不支持的字符 ${char}`);
  }
  return tokens;
}

class Expression {
  private index = 0;
  constructor(
    private tokens: Token[],
    private scope: Record<string, number>,
  ) {}
  evaluate() {
    const value = this.expression();
    if (this.index < this.tokens.length) fail('formula', '有多余的内容');
    if (!Number.isFinite(value)) fail('formula', '计算结果不是有限数字');
    return value;
  }
  private peek() {
    return this.tokens[this.index];
  }
  private take(value?: string) {
    const token = this.tokens[this.index];
    if (!token || (value !== undefined && token.value !== value)) return undefined;
    this.index++;
    return token;
  }
  private expression(): number {
    let value = this.term();
    for (;;) {
      if (this.take('+')) value += this.term();
      else if (this.take('-')) value -= this.term();
      else return value;
    }
  }
  private term(): number {
    let value = this.factor();
    for (;;) {
      if (this.take('*')) value *= this.factor();
      else if (this.take('/')) value /= this.factor();
      else return value;
    }
  }
  private factor(): number {
    if (this.take('-')) return -this.factor();
    if (this.take('+')) return this.factor();
    const token = this.peek();
    if (!token) fail('formula', '不完整');
    if (token.kind === 'number') {
      this.index++;
      return token.value;
    }
    if (token.kind === 'name') {
      this.index++;
      if (this.take('(')) {
        const args: number[] = [];
        if (!this.take(')')) {
          for (;;) {
            args.push(this.expression());
            if (this.take(')')) break;
            if (!this.take(',')) fail('formula', '函数参数之间需要逗号');
          }
        }
        return this.call(token.value, args);
      }
      const value = this.scope[token.value];
      if (!Object.hasOwn(this.scope, token.value) || typeof value !== 'number')
        fail('formula', `引用了未知变量 ${token.value}`);
      return value;
    }
    if (this.take('(')) {
      const value = this.expression();
      if (!this.take(')')) fail('formula', '缺少右括号');
      return value;
    }
    return fail('formula', '语法不完整') as never;
  }
  private call(name: string, args: number[]): number {
    const one = () => {
      if (args.length !== 1) fail('formula', `${name} 需要 1 个参数`);
      return args[0];
    };
    if (name === 'min') return args.length ? Math.min(...args) : fail('formula', 'min 需要参数');
    if (name === 'max') return args.length ? Math.max(...args) : fail('formula', 'max 需要参数');
    if (name === 'round') return Math.round(one());
    if (name === 'floor') return Math.floor(one());
    if (name === 'ceil') return Math.ceil(one());
    if (name === 'abs') return Math.abs(one());
    return fail('formula', `不支持的函数 ${name}`);
  }
}

export function evaluateFormula(source: string, scope: Record<string, number>) {
  if (!source.trim() || source.length > 500) fail('formula', '公式为空或过长');
  return new Expression(tokenize(source), scope).evaluate();
}

export interface CalculatorResult {
  values: Record<string, number>;
  primary: number;
  outputs: Array<{ label: string; value: number; unit?: string; format?: string }>;
}
export function calculate(spec: CalculatorSpec, inputs: Record<string, number> = {}): CalculatorResult {
  const values: Record<string, number> = {};
  for (const input of spec.inputs) {
    const value = inputs[input.id] ?? input.value;
    if (!Number.isFinite(value)) fail(`inputs.${input.id}`, '必须是有限数字');
    values[input.id] = value;
  }
  const taxable = spec.taxableFormula ? evaluateFormula(spec.taxableFormula, values) : undefined;
  let primary: number;
  if (spec.brackets?.length) {
    if (taxable === undefined) fail('taxableFormula', '使用税率表时必须提供');
    const amount = taxable as number,
      bracket = spec.brackets.find((item) => item.upTo === null || amount <= item.upTo);
    if (!bracket) fail('brackets', '没有匹配的档位');
    const matched = bracket as { upTo: number | null; rate: number; quickDeduction?: number };
    primary = Math.max(0, amount * matched.rate - (matched.quickDeduction || 0));
  } else {
    primary = evaluateFormula(spec.formula || '0', values);
  }
  const scope = { ...values, taxable: taxable ?? 0, result: primary };
  const outputs = spec.outputs.map((output) => ({
    label: output.label,
    value: evaluateFormula(output.formula, scope),
    ...(output.unit ? { unit: output.unit } : {}),
    ...(output.format ? { format: output.format } : {}),
  }));
  return { values, primary, outputs };
}

function chartSpec(value: unknown): ChartSpec {
  const spec = asObject(value, 'spec'),
    chartType = oneOf(spec.chartType, CHART_TYPES, 'spec.chartType'),
    categories = asArray(spec.categories, 'spec.categories').map((item, index) =>
      asText(item, `spec.categories[${index}]`, 60),
    );
  if (!categories.length || categories.length > 60) fail('spec.categories', '需要 1–60 个分类');
  const series = asArray(spec.series, 'spec.series');
  if (!series.length || series.length > 6) fail('spec.series', '需要 1–6 个序列');
  const parsed = series.map((item, index) => {
    const entry = asObject(item, `spec.series[${index}]`),
      values = asArray(entry.values, `spec.series[${index}].values`);
    if (values.length !== categories.length) fail(`spec.series[${index}].values`, '长度必须与 categories 一致');
    if (values.length > 60) fail(`spec.series[${index}].values`, '最多 60 个点');
    return {
      name: asText(entry.name, `spec.series[${index}].name`, 60),
      values: values.map((value, point) =>
        value === null ? null : asNumber(value, `spec.series[${index}].values[${point}]`),
      ),
      ...(entry.color ? { color: asText(entry.color, `spec.series[${index}].color`, 32) } : {}),
    };
  });
  if (['pie', 'donut'].includes(chartType)) {
    if (parsed.length !== 1) fail('spec.series', '饼图只允许一个序列');
    if (parsed[0].values.some((value) => value === null || value < 0)) fail('spec.series[0].values', '饼图不能有负数');
  }
  return {
    chartType,
    categories,
    series: parsed,
    ...(spec.unit ? { unit: asText(spec.unit, 'spec.unit', 20) } : {}),
    ...(isObject(spec.yAxis)
      ? {
          yAxis: {
            ...(spec.yAxis.min !== undefined ? { min: asNumber(spec.yAxis.min, 'spec.yAxis.min') } : {}),
            ...(spec.yAxis.max !== undefined ? { max: asNumber(spec.yAxis.max, 'spec.yAxis.max') } : {}),
          },
        }
      : {}),
    ...(spec.highlight !== undefined
      ? {
          highlight: asNumber(spec.highlight, 'spec.highlight', {
            min: 0,
            max: categories.length - 1,
            integer: true,
          }),
        }
      : {}),
  };
}

function metricsSpec(value: unknown): MetricsSpec {
  const spec = asObject(value, 'spec'),
    items = asArray(spec.items, 'spec.items');
  if (!items.length || items.length > 4) fail('spec.items', '需要 1–4 个指标');
  return {
    items: items.map((item, index) => {
      const entry = asObject(item, `spec.items[${index}]`);
      return {
        label: asText(entry.label, `spec.items[${index}].label`, 40),
        value: asText(entry.value, `spec.items[${index}].value`, 40),
        ...(entry.delta ? { delta: asText(entry.delta, `spec.items[${index}].delta`, 40) } : {}),
        ...(entry.tone
          ? { tone: oneOf(entry.tone, ['up', 'down', 'flat'] as const, `spec.items[${index}].tone`) }
          : {}),
      };
    }),
  };
}

function tableSpec(value: unknown): TableSpec {
  const spec = asObject(value, 'spec'),
    columns = asArray(spec.columns, 'spec.columns'),
    rows = asArray(spec.rows, 'spec.rows');
  if (!columns.length || columns.length > 12) fail('spec.columns', '需要 1–12 列');
  if (rows.length > 200) fail('spec.rows', '最多 200 行');
  const parsedColumns = columns.map((item, index) => {
    const entry = asObject(item, `spec.columns[${index}]`);
    return {
      label: asText(entry.label, `spec.columns[${index}].label`, 60),
      ...(entry.align
        ? { align: oneOf(entry.align, ['left', 'right', 'center'] as const, `spec.columns[${index}].align`) }
        : {}),
      ...(entry.format
        ? { format: oneOf(entry.format, ['number', 'percent', 'currency'] as const, `spec.columns[${index}].format`) }
        : {}),
    };
  });
  return {
    columns: parsedColumns,
    rows: rows.map((row, index) => {
      const cells = asArray(row, `spec.rows[${index}]`);
      if (cells.length > parsedColumns.length) fail(`spec.rows[${index}]`, '单元格数量超过列数');
      return cells.map((cell, cellIndex) =>
        cell === null || typeof cell === 'number' ? cell : asText(cell, `spec.rows[${index}][${cellIndex}]`, 500),
      );
    }),
  };
}

function timelineSpec(value: unknown): TimelineSpec {
  const spec = asObject(value, 'spec'),
    items = asArray(spec.items, 'spec.items');
  if (!items.length || items.length > 30) fail('spec.items', '需要 1–30 个节点');
  return {
    items: items.map((item, index) => {
      const entry = asObject(item, `spec.items[${index}]`);
      return {
        title: asText(entry.title, `spec.items[${index}].title`, 120),
        ...(entry.time ? { time: asText(entry.time, `spec.items[${index}].time`, 40) } : {}),
        ...(entry.detail ? { detail: asText(entry.detail, `spec.items[${index}].detail`, 500) } : {}),
        ...(entry.state
          ? { state: oneOf(entry.state, ['done', 'current', 'pending'] as const, `spec.items[${index}].state`) }
          : {}),
      };
    }),
  };
}

function calloutSpec(value: unknown): CalloutSpec {
  const spec = asObject(value, 'spec');
  return {
    tone: oneOf(spec.tone, ['info', 'warning', 'success', 'danger'] as const, 'spec.tone'),
    ...(spec.title ? { title: asText(spec.title, 'spec.title', 120) } : {}),
    text: asText(spec.text, 'spec.text', 2000),
  };
}

function calculatorSpec(value: unknown): CalculatorSpec {
  const spec = asObject(value, 'spec'),
    inputs = asArray(spec.inputs, 'spec.inputs'),
    outputs = asArray(spec.outputs, 'spec.outputs');
  if (!inputs.length || inputs.length > 8) fail('spec.inputs', '需要 1–8 个输入');
  if (!outputs.length || outputs.length > 6) fail('spec.outputs', '需要 1–6 个输出');
  const parsedInputs = inputs.map((item, index) => {
    const entry = asObject(item, `spec.inputs[${index}]`),
      type = oneOf(entry.type, ['number', 'percent', 'money'] as const, `spec.inputs[${index}].type`);
    return {
      id: asText(entry.id, `spec.inputs[${index}].id`, 40),
      label: asText(entry.label, `spec.inputs[${index}].label`, 40),
      type,
      value: asNumber(entry.value, `spec.inputs[${index}].value`),
      ...(entry.min !== undefined ? { min: asNumber(entry.min, `spec.inputs[${index}].min`) } : {}),
      ...(entry.max !== undefined ? { max: asNumber(entry.max, `spec.inputs[${index}].max`) } : {}),
      ...(entry.step !== undefined ? { step: asNumber(entry.step, `spec.inputs[${index}].step`, { min: 0 }) } : {}),
      ...(entry.unit ? { unit: asText(entry.unit, `spec.inputs[${index}].unit`, 12) } : {}),
    };
  });
  if (new Set(parsedInputs.map((input) => input.id)).size !== parsedInputs.length)
    fail('spec.inputs', '输入 id 不能重复');
  const brackets = spec.brackets
    ? asArray(spec.brackets, 'spec.brackets').map((item, index) => {
        const entry = asObject(item, `spec.brackets[${index}]`);
        return {
          upTo: entry.upTo === null ? null : asNumber(entry.upTo, `spec.brackets[${index}].upTo`, { min: 0 }),
          rate: asNumber(entry.rate, `spec.brackets[${index}].rate`, { min: 0, max: 1 }),
          ...(entry.quickDeduction !== undefined
            ? { quickDeduction: asNumber(entry.quickDeduction, `spec.brackets[${index}].quickDeduction`, { min: 0 }) }
            : {}),
        };
      })
    : undefined;
  if (brackets && brackets.length > 10) fail('spec.brackets', '最多 10 档');
  if (brackets) {
    const limits = brackets.filter((bracket) => bracket.upTo !== null).map((bracket) => bracket.upTo as number);
    if (limits.some((value, index) => index > 0 && value <= limits[index - 1])) fail('spec.brackets', 'upTo 必须递增');
    if (brackets.some((bracket, index) => bracket.upTo === null && index !== brackets.length - 1))
      fail('spec.brackets', '无上限档位必须放在最后');
  }
  const parsed: CalculatorSpec = {
    inputs: parsedInputs,
    ...(spec.taxableFormula ? { taxableFormula: asText(spec.taxableFormula, 'spec.taxableFormula', 500) } : {}),
    ...(brackets ? { brackets } : {}),
    ...(spec.formula ? { formula: asText(spec.formula, 'spec.formula', 500) } : {}),
    outputs: outputs.map((item, index) => {
      const entry = asObject(item, `spec.outputs[${index}]`);
      return {
        label: asText(entry.label, `spec.outputs[${index}].label`, 60),
        formula: asText(entry.formula, `spec.outputs[${index}].formula`, 500),
        ...(entry.unit ? { unit: asText(entry.unit, `spec.outputs[${index}].unit`, 12) } : {}),
        ...(entry.format
          ? { format: oneOf(entry.format, ['number', 'money', 'percent'] as const, `spec.outputs[${index}].format`) }
          : {}),
      };
    }),
    ...(spec.note ? { note: asText(spec.note, 'spec.note', 300) } : {}),
    ...(isObject(spec.action)
      ? {
          action: {
            label: asText(spec.action.label, 'spec.action.label', 60),
            template: asText(spec.action.template, 'spec.action.template', 500),
          },
        }
      : {}),
  };
  // Fail at creation, not when the user opens the block.
  calculate(parsed);
  return parsed;
}

const MAX_BLOCK_BYTES = 64 * 1024;

export function createMessageBlock(input: unknown, id: string, createdAt: string): MessageBlock {
  const value = asObject(input, 'block'),
    type = oneOf(value.type, BLOCK_TYPES, 'type'),
    fallback = asText(value.fallback, 'fallback', 600),
    title = value.title === undefined ? undefined : asText(value.title, 'title', 120),
    spec =
      type === 'chart'
        ? chartSpec(value.spec)
        : type === 'metrics'
          ? metricsSpec(value.spec)
          : type === 'table'
            ? tableSpec(value.spec)
            : type === 'timeline'
              ? timelineSpec(value.spec)
              : type === 'callout'
                ? calloutSpec(value.spec)
                : calculatorSpec(value.spec);
  const block = {
    id,
    type,
    version: 1,
    spec,
    fallback,
    ...(title ? { title } : {}),
    createdAt,
  } as MessageBlock;
  if (JSON.stringify(block).length > MAX_BLOCK_BYTES) fail('block', '内容超过 64 KB');
  return block;
}
