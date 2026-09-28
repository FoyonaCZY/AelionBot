// A Bot's SOUL.md: free-form Markdown that defines its voice, values and boundaries, as in OpenClaw and Hermes Agent.
// It is stored verbatim; only the prompt copy drops YAML front matter and is bounded by the model's context window.

/** Storage limit. Matches OpenClaw's per-file bootstrap default and Hermes' context-file floor. */
export const SOUL_MAX_CHARS = 20000;

// Invisible characters used to hide text from a reviewer (zero-width space, bidi embeddings/overrides/isolates, BOM).
// ZWJ/ZWNJ and LRM/RLM stay: emoji sequences and right-to-left text need them.
const HIDDEN = /[\u200b\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const FRONT_MATTER = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/;

/** Validates a SOUL.md from the profile form or an imported file. Returns undefined when it cannot be stored. */
export function normalizeSoul(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.replace(/\r\n?/g, '\n').replace(HIDDEN, '').replace(CONTROL, '').trim();
  return text.length <= SOUL_MAX_CHARS ? text : undefined;
}

const frontMatter = (soul: string) => FRONT_MATTER.exec(soul)?.[0] || '';
const soulBody = (soul: string) => soul.slice(frontMatter(soul).length).trim();

// Prose paragraphs of the body with Markdown markup removed; headings, rules and HTML lines are dropped.
function proseParagraphs(soul: string) {
  const paragraphs: string[][] = [[]];
  for (const raw of soulBody(soul).split('\n')) {
    const line = raw
      .trim()
      .replace(/^(?:[>*+-]|\d+[.)])\s+/, '')
      .replace(/[*_`]+/g, '')
      .trim();
    if (!line || /^#|^[-*_=]{3,}$|^<\/?\w/.test(line)) {
      if (paragraphs.at(-1)!.length) paragraphs.push([]);
    } else paragraphs.at(-1)!.push(line);
  }
  return paragraphs.filter((lines) => lines.length).map((lines) => lines.join(' '));
}
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
};
const described = (soul: string) =>
  /^description:[ \t]*(.+)$/m
    .exec(frontMatter(soul))?.[1]
    ?.replace(/^(['"])(.*)\1$/, '$2')
    .trim();

/** One line for Bot lists: front matter `description`, else the first prose paragraph. */
export const soulSummary = (soul: string, max = 80) => clip(described(soul) || proseParagraphs(soul)[0] || '', max);

/** Longer plain-text excerpt so other Bots can judge who to delegate to. */
export const soulExcerpt = (soul: string, max = 500) =>
  clip([described(soul), ...proseParagraphs(soul)].filter(Boolean).join(' '), max);

/** Prompt budget in characters: 4k (the old role limit) on small windows, up to the full 20k on 80k+ windows. */
export const soulPromptBudget = (contextTokens?: number) =>
  Math.max(4000, Math.min(SOUL_MAX_CHARS, Math.floor((contextTokens || 32000) / 4)));

/** The SOUL text for the system prompt. Oversized souls keep 70% head and 20% tail, like Hermes context files. */
export function soulPromptText(soul: string, budget = SOUL_MAX_CHARS) {
  const body = soulBody(soul);
  if (body.length <= budget) return body;
  const head = Math.floor(budget * 0.7),
    tail = Math.floor(budget * 0.2);
  return (
    body.slice(0, head).trimEnd() +
    `\n\n[SOUL.md 超出当前模型的上下文预算，已省略中间部分：保留 ${head}+${tail} / ${body.length} 字符]\n\n` +
    body.slice(-tail).trimStart()
  );
}
