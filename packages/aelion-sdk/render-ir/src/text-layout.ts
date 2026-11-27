import type { JsonObject } from '@aelionsdk/core';

import type { IrTextClip, IrTextRun } from './types.js';

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

function graphemes(value: string): readonly string[] {
  return Array.from(graphemeSegmenter.segment(value), (segment) => segment.segment);
}

export interface IrLaidOutTextSpan {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly advancePx: number;
  readonly glyphs: readonly IrLaidOutTextGlyph[];
  readonly style: PortableTextStyle;
}

export interface IrLaidOutTextGlyph {
  readonly text: string;
  readonly x: number;
  readonly advancePx: number;
}

export interface IrLaidOutTextLine {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly spans: readonly IrLaidOutTextSpan[];
}

export interface TextMeasureContext {
  measureText(text: string, style: PortableTextStyle): number;
}

export interface LayoutIrTextOptions {
  /**
   * Text measurement strategy:
   * - `'auto'` (default): uses OffscreenCanvas 2D `measureText` when available in Chromium/browser,
   *   falling back cleanly to deterministic portable heuristics in Node.
   * - `'portable'`: forces heuristic em-width measurement.
   * - custom `TextMeasureContext`: uses caller-provided canvas/metrics measurer.
   */
  readonly measure?: TextMeasureContext | 'auto' | 'portable';
}

export interface IrTextLayout {
  readonly metricsId: 'aelion-portable-text-metrics/1' | 'aelion-canvas-text-metrics/1';
  readonly fontSizePx: number;
  readonly overflowed: boolean;
  readonly lines: readonly IrLaidOutTextLine[];
}

