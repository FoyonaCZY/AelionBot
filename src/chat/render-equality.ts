import type { BotMention, ChatMessage } from '../../shared/types/core';
import type { RunStep } from '../../shared/chat/activity';

// Every IPC snapshot is a structured clone, so nothing survives between snapshots by reference. These compare by
// value so memoized chat components skip renders when a snapshot did not change what they show.

// Top-level content holds tool output (megabytes across a long chat): string equality is cheap, re-serializing
// it is not. Only that field is skipped; nested content (a quoted reply, for example) is still compared.
const rest = ({ content: _content, ...fields }: ChatMessage) => JSON.stringify(fields);
export const sameMessage = (a: ChatMessage, b: ChatMessage) =>
  a === b || (a.id === b.id && a.content === b.content && rest(a) === rest(b));

export const sameSteps = (a: RunStep[], b: RunStep[]) =>
  a === b ||
  (a.length === b.length &&
    a.every((step, index) => step.kind === b[index].kind && sameMessage(step.message, b[index].message)));

export const sameMentions = (a: BotMention[] = [], b: BotMention[] = []) =>
  a === b || (a.length === b.length && JSON.stringify(a) === JSON.stringify(b));
