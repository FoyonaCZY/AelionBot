// DeepSeek's web search, fetch and OCR APIs (https://api-docs.deepseek.com/zh-cn/guides/search and ocr) served as an
// MCP server inside the app. DeepSeek has no MCP endpoint of its own; this lets it join the app catalog like the
// remote ones, with the same switch, encrypted API key and native functions. Files come in through mcp-files.
// Its speech recognition and synthesis are a speech protocol in settings instead (electron/core/speech).
import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { attachmentName } from '../attachments/attachments';
import { FILE_BRIDGE_META, FILE_INPUTS_META, fileArgument, type BridgedFile, type FileBridge } from './mcp-files';

const API = 'https://api.deepseek.com/v1/tools';
const PAGE_CHARS = 12000;
const MAX_PAGE_CHARS = 32000;
/** Body text per result when `need_content` is set, so 50 results stay within one tool result. */
const RESULT_CONTENT_CHARS = 4000;
/** Fetched pages and recognized text are kept this long for paging. */
const CACHE_MINUTES = 30;

const fileTool = (inputs: string[]) => ({ [FILE_BRIDGE_META]: { inputs } satisfies FileBridge });

const TOOLS: Tool[] = [
  {
    name: 'search',
    description:
      '用 DeepSeek 搜索网页，返回标题、链接、日期、来源和摘要。query 支持 site:、-site:、"精确短语"、-排除词、lang:zh,en、after:2025-01-01、before:2025。rerank_score ≥ 1.5 的结果相关度高，authority ≥ 3 的来源权威度高。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 128, description: '搜索词，1–128 个字符' },
        count: { type: 'integer', minimum: 1, maximum: 50, description: '返回结果数，默认 10' },
        ori_question: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: '用户的原始问题，帮助判断搜索意图',
        },
        need_content: {
          type: 'boolean',
          description: `为 true 时附带每个结果的网页正文（每条最多 ${RESULT_CONTENT_CHARS} 字）`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'DeepSeek 网页搜索', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'fetch',
    description:
      '用 DeepSeek 抓取网页，返回标题和 Markdown 正文。正文较长时分页返回，用 offset 读取后续内容；同一网址 30 分钟内翻页不会重复抓取。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 8192, description: 'http 或 https 网址' },
        offset: { type: 'integer', minimum: 0, description: '从正文第几个字符开始，默认 0' },
        max_chars: {
          type: 'integer',
          minimum: 100,
          maximum: MAX_PAGE_CHARS,
          description: `本次最多返回的字符数，默认 ${PAGE_CHARS}`,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { title: 'DeepSeek 网页抓取', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'ocr',
    description:
      '用 DeepSeek 识别文档或图片里的文字，支持 PDF、Word、PPT 和 PNG、JPEG、WebP、GIF、BMP、TIFF 图片，最多 1000 页、25 MB，按页返回。扫描件、截图、照片和不能直接复制文字的 PDF 适合用它。layout 为 true 时按版面识别，保留标题、表格和图片区域，文本里的 <｜ref｜>、<｜box｜> 标记带 [[x1, y1, x2, y2]] 坐标（按页面宽高归一化到 0–1000）。结果较长时分页返回，用 offset 读取后续内容；30 分钟内翻页不会重复识别。',
    inputSchema: {
      type: 'object',
      properties: {
        file: fileArgument('要识别的文件，填写 attachmentId 或 path'),
        layout: { type: 'boolean', description: '按版面识别，默认 false 只取文字' },
        offset: { type: 'integer', minimum: 0, description: '从结果第几个字符开始，默认 0' },
        max_chars: {
          type: 'integer',
          minimum: 100,
          maximum: MAX_PAGE_CHARS,
          description: `本次最多返回的字符数，默认 ${PAGE_CHARS}`,
        },
      },
      required: ['file'],
      additionalProperties: false,
    },
    annotations: { title: 'DeepSeek 文字识别', readOnlyHint: true, openWorldHint: true },
    _meta: fileTool(['file']),
  },
];

interface SearchResult {
  rerank_score?: number;
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string;
  date?: string | null;
  authority?: number;
}

const STATUS: Record<number, string> = {
  400: '请求参数无效',
  401: 'DeepSeek API Key 无效，请在插件页移除 DeepSeek 后用新的 Key 重新添加',
  402: 'DeepSeek 账户余额不足，充值后再试',
  403: '这个网址被 DeepSeek 的安全策略拦截',
  404: 'DeepSeek 没能从这个网址取到可用内容',
  408: '请求超时，稍后重试',
  413: '请求内容过大',
  429: '请求过于频繁，稍后重试',
  503: 'DeepSeek 服务繁忙，稍后重试',
  504: 'DeepSeek 处理超时，稍后重试',
};

const failure = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
const reply = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });

