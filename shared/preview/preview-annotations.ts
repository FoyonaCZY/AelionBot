import type { PreviewAnnotation } from '../types/preview-editor-types';
import { AppError } from '../errors';
const STATUSES = ['sent', 'working', 'done', 'kept'];
export function validateAnnotations(value: unknown): PreviewAnnotation[] {
  if (!Array.isArray(value) || value.length > 100 || JSON.stringify(value).length > 1_000_000) throw Error('标注过多');
  const ids = new Set<string>();
  return value.map((raw) => {
    if (
      !raw ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      raw.id.length > 100 ||
      ids.has(raw.id) ||
      !['rect', 'arrow', 'pen', 'text', 'element'].includes(raw.type) ||
      !/^#[\da-f]{6}$/i.test(raw.color)
    )
      throw new AppError('preview.annotation_invalid', '标注无效');
    ids.add(raw.id);
    const point = (p: any) => {
      if (!p || ![p.x, p.y].every((n) => Number.isFinite(n) && n >= -1 && n <= 100)) throw Error('标注坐标无效');
      return { x: p.x, y: p.y };
    };
    const p = point(raw);
    if (
      (raw.w !== undefined && (!Number.isFinite(raw.w) || raw.w < 0 || raw.w > 100)) ||
      (raw.h !== undefined && (!Number.isFinite(raw.h) || raw.h < 0 || raw.h > 100))
    )
      throw Error('标注范围无效');
    for (const key of ['sourceWidth', 'sourceHeight'] as const)
      if (raw[key] !== undefined && (!Number.isFinite(raw[key]) || raw[key] < 1 || raw[key] > 10_000_000))
        throw new AppError('preview.annotation_canvas_invalid', '标注画布尺寸无效');
    if (raw.points !== undefined && (!Array.isArray(raw.points) || raw.points.length > 3000))
      throw Error('画笔点数过多');
    for (const [key, limit] of [
      ['text', 1000],
      ['selector', 3000],
      ['designId', 120],
      ['elementLabel', 160],
      ['elementText', 1000],
      ['reply', 1000],
      ['botNote', 1000],
    ] as const)
      if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > limit))
        throw new AppError('preview.annotation_text_too_long', '标注文字过长');
    if (
      (raw.n !== undefined && (!Number.isInteger(raw.n) || raw.n < 1 || raw.n > 999)) ||
      (raw.status !== undefined && !STATUSES.includes(raw.status)) ||
      (raw.author !== undefined && raw.author !== 'bot') ||
      (raw.timestampSec !== undefined &&
        (typeof raw.timestampSec !== 'number' ||
          !Number.isFinite(raw.timestampSec) ||
          raw.timestampSec < 0 ||
          raw.timestampSec > 86400 * 7))
    )
      throw new AppError('preview.annotation_invalid', '标注无效');
    return {
      id: raw.id,
      type: raw.type,
      ...p,
      color: raw.color,
      ...(raw.w !== undefined ? { w: raw.w } : {}),
      ...(raw.h !== undefined ? { h: raw.h } : {}),
      ...(raw.end ? { end: point(raw.end) } : {}),
      ...(raw.points ? { points: raw.points.map(point) } : {}),
      ...(raw.text ? { text: raw.text } : {}),
      ...(raw.selector ? { selector: raw.selector } : {}),
      ...(raw.designId ? { designId: raw.designId } : {}),
      ...(raw.sourceWidth ? { sourceWidth: raw.sourceWidth } : {}),
      ...(raw.sourceHeight ? { sourceHeight: raw.sourceHeight } : {}),
      ...(raw.elementLabel ? { elementLabel: raw.elementLabel } : {}),
      ...(raw.elementText ? { elementText: raw.elementText } : {}),
      ...(Number.isInteger(raw.page) && raw.page > 0 ? { page: raw.page } : {}),
      ...(raw.timestampSec !== undefined ? { timestampSec: raw.timestampSec } : {}),
      ...(raw.n !== undefined ? { n: raw.n } : {}),
      ...(raw.status ? { status: raw.status } : {}),
      ...(raw.reply ? { reply: raw.reply } : {}),
      ...(raw.author ? { author: raw.author } : {}),
      ...(raw.botNote ? { botNote: raw.botNote } : {}),
    };
  });
}
/** A pin as a sent message records it: enough to show it beside the Bot's reply and to find it again. */
export interface PreviewMarkRef {
  id: string;
  n: number;
  /** A short name for what was pointed at, as an i18n key (see pinTitle). */
  title: string;
  /** Video playback timestamp in seconds when the pin was placed on a video or video project. */
  timestampSec?: number;
}
const TAG_TITLES: Record<string, string> = {
  a: '链接',
  button: '按钮',
  h1: '标题',
  h2: '标题',
  h3: '标题',
  h4: '标题',
  h5: '标题',
  h6: '标题',
  p: '段落',
  img: '图片',
  svg: '图形',
  picture: '图片',
  video: '视频',
  input: '输入框',
  textarea: '输入框',
  select: '下拉框',
  nav: '导航',
  header: '页头',
  footer: '页脚',
  form: '表单',
  ul: '列表',
  ol: '列表',
  li: '列表项',
  table: '表格',
  section: '区块',
  article: '区块',
  aside: '侧栏',
  main: '正文',
  span: '文字',
  label: '文字',
};
/** "按钮", "标题", "区域": what a pin points at, in a word the person recognises. An i18n key. */
export function pinTitle(mark: Pick<PreviewAnnotation, 'type' | 'elementLabel' | 'w' | 'h' | 'author'>) {
  if (mark.author === 'bot') return 'Bot 的说明';
  if (mark.type === 'element') {
    const tag = mark.elementLabel?.match(/^[a-z][a-z0-9-]*/i)?.[0].toLowerCase() || '';
    // Links styled as buttons are buttons to the person looking at them.
    if (tag === 'a' && /btn|button|cta/i.test(mark.elementLabel || '')) return '按钮';
    return TAG_TITLES[tag] || '元素';
  }
  if (mark.type === 'rect') return (mark.w || 0) > 0 || (mark.h || 0) > 0 ? '区域' : '位置';
  return mark.type === 'arrow' ? '箭头' : mark.type === 'pen' ? '画笔' : '文字';
}
export const markRefs = (marks: PreviewAnnotation[]): PreviewMarkRef[] =>
  marks.map((mark, index) => ({
    id: mark.id,
    n: pinNumber(mark, index),
    title: pinTitle(mark),
    ...(mark.timestampSec !== undefined ? { timestampSec: mark.timestampSec } : {}),
  }));
