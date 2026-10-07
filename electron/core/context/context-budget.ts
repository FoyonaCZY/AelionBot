import { TokenCountCache } from './token-count-cache';
import { createHash, type Hash } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { visibleImages } from '../../../shared/chat/model-images';
import type { WireMessage } from '../../../shared/types/core';
import type { ToolDefinition } from '../model/model';

const encoding = getEncoding('o200k_base');
// Provider usage still calibrates this unchanged tokenizer's exact local count. Room for every text of a few long
// conversations: a count evicted here is counted again on the thread that also delivers input.
const cache = new TokenCountCache((text) => encoding.encode(text, [], []).length, 131072);
export const textTokens = (text: string) => cache.count(text);
/** The texts a message is counted by: its content, its tool calls and its provider-native form. */
const messageTexts = (message: WireMessage) =>
  [
    message.content || '',
    message.tool_calls ? JSON.stringify(message.tool_calls) : '',
    message.native ? JSON.stringify(message.native.data) : '',
  ] as const;
// Conversation entries are replaced, never edited in place (the state database relies on that as well), so a result
// worked out for an entry is kept on the entry, checked against the fields it came from. Each estimate visits every
// entry of a long conversation; this spares it hashing (and serializing) megabytes of text again.
type EntryFields = { content: unknown; calls: unknown; native: unknown; images: unknown };
const fieldsOf = (message: WireMessage): EntryFields => ({
  content: message.content,
  calls: message.tool_calls,
  native: message.native,
  images: message.images,
});
const sameFields = (a: EntryFields, message: WireMessage) =>
  a.content === message.content &&
  a.calls === message.tool_calls &&
  a.native === message.native &&
  a.images === message.images;
const entryTokens = new WeakMap<WireMessage, EntryFields & { tokens: number }>();
const knownTokens = (message: WireMessage) => {
  const entry = entryTokens.get(message);
  return entry && sameFields(entry, message) ? entry.tokens : undefined;
};
export function messageTokens(message: WireMessage) {
  const known = knownTokens(message);
  if (known !== undefined) return known;
  const [content, calls, native] = messageTexts(message),
    tokens = 5 + Math.max(textTokens(content) + textTokens(calls), textTokens(native));
  entryTokens.set(message, { ...fieldsOf(message), tokens });
  return tokens;
}
/** The texts that estimating `messages` and `texts` would count, that have no count yet (see primeTokenCounts). */
export const uncountedTexts = (messages: WireMessage[], texts: string[] = []) =>
  cache.unknown([...messages.filter((message) => knownTokens(message) === undefined).flatMap(messageTexts), ...texts]);
