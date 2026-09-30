import { friendlyError } from '../../shared/chat/activity';
import { translate } from '../../shared/i18n';

export const objectValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const textValue = (value: unknown) => (typeof value === 'string' ? value : '');
export const arrayValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const fileName = (path: string) => path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path;
/**
 * Pretty-printed JSON when the whole text is JSON, or when every non-empty line is (gh/jq often print one value
 * per line). Undefined for anything else so ordinary output keeps its own layout.
 */
export function prettyJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || !'{['.includes(trimmed[0]) || trimmed.length > 200_000) return;
  const format = (value: string) => JSON.stringify(JSON.parse(value), null, 2);
  try {
    return format(trimmed);
  } catch {}
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2 || !lines.every((line) => '{['.includes(line.trim()[0]))) return;
  try {
    return lines.map(format).join('\n\n');
  } catch {
    return;
  }
}
const languages: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  html: 'xml',
  xml: 'xml',
  svg: 'xml',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  ps1: 'powershell',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  diff: 'diff',
};
/** Highlighter language for a file name; empty when the extension is unknown. */
export const codeLanguage = (name: string) =>
  /^dockerfile$/i.test(fileName(name))
    ? 'dockerfile'
    : /^makefile$/i.test(fileName(name))
      ? 'makefile'
      : languages[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() || ''] || '';