export function validMarkRefs(value: unknown): PreviewMarkRef[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some(
      (ref) =>
        !ref ||
        typeof ref.id !== 'string' ||
        !ref.id ||
        ref.id.length > 100 ||
        !Number.isInteger(ref.n) ||
        ref.n < 1 ||
        ref.n > 999 ||
        typeof ref.title !== 'string' ||
        ref.title.length > 40 ||
        (ref.timestampSec !== undefined &&
          (typeof ref.timestampSec !== 'number' ||
            !Number.isFinite(ref.timestampSec) ||
            ref.timestampSec < 0 ||
            ref.timestampSec > 86400 * 7)),
    )
  )
    throw new AppError('preview.annotation_invalid', '评论无效');
  return value.map((ref) => ({
    id: ref.id,
    n: ref.n,
    title: ref.title,
    ...(ref.timestampSec !== undefined ? { timestampSec: ref.timestampSec } : {}),
  }));
}
/** Pin colours: the person's own, waiting, changed, left as it was, and the Bot's. */
export const PIN = {
  mine: '#29282c',
  sent: '#9c99a3',
  done: '#3f9a6e',
  kept: '#b9822f',
  bot: '#8b6bea',
  focus: '#8b6bea',
};
export const pinColor = (a: PreviewAnnotation) =>
  a.author === 'bot'
    ? PIN.bot
    : a.status === 'done'
      ? PIN.done
      : a.status === 'kept'
        ? PIN.kept
        : a.status === 'sent' || a.status === 'working'
          ? PIN.sent
          : PIN.mine;
/** A drawn stroke that is close to a straight line becomes an arrow. */
export function straightStroke(points: { x: number; y: number }[], width: number, height: number) {
  if (points.length < 2) return false;
  const a = points[0],
    b = points.at(-1)!,
    dx = (b.x - a.x) * width,
    dy = (b.y - a.y) * height,
    length = Math.hypot(dx, dy);
  if (length < 24) return false;
  return points.every(
    (p) => Math.abs(((p.x - a.x) * width * dy - (p.y - a.y) * height * dx) / length) <= Math.max(6, length * 0.06),
  );
}
/**
 * A Bot's pins from preview_mark: each names an element by CSS selector, or a region as [x, y, w, h] in 0–1 of the
 * page (or of one PDF page), with the note shown in its bubble. Numbers are given when the preview adds them.
 */