/** The texts tool definitions are counted by: the whole schema, and each tool for the context overview. */
export const toolTexts = (tools: ToolDefinition[]) => [
  JSON.stringify(tools),
  ...tools.map((tool) => JSON.stringify(tool)),
];
/** Stores counts made on another thread, so counting these texts here is a lookup. */
export function rememberTokenCounts(entries: { key: string }[], counts: number[]) {
  entries.forEach((entry, index) => cache.remember(entry.key, counts[index]));
}
export function estimateRequest(messages: WireMessage[], tools: ToolDefinition[], calibration = 1) {
  const text = messages.reduce((total, message) => total + messageTokens(message), 3),
    schema = textTokens(JSON.stringify(tools));
  const images = visibleImages(messages);
  // Vision token accounting varies by provider. Keep an explicit reserve instead of counting IDs as pixels.
  const vision = images.reduce(
    (sum, image) => sum + Math.max(1024, Math.ceil(image.width / 768) * Math.ceil(image.height / 768) * 1024),
    0,
  );
  return {
    tokens: Math.ceil((text + schema + vision) * Math.max(1, calibration)),
    textTokens: text,
    toolTokens: schema,
    imageTokens: vision,
    calibration: Math.max(1, calibration),
  };
}
const DEFAULT_COMPACT_PERCENT = 85;
export function contextBudget(capacity: number, compactPercent = DEFAULT_COMPACT_PERCENT) {
  // Large windows reserve up to 8k so a turn just below the trigger still has room for reasoning and a sizeable patch.
  const output = capacity >= 160000 ? 8192 : Math.min(4096, Math.max(1024, Math.floor(capacity * 0.2))),
    safety = Math.max(768, Math.min(8192, Math.floor(capacity * 0.08)));
  const input = capacity - output - safety;
  const headroom = Math.max(512, Math.min(8192, Math.floor(input * 0.03)));
  // The verbatim tail and the summary grow with very large windows instead of collapsing a 1M context to ~30k.
  const tail = Math.max(1200, Math.min(Math.floor(input * 0.3), Math.max(24000, Math.floor(input * 0.12)))),
    summary = Math.max(
      Math.min(3000, Math.max(600, Math.floor(input * 0.12))),
      Math.min(8000, Math.floor(input * 0.03)),
    );
  // Compact before the window is nearly full: quality degrades well before the limit, and the summary call needs room.
  const trigger = Math.min(input - headroom, Math.floor((capacity * Math.max(50, Math.min(95, compactPercent))) / 100));
  // The summary call may spend part of its output on reasoning, so it gets its own larger allowance.
  const compaction = Math.max(output, Math.min(32000, summary * 2 + 2048, Math.floor(capacity * 0.25)));
  return { capacity, output, safety, input, trigger, tail, summary, compaction };
}
export interface Exchange {
  start: number;
  end: number;
  tokens: number;
  complete: boolean;
}
export function exchanges(history: WireMessage[], from = 0): Exchange[] {
  const groups: Exchange[] = [];
  for (let i = from; i < history.length;) {
    const start = i,
      message = history[i++];
    let complete = true;
    if (message.tool_calls?.length) {
      const pending = new Set(message.tool_calls.map((call) => call.id));
      while (i < history.length && history[i].role === 'tool') {
        pending.delete(history[i].tool_call_id || '');
        i++;
      }
      while (i < history.length && history[i].role === 'user' && history[i].images?.length) i++;
      complete = pending.size === 0;
    } else if (message.role === 'tool') complete = false;
    groups.push({
      start,
      end: i,
      tokens: history.slice(start, i).reduce((sum, item) => sum + messageTokens(item), 0),
      complete,
    });
  }
  return groups;
}
export function tailBoundary(history: WireMessage[], from: number, budget: number) {
  const groups = exchanges(history, from);
  if (groups.length < 4) return from;
  let count = 0,
    total = 0,
    boundary = history.length;
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (count >= 2 && total + group.tokens > budget) break;
    boundary = group.start;
    total += group.tokens;
    count++;
  }
  if (groups.some((group) => group.end <= boundary && !group.complete)) return from;
  return boundary;
}
export function resultDigest(content: string, limit = 900) {
  let value: any;
  try {
    const parsed = JSON.parse(content);
    value = parsed.result ?? parsed;
  } catch {
    return excerpt(content, limit);
  }
  let resultId: string | undefined;
  try {
    resultId = JSON.parse(content).resultId;
  } catch {}
  const result: Record<string, unknown> = {
    archived: true,
    ...(resultId ? { resultId, readWith: 'read_result' } : {}),
  };
  for (const key of [
    'exitCode',
    'isError',
    'error',
    'path',
    'vmPath',
    'saved',
    'name',
    'tool',
    'durationMs',
    'location',
  ])
    if (value?.[key] !== undefined)
      result[key] = typeof value[key] === 'string' ? excerpt(value[key], 300) : value[key];
  if (value?.stderr) result.stderr = excerpt(String(value.stderr), 500);
  const text = value?.stdout ?? value?.content ?? value?.preview;
  if (text) result.preview = excerpt(typeof text === 'string' ? text : JSON.stringify(text), limit);
  if (Array.isArray(value)) result.items = value.length;
  if (Array.isArray(value?.files)) result.files = value.files.slice(0, 8);
  return JSON.stringify(result);
}
export function excerpt(text: string, limit: number) {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.65);
  return `${text.slice(0, head)}\n[…内容已外置，可回查原记录…]\n${text.slice(-(limit - head))}`;
}
export function pruneToolOutputs(
  history: WireMessage[],
  protectedFrom: number,
  archivedOnly = false,
  skipIndices?: ReadonlySet<number>,
) {
  const view = history.map((message) => ({ ...message }));
  let pruned = 0;
  for (let i = 0; i < protectedFrom; i++)
    if (!skipIndices?.has(i) && view[i].role === 'tool' && textTokens(view[i].content || '') > 350) {
      if (archivedOnly) {
        try {
          if (typeof JSON.parse(view[i].content || '').resultId !== 'string') continue;
        } catch {
          continue;
        }
      }
      const digest = resultDigest(view[i].content || '');
      if (digest.length < (view[i].content?.length || 0)) {
        view[i].content = digest;
        pruned++;
      }
    }
  return { messages: view, pruned };
}
export function sourceHash(messages: WireMessage[]) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex');
}
const entryHashes = new WeakMap<WireMessage, EntryFields & { hash: string }>();
/** sourceHash([message]), kept on the message (see entryTokens). */
export function messageSourceHash(message: WireMessage) {
  const entry = entryHashes.get(message);
  if (entry && sameFields(entry, message)) return entry.hash;
  const hash = sourceHash([message]);
  entryHashes.set(message, { ...fieldsOf(message), hash });
  return hash;
}
const prefixHashes = new WeakMap<WireMessage[], { entries: WireMessage[]; hash: Hash }>();
/**
 * sourceHash(history.slice(0, length)) of a history that grows by appending: the hash state after the entries seen so
 * far is kept and carried forward, so each call serializes only new entries. Any earlier entry replaced starts over.
 */
