// Cuts a document's text into passages a search can return whole. Deterministic: the same text always gives the
// same passages, so an unchanged passage keeps its vector when its file is indexed again.
import { createHash } from 'node:crypto';

/** A stretch of a document's text and where it sits. */
export interface Section {
  /** The headings above it, outermost first. */
  heading: string[];
  /** Its page or slide, from 1. */
  page?: number;
  unit?: 'page' | 'slide';
  /** A place with a name instead of a number, already worded (a worksheet). Passages never span two of them. */
  label?: string;
  /** The line of the file its text starts at, from 1, for files read as lines. */
  line?: number;
  text: string;
}
export interface Chunk {
  heading: string;
  location: string;
  line?: number;
  text: string;
}
export interface ChunkOptions {
  /** The size a passage is filled to, in rough tokens. */
  target?: number;
  /** How much of the end of a passage the next one repeats. */
  overlap?: number;
  /** A passage this small does not end at a new heading or page; it takes what follows. */
  min?: number;
  maxChunks?: number;
}
/** The local embedding model reads the first 256 tokens; a passage is somewhat longer, so answers come with context. */
const TARGET = 360,
  OVERLAP = 40,
  MIN = 120,
  MAX_CHUNKS = 3000;

/** A rough token count: one per CJK character, one per 3.5 other characters. */
export function textWeight(text: string) {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff))
      cjk++;
  }
  return cjk + Math.ceil((text.length - cjk) / 3.5);
}
export const chunkHash = (heading: string, text: string) =>
  createHash('sha256')
    .update(heading + '\n' + text)
    .digest('hex')
    .slice(0, 32);
/** Text that reads like a credential is left out of the index. */
const looksSecret = (text: string) =>
  /\b(?:sk-[\w-]{20,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16})\b|BEGIN [A-Z ]*PRIVATE KEY/.test(text);

/** Line endings, control characters and runs of blank lines made plain; line numbers stay the file's own. */
const cleanText = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f﻿]/g, '')
    .replace(/[ \t]+$/gm, '');

interface Block {
  text: string;
  weight: number;
  section: number;
  line?: number;
  /** Repeated from the end of the previous passage. */
  carried?: boolean;
}
const SENTENCE_END = '。！？；';
function sentences(text: string) {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (
      ch === '\n' ||
      SENTENCE_END.includes(ch) ||
      ((ch === '.' || ch === '!' || ch === '?' || ch === ';') && (i + 1 >= text.length || /\s/.test(text[i + 1])))
    ) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}
/** A sentence longer than a passage is cut by size. */
function hardSplit(text: string, target: number) {
  const out: string[] = [];
  let start = 0,
    weight = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    weight += (code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) ? 1 : 1 / 3.5;
    // Never between the two halves of a surrogate pair.
    if (weight >= target && !(code >= 0xd800 && code <= 0xdbff)) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
      weight = 0;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}
