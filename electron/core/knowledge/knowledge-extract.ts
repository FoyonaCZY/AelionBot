// Reads the text of a document for the knowledge index: Markdown, plain text and code, HTML, PDF and Office files.
// Runs on the indexing thread (knowledge-worker.ts); nothing here may be imported by the main bundle, which would
// take the PDF reader with it.
import { isUtf8 } from 'node:buffer';
import { extname } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { Parser } from 'htmlparser2';
import { AppError } from '../../../shared/errors';
import type { Section } from './knowledge-text';

export type DocumentKind = 'markdown' | 'text' | 'html' | 'pdf' | 'docx' | 'pptx' | 'xlsx';
/** Reads a file the PDF reader ships with: a character map or a standard font's metrics. */
export type PdfAssetReader = (folder: 'cmaps' | 'standard_fonts', name: string) => Promise<Uint8Array>;
export interface ExtractOptions {
  pdfAssets?: PdfAssetReader;
  signal?: AbortSignal;
}

const MARKDOWN = new Set(['.md', '.markdown', '.mdx']);
const TEXT = new Set(
  (
    '.txt .text .rst .org .adoc .tex .csv .tsv .json .jsonl .yaml .yml .toml .ini .cfg .conf .xml .sql .sh .bash .zsh ' +
    '.fish .ps1 .bat .cmd .py .js .jsx .ts .tsx .mjs .cjs .java .kt .kts .go .rs .c .h .cpp .hpp .cc .cs .rb .php ' +
    '.swift .m .mm .scala .lua .r .pl .dart .vue .svelte .css .scss .less .gradle .properties .srt .vtt .proto .graphql'
  ).split(' '),
);
const SKIPPED_NAMES =
  /(?:^|[\\/])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|Cargo\.lock|poetry\.lock)$|\.min\.(?:js|css)$/i;
const MB = 1024 * 1024;
/** The largest file of each kind that is read. */
export const SIZE_LIMIT: Record<DocumentKind, number> = {
  markdown: 4 * MB,
  text: 2 * MB,
  html: 8 * MB,
  pdf: 64 * MB,
  docx: 32 * MB,
  pptx: 64 * MB,
  xlsx: 16 * MB,
};
/** The most text taken from one file. */
const TEXT_LIMIT = 4_000_000;
const PDF_PAGE_LIMIT = 3000;
const SHEET_ROW_LIMIT = 20000;

/** What a file is read as, or undefined for files the index leaves alone. */
export function documentKind(path: string): DocumentKind | undefined {
  if (SKIPPED_NAMES.test(path)) return undefined;
  const extension = extname(path).toLowerCase();
  if (MARKDOWN.has(extension)) return 'markdown';
  if (TEXT.has(extension)) return 'text';
  if (extension === '.html' || extension === '.htm') return 'html';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'docx';
  if (extension === '.pptx') return 'pptx';
  if (extension === '.xlsx') return 'xlsx';
  return undefined;
}

function decode(bytes: Buffer) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes.includes(0)) throw new AppError('knowledge.not_text', '不是文本文件');
  if (isUtf8(bytes)) return bytes.toString('utf8');
  // Older Chinese text files are GBK; GB18030 reads them and fails on anything else.
  try {
    return new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError('knowledge.encoding_unsupported', '无法识别文字编码');
  }
}

function markdownSections(text: string): Section[] {
  const sections: Section[] = [],
    lines = text.replace(/\r\n?/g, '\n').split('\n');
  let path: string[] = [],
    buffer: string[] = [],
    start = 1,
    fence = '';
  const flush = () => {
    if (buffer.some((line) => line.trim())) sections.push({ heading: [...path], line: start, text: buffer.join('\n') });
    buffer = [];
  };
  lines.forEach((line, index) => {
    const mark = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = '';
    } else if (mark) fence = mark;
    else {
      const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
      if (heading) {
        flush();
        const level = heading[1].length;
        path = path.slice(0, level - 1);
        path[level - 1] = heading[2].trim();
        start = index + 2;
        return;
      }
    }
    if (!buffer.length) start = index + 1;
    buffer.push(line);
  });
  flush();
  return sections.map((section) => ({ ...section, heading: [...section.heading].map((item) => item || '') }));
}