export function botPins(value: unknown): PreviewAnnotation[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    throw new AppError('preview.mark_invalid', 'marks 需要 1–20 条');
  return value.map((raw) => {
    const note = typeof raw?.note === 'string' ? raw.note.trim() : '',
      selector = typeof raw?.selector === 'string' ? raw.selector.trim() : '',
      box = raw?.box;
    if (!note || note.length > 1000)
      throw new AppError('preview.mark_invalid', '每条 mark 都需要 note，不超过 1000 字');
    if (selector.length > 3000) throw new AppError('preview.mark_invalid', 'selector 过长');
    const region =
      Array.isArray(box) && box.length === 4 && box.every((n) => typeof n === 'number' && n >= 0 && n <= 1)
        ? (box as number[])
        : undefined;
    if (!selector && !region)
      throw new AppError('preview.mark_invalid', '每条 mark 需要 selector，或 box [x, y, w, h]（0–1 之间）');
    if (raw.page !== undefined && (!Number.isInteger(raw.page) || raw.page < 1 || raw.page > 100000))
      throw new AppError('preview.mark_invalid', 'page 无效');
    if (
      raw.timestampSec !== undefined &&
      (typeof raw.timestampSec !== 'number' ||
        !Number.isFinite(raw.timestampSec) ||
        raw.timestampSec < 0 ||
        raw.timestampSec > 86400 * 7)
    )
      throw new AppError('preview.mark_invalid', 'timestampSec 无效');
    const [x, y, w, h] = region || [0, 0, 0, 0];
    return {
      id: globalThis.crypto.randomUUID(),
      type: selector ? 'element' : 'rect',
      x,
      y,
      w: Math.min(w, 1 - x),
      h: Math.min(h, 1 - y),
      color: PIN.bot,
      author: 'bot',
      botNote: note,
      ...(selector ? { selector } : {}),
      ...(raw.page ? { page: raw.page } : {}),
      ...(raw.timestampSec !== undefined ? { timestampSec: raw.timestampSec } : {}),
    } satisfies PreviewAnnotation;
  });
}
/** The number a pin shows: its own once given, otherwise its place in the list. */
export const pinNumber = (mark: PreviewAnnotation, index: number) => mark.n ?? index + 1;
/** The next number for a new pin: one past the highest, so numbers are never reused while pins remain. */
export const nextPinNumber = (marks: PreviewAnnotation[]) =>
  Math.min(999, marks.reduce((top, mark, index) => Math.max(top, pinNumber(mark, index)), 0) + 1);
/** Pins that go out with the next message: the person's own, not yet sent, and Bot pins they answered. */
export const unsentPins = (marks: PreviewAnnotation[]) =>
  marks.filter((mark) => !mark.status && (mark.author !== 'bot' || Boolean(mark.text?.trim())));
const formatPinTimestamp = (sec: number) => {
  const totalTenths = Math.round(sec * 10);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
};
const clean = (text: string) => text.replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
/**
 * The pins as the Bot reads them: one block per number with what was pointed at, what the person asked, where to
 * find it in the source, the exact coordinates, and the close-up image's file name when there is one.
 */
export function annotationContext(
  annotations: PreviewAnnotation[],
  options: { en?: boolean; closeUps?: Map<string, string> } = {},
) {
  const en = Boolean(options.en);
  const kind = (a: PreviewAnnotation) =>
    a.type === 'element'
      ? en
        ? 'element'
        : '元素'
      : a.type === 'rect'
        ? (a.w || 0) > 0 || (a.h || 0) > 0
          ? en
            ? 'region'
            : '区域'
          : en
            ? 'point'
            : '位置'
        : a.type === 'arrow'
          ? en
            ? 'arrow'
            : '箭头'
          : a.type === 'pen'
            ? en
              ? 'drawing'
              : '画笔'
            : en
              ? 'text'
              : '文字';
  const field = (cn: string, english: string) => '   ' + (en ? english + ': ' : cn + '：');
  return validateAnnotations(annotations)
    .map((a, i) => {
      const lines = [
        `#${pinNumber(a, i)} ${kind(a)}${a.elementLabel ? ' ' + clean(a.elementLabel) : ''}${a.elementText ? (en ? ` "${clean(a.elementText).slice(0, 200)}"` : `「${clean(a.elementText).slice(0, 200)}」`) : ''}`,
      ];
      if (a.author === 'bot' && a.botNote) lines.push(field('你钉的说明', 'Your note') + clean(a.botNote));
      if (a.text?.trim())
        lines.push(
          field(a.author === 'bot' ? '用户回复' : '要求', a.author === 'bot' ? 'Reply' : 'Request') + clean(a.text),
        );
      const locate = [
        a.selector && clean(a.selector),
        a.designId && 'data-design-id=' + a.designId,
        a.page && (en ? 'page ' + a.page : '第 ' + a.page + ' 页'),
        a.timestampSec !== undefined &&
          (en ? 'time ' + formatPinTimestamp(a.timestampSec) : '时间点 ' + formatPinTimestamp(a.timestampSec)),
      ].filter(Boolean);
      if (locate.length) lines.push(field('定位', 'Locate') + locate.join(' · '));
      lines.push(
        field('坐标', 'Coordinates') +
          `[${[a.x, a.y, a.w ?? 0, a.h ?? 0].map((n) => n.toFixed(4)).join(', ')}]` +
          (a.sourceWidth && a.sourceHeight
            ? (en ? ' · source ' : ' · 基于 ') + a.sourceWidth + '×' + a.sourceHeight + ' CSS px'
            : '') +
          (a.end ? (en ? ' · end ' : ' · 终点 ') + `[${a.end.x.toFixed(4)}, ${a.end.y.toFixed(4)}]` : ''),
      );
      const closeUp = options.closeUps?.get(a.id);
      if (closeUp) lines.push(field('特写', 'Close-up') + closeUp);
      return lines.join('\n');
    })
    .join('\n');
}