/** One page of text, with where the next page starts. */
function page(text: string, offset: number, maxChars: number, unit = '正文') {
  const part = text.slice(offset, offset + maxChars),
    end = offset + part.length;
  return end < text.length
    ? `${part}\n\n[${unit}共 ${text.length} 字，已显示到第 ${end} 字；用 offset=${end} 继续读取]`
    : part;
}

function formatResults(results: SearchResult[], withContent: boolean) {
  if (!results.length) return '没有搜索结果。';
  return results
    .map((item, index) => {
      const meta = [
        item.site_name,
        item.date?.slice(0, 10),
        typeof item.rerank_score === 'number' ? `相关度 ${item.rerank_score.toFixed(2)}` : '',
        typeof item.authority === 'number' && item.authority >= 0 ? `权威度 ${item.authority}` : '',
      ].filter(Boolean);
      const lines = [`${index + 1}. ${item.title || item.url}`, item.url || ''];
      if (meta.length) lines.push(meta.join(' · '));
      const summary = item.summary || item.snippet;
      if (summary) lines.push(summary.trim());
      if (withContent && item.content) {
        const content = item.content.trim();
        lines.push(
          '正文：\n' +
            (content.length > RESULT_CONTENT_CHARS
              ? content.slice(0, RESULT_CONTENT_CHARS) + '\n[正文已截断，可用 fetch 读取全文]'
              : content),
        );
      }
      return lines.filter(Boolean).join('\n');
    })
    .join('\n\n');
}

type Reply<T> = { data: T; error?: undefined } | { data?: undefined; error: string };

/** What went wrong, from a failed response or an `error` object in a successful one. */
async function problem(response: Response, body?: unknown) {
  const data = body ?? (await response.json().catch(() => undefined));
  const message =
    typeof (data as any)?.error?.message === 'string' ? ((data as any).error.message as string).slice(0, 300) : '';
  const known = response.ok
    ? 'DeepSeek 处理失败'
    : STATUS[response.status] || (response.status >= 500 ? 'DeepSeek 服务暂时出错，稍后重试' : '');
  return `${known || `DeepSeek 返回 HTTP ${response.status}`}${message ? `（${message}）` : ''}`;
}

