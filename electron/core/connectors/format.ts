// Text for IM platforms: Markdown subsets, length limits and short summaries of approval requests.
import type { HostPermissionDetails } from '../../../shared/types/core';
import { readableContent } from '../../../shared/chat/activity';
import { stripBlockMarkers, visualsAsText } from '../../../shared/chat/message-blocks';

/** Finds where to cut `text` so the prefix fits within `limit` characters (or UTF-8 bytes with `bytes`). */
export function splitCut(text: string, limit: number, bytes = false) {
  const size = (value: string) => (bytes ? Buffer.byteLength(value, 'utf8') : value.length);
  if (size(text) <= limit) return text.length;
  let cut = 0,
    used = 0;
  for (const char of text) {
    const next = used + size(char);
    if (next > limit) break;
    used = next;
    cut += char.length;
  }
  const head = text.slice(0, cut),
    paragraph = head.lastIndexOf('\n\n'),
    line = head.lastIndexOf('\n');
  return paragraph > cut / 2 ? paragraph : line > cut / 2 ? line : Math.max(1, cut);
}

/** Splits text into parts of at most `limit` units (characters, or UTF-8 bytes with `bytes`), at paragraph or line ends where it can. */
export function splitText(text: string, limit: number, bytes = false) {
  const size = (value: string) => (bytes ? Buffer.byteLength(value, 'utf8') : value.length);
  const parts: string[] = [];
  let rest = text.trim();
  while (rest && size(rest) > limit) {
    const end = splitCut(rest, limit, bytes);
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

const UNCLOSED_VISUAL_FENCE =
  /(?:^|\n)[ \t]*```(?:widget|chart|metrics|table|timeline|callout|calculator)[ \t]*(?:\n[\s\S]*)?$/;

/** Cleans a finalized assistant message for IM: strips reasoning tags and block markers, turns visual fences into text. */
export function connectorText(content: string) {
  return visualsAsText(stripBlockMarkers(readableContent(content))).trim();
}

/** Cleans a live streaming reply for IM: converts finished visual fences and hides an unclosed visual fence tail. */
export function connectorStreamingText(content: string) {
  return visualsAsText(stripBlockMarkers(content)).replace(UNCLOSED_VISUAL_FENCE, '').trim();
}

/** Plain text for platforms that show no Markdown (WeChat). */
export function plainText(markdown: string) {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_match, label: string, url: string) =>
      label === url ? url : `${label}（${url}）`,
    )
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const clip = (value: string, max: number) => {
  const chars = Array.from(value.trim());
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('');
};

const OPERATIONS: Record<HostPermissionDetails['operation'], string> = {
  command: '运行命令',
  read_file: '读取文件',
  write_file: '写入文件',
  delete_file: '删除文件',
  mcp: '调用 MCP 工具',
};

/** What a permission request asks for, in a few short lines. */
export function permissionSummary(details: HostPermissionDetails) {
  const lines = [OPERATIONS[details.operation] || '本机操作'];
  if (details.command) lines.push('命令：' + clip(details.command, 600));
  if (details.cwd) lines.push('目录：' + details.cwd);
  if (details.path) lines.push('路径：' + details.path);
  if (details.server || details.tool)
    lines.push(`工具：${details.server || ''}${details.tool ? ' · ' + details.tool : ''}`);
  if (details.reason) lines.push('原因：' + clip(details.reason, 300));
  return lines;
}
