// Text handling shared by the memory index, recall and deduplication. Everything here is deterministic and
// runs the same in the desktop app and the headless CLI: the index written by one must be readable by the other.

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u;
// A CJK run, or a run of other letters and digits. Latin text is split here rather than by the segmenter, whose
// rules for strings like `kiro.rs` differ between Node and Electron builds.
const RUNS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}])+/gu;
const HAN_CHAR = /^\p{Script=Han}$/u;

// Function words that match almost everything. Single characters are listed separately because a run of them
// is indexed as bigrams as well.
const ZH_STOP_CHARS = new Set(
  '的了是在我你他她它们这那和与或就都也而及着过吗呢吧啊呀哦嘛把被给让从向对为以之其个一不有没很要会能可将还又再',
);
const ZH_STOP_WORDS = new Set(
  '我们 你们 他们 她们 它们 这个 那个 这些 那些 这里 那里 这样 那样 怎么 怎样 怎么样 什么 为什么 哪里 哪个 哪些 如何 是否 是不是 可以 可能 应该 需要 已经 还是 或者 因为 所以 但是 然后 如果 就是 一下 一些 一个 一直 现在 之前 之后 时候 上次 这次 一样 不是 没有 有没有 自己 大家 这种 那种 回事 东西 帮我 请问 谢谢 好的 知道 今天 明天 昨天 后天 今年 明年 去年 最近 刚才 不错 问题 情况 事情 一首 一篇 一段 一次 看看 看下 告诉 觉得 我写 给我 我的 你的 你好'.split(
    ' ',
  ),
);
const EN_STOP = new Set(
  'a an the and or but if then else of to in on at by for with from as is are was were be been being am do does did done doing have has had having i me my we our you your he him his she her it its they them their this that these those there here what which who whom whose why how when where can could should would will shall may might must not no yes so too very just also than into onto about over under again more most some any all each both few other such only own same s t don now please thanks ok okay let lets get got make made'.split(
    ' ',
  ),
);

function latinTokens(run: string, out: string[]) {
  const word = run.toLowerCase();
  if (word.length >= 2 && !EN_STOP.has(word)) out.push(word);
  // camelCase and digit boundaries: `historySearch` also yields `history` and `search`.
  const parts = run.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/);
  if (parts.length > 1)
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.length >= 2 && lower !== word && !EN_STOP.has(lower)) out.push(lower);
    }
}

function cjkTokens(run: string, out: string[]) {
  const words = [...segmenter.segment(run)].filter((part) => part.isWordLike).map((part) => part.segment);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!(HAN_CHAR.test(word) && word.length === 1)) {
      if (!ZH_STOP_WORDS.has(word)) out.push(word);
      continue;
    }
    // Characters the dictionary does not know come back one by one ("发｜版"). Their bigrams match the same text
    // on both sides of the index; non-stopword single characters stay searchable on their own.
    let end = i;
    while (end + 1 < words.length && words[end + 1].length === 1 && HAN_CHAR.test(words[end + 1])) end++;
    for (let k = i; k <= end; k++) {
      if (!ZH_STOP_CHARS.has(words[k])) out.push(words[k]);
      if (k < end && !ZH_STOP_WORDS.has(words[k] + words[k + 1])) out.push(words[k] + words[k + 1]);
    }
    i = end;
  }
}

/** Search terms of a text, in order, with repeats: what the memory index stores and what queries are made of. */
export function searchTokens(text: string, limit = 4000): string[] {
  const out: string[] = [];
  // Case is kept until the Latin split, which needs it to find camelCase boundaries.
  for (const [run] of text.normalize('NFKC').matchAll(RUNS)) {
    if (out.length >= limit) break;
    if (CJK_RUN.test(run[0])) cjkTokens(run, out);
    else latinTokens(run, out);
  }
  return out.slice(0, limit);
}

/** Distinct query terms, longest first within the limit, so a long question keeps its specific words. */
export function queryTokens(text: string, limit = 16): string[] {
  const seen = [...new Set(searchTokens(text.slice(0, 2000), 400))];
  if (seen.length <= limit) return seen;
  const keep = new Set([...seen].sort((a, b) => b.length - a.length).slice(0, limit));
  return seen.filter((token) => keep.has(token));
}

/** An FTS5 query matching any of the tokens. Each is quoted, so operators in user text are never parsed. */
export const anyOf = (tokens: string[]) => tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');

/** An FTS5 query matching only entries with every token. */
export const allOf = (tokens: string[]) => tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');

/** Tokens that identify something precisely: names with digits, paths, longer Latin words. */
export const identifierLike = (token: string) => /\d/.test(token) || /^[a-z][a-z0-9]{6,}$/.test(token);

// Near-duplicate detection works on character shingles of the text without spaces and punctuation, which
// treats Chinese and English the same way.
function shingles(text: string) {
  // Case stays: `/Reports` and `/reports` can be different things.
  const compact = text.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
  const size = compact.length < 6 ? 2 : 3,
    set = new Set<string>();
  if (compact.length <= size) {
    if (compact) set.add(compact);
    return set;
  }
  for (let i = 0; i + size <= compact.length; i++) set.add(compact.slice(i, i + size));
  return set;
}

/** Jaccard similarity of two texts' shingles, 0 to 1. */
export function similarity(a: string, b: string) {
  const left = shingles(a),
    right = shingles(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  return shared / (left.size + right.size - shared);
}

const SIGNATURE = 64;
// Fixed seeds keep signatures comparable across versions; changing them would orphan every stored tombstone.
const SEEDS = Array.from({ length: SIGNATURE }, (_, i) => [
  (Math.imul(i + 1, 0x9e3779b1) | 1) >>> 0,
  Math.imul(i + 7, 0x85ebca6b) >>> 0,
]);
function fnv(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A MinHash signature of the text. Stored for forgotten memories instead of their text: it still recognizes a
 * rewording of the same sentence, and the sentence cannot be read back from it.
 */
export function signature(text: string): Buffer {
  const values = new Uint32Array(SIGNATURE).fill(0xffffffff);
  for (const shingle of shingles(text)) {
    const base = fnv(shingle);
    for (let i = 0; i < SIGNATURE; i++) {
      const [a, b] = SEEDS[i],
        value = (Math.imul(base, a) + b) >>> 0;
      if (value < values[i]) values[i] = value;
    }
  }
  return Buffer.from(values.buffer);
}

/** Estimated Jaccard similarity of two signatures. */
export function signatureSimilarity(a: Uint8Array, b: Uint8Array) {
  const left = new Uint32Array(a.buffer, a.byteOffset, Math.floor(a.byteLength / 4)),
    right = new Uint32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
  const length = Math.min(left.length, right.length);
  if (!length) return 0;
  let same = 0;
  for (let i = 0; i < length; i++) if (left[i] === right[i]) same++;
  return same / length;
}