const newlines = (text: string) => {
  let count = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
};
/** A paragraph too long for one passage, as pieces that end at sentences where they can. */
function splitLong(text: string, target: number, line: number | undefined) {
  const pieces: Array<{ text: string; line?: number }> = [];
  let current = '',
    currentLine = line,
    seen = 0;
  const flush = () => {
    if (current.trim()) pieces.push({ text: current.trim(), ...(currentLine ? { line: currentLine } : {}) });
    current = '';
  };
  for (const sentence of sentences(text)) {
    const parts = textWeight(sentence) > target ? hardSplit(sentence, target) : [sentence];
    for (const part of parts) {
      if (current && textWeight(current) + textWeight(part) > target) flush();
      if (!current) currentLine = line === undefined ? undefined : line + seen;
      current += part;
      seen += newlines(part);
    }
  }
  flush();
  return pieces;
}
/** Paragraphs of a section: runs of lines between blank ones, with a fenced code block kept together. */
function paragraphs(text: string, line: number | undefined) {
  const out: Array<{ text: string; line?: number }> = [],
    lines = text.split('\n');
  let buffer: string[] = [],
    start = 0,
    fence = '';
  const flush = () => {
    const value = buffer.join('\n').trim();
    if (value) out.push({ text: value, ...(line ? { line: line + start } : {}) });
    buffer = [];
  };
  lines.forEach((value, index) => {
    const mark = /^\s*(```+|~~~+)/.exec(value)?.[1];
    if (fence) {
      buffer.push(value);
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = '';
      return;
    }
    if (mark) {
      if (!buffer.length) start = index;
      buffer.push(value);
      fence = mark;
      return;
    }
    if (!value.trim()) return flush();
    if (!buffer.length) start = index;
    buffer.push(value);
  });
  flush();
  return out;
}
const place = (section: Section) =>
  `${section.heading.join('\u0000')}\u0001${section.label || ''}\u0001${section.page ?? ''}`;
function location(first: Section, last: Section) {
  if (first.label) return first.label;
  if (first.page === undefined) return '';
  const unit = first.unit === 'slide' ? ' 张幻灯片' : ' 页';
  return last.page !== undefined && last.page !== first.page
    ? `第 ${first.page}–${last.page}${unit}`
    : `第 ${first.page}${unit}`;
}

/** The passages of a document, in order. */
export function chunkSections(sections: Section[], options: ChunkOptions = {}): Chunk[] {
  const target = options.target ?? TARGET,
    overlap = options.overlap ?? OVERLAP,
    min = options.min ?? MIN,
    maxChunks = options.maxChunks ?? MAX_CHUNKS;
  const blocks: Block[] = [];
  sections.forEach((section, index) => {
    for (const paragraph of paragraphs(cleanText(section.text), section.line))
      for (const piece of textWeight(paragraph.text) > target
        ? splitLong(paragraph.text, target, paragraph.line)
        : [paragraph])
        if (!looksSecret(piece.text))
          blocks.push({
            text: piece.text,
            weight: textWeight(piece.text),
            section: index,
            ...(piece.line ? { line: piece.line } : {}),
          });
  });
  const chunks: Array<Chunk & { key: string; weight: number }> = [];
  let current: Block[] = [],
    weight = 0;
  const emit = () => {
    const own = current.filter((block) => !block.carried);
    if (!own.length) return;
    const first = sections[own[0].section],
      last = sections[own[own.length - 1].section],
      heading = first.heading.filter(Boolean).join(' › '),
      text = current.map((block) => block.text).join('\n\n'),
      ownWeight = own.reduce((sum, block) => sum + block.weight, 0),
      previous = chunks[chunks.length - 1];
    // A last scrap joins the passage before it rather than standing alone.
    if (previous && ownWeight < 30 && previous.key === place(first) && previous.weight + ownWeight <= target * 1.5) {
      previous.text += '\n\n' + own.map((block) => block.text).join('\n\n');
      previous.weight += ownWeight;
      return;
    }
    chunks.push({
      heading,
      location: location(first, last),
      ...(own[0].line ? { line: own[0].line } : {}),
      text,
      key: place(last),
      weight,
    });
  };
  /** The end of a passage the next one starts with: its last short paragraph, or its last sentences. */
  const tail = (): Block[] => {
    const last = current[current.length - 1];
    if (!last || overlap <= 0) return [];
    if (last.weight <= overlap) return [{ ...last, carried: true }];
    let text = '';
    for (const sentence of sentences(last.text).reverse()) {
      if (textWeight(sentence + text) > overlap) break;
      text = sentence + text;
    }
    text = text.trim();
    return text ? [{ text, weight: textWeight(text), section: last.section, carried: true }] : [];
  };
  for (const block of blocks) {
    if (chunks.length >= maxChunks) break;
    const previous = current[current.length - 1],
      moved = previous && place(sections[previous.section]) !== place(sections[block.section]),
      renamed = previous && (sections[previous.section].label || '') !== (sections[block.section].label || '');
    if (previous && (weight + block.weight > target || renamed || (moved && weight >= min))) {
      emit();
      current = moved ? [] : tail();
      weight = current.reduce((sum, item) => sum + item.weight, 0);
    }
    // A short section that joins the passage of the one before brings its heading along, as a line of its own.
    const last = current[current.length - 1],
      title = sections[block.section].heading.filter(Boolean).join(' › '),
      joins = last && title && title !== sections[last.section].heading.filter(Boolean).join(' › '),
      item = joins ? { ...block, text: `${title}\n${block.text}`, weight: block.weight + textWeight(title) } : block;
    current.push(item);
    weight += item.weight;
  }
  if (chunks.length < maxChunks) emit();
  return chunks.map(({ heading, location: where, line, text }) => ({
    heading,
    location: where,
    ...(line ? { line } : {}),
    text,
  }));
}

// ---------- Words for the index ----------
// Chinese is indexed by overlapping pairs of characters rather than by dictionary words: a segmenter cuts
// 「退货运费」 into 退 / 货运 / 费 in one sentence and 退货 / 运费 in another, and the two would never meet.

const RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+/gu;
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
function latinWords(run: string, out: string[]) {
  const word = run.toLowerCase();
  if (word.length >= 2) out.push(word);
  // `knowledgeSearch` and `v2beta` are found by their parts as well.
  const parts = run.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/);
  if (parts.length > 1)
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length >= 2 && lower !== word) out.push(lower);
    }
}
/** The terms a text is indexed under, in order and with repeats; joined by spaces they are the index column. */
export function indexTerms(text: string, limit = 8000): string[] {
  const out: string[] = [];
  for (const [run] of text.normalize('NFKC').matchAll(RUN)) {
    if (out.length >= limit) break;
    if (!CJK_START.test(run)) latinWords(run, out);
    else {
      const chars = [...run];
      if (chars.length === 1) out.push(run);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
    }
  }
  return out.length > limit ? out.slice(0, limit) : out;
}
/** Characters that only hold a sentence together; a pair with one of them says little about the subject. */
const GLUE = new Set('的了是在和与或就都也而及着过吗呢吧啊呀哦嘛把被给让从向对为以之其这那我你他她它们很还又再将');
const COMMON_PAIRS = new Set(
  '什么 怎么 怎样 如何 哪里 哪个 哪些 多少 时候 是否 为何 请问 一下 知道 告诉 可以 需要 应该 有没 没有 能否'.split(' '),
);
const COMMON_WORDS = new Set(
  'a an the and or of to in on at by for with from is are was were be been am do does did can could should would will shall may might i me my we our you your he she it its they them their this that these those what which who whom whose why how when where there here not no yes so if then than please'.split(
    ' ',
  ),
);
/** The distinct terms a question is searched by: the specific ones when it has any, all of them otherwise. */
export function queryTerms(query: string, limit = 32): string[] {
  const all = [...new Set(indexTerms(query.slice(0, 1000), 400))],
    specific = all.filter((term) =>
      CJK_START.test(term)
        ? [...term].length >= 2 && !COMMON_PAIRS.has(term) && ![...term].some((char) => GLUE.has(char))
        : !COMMON_WORDS.has(term),
    );
  return (specific.length ? specific : all).slice(0, limit);
}