export interface PortableTextStyle {
  readonly fontFamilies: readonly string[];
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly fontStyle: 'normal' | 'italic' | 'oblique';
  readonly lineHeightPx: number;
  readonly letterSpacingPx: number;
  readonly fill: string;
  readonly stroke: string | undefined;
  readonly strokeWidthPx: number;
  readonly align: 'start' | 'center' | 'end';
  readonly direction: 'ltr' | 'rtl';
  readonly backgroundFill: string;
  readonly backgroundOpacity: number;
  readonly backgroundPaddingPx: number;
  readonly backgroundRadiusPx: number;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function portableTextStyle(runStyle: JsonObject, paragraphStyle: JsonObject = {}, scale = 1): PortableTextStyle {
  const combined = { ...paragraphStyle, ...runStyle } as Readonly<Record<string, unknown>>;
  const families = Array.isArray(combined.fontFamilies)
    ? combined.fontFamilies.filter((value): value is string => typeof value === 'string')
    : [text(combined.fontFamily, 'sans-serif')];
  const fontSizePx = Math.max(1, finite(combined.fontSizePx, 32) * scale);
  const fontStyle = text(combined.fontStyle, 'normal');
  const align = text(combined.align, 'start');
  const direction = text(combined.direction, 'ltr');
  return {
    fontFamilies: families.length === 0 ? ['sans-serif'] : families,
    fontSizePx,
    fontWeight: Math.max(1, Math.min(1_000, finite(combined.fontWeight, 400))),
    fontStyle: fontStyle === 'italic' || fontStyle === 'oblique' ? fontStyle : ('normal' as const),
    lineHeightPx: Math.max(fontSizePx, finite(combined.lineHeightPx, fontSizePx * 1.2) * scale),
    letterSpacingPx: finite(combined.letterSpacingPx, 0) * scale,
    fill: text(combined.fill, '#ffffff'),
    stroke: typeof combined.stroke === 'string' ? combined.stroke : undefined,
    strokeWidthPx: Math.max(0, finite(combined.strokeWidthPx, 0) * scale),
    align: align === 'center' || align === 'end' ? align : 'start',
    direction: direction === 'rtl' ? 'rtl' : 'ltr',
    backgroundFill: text(combined.backgroundFill, '#000000'),
    backgroundOpacity: Math.max(0, Math.min(1, finite(combined.backgroundOpacity, 0))),
    backgroundPaddingPx: Math.max(
      0,
      combined.backgroundPaddingPx === undefined
        ? fontSizePx * 0.25
        : finite(combined.backgroundPaddingPx, fontSizePx * 0.25) * scale,
    ),
    backgroundRadiusPx: Math.max(
      0,
      combined.backgroundRadiusPx === undefined
        ? fontSizePx * 0.15
        : finite(combined.backgroundRadiusPx, fontSizePx * 0.15) * scale,
    ),
  };
}

/** Whether a run's background plate contributes any pixels at its opacity. */
export function textBackgroundVisible(style: PortableTextStyle): boolean {
  return style.backgroundOpacity > 0.001;
}

/**
 * Rewrites a `#rgb`, `#rrggbb` or `rgb()` colour as `rgba()` with the given
 * alpha. Colours the parser does not recognize are returned unchanged.
 */
export function cssColorWithAlpha(color: string, alpha: number): string {
  const rgb = parseCssRgb(color);
  const clamped = Math.max(0, Math.min(1, alpha));
  if (rgb === undefined) return color;
  return `rgba(${rgb[0].toString()}, ${rgb[1].toString()}, ${rgb[2].toString()}, ${clamped.toString()})`;
}

/**
 * Pixels a run paints outside its glyph box, whichever of the stroke or the
 * background plate's padding reaches further.
 */
export function textPaintExtent(style: PortableTextStyle): number {
  const pad = textBackgroundVisible(style) ? style.backgroundPaddingPx : 0;
  return Math.max(style.strokeWidthPx, pad);
}

/** Largest {@link textPaintExtent} across every run in a text clip. */
export function textClipPaintExtent(clip: IrTextClip): number {
  let pad = 0;
  for (const paragraph of clip.paragraphs) {
    for (const run of paragraph.runs) {
      pad = Math.max(pad, textPaintExtent(portableTextStyle(run.style, paragraph.style)));
    }
  }
  return pad;
}

/**
 * Grows a layout box by `pad` on every side so stroke and background pixels
 * stay inside the rasterized target. Non-positive padding returns `box` as-is.
 */
export function inflateTextBox(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  pad: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  if (pad <= 0) return box;
  return {
    x: box.x - pad,
    y: box.y - pad,
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

function parseCssRgb(color: string): readonly [number, number, number] | undefined {
  const value = color.trim();
  const hex6 = /^#([0-9a-f]{6})$/iu.exec(value);
  if (hex6?.[1] !== undefined) {
    const n = Number.parseInt(hex6[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hex3 = /^#([0-9a-f]{3})$/iu.exec(value);
  if (hex3?.[1] !== undefined) {
    const raw = hex3[1];
    const r = raw[0];
    const g = raw[1];
    const b = raw[2];
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return [Number.parseInt(`${r}${r}`, 16), Number.parseInt(`${g}${g}`, 16), Number.parseInt(`${b}${b}`, 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(value);
  if (rgb === null) return undefined;
  return [Number.parseInt(rgb[1] ?? '0', 10), Number.parseInt(rgb[2] ?? '0', 10), Number.parseInt(rgb[3] ?? '0', 10)];
}

export function portableTextCanvasFont(style: PortableTextStyle): string {
  const families = style.fontFamilies
    .map((value) => (/^[\w-]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`))
    .join(', ');
  return `${style.fontStyle} ${style.fontWeight.toString()} ${style.fontSizePx.toString()}px ${families}`;
}

let cachedOffscreenMeasurer: TextMeasureContext | null | undefined;

function createCanvasTextMeasurer(
  context: Pick<OffscreenCanvasRenderingContext2D, 'font' | 'measureText'>,
): TextMeasureContext {
  let activeFont = '';
  return {
    measureText(value: string, style: PortableTextStyle): number {
      if (value.length === 0) return 0;
      const font = portableTextCanvasFont(style);
      if (activeFont !== font) {
        context.font = font;
        activeFont = font;
      }
      const width = context.measureText(value).width;
      return Number.isFinite(width) && width >= 0 ? width : 0;
    },
  };
}

function defaultCanvasTextMeasurer(): TextMeasureContext | undefined {
  if (cachedOffscreenMeasurer !== undefined) return cachedOffscreenMeasurer ?? undefined;
  if (typeof OffscreenCanvas !== 'function') {
    cachedOffscreenMeasurer = null;
    return undefined;
  }
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    if (context === null || typeof context.measureText !== 'function') {
      cachedOffscreenMeasurer = null;
      return undefined;
    }
    cachedOffscreenMeasurer = createCanvasTextMeasurer(context);
    return cachedOffscreenMeasurer;
  } catch {
    cachedOffscreenMeasurer = null;
    return undefined;
  }
}

function resolveTextMeasurer(measure: LayoutIrTextOptions['measure']): TextMeasureContext | undefined {
  if (measure === 'portable') return undefined;
  if (measure !== undefined && measure !== 'auto') return measure;
  return defaultCanvasTextMeasurer();
}

export function portableGlyphAdvance(character: string, style: PortableTextStyle): number {
  const codePoint = character.codePointAt(0) ?? 0;
  const em =
    character === ' '
      ? 0.33
      : codePoint >= 0x2e80 || codePoint > 0xffff
        ? 1
        : /[ilI1.,'`]/u.test(character)
          ? 0.32
          : /[MW@#%]/u.test(character)
            ? 0.9
            : 0.6;
  return style.fontSizePx * em + style.letterSpacingPx;
}

function runTokens(run: IrTextRun): readonly string[] {
  const matches = run.text.match(
    /\r?\n|[\t ]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][，。、！？；：）》」』】〉”’…·]?|[^\r\n\t \p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
  );
  return matches ?? [];
}

function tokenAdvance(token: string, style: PortableTextStyle, measurer: TextMeasureContext | undefined): number {
  if (measurer !== undefined) {
    const clusters = graphemes(token);
    if (clusters.length === 0) return 0;
    if (style.letterSpacingPx === 0) {
      return measurer.measureText(token, style);
    }
    return clusters.reduce(
      (total, character) => total + measurer.measureText(character, style) + style.letterSpacingPx,
      0,
    );
  }
  return graphemes(token).reduce((total, character) => total + portableGlyphAdvance(character, style), 0);
}

function lineOffset(
  width: number,
  boxWidth: number,
  align: PortableTextStyle['align'],
  direction: PortableTextStyle['direction'],
): number {
  if (align === 'center') return (boxWidth - width) / 2;
  if (align === 'end') return direction === 'rtl' ? 0 : boxWidth - width;
  return direction === 'rtl' ? boxWidth - width : 0;
}

function laidOutSpan(
  value: string,
  x: number,
  y: number,
  style: PortableTextStyle,
  measurer: TextMeasureContext | undefined,
): IrLaidOutTextSpan {
  const clusters = graphemes(value);
  if (measurer !== undefined) {
    if (style.letterSpacingPx === 0) {
      const totalAdvance = measurer.measureText(value, style);
      let prefix = '';
      let prevWidth = 0;
      const glyphs = clusters.map((character) => {
        prefix += character;
        const nextWidth = measurer.measureText(prefix, style);
        const advancePx = Math.max(0, nextWidth - prevWidth);
        const glyph = { text: character, x: x + prevWidth, advancePx };
        prevWidth = nextWidth;
        return glyph;
      });
      return { text: value, x, y, advancePx: totalAdvance, glyphs, style };
    }
    let cursor = x;
    const glyphs = clusters.map((character) => {
      const advancePx = measurer.measureText(character, style) + style.letterSpacingPx;
      const glyph = { text: character, x: cursor, advancePx };
      cursor += advancePx;
      return glyph;
    });
    return { text: value, x, y, advancePx: cursor - x, glyphs, style };
  }
  let cursor = x;
  const glyphs = clusters.map((character) => {
    const advancePx = portableGlyphAdvance(character, style);
    const glyph = { text: character, x: cursor, advancePx };
    cursor += advancePx;
    return glyph;
  });
  return { text: value, x, y, advancePx: cursor - x, glyphs, style };
}

function splitLongToken(
  token: string,
  boxWidth: number,
  style: PortableTextStyle,
  measurer: TextMeasureContext | undefined,
): readonly string[] {
  const clusters = graphemes(token);
  if (clusters.length <= 1 || boxWidth <= 0) return [token];
  const parts: string[] = [];
  let current = '';
  for (const cluster of clusters) {
    const next = current + cluster;
    if (current.length > 0 && tokenAdvance(next, style, measurer) > boxWidth) {
      parts.push(current);
      current = cluster;
    } else {
      current = next;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function layoutAtScale(clip: IrTextClip, scale: number, measurer: TextMeasureContext | undefined): IrTextLayout {
  const lines: IrLaidOutTextLine[] = [];
  let cursorY = clip.box.y;
  let current: IrLaidOutTextSpan[] = [];
  let width = 0;
  let height = 0;
  let align: PortableTextStyle['align'] = 'start';
  let direction: PortableTextStyle['direction'] = 'ltr';
  let overflowed = false;
  const flush = (): void => {
    if (current.length === 0 && height === 0) return;
    const offset = lineOffset(width, clip.box.width, align, direction);
    let rtlCursor = clip.box.x + width;
    const positioned = current.map((span) => {
      if (direction !== 'rtl') return span;
      rtlCursor -= span.advancePx;
      const shift = rtlCursor - span.x;
      return {
        ...span,
        x: rtlCursor,
        glyphs: span.glyphs.map((glyph) => ({ ...glyph, x: glyph.x + shift })),
      };
    });
    lines.push({
      x: clip.box.x + offset,
      y: cursorY,
      width,
      height,
      spans: positioned.map((span) => ({
        ...span,
        x: span.x + offset,
        glyphs: span.glyphs.map((glyph) => ({ ...glyph, x: glyph.x + offset })),
      })),
    });
    cursorY += height;
    current = [];
    width = 0;
    height = 0;
  };
  for (const paragraph of clip.paragraphs) {
    for (const run of paragraph.runs) {
      const style = portableTextStyle(run.style, paragraph.style, scale);
      for (const rawToken of runTokens(run)) {
        if (rawToken === '\n' || rawToken === '\r\n') {
          flush();
          continue;
        }
        const rawAdvance = tokenAdvance(rawToken, style, measurer);
        const tokens =
          rawToken.trim().length > 0 && rawAdvance > clip.box.width
            ? splitLongToken(rawToken, clip.box.width, style, measurer)
            : [rawToken];
        for (const token of tokens) {
          if (current.length === 0) {
            align = style.align;
            direction = style.direction;
          }
          const advance = tokens.length === 1 ? rawAdvance : tokenAdvance(token, style, measurer);
          if (width > 0 && width + advance > clip.box.width && token.trim().length > 0) flush();
          if (cursorY + Math.max(height, style.lineHeightPx) > clip.box.y + clip.box.height) {
            overflowed = true;
          }
          current.push(laidOutSpan(token, clip.box.x + width, cursorY, style, measurer));
          width += advance;
          height = Math.max(height, style.lineHeightPx);
        }
      }
    }
    flush();
  }
  if (clip.overflow === 'ellipsis' && overflowed) {
    const last = lines.findLast((line) => line.y + line.height <= clip.box.y + clip.box.height);
    if (last !== undefined && last.spans.length > 0) {
      const spans = last.spans.slice();
      const tail = spans.at(-1);
      if (tail !== undefined) {
        const replacement = laidOutSpan(`${tail.text.trimEnd()}…`, tail.x, tail.y, tail.style, measurer);
        spans[spans.length - 1] = replacement;
      }
      const index = lines.indexOf(last);
      lines.splice(index, lines.length - index, { ...last, spans });
    }
  }
  return {
    metricsId: measurer === undefined ? 'aelion-portable-text-metrics/1' : 'aelion-canvas-text-metrics/1',
    fontSizePx: 32 * scale,
    overflowed,
    lines,
  };
}

/** Line breaking used by Preview and Export, using OffscreenCanvas 2D `measureText` when available. */
export function layoutIrText(clip: IrTextClip, options: LayoutIrTextOptions = {}): IrTextLayout {
  const measurer = resolveTextMeasurer(options.measure);
  if (clip.writingMode !== 'horizontal-tb') {
    // Portable vertical fallback treats each grapheme as a line. It remains
    // deterministic and preserves content when native vertical shaping is unavailable.
    const vertical = {
      ...clip,
      paragraphs: clip.paragraphs.map((paragraph) => ({
        ...paragraph,
        runs: paragraph.runs.map((run) => ({ ...run, text: graphemes(run.text).join('\n') })),
      })),
    };
    return layoutAtScale(vertical, 1, measurer);
  }
  let result = layoutAtScale(clip, 1, measurer);
  if (clip.overflow !== 'auto-fit' || !result.overflowed) return result;
  let low = 0.25;
  let high = 1;
  for (let iteration = 0; iteration < 12; iteration++) {
    const middle = (low + high) / 2;
    const candidate = layoutAtScale(clip, middle, measurer);
    if (candidate.overflowed) high = middle;
    else {
      low = middle;
      result = candidate;
    }
  }
  return result;
}
