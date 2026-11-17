// Search across every conversation: each Bot's main chat, its work sessions, and the groups. It reads the same
// text the chats show, so every hit is a message its conversation can scroll to.
import type { ChatMessage, RunRecord } from '../types/core';
import type { GroupMessage } from '../types/group-types';
import { isPrivatePeerOrigin } from '../types/peer-types';
import { previewFeedbackDisplay } from '../preview/preview-feedback';
import { readableContent } from './activity';
import { isEmptyGroupReply } from './group-empty-reply';
import { groupReplyContent } from './message-envelope';

export interface ConversationSearchHit {
  /** Where it was said: a Bot's main chat, one of its work sessions (`sessionId`), or a group. */
  scope: { kind: 'bot'; id: string; sessionId?: string } | { kind: 'group'; id: string };
  messageId: string;
  time: string;
  /** Who said it; a Bot by its ID, with its name for one that has left since. */
  sender: { kind: 'user' } | { kind: 'bot'; id: string; name: string };
  /** The text around the first match, on one line. */
  snippet: string;
}
export interface ConversationSearchResult {
  /** The newest matches, newest first. */
  hits: ConversationSearchHit[];
  /** How many messages match in all. */
  total: number;
}
/** What is searched: the stored messages of every chat. */
export interface ConversationSearchSource {
  bots: ReadonlyArray<{ id: string; name: string }>;
  /** The work sessions that exist; a message left behind by a deleted one has no chat to open. */
  sessionIds: ReadonlySet<string>;
  messages: readonly ChatMessage[];
  runs: readonly RunRecord[];
  groups: ReadonlyArray<{ id: string; messages: readonly GroupMessage[] }>;
}

/** Results asked for at a time, and the most one search returns however far the reader loads on. */
export const CONVERSATION_SEARCH_PAGE = 40,
  CONVERSATION_SEARCH_MAX = 400;

/** The words of a query, lowercased; a message matches when it holds every one of them. */
export function searchTerms(query: string) {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].map((term) => term.slice(0, 100)).slice(0, 8);
}

/** Text without letter case (Chinese, digits) is compared as it is, which skips lowercasing every message. */
function matcher(terms: string[]) {
  const caseless = terms.every((term) => term === term.toUpperCase());
  return (text: string) => {
    const value = caseless ? text : text.toLowerCase();
    return terms.every((term) => value.includes(term));
  };
}

const SNIPPET_LEAD = 18,
  SNIPPET_LENGTH = 110;