const HTML_SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'select', 'nav']);
const HTML_BLOCK = new Set(
  'p div section article header footer main aside blockquote pre ul ol table figure form fieldset details'.split(' '),
);
const HTML_LINE = new Set(['li', 'tr', 'dt', 'dd', 'br', 'hr', 'summary', 'figcaption', 'caption']);
function htmlSections(html: string): Section[] {
  const sections: Section[] = [];
  let path: string[] = [],
    buffer = '',
    skip = 0,
    pre = 0,
    level = 0,
    headingText = '',
    inTitle = false,
    title = '';
  const flush = () => {
    if (buffer.trim()) sections.push({ heading: [...path].map((item) => item || ''), text: buffer });
    buffer = '';
  };
  const parser = new Parser(
    {
      onopentag(name) {
        if (HTML_SKIP.has(name)) skip++;
        else if (skip) return;
        else if (name === 'title') inTitle = true;
        else if (/^h[1-6]$/.test(name)) {
          flush();
          level = Number(name[1]);
          headingText = '';
        } else if (name === 'pre') {
          pre++;
          buffer += '\n\n';
        } else if (HTML_BLOCK.has(name)) buffer += '\n\n';
        else if (HTML_LINE.has(name)) buffer += '\n';
        else if (name === 'td' || name === 'th') buffer += '\t';
      },
      ontext(value) {
        if (skip) return;
        if (inTitle) title += value;
        else if (level) headingText += value;
        else buffer += pre ? value : value.replace(/\s+/g, ' ');
      },
      onclosetag(name) {
        if (HTML_SKIP.has(name)) skip = Math.max(0, skip - 1);
        else if (skip) return;
        else if (name === 'title') inTitle = false;
        else if (/^h[1-6]$/.test(name) && level) {
          const text = headingText.replace(/\s+/g, ' ').trim();
          if (text) {
            path = path.slice(0, level - 1);
            path[level - 1] = text;
          }
          level = 0;
        } else if (name === 'pre') {
          pre = Math.max(0, pre - 1);
          buffer += '\n\n';
        } else if (HTML_BLOCK.has(name)) buffer += '\n\n';
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  flush();
  const name = title.replace(/\s+/g, ' ').trim();
  // A page without headings is known by its title.
  return name
    ? sections.map((section) => (section.heading.some(Boolean) ? section : { ...section, heading: [name] }))
    : sections;
}

const XML_ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (value: string) =>
  value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity[0] !== '#') return XML_ENTITY[entity] ?? whole;
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
const attribute = (attributes: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];
function archive(bytes: Buffer, wanted: (name: string) => boolean) {
  try {
    // Only the wanted parts are inflated, and none beyond what a text part can reasonably be.
    return unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
      filter: (file) => wanted(file.name) && file.originalSize <= 256 * MB,
    });
  } catch {
    throw new AppError('knowledge.file_damaged', '文件已损坏或不是有效的 Office 文档');
  }
}
const part = (files: Record<string, Uint8Array>, name: string) => (files[name] ? strFromU8(files[name]) : '');
/** Relationship targets of a part, by ID, relative to the folder of the part they belong to. */
function relationships(xml: string) {
  const map = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attribute(match[1], 'Id'),
      target = attribute(match[1], 'Target');
    if (id && target) map.set(id, target.replace(/^\//, ''));
  }
  return map;
}

function docxSections(bytes: Buffer): Section[] {
  const files = archive(bytes, (name) => name === 'word/document.xml' || name === 'word/styles.xml'),
    xml = part(files, 'word/document.xml');
  if (!xml) throw new AppError('knowledge.file_damaged', '文件已损坏或不是有效的 Office 文档');
  // Heading styles are known by name; their IDs differ by language ("Heading1", "1", "berschrift1").
  const levels = new Map<string, number>();
  for (const match of part(files, 'word/styles.xml').matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const id = attribute(match[1], 'w:styleId'),
      name = /<w:name\b[^>]*w:val="([^"]*)"/.exec(match[2])?.[1] || '',
      level = /^(?:heading|标题)\s*([1-6])$/i.exec(name)?.[1];
    if (id && level) levels.set(id, Number(level));
    else if (id && /^title$/i.test(name)) levels.set(id, 1);
  }
  const sections: Section[] = [];
  let path: string[] = [],
    buffer: string[] = [],
    paragraph = '',
    style = '',
    inText = false,
    cell: string[] | undefined,
    row: string[] | undefined;
  const flush = () => {
    if (buffer.some((line) => line.trim()))
      sections.push({ heading: [...path].map((item) => item || ''), text: buffer.join('\n\n') });
    buffer = [];
  };
  const endParagraph = () => {
    const text = paragraph.trim(),
      level = levels.get(style) ?? (/^heading\s*([1-6])$/i.exec(style) ? Number(/([1-6])$/.exec(style)![1]) : 0);
    paragraph = '';
    style = '';
    if (!text) return;
    if (cell) return void cell.push(text);
    if (level) {
      flush();
      path = path.slice(0, level - 1);
      path[level - 1] = text;
    } else buffer.push(text);
  };
  for (const match of xml.matchAll(/<(\/?)w:(p|tc|tr|t|tab|br|cr|pStyle)\b([^>]*)>|([^<]+)/g)) {
    const [, closing, tag, attributes = '', text] = match;
    if (text !== undefined) {
      if (inText) paragraph += xmlText(text);
      continue;
    }
    const selfClosing = attributes.endsWith('/');
    if (tag === 't') inText = !closing && !selfClosing;
    else if (tag === 'tab') paragraph += '\t';
    else if (tag === 'br' || tag === 'cr') paragraph += '\n';
    else if (tag === 'pStyle') style = attribute(attributes, 'w:val') || '';
    else if (tag === 'p') {
      if (closing || selfClosing) endParagraph();
    } else if (tag === 'tc') {
      if (!closing) cell = [];
      else {
        (row ||= []).push((cell || []).join(' '));
        cell = undefined;
      }
    } else if (tag === 'tr' && closing) {
      if (row?.some(Boolean)) buffer.push(row.join(' | '));
      row = undefined;
    }
  }
  flush();
  return sections;
}