/** Calls the API with the person's key; errors come back as text the model can read. */
async function request(
  apiKey: string,
  path: string,
  body: Record<string, unknown> | FormData,
  signal?: AbortSignal,
): Promise<Reply<Response>> {
  const json = !(body instanceof FormData);
  try {
    const response = await fetch(`${API}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(body) : body,
      signal,
    });
    return response.ok ? { data: response } : { error: await problem(response) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { error: '连接 DeepSeek 失败，请检查网络或代理' };
  }
}

async function post(
  apiKey: string,
  path: string,
  body: Record<string, unknown> | FormData,
  signal?: AbortSignal,
): Promise<Reply<Record<string, any>>> {
  const result = await request(apiKey, path, body, signal);
  if (!result.data) return result;
  // OCR keeps the connection open with newlines before the JSON; JSON.parse skips them as whitespace.
  const data = await result.data.json().catch(() => undefined);
  if (!data || typeof data !== 'object') return { error: 'DeepSeek 返回了无法解析的结果' };
  // Recognition that fails after it started still answers 200, with an error in place of the result.
  if (data.error) return { error: await problem(result.data, data) };
  return { data };
}

/** The file the tool layer resolved for an argument; absent when the client is not AelionBot. */
function bridged(meta: Record<string, unknown> | undefined, name: string) {
  const file = (meta?.[FILE_INPUTS_META] as Record<string, BridgedFile> | undefined)?.[name];
  return file && typeof file.path === 'string' ? file : undefined;
}

const upload = (bytes: Uint8Array, name: string, mime: string, fields: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime || 'application/octet-stream' }), name);
  return form;
};

/** Text recognized from a file, one section per page. */
function ocrText(data: Record<string, any>) {
  const pages = Array.isArray(data.pages) ? (data.pages as Array<Record<string, unknown>>) : [];
  if (!pages.length) return '';
  return pages
    .map((item, index) => {
      const number = (typeof item.index === 'number' ? item.index : index) + 1,
        text = typeof item.text === 'string' ? item.text.trim() : '';
      return [
        pages.length > 1 ? `--- 第 ${number} 页 ---` : '',
        text || '（这一页没有识别到文字）',
        item.finish_reason === 'length' ? '[这一页的识别结果达到长度上限，可能不完整]' : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

interface Cached {
  text: string;
  time: number;
}
/** Remembers the last 16 results for 30 minutes, so paging through one does not repeat the request. */
function cache() {
  const items = new Map<string, Cached>();
  return {
    get(key: string) {
      const item = items.get(key);
      return item && Date.now() - item.time <= CACHE_MINUTES * 60000 ? item : undefined;
    },
    set(key: string, text: string) {
      const item = { text, time: Date.now() };
      items.delete(key);
      items.set(key, item);
      while (items.size > 16) items.delete(items.keys().next().value!);
      return item;
    },
  };
}

function deepseekServer(apiKey: string) {
  const server = new Server({ name: 'deepseek', version: '1.1.0' }, { capabilities: { tools: {} } });
  const pages = new Map<string, { title: string; content: string; time: number }>(),
    recognized = cache();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra): Promise<CallToolResult> => {
    const args = (params.arguments || {}) as Record<string, any>,
      meta = params._meta as Record<string, unknown> | undefined;
    if (params.name === 'search') {
      const result = await post(
        apiKey,
        'search',
        {
          query: args.query,
          count: args.count ?? 10,
          need_content: args.need_content === true,
          ...(args.ori_question ? { ori_question: args.ori_question } : {}),
        },
        extra.signal,
      );
      if (!result.data) return failure(result.error);
      const results = Array.isArray(result.data.results) ? (result.data.results as SearchResult[]) : [];
      return reply(formatResults(results, args.need_content === true));
    }
    if (params.name === 'fetch') {
      const url = String(args.url);
      if (!/^https?:\/\//i.test(url)) return failure('只能抓取 http 或 https 网址');
      let cached = pages.get(url);
      if (!cached || Date.now() - cached.time > CACHE_MINUTES * 60000) {
        const result = await post(apiKey, 'fetch', { url }, extra.signal);
        if (!result.data) return failure(result.error);
        cached = {
          title: typeof result.data.title === 'string' ? result.data.title : '',
          content: typeof result.data.content === 'string' ? result.data.content : '',
          time: Date.now(),
        };
        pages.delete(url);
        pages.set(url, cached);
        while (pages.size > 16) pages.delete(pages.keys().next().value!);
      }
      const offset = Number.isInteger(args.offset) ? args.offset : 0,
        maxChars = Number.isInteger(args.max_chars) ? args.max_chars : PAGE_CHARS;
      if (offset > 0 && offset >= cached.content.length) return failure(`offset 超出正文长度 ${cached.content.length}`);
      const body = cached.content ? page(cached.content, offset, maxChars) : '（页面没有正文）';
      return reply(`# ${cached.title || url}\n${url}\n\n${body}`);
    }
    if (params.name === 'ocr') {
      const file = bridged(meta, 'file');
      if (!file) return failure('这个工具需要在 AelionBot 里调用，由它读取文件');
      const key = `${file.path}\0${file.size}\0${args.layout === true}`;
      let done = recognized.get(key);
      if (!done) {
        const purpose = args.layout === true ? 'rich_layout_recognition' : 'text_recognition',
          bytes = await readFile(file.path),
          result = await post(
            apiKey,
            'ocr',
            upload(bytes, attachmentName(file.name), file.mime, { purpose }),
            extra.signal,
          );
        if (!result.data) return failure(result.error);
        done = recognized.set(key, ocrText(result.data));
      }
      if (!done.text) return reply('没有识别到文字。');
      const offset = Number.isInteger(args.offset) ? args.offset : 0,
        maxChars = Number.isInteger(args.max_chars) ? args.max_chars : PAGE_CHARS;
      if (offset > 0 && offset >= done.text.length) return failure(`offset 超出结果长度 ${done.text.length}`);
      return reply(page(done.text, offset, maxChars, '识别结果'));
    }
    return failure('未知工具');
  });
  return server;
}

/** The client side of a fresh in-process DeepSeek server; closing it closes the server. */
export async function deepseekTransport(apiKey: string) {
  const [client, server] = InMemoryTransport.createLinkedPair();
  await deepseekServer(apiKey).connect(server);
  return client;
}