/** One line of `text` around the first matching term, with an ellipsis where it was cut. */
export function searchSnippet(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  let start = Math.max(0, Math.min(at, text.length) - SNIPPET_LEAD),
    end = Math.min(text.length, start + SNIPPET_LENGTH);
  // Never cut an emoji or other surrogate pair in half.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  let line = text.slice(start, end).replace(/\s+/g, ' ');
  // Markdown marks are noise in a one-line preview, unless they are what was searched for.
  if (!terms.some((term) => /[#*`]/.test(term))) line = line.replace(/[#*`]/g, '');
  return (start > 0 ? '…' : '') + line.trim() + (end < text.length ? '…' : '');
}

/** `text` split into the parts that match a term and the parts between them, for highlighting. */
export function highlightParts(text: string, terms: string[]): Array<{ text: string; hit: boolean }> {
  const lower = text.toLowerCase(),
    ranges: Array<[number, number]> = [];
  // Lowercasing can change a string's length (İ); the offsets would not line up, so show it plain.
  if (lower.length === text.length)
    for (const term of terms)
      for (let index = lower.indexOf(term); term && index >= 0; index = lower.indexOf(term, index + term.length))
        ranges.push([index, index + term.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (to <= at) continue;
    if (from > at) parts.push({ text: text.slice(at, from), hit: false });
    parts.push({ text: text.slice(Math.max(at, from), to), hit: true });
    at = to;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/** What a Bot chat shows of a message: the answer without tagged reasoning, the user's words as typed. */
const botText = (message: ChatMessage) =>
  message.role === 'assistant' ? readableContent(message.content) : previewFeedbackDisplay(message).content;
/** What a group shows of a message: a Bot's reply without the envelope some models wrap it in. */
const groupText = (message: GroupMessage) =>
  message.sender.kind === 'bot'
    ? groupReplyContent(message.content, message.sender.id)
    : previewFeedbackDisplay(message).content;

/**
 * Finds the messages holding every term of `query` and returns the newest `limit`. Only what the user and the Bots
 * said is searched: no tool output, events, reactions or drafts still being written. The scan is a generator that
 * yields between batches, so a caller with a large history can spread it over several turns of its event loop.
 */
export function* scanConversations(
  source: ConversationSearchSource,
  query: string,
  limit: number,
): Generator<undefined, ConversationSearchResult> {
  const terms = searchTerms(query);
  if (!terms.length) return { hits: [], total: 0 };
  const matches = matcher(terms),
    botNames = new Map(source.bots.map((bot) => [bot.id, bot.name])),
    privateRuns = new Set(source.runs.filter((run) => isPrivatePeerOrigin(run.peerOrigin)).map((run) => run.id));
  const found: Array<{ at: number; order: number; hit: () => ConversationSearchHit }> = [];
  let order = 0,
    budget = 0;
  /** True once per batch; long messages use the batch up sooner. */
  const pause = (length: number) => {
    budget += 1 + (length >> 11);
    if (budget < 400) return false;
    budget = 0;
    return true;
  };
  const add = (time: string, hit: () => ConversationSearchHit) =>
    found.push({ at: Date.parse(time) || 0, order: order++, hit });
  for (const message of source.messages) {
    if (pause(message.content.length)) yield;
    if (message.reaction || (message.role !== 'user' && message.role !== 'assistant')) continue;
    if (message.status === 'running' || message.status === 'cancelled') continue;
    if (!botNames.has(message.botId) || (message.sessionId && !source.sessionIds.has(message.sessionId))) continue;
    // Tasks and notices from other Bots and from groups are shown as cards; groups are searched where they are.
    if (message.taskSource || message.groupTaskSource || message.peer || message.groupLink) continue;
    // A Bot's private exchanges with other Bots are not part of its chat with the user.
    if (message.runId && privateRuns.has(message.runId) && message.audience !== 'user') continue;
    // The shown text only leaves parts of the stored one out, so the stored one rules most messages out cheaply.
    if (!matches(message.content)) continue;
    const text = botText(message);
    if (text !== message.content && !matches(text)) continue;
    add(message.time, () => ({
      scope: { kind: 'bot', id: message.botId, ...(message.sessionId ? { sessionId: message.sessionId } : {}) },
      messageId: message.id,
      time: message.time,
      sender:
        message.role === 'user'
          ? { kind: 'user' }
          : { kind: 'bot', id: message.botId, name: botNames.get(message.botId) || '' },
      snippet: searchSnippet(text, terms),
    }));
  }
  for (const room of source.groups)
    for (const message of room.messages) {
      if (pause(message.content.length)) yield;
      if (message.kind !== 'message' && message.kind !== 'progress') continue;
      if (message.sender.kind === 'system' || !matches(message.content)) continue;
      const text = groupText(message),
        sender = message.sender;
      if (text !== message.content && !matches(text)) continue;
      // Replies that say nothing are not shown in the group.
      if (sender.kind === 'bot' && !message.attachments?.length && isEmptyGroupReply(text)) continue;
      add(message.time, () => ({
        scope: { kind: 'group', id: room.id },
        messageId: message.id,
        time: message.time,
        sender:
          sender.kind === 'bot'
            ? { kind: 'bot', id: sender.id, name: botNames.get(sender.id) || sender.name }
            : { kind: 'user' },
        snippet: searchSnippet(text, terms),
      }));
    }
  found.sort((a, b) => b.at - a.at || b.order - a.order);
  return { hits: found.slice(0, Math.max(0, limit)).map((entry) => entry.hit()), total: found.length };
}