/** Short facts shown on a folded step row: duration, a failing exit code, match or edit counts. */
export function stepMeta(result: unknown): { text: string; tone?: 'bad' } | undefined {
  const value = objectValue(result);
  if (typeof value.exitCode === 'number' && value.exitCode !== 0)
    return { text: `exit ${value.exitCode}`, tone: 'bad' };
  if (typeof value.durationMs === 'number') {
    const seconds = value.durationMs / 1000;
    return { text: seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s` };
  }
  if (Array.isArray(value.matches) && value.matches.length)
    return { text: translate('{count} 处', { count: value.matches.length }) };
  if (typeof value.replacements === 'number' && value.replacements > 1)
    return { text: translate('{count} 处', { count: value.replacements }) };
  return;
}
export function parsedText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || !['{', '['].includes(trimmed[0])) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}
export function cleanConsole(text: string) {
  return text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}
const labels: Record<string, string> = {
  name: '名称',
  title: '标题',
  description: '说明',
  echo: '回显内容',
  marker: '验证标记',
  system: '运行系统',
  platform: '运行平台',
  source: '来源',
  result: '结果',
  message: '说明',
  status: '状态',
  total: '合计',
  byTeam: '团队汇总',
  team: '团队',
  amount: '金额',
  count: '数量',
  path: '文件路径',
  url: '地址',
  uri: '资源地址',
  success: '是否成功',
  verified: '是否通过',
  tests: '测试',
  passed: '通过',
  failed: '失败',
  errors: '错误',
  warnings: '提示',
  durationMs: '耗时（毫秒）',
  size: '大小',
  bytes: '字节数',
  rows: '记录',
  data: '数据',
  value: '内容',
  date: '日期',
  id: '编号',
};
export function fieldLabel(key: string) {
  return translate(labels[key] || key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
}
export function scalarText(value: unknown) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? translate('是') : translate('否');
  return String(value);
}
export function parameterRows(schema: unknown) {
  const root = objectValue(schema),
    required = new Set(arrayValue(root.required));
  const types: Record<string, string> = {
    string: '文本',
    number: '数字',
    integer: '整数',
    boolean: '是 / 否',
    array: '列表',
    object: '对象',
    null: '空值',
  };
  return Object.entries(objectValue(root.properties)).map(([name, value]) => {
    const item = objectValue(value);
    const kinds = Array.isArray(item.type) ? item.type : [item.type];
    return {
      name,
      description: textValue(item.description),
      required: required.has(name),
      type:
        kinds
          .filter((type) => typeof type === 'string')
          .map((type) => translate(types[String(type)] || String(type)))
          .join(' / ') || translate('任意值'),
      choices: arrayValue(item.enum).map(scalarText),
    };
  });
}
export function fileGroups(files: unknown) {
  const groups = new Map<string, Array<{ name: string; path: string }>>();
  for (const value of arrayValue(files)) {
    if (typeof value !== 'string') continue;
    const path = value.replace(/\\/g, '/'),
      dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const label =
      dir === 'scripts' ? '脚本' : dir === 'references' ? '参考资料' : dir === 'assets' ? '素材' : dir || '说明文件';
    const items = groups.get(label) || [];
    items.push({ name: fileName(path), path });
    groups.set(label, items);
  }
  return [...groups].map(([label, files]) => ({ label: translate(label), files }));
}
/** Path shown relative to the searched root; absolute paths are only kept when they sit outside it. */
export function relativePath(path: string, root: string) {
  const clean = path.replace(/\\/g, '/'),
    base = root.replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && clean.toLowerCase().startsWith(base.toLowerCase() + '/')) return clean.slice(base.length + 1);
  return clean === base ? fileName(clean) : clean;
}
export interface SearchFile {
  path: string;
  name: string;
  dir: string;
  count?: number;
  lines: Array<{ line: number; text: string; context?: boolean }>;
}
/** Groups file-search output (content, files or count mode) by file, preserving result order. */
export function searchFiles(result: Record<string, unknown>): SearchFile[] {
  const root = textValue(result.path),
    groups = new Map<string, SearchFile>();
  const group = (raw: string) => {
    const path = relativePath(raw, root);
    let item = groups.get(path);
    if (!item) {
      item = {
        path,
        name: fileName(path),
        dir: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
        lines: [],
      };
      groups.set(path, item);
    }
    return item;
  };
  for (const value of arrayValue(result.files)) if (typeof value === 'string') group(value);
  for (const value of arrayValue(result.counts)) {
    const entry = objectValue(value);
    if (typeof entry.path === 'string') group(entry.path).count = Number(entry.count) || 0;
  }
  for (const value of arrayValue(result.matches)) {
    const match = objectValue(value);
    if (typeof match.path !== 'string') continue;
    const item = group(match.path),
      line = Number(match.line) || 0;
    const add = (number: number, text: unknown, context: boolean) => {
      if (typeof text !== 'string' || item.lines.some((entry) => entry.line === number)) return;
      item.lines.push({ line: number, text, ...(context ? { context: true } : {}) });
    };
    arrayValue(match.before).forEach((text, index, list) => add(line - list.length + index, text, true));
    const existing = item.lines.find((entry) => entry.line === line);
    if (existing) delete existing.context;
    else add(line, match.text, false);
    arrayValue(match.after).forEach((text, index) => add(line + index + 1, text, true));
    item.count = item.lines.filter((entry) => !entry.context).length;
  }
  for (const item of groups.values()) item.lines.sort((a, b) => a.line - b.line);
  return [...groups.values()];
}
// Tool bookkeeping that helps the model page through results but means nothing to a reader.
const bookkeeping = new Set([
  'location',
  'sha256',
  'bom',
  'redacted',
  'written',
  'offset',
  'nextOffset',
  'nextLine',
  'eof',
  'truncated',
  'partialLine',
  'rangeTruncated',
  'withLineNumbers',
  'scanLimited',
  'visitedEntries',
  'scannedFiles',
  'scannedBytes',
  'skipped',
  'backend',
  'textStartColumn',
  'executionId',
  'resultId',
]);
export function readableResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readableResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !bookkeeping.has(key))
      .map(([key, item]) => [key, readableResult(item)]),
  );
}
export interface ErrorExplanation {
  title: string;
  message: string;
  code?: string;
  location?: string;
}
export function errorExplanation(raw: string): ErrorExplanation {
  const clean = cleanConsole(raw),
    http = /\bHTTP\s*(\d{3})\b/i.exec(clean),
    exception =
      /(KeyError|NameError|ModuleNotFoundError|FileNotFoundError|PermissionError|SyntaxError|AssertionError|ValueError|TypeError):\s*([^\n]*)/g;
  const last = [...clean.matchAll(exception)].at(-1),
    frame = [...clean.matchAll(/File "([^"]+)", line (\d+)/g)].at(-1);
  const location = frame
    ? `${frame[1] === '<string>' ? translate('当前脚本') : fileName(frame[1])} · ${translate('第 {line} 行', { line: frame[2] })}`
    : undefined;
  if (last) {
    const kind = last[1],
      detail = last[2].trim(),
      value = detail.replace(/^['"]|['"]$/g, '');
    const titles: Record<string, string> = {
      KeyError: '读取到了缺失的字段',
      NameError: '代码引用了未定义的名称',
      ModuleNotFoundError: '缺少运行依赖',
      FileNotFoundError: '没有找到文件',
      PermissionError: '没有访问权限',
      SyntaxError: '代码语法需要修正',
      AssertionError: '结果未通过校验',
      ValueError: '数据格式不符合要求',
      TypeError: '数据类型不符合要求',
    };
    const message =
      kind === 'KeyError'
        ? translate('返回数据中没有“{field}”字段。', { field: value })
        : kind === 'AssertionError'
          ? detail || translate('实际结果与校验条件不一致。')
          : detail || translate('请检查出错位置后继续。');
    return { title: translate(titles[kind]), message, code: kind, location };
  }
  let message = clean;
  const at = clean.indexOf('{');
  if (at >= 0) {
    const data = objectValue(parsedText(clean.slice(at))),
      error = objectValue(data.error);
    message = textValue(error.message) || textValue(data.message) || textValue(data.error) || '';
  }
  const notice = friendlyError(clean);
  return {
    title: notice.title,
    message: (message && message !== clean ? message : http ? notice.description : message || notice.description).slice(
      0,
      500,
    ),
    ...(http ? { code: `HTTP ${http[1]}` } : {}),
  };
}

// MCP content often repeats structuredContent. Omit the duplicate while retaining extra text.
export function mcpResultParts(result: Record<string, unknown>) {
  const structured = result.structuredContent;
  const comparable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(comparable);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(
            ([key, item]) => !(item === '[redacted]' && /credential|token|secret|password|authorization/i.test(key)),
          )
          .map(([key, item]) => [key, comparable(item)])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      );
    return value;
  };
  const content = arrayValue(result.content)
    .map(objectValue)
    .filter(
      (block) =>
        !(
          block.type === 'text' &&
          structured !== undefined &&
          JSON.stringify(comparable(parsedText(textValue(block.text)))) === JSON.stringify(comparable(structured))
        ),
    );
  return { structured, content };
}