function pptxSections(bytes: Buffer): Section[] {
  const files = archive(
      bytes,
      (name) =>
        /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
        name === 'ppt/presentation.xml' ||
        name === 'ppt/_rels/presentation.xml.rels',
    ),
    targets = relationships(part(files, 'ppt/_rels/presentation.xml.rels'));
  // The order slides are shown in is the presentation's list, not their file numbers.
  let order = [...part(files, 'ppt/presentation.xml').matchAll(/<p:sldId\b([^>]*)\/?>/g)]
    .map((match) => targets.get(attribute(match[1], 'r:id') || ''))
    .filter((target): target is string => Boolean(target))
    .map((target) => 'ppt/' + target.replace(/^\.\.\//, ''))
    .filter((name) => files[name]);
  if (!order.length)
    order = Object.keys(files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const sections: Section[] = [];
  order.forEach((name, index) => {
    const lines: string[] = [];
    for (const paragraph of part(files, name).matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)) {
      const text = [...paragraph[1].matchAll(/<a:t\b[^>]*>([^<]*)<\/a:t>|<a:br\b[^>]*\/?>/g)]
        .map((run) => (run[1] === undefined ? '\n' : xmlText(run[1])))
        .join('')
        .trim();
      if (text) lines.push(text);
    }
    if (lines.length) sections.push({ heading: [], page: index + 1, unit: 'slide', text: lines.join('\n') });
  });
  return sections;
}

function xlsxSections(bytes: Buffer): Section[] {
  const files = archive(
      bytes,
      (name) =>
        name === 'xl/workbook.xml' ||
        name === 'xl/_rels/workbook.xml.rels' ||
        name === 'xl/sharedStrings.xml' ||
        /^xl\/worksheets\/[^/]+\.xml$/.test(name),
    ),
    targets = relationships(part(files, 'xl/_rels/workbook.xml.rels'));
  const shared = [...part(files, 'xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
    // Phonetic guides (rPh) repeat the text in kana; they are not part of the value.
    [...item[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)]
      .map((run) => xmlText(run[1]))
      .join(''),
  );
  const sections: Section[] = [];
  for (const sheet of part(files, 'xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = xmlText(attribute(sheet[1], 'name') || ''),
      target = targets.get(attribute(sheet[1], 'r:id') || ''),
      xml = target ? part(files, 'xl/' + target.replace(/^\.\.\//, '')) : '';
    if (!xml) continue;
    const lines: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (lines.length >= SHEET_ROW_LIMIT) break;
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attribute(cell[1], 't'),
          body = cell[2] || '',
          raw = /<v\b[^>]*>([^<]*)<\/v>/.exec(body)?.[1];
        const value =
          type === 's'
            ? shared[Number(raw)] || ''
            : type === 'inlineStr'
              ? [...body.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((run) => xmlText(run[1])).join('')
              : xmlText(raw || '');
        if (value.trim()) cells.push(value.trim().replace(/\s*\n\s*/g, ' '));
      }
      if (cells.length) lines.push(cells.join(' | '));
    }
    if (lines.length) sections.push({ heading: [name], label: `工作表「${name}」`, text: lines.join('\n') });
  }
  return sections;
}

const CJK_CHAR = /[　-鿿＀-￯]/;
/** Lines of one paragraph of a PDF page, joined the way they read: no space inside Chinese, one between words. */
function joinLines(lines: string[]) {
  let text = '';
  for (const line of lines) {
    const next = line.trim();
    if (!next) continue;
    if (!text) text = next;
    else if (CJK_CHAR.test(text[text.length - 1]) && CJK_CHAR.test(next[0])) text += next;
    else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(next)) text = text.slice(0, -1) + next;
    else text += ' ' + next;
  }
  return text;
}
/** The PDF reader, loaded when the first PDF comes up. */
async function pdfReader() {
  // As it loads outside a browser it warns that it cannot draw; drawing is not asked of it.
  const warn = console.warn;
  console.warn = () => {};
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const scope = globalThis as { pdfjsWorker?: unknown };
    // Without this the reader would look for its parser as a separate file next to itself, which a bundle has not.
    // @ts-expect-error The parser module ships without type declarations.
    scope.pdfjsWorker ||= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    return pdfjs;
  } finally {
    console.warn = warn;
  }
}
async function pdfSections(bytes: Buffer, options: ExtractOptions): Promise<Section[]> {
  const pdfjs = await pdfReader();
  const assets = options.pdfAssets;
  class Assets {
    async fetch({ kind, filename }: { kind: string; filename: string }) {
      if (!assets) throw new Error('unavailable');
      return assets(kind === 'cMapUrl' ? 'cmaps' : 'standard_fonts', filename);
    }
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'standard_fonts/',
    BinaryDataFactory: Assets,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    if ((error as { name?: string }).name === 'PasswordException')
      throw new AppError('knowledge.pdf_password', 'PDF 有密码，无法读取');
    throw new AppError(
      'knowledge.file_damaged',
      'PDF 无法读取：' + String((error as Error).message || error).slice(0, 120),
    );
  }
  try {
    const sections: Section[] = [];
    let total = 0;
    for (let number = 1; number <= Math.min(document.numPages, PDF_PAGE_LIMIT); number++) {
      options.signal?.throwIfAborted();
      const page = await document.getPage(number),
        content = await page.getTextContent();
      const paragraphs: string[][] = [[]];
      let line = '',
        lineY: number | undefined,
        lineHeight = 0,
        previousY: number | undefined,
        previousHeight = 0;
      const endLine = () => {
        if (line.trim()) {
          // A gap of well over a line between two lines starts a new paragraph.
          if (
            previousY !== undefined &&
            lineY !== undefined &&
            Math.abs(previousY - lineY) > 1.9 * Math.max(lineHeight, previousHeight, 1)
          )
            paragraphs.push([]);
          paragraphs[paragraphs.length - 1].push(line);
          previousY = lineY;
          previousHeight = lineHeight;
        }
        line = '';
        lineY = undefined;
        lineHeight = 0;
      };
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str) {
          lineY ??= Number(item.transform[5]);
          lineHeight = Math.max(lineHeight, Number(item.height) || 0);
          line += item.str;
        }
        if (item.hasEOL) endLine();
      }
      endLine();
      page.cleanup();
      const text = paragraphs.map(joinLines).filter(Boolean).join('\n\n');
      if (text) {
        sections.push({ heading: [], page: number, unit: 'page', text });
        total += text.length;
        if (total > TEXT_LIMIT) break;
      }
    }
    return sections;
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** The text of a document, in the order it reads, with the headings and pages it sits under. */
export async function extractSections(
  kind: DocumentKind,
  bytes: Buffer,
  options: ExtractOptions = {},
): Promise<Section[]> {
  const sections =
    kind === 'markdown'
      ? markdownSections(decode(bytes))
      : kind === 'text'
        ? [{ heading: [], line: 1, text: decode(bytes) }]
        : kind === 'html'
          ? htmlSections(decode(bytes))
          : kind === 'docx'
            ? docxSections(bytes)
            : kind === 'pptx'
              ? pptxSections(bytes)
              : kind === 'xlsx'
                ? xlsxSections(bytes)
                : await pdfSections(bytes, options);
  let total = 0;
  const kept: Section[] = [];
  for (const section of sections) {
    if (total >= TEXT_LIMIT) break;
    const text = section.text.slice(0, TEXT_LIMIT - total);
    total += text.length;
    kept.push({ ...section, text });
  }
  return kept;
}
