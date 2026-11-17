// Markdown for chat platforms that show their own subset: Telegram's HTML, Discord's Markdown and Slack's mrkdwn.
// Replies are split first and converted part by part, so a part never ends inside a tag.
import { plainText, splitText } from './format';

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
/** The row under a table's header: dashes in at least two cells, or in one cell between pipes. */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

/**
 * Splits Markdown into parts of at most `limit` characters like splitText. A cut inside a code block closes the
 * fence and opens it again in the next part, so each part is formatted on its own.
 */
export function splitMarkdown(text: string, limit: number) {
  let open: { marker: string; lang: string } | undefined;
  return splitText(text, Math.max(80, limit - 40)).map((part) => {
    const head = open ? `${open.marker}${open.lang}\n` : '';
    for (const line of part.split('\n')) {
      const fence = FENCE.exec(line);
      if (!fence) continue;
      if (!open) open = { marker: fence[1], lang: fence[2].slice(0, 20) };
      else if (fence[1][0] === open.marker[0] && fence[1].length >= open.marker.length && !fence[2]) open = undefined;
    }
    return head + part + (open ? '\n' + open.marker : '');
  });
}

type Block = { code: string; lang: string } | { table: string[] } | { lines: string[] };

/** Code blocks and tables apart from running text; none of these platforms draws a Markdown table. */
function blocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n'),
    result: Block[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) result.push({ lines: text });
    text = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const fence = FENCE.exec(lines[index]);
    if (fence) {
      flush();
      const body: string[] = [];
      for (index++; index < lines.length; index++) {
        const close = FENCE.exec(lines[index]);
        if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length && !close[2]) break;
        body.push(lines[index]);
      }
      result.push({ code: body.join('\n'), lang: fence[2] });
    } else if (lines[index].includes('|') && TABLE_RULE.test(lines[index + 1] ?? '')) {
      flush();
      const table = [lines[index]];
      for (index += 2; index < lines.length && lines[index].includes('|') && lines[index].trim(); index++)
        table.push(lines[index]);
      index--;
      result.push({ table });
    } else text.push(lines[index]);
  }
  flush();
  return result;
}

/** A table as aligned plain text for a monospaced block; wide characters count as two columns. */
function tableText(rows: string[]) {
  const width = (value: string) => Array.from(value).reduce((total, char) => total + (WIDE.test(char) ? 2 : 1), 0);
  const cells = rows.map((row) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => plainText(cell.trim())),
  );
  const widths: number[] = [];
  for (const row of cells) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] || 0, width(cell))));
  return cells
    .map((row) =>
      row
        .map((cell, index) => cell + ' '.repeat(widths[index] - width(cell)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

interface InlineStyle {
  escape(text: string): string;
  code(text: string): string;
  link(label: string, url: string): string;
  /** A bare address, which every platform links by itself. */
  url(url: string): string;
  bold: [string, string];
  italic: [string, string];
  strike: [string, string];
}

/**
 * Emphasis, code and links of one line in a platform's syntax. Finished pieces are held aside under placeholders,
 * so that a later rule does not read them again (an underscore in an address, a star the bold rule wrote).
 */
function inline(text: string, style: InlineStyle) {
  const held: string[] = [],
    hold = (value: string) => `\u0000${held.push(value) - 1}\u0000`,
    wrap = ([open, close]: [string, string], inner: string) => hold(open) + inner + hold(close);
  const marked = text
    .replace(/`([^`\n]+)`/g, (_match, code: string) => hold(style.code(code)))
    .replace(
      /!?\[([^\]\n]*)\]\(((?:https?:\/\/|mailto:)[^)\s]+)(?:\s+"[^"]*")?\)/g,
      (_match, label: string, url: string) => hold(style.link(label.replace(/[*_~]/g, '') || url, url)),
    )
    .replace(/https?:\/\/[^\s<>()\u0000]+/g, (url) => hold(style.url(url)));
  return style
    .escape(marked)
    .replace(/\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, (_match, inner: string) => wrap(style.bold, inner))
    .replace(
      /(^|[^\w_])__(?=\S)([^\n]+?)(?<=\S)__(?![\w_])/g,
      (_match, lead: string, inner: string) => lead + wrap(style.bold, inner),
    )
    .replace(
      /(^|[^*\w\\])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])/g,
      (_match, lead: string, inner: string) => lead + wrap(style.italic, inner),
    )
    .replace(
      /(^|[^\w_\\])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/g,
      (_match, lead: string, inner: string) => lead + wrap(style.italic, inner),
    )
    .replace(/~~(?=\S)([^\n]+?)(?<=\S)~~/g, (_match, inner: string) => wrap(style.strike, inner))
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => held[Number(index)]);
}

/** A line of running text: headings become bold, list markers become bullets. */
function line(text: string, style: InlineStyle) {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
  if (heading) return style.bold[0] + inline(heading[1].replace(/\*\*|__/g, ''), style) + style.bold[1];
  if (RULE.test(text)) return '———';
  const item = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/.exec(text);
  if (item) return item[1] + (item[2] ? (/x/i.test(item[2]) ? '☑ ' : '☐ ') : '• ') + inline(item[3], style);
  return inline(text, style);
}

/** The three characters Telegram's HTML and Slack's mrkdwn both read as markup. */
export const escapeMarkup = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = escapeMarkup;
const TELEGRAM: InlineStyle = {
  escape: html,
  code: (text) => `<code>${html(text)}</code>`,
  link: (label, url) => `<a href="${html(url).replace(/"/g, '&quot;')}">${html(label)}</a>`,
  url: html,
  bold: ['<b>', '</b>'],
  italic: ['<i>', '</i>'],
  strike: ['<s>', '</s>'],
};

