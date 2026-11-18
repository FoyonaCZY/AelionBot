// The turns of a Bot's chat, for the rail beside the conversation: each thing the user said with the Bot's answer,
// and what the Bot said on its own. A turn is found again, and marked, by the message it starts with.
import type { ChatMessage, RunRecord } from '../types/core';
import { previewFeedbackDisplay } from '../preview/preview-feedback';
import { readableContent, runPresentation, type TimelineItem } from './activity';
import { stripBlockPlacements } from './message-blocks';
import { readableQuestionAnswer } from './question-answers';

export interface ConversationTurn {
  /** The message the turn starts with: the user's, or the Bot's answer when it spoke first. */
  id: string;
  /** What the user said, as plain text on one line; empty when the Bot spoke first. */
  prompt: string;
  /** The Bot's answer as plain text; empty while it works on it or when it gave none. */
  reply: string;
  /** The user marked the turn to find it again. */
  marked: boolean;
  /** How much was said, from 0 to 1 on a log scale: a one-line exchange is short, a long report long. */
  weight: number;
}

/** More than a preview card shows in three lines. */
const PREVIEW_CHARS = 280;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Markdown reduced to what a preview line shows: no code blocks, markup, tables or link addresses. */
export function previewText(markdown: string) {
  // A preview needs the start only; a long reply is not worth scanning to its end.
  markdown = markdown.slice(0, PREVIEW_CHARS * 16);
  const text = oneLine(
    markdown
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .replace(/<[^>\n]+>/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
      .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.replace(/\|/g, ' '))
      .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
      .replace(/(\*\*|__|~~|\*)(?=\S)([^*~\n]+?)\1/g, '$2'),
  );
  // A message that is all code still says something: the code, without its fences.
  const shown = text || oneLine(markdown.replace(/```[^\n]*/g, ' '));
  return shown.length > PREVIEW_CHARS ? shown.slice(0, PREVIEW_CHARS).trimEnd() + '…' : shown;
}

const fileNames = (message: ChatMessage) => (message.attachments || []).map((file) => file.name).join(', ');

// The chat keeps a message's object while it is unchanged, so its preview is worked out once.
const previews = new WeakMap<ChatMessage, string>();
const cached = (message: ChatMessage, make: (message: ChatMessage) => string) => {
  let text = previews.get(message);
  if (text === undefined) previews.set(message, (text = make(message)));
  return text;
};
const userText = (message: ChatMessage) =>
  cached(message, () => {
    const said = readableQuestionAnswer(previewFeedbackDisplay(message).content);
    if (message.scheduled) return oneLine(message.scheduled.title) || previewText(said);
    return previewText(said) || fileNames(message);
  });
const botText = (message: ChatMessage) =>
  cached(message, () => previewText(stripBlockPlacements(readableContent(message.content))) || fileNames(message));

const weightOf = (chars: number) => Math.min(1, Math.log10(1 + chars) / 4);

/**
 * The turns of a chat, oldest first, from its timeline (conversationTimeline). The user's messages start turns; a
 * run's answer completes the latest turn still waiting for one, or is a turn of its own when the Bot spoke first.
 * Notices, reactions, tool steps and progress notes are not turns.
 */
export function conversationTurns(
  timeline: readonly TimelineItem[],
  runs: ReadonlyMap<string, RunRecord>,
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  /** The latest turn, while it still waits for an answer; and how many characters it holds so far. */
  let open: ConversationTurn | undefined,
    said = 0;
  const answer = (message: ChatMessage) => {
    const reply = botText(message);
    if (!reply) return;
    if (open) {
      open.reply = reply;
      open.weight = weightOf(said + message.content.length);
      open = undefined;
      return;
    }
    turns.push({
      id: message.id,
      prompt: '',
      reply,
      marked: Boolean(message.marked),
      weight: weightOf(message.content.length),
    });
  };
  for (const item of timeline) {
    if (item.kind === 'run') {
      // A run split by the user's messages shows its answer under its last part.
      if (!item.isLast) continue;
      const final = runPresentation(item.messages, runs.get(item.id)).final;
      if (final) answer(final);
      continue;
    }
    const message = item.message;
    if (message.reaction || message.peer || message.groupLink) continue;
    if (message.role === 'assistant' && message.status !== 'running') answer(message);
    if (message.role !== 'user') continue;
    const prompt = userText(message);
    if (!prompt) continue;
    said = message.content.length;
    open = { id: message.id, prompt, reply: '', marked: Boolean(message.marked), weight: weightOf(said) };
    turns.push(open);
  }
  return turns;
}