export function historySourceHash(history: WireMessage[], length = history.length) {
  let state = prefixHashes.get(history);
  if (!state || state.entries.length > length || state.entries.some((entry, index) => entry !== history[index]))
    state = { entries: [], hash: createHash('sha256').update('[') };
  for (let index = state.entries.length; index < length; index++) {
    state.hash.update((index ? ',' : '') + JSON.stringify(history[index]));
    state.entries.push(history[index]);
  }
  prefixHashes.set(history, state);
  return state.hash.copy().update(']').digest('hex');
}
export function serializeForSummary(history: WireMessage[], maxTokens: number) {
  let limit = 1800;
  const serialize = () =>
    history.map((message, index) => ({
      index,
      role: message.role,
      text: excerpt(message.content || '', limit),
      ...(message.tool_calls
        ? {
            tools: message.tool_calls.map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: excerpt(call.function.arguments, limit),
            })),
          }
        : {}),
      ...(message.images?.length ? { images: message.images.map((image) => image.id) } : {}),
    }));
  // Counted item by item, so an item that did not change between attempts is a cache lookup, and only until the
  // budget is exceeded: a long history is far over it, and counting all of it (megabytes) took tens of seconds.
  // Joined items can only share tokens at their seams, so the sum (plus a token per comma) never undercounts.
  const tokens = (items: ReturnType<typeof serialize>) => {
    let total = 2;
    for (const item of items) {
      total += textTokens(JSON.stringify(item)) + 1;
      if (total > maxTokens) break;
    }
    return total;
  };
  let items = serialize();
  while (tokens(items) > maxTokens && limit > 120) {
    limit = Math.floor(limit / 2);
    items = serialize();
  }
  return {
    text: JSON.stringify(items),
    fits: tokens(items) <= maxTokens,
    abbreviated: history.some(
      (message) =>
        (message.content?.length || 0) > limit ||
        message.tool_calls?.some((call) => call.function.arguments.length > limit),
    ),
  };
}