/** Markdown as Telegram's HTML (parse_mode HTML): b, i, s, a, code, pre and blockquote; everything else escaped. */
export function telegramHtml(markdown: string) {
  const out: string[] = [];
  for (const block of blocks(markdown)) {
    if ('code' in block)
      out.push(
        /^[\w+#.-]+$/.test(block.lang)
          ? `<pre><code class="language-${block.lang}">${html(block.code)}</code></pre>`
          : `<pre>${html(block.code)}</pre>`,
      );
    else if ('table' in block) out.push(`<pre>${html(tableText(block.table))}</pre>`);
    else {
      let quote: string[] | undefined;
      const endQuote = () => {
        if (quote) out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
        quote = undefined;
      };
      for (const text of block.lines) {
        const quoted = /^\s{0,3}>\s?(.*)$/.exec(text);
        if (quoted) (quote ||= []).push(line(quoted[1], TELEGRAM));
        else {
          endQuote();
          out.push(line(text, TELEGRAM));
        }
      }
      endQuote();
    }
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Discord reads Markdown itself; only tables, images and the deeper headings need another form. */
export function discordMarkdown(markdown: string) {
  const out: string[] = [];
  for (const block of blocks(markdown)) {
    if ('code' in block) out.push('```' + block.lang + '\n' + block.code + '\n```');
    else if ('table' in block) out.push('```\n' + tableText(block.table) + '\n```');
    else
      for (const text of block.lines) {
        const heading = /^\s{0,3}#{4,6}\s+(.*?)\s*#*\s*$/.exec(text);
        out.push(
          heading
            ? `**${heading[1].replace(/\*\*|__/g, '')}**`
            : text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/g, (_match, label: string, url: string) =>
                label ? `[${label}](${url})` : url,
              ),
        );
      }
  }
  return out.join('\n').trim();
}

/** Marks where a mrkdwn emphasis starts and ends; Slack reads one only between spaces or punctuation. */
const OPEN = '\u0001',
  CLOSE = '\u0002';
const SLACK: InlineStyle = {
  escape: html,
  code: (text) => OPEN + '`' + html(text) + '`' + CLOSE,
  link: (label, url) => `<${html(url)}|${html(label).replace(/\|/g, '¦')}>`,
  url: (url) => `<${html(url)}>`,
  bold: [OPEN + '*', '*' + CLOSE],
  italic: [OPEN + '_', '_' + CLOSE],
  strike: [OPEN + '~', '~' + CLOSE],
};
/**
 * Slack shows `*bold*` only when the stars stand between spaces or punctuation, which Chinese text seldom gives
 * them: a space goes in where a letter touches the outside of an emphasis.
 */
function slackSpacing(text: string) {
  return text
    .replace(/([\p{L}\p{N}])\u0001/gu, '$1 ')
    .replace(/\u0002(?=[\p{L}\p{N}])/gu, ' ')
    .replace(/[\u0001\u0002]/g, '');
}

/** Markdown as Slack's mrkdwn: single stars for bold, underscores for italic, `<url|label>` links. */
export function slackMrkdwn(markdown: string) {
  const out: string[] = [];
  for (const block of blocks(markdown)) {
    if ('code' in block) out.push('```\n' + html(block.code) + '\n```');
    else if ('table' in block) out.push('```\n' + html(tableText(block.table)) + '\n```');
    else
      for (const text of block.lines) {
        const quoted = /^\s{0,3}>\s?(.*)$/.exec(text);
        out.push(slackSpacing(quoted ? '> ' + line(quoted[1], SLACK) : line(text, SLACK)));
      }
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What a person typed in Slack, without its escapes: `<url|label>` links, mentions and `&amp;`. */
export function slackPlain(text: string) {
  return text
    .replace(/<(https?:[^|>\s]+|mailto:[^|>\s]+)\|([^>]*)>/g, (_match, url: string, label: string) =>
      !label || label === url || label === url.replace(/^mailto:/, '')
        ? url.replace(/^mailto:/, '')
        : `${label} (${url})`,
    )
    .replace(/<(https?:[^|>\s]+)>/g, '$1')
    .replace(/<mailto:([^|>\s]+)>/g, '$1')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, name?: string) => '@' + (name || id))
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
