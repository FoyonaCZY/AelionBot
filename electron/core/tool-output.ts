// Tool results reach the model inside a JSON envelope. When a result is too
// large, keep its structure and every scalar field (exitCode, sha256, eof,
// nextOffset…) and shorten only long strings from the middle, so failures at
// the end of a log and status fields are never cut off. The full result stays
// on disk and can be paged with read_result.

// Scale the inline budget with the model window instead of a fixed 7000 chars.
export function toolResultLimit(contextTokens: number) {
  return Math.max(6000, Math.min(24000, Math.floor((Number(contextTokens) || 0) * 0.1)));
}
// Default page size for file and result reads so a default page fits inline, JSON escaping included.
export function readPageLimit(contextTokens: number) {
  return Math.max(2000, Math.min(12000, Math.floor((toolResultLimit(contextTokens) - 1500) * 0.85)));
}

const TAIL_KEYS = /^(stdout|stderr|output|log|logs|error|errors|trace|traceback)$/i;
const size = (value: unknown) => JSON.stringify(value)?.length ?? 4;
function clip(text: string, limit: number, key?: string) {
  if (text.length <= limit) return text;
  const marker = (omitted: number) => `\n…[省略中间 ${omitted} 字符；完整内容用 read_result 读取]…\n`;
  const room = Math.max(0, limit - marker(text.length).length),
    headShare = key && TAIL_KEYS.test(key) ? 0.4 : 0.7;
  let head = Math.floor(room * headShare),
    tail = room - head;
  // Do not split a surrogate pair at either edge.
  if (head > 0 && /[\uD800-\uDBFF]/.test(text[head - 1])) head--;
  if (tail > 0 && /[\uDC00-\uDFFF]/.test(text[text.length - tail])) tail--;
  return text.slice(0, head) + marker(text.length - head - tail) + (tail ? text.slice(-tail) : '');
}
function mapStrings(value: unknown, limit: number, key?: string): unknown {
  if (typeof value === 'string') return clip(value, limit, key);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, limit, key));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapStrings(item, limit, name)]));
  return value;
}
function longestString(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((max: number, item) => Math.max(max, longestString(item)), 0);
  if (value && typeof value === 'object')
    return Object.values(value).reduce((max: number, item) => Math.max(max, longestString(item)), 0);
  return 0;
}
function longestArray(value: unknown): number {
  if (Array.isArray(value)) return Math.max(value.length, ...value.map(longestArray));
  if (value && typeof value === 'object') return Math.max(0, ...Object.values(value).map(longestArray));
  return 0;
}
function limitArrays(value: unknown, items: number): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => limitArrays(item, items));
    return value.length > items ? [...kept, `…[省略 ${value.length - items} 项；完整内容用 read_result 读取]`] : kept;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, limitArrays(item, items)]));
  return value;
}
// Largest integer in [low, high] for which fits() holds, assuming monotonicity; low is returned when nothing fits.
function largest(low: number, high: number, fits: (value: number) => boolean) {
  let best = low;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) {
      best = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}
export function compactToolResult(
  value: unknown,
  limit: number,
): { value: unknown; truncated: boolean; originalChars: number } {
  const originalChars = size(value);
  if (originalChars <= limit) return { value, truncated: false, originalChars };
  // No single string can be shown beyond the whole budget; this also bounds the search below.
  let current = mapStrings(value, limit);
  if (size(current) > limit) {
    const cap = largest(120, Math.min(limit, longestString(current)), (cap) => size(mapStrings(current, cap)) <= limit);
    current = mapStrings(current, cap);
  }
  if (size(current) > limit) {
    const items = largest(1, longestArray(current), (items) => size(limitArrays(current, items)) <= limit);
    current = limitArrays(current, items);
  }
  if (size(current) > limit) {
    const text = JSON.stringify(current);
    current = { preview: clip(text, limit - 200) };
  }
  return { value: current, truncated: true, originalChars };
}
// The envelope stays parseable by every consumer that reads `.result`.
export function toolResultEnvelope(executionId: string, resultId: string, output: unknown, limit: number) {
  const compact = compactToolResult(output ?? null, limit);
  return compact.truncated
    ? JSON.stringify({
        executionId,
        resultId,
        truncated: true,
        originalChars: compact.originalChars,
        readWith: 'read_result',
        result: compact.value,
      })
    : JSON.stringify({ executionId, resultId, result: output });
}
