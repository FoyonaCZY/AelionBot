import { AppError } from '../errors';

export type WidgetScope = { kind: 'bot'; id: string; sessionId?: string } | { kind: 'group'; id: string };

export interface PinnedWidget {
  id: string;
  scope: WidgetScope;
  title: string;
  html: string;
  state: Record<string, unknown>;
  /** Message ID this widget was pinned from, when pinned from an inline reply fence. */
  sourceMessageId?: string;
  /** 0-based index of the widget fence inside `sourceMessageId`. */
  sourceIndex?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PinWidgetInput {
  scope: WidgetScope;
  title?: string;
  html: string;
  state?: Record<string, unknown>;
  sourceMessageId?: string;
  sourceIndex?: number;
}

export interface UpdatePinnedWidgetInput {
  id: string;
  title?: string;
  html?: string;
  state?: Record<string, unknown>;
  mergeState?: boolean;
  resetState?: boolean;
}

export const WIDGET_MAX_HTML_BYTES = 64 * 1024;
export const WIDGET_MAX_STATE_BYTES = 64 * 1024;
export const WIDGET_MAX_TITLE_CHARS = 80;
export const WIDGET_MAX_PER_SCOPE = 12;
export const WIDGET_DEFAULT_TITLE = '小工具';

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export function widgetScopeKey(scope: WidgetScope): string {
  return scope.kind === 'group'
    ? 'group:' + scope.id
    : 'bot:' + scope.id + (scope.sessionId ? ':' + scope.sessionId : '');
}

export function widgetInScope(widget: PinnedWidget, scope: WidgetScope): boolean {
  return widgetScopeKey(widget.scope) === widgetScopeKey(scope);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function decodeHtmlText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts a display title from widget HTML metadata:
 * 1. `<!-- title: Name -->`
 * 2. `<title>Name</title>`
 * 3. First `<h1>`–`<h3>` heading text
 * Falls back to `WIDGET_DEFAULT_TITLE`.
 */
export function extractWidgetTitle(html: string): string {
  const comment = /<!--\s*title\s*:\s*([\s\S]*?)-->/i.exec(html);
  if (comment) {
    const clean = decodeHtmlText(comment[1]).slice(0, WIDGET_MAX_TITLE_CHARS).trim();
    if (clean) return clean;
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleTag) {
    const clean = decodeHtmlText(titleTag[1]).slice(0, WIDGET_MAX_TITLE_CHARS).trim();
    if (clean) return clean;
  }
  const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  if (heading) {
    const clean = decodeHtmlText(heading[1]).slice(0, WIDGET_MAX_TITLE_CHARS).trim();
    if (clean) return clean;
  }
  return WIDGET_DEFAULT_TITLE;
}

export function validateWidgetTitle(title: unknown, html?: string): string {
  if (title === undefined) return extractWidgetTitle(html || '');
  if (typeof title !== 'string') throw new AppError('widget.title_invalid', '小工具标题必须是文本');
  const trimmed = title.replace(/[\r\n\t]+/g, ' ').trim();
  if (!trimmed || trimmed.length > WIDGET_MAX_TITLE_CHARS)
    throw new AppError('widget.title_invalid', `小工具标题需要 1–${WIDGET_MAX_TITLE_CHARS} 个字符`);
  return trimmed;
}

export function validateWidgetHtml(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) throw new AppError('widget.html_invalid', '小工具 HTML 不能为空');
  if (utf8Bytes(html) > WIDGET_MAX_HTML_BYTES)
    throw new AppError('widget.html_too_large', '小工具 HTML 不能超过 64 KB');
  return html;
}

export function validateWidgetState(state: unknown): Record<string, unknown> {
  if (state === undefined) return {};
  if (!isPlainObject(state)) throw new AppError('widget.state_invalid', '小工具状态必须是普通 JSON 对象');
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    throw new AppError('widget.state_invalid', '小工具状态无法序列化为 JSON');
  }
  if (typeof serialized !== 'string') throw new AppError('widget.state_invalid', '小工具状态必须是普通 JSON 对象');
  if (utf8Bytes(serialized) > WIDGET_MAX_STATE_BYTES)
    throw new AppError('widget.state_too_large', '小工具状态不能超过 64 KB');
  const parsed: unknown = JSON.parse(serialized);
  if (!isPlainObject(parsed)) throw new AppError('widget.state_invalid', '小工具状态必须是普通 JSON 对象');
  return parsed;
}
