// Text to read aloud: a reply's Markdown reduced to what a person would say, in pieces a speech service takes.
import { visualsAsText } from '../chat/message-blocks';

/** Markdown as it reads: code and tables are named rather than spelled out, links read as their text. */
export function spokenText(markdown: string) {
  return (
    visualsAsText(markdown)
      .replace(/```[\s\S]*?(```|$)/g, '\n（代码略）\n')
      .replace(/<[^>\n]+>/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '（链接）')
      .replace(/`([^`\n]+)`/g, '$1')
      // A table is hard to follow by ear; its rows become plain lines.
      .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) =>
        row
          .split('|')
          .map((cell) => cell.trim())
          .join('，'),
      )
      .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/(\*\*|__|~~|\*)(?=\S)([^*~\n]+?)\1/g, '$2')
      .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * The text in pieces of at most `limit` characters, ending at a sentence where one fits, then at a comma, then
 * anywhere. The first piece is kept short so speech starts soon.
 */
export function speechChunks(text: string, limit: number, first = limit) {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest) {
    const size = chunks.length ? limit : Math.min(first, limit);
    if (rest.length <= size) {
      chunks.push(rest);
      break;
    }
    const window = rest.slice(0, size);
    const at = (pattern: RegExp) => {
      let found = -1;
      for (const match of window.matchAll(pattern)) found = match.index + match[0].length;
      return found > size / 3 ? found : -1;
    };
    const cut = [at(/[。！？!?…]+["”’」』)）]*|[.!?]+["”’)]*\s|\n+/g), at(/[，、；：,;:]\s*/g), at(/\s+/g)].find(
      (value) => value > 0,
    );
    const end = cut || size;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  return chunks.filter(Boolean);
}
