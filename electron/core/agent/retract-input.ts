/**
 * Taking back what the user sent to edit it. Input that is still waiting simply leaves the queue. Input a run is
 * working on stops that run, and the input, everything the Bot wrote for it and its turn in the model history go:
 * the Bot answers the edited message as if the first one was never sent. What the run already did outside the chat
 * (files written, commands run) stays done.
 */
import type { BotMention, ChatMessage, RunRecord, WireMessage } from '../../../shared/types/core';
import type { Attachment } from '../../../shared/types/attachment-types';
import type { MessageReply } from '../../../shared/chat/message-replies';
import { canRetract } from '../../../shared/chat/retract';
import { AppError } from '../../../shared/errors';
import { Store } from '../storage/store';
import { chatInputText } from './chat-input';

/** What goes back into the composer. */
export interface RetractedDraft {
  text: string;
  mentions: BotMention[];
  attachments: Attachment[];
  reply?: MessageReply;
}

export interface RetractDeps {
  store: Store;
  /** Stops the work in one of a Bot's chats (`sessionId` null for its main chat), delegated work included. */
  stop: (botId: string, sessionId: string | null) => void;
  isRunning: (botId: string, sessionId: string | null) => boolean;
  /** Runs `work` with no new input starting in that chat. */
  hold: <T>(botId: string, sessionId: string | undefined, work: () => Promise<T>) => Promise<T>;
  forgetSuperseded: (botId: string, sessionId: string | undefined, runId: string) => void;
  /** How far a summary already covers the chat's history (see ContextEngine.summarizedThrough). */
  summarizedThrough?: (botId: string, scopeKey?: string) => number;
  changed: () => void;
  /** How long a run may take to stop; tests shorten it. */
  stopTimeoutMs?: number;
}

const NOTE =
  '（用户撤回了上一条消息去修改；那条消息和你为它做的处理都作废，不要再提起或继续，以用户接下来发送的内容为准。）';

export async function retractInput(
  deps: RetractDeps,
  input: { botId: string; sessionId?: string; messageId: string },
): Promise<RetractedDraft> {
  const { store } = deps;
  const botId = String(input?.botId || ''),
    sessionId = typeof input?.sessionId === 'string' && input.sessionId ? input.sessionId : undefined;
  store.bot(botId);
  const message = store.data.messages.find(
    (item) => item.id === input?.messageId && item.botId === botId && item.sessionId === sessionId,
  );
  const run = message?.runId ? store.data.runs.find((item) => item.id === message.runId) : undefined;
  if (!message || !canRetract(message, run))
    throw new AppError('chat.retract_unavailable', '这条消息已经处理完，不能撤回编辑');
  // Waiting input: nothing has seen it yet. Taking it out is synchronous, so the queue cannot start it meanwhile.
  if (!run) {
    store.data.messages = store.data.messages.filter((item) => item !== message);
    store.save();
    deps.changed();
    return draftOf([message]);
  }
  return deps.hold(botId, sessionId, async () => {
    run.retracted = true;
    store.touch(run);
    deps.forgetSuperseded(botId, sessionId, run.id);
    deps.stop(botId, sessionId ?? null);
    const deadline = Date.now() + (deps.stopTimeoutMs ?? 20000);
    while (run.status === 'running' || deps.isRunning(botId, sessionId ?? null)) {
      if (Date.now() > deadline) {
        delete run.retracted;
        store.touch(run);
        store.save();
        throw new AppError('chat.retract_busy', '任务还没有停下来，请稍后再试');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const inputs = store.data.messages.filter(
      (item) => item.runId === run.id && item.role === 'user' && !item.reaction,
    );
    cutHistory(deps, run, inputs);
    store.data.messages = store.data.messages.filter((item) => item.runId !== run.id);
    store.save();
    deps.changed();
    return draftOf(inputs.length ? inputs : [message]);
  });
}

/** Cuts the model history back to before the run's input, or tells the model to disregard it when it is not found. */
function cutHistory(deps: RetractDeps, run: RunRecord, inputs: ChatMessage[]) {
  const { store } = deps;
  const scopeKey = run.sessionId ? Store.sessionHistoryKey(run.sessionId) : undefined,
    key = scopeKey || run.botId,
    history = store.data.conversations[key];
  if (!history) return;
  const first = inputs[0] ? chatInputText(inputs[0]) : undefined;
  let at = -1;
  for (let index = history.length - 1; first && index >= 0; index--)
    if (isInput(history[index], first)) {
      at = index;
      break;
    }
  if (at < 0) {
    history.push({ role: 'system', content: NOTE });
    return;
  }
  history.splice(at);
  // A summary that already covers the cut part would bring it back: start the context over from the history.
  if (at < (deps.summarizedThrough?.(run.botId, scopeKey) ?? 0) || at < (store.data.contextOffsets[key] || 0)) {
    (store.data.historyVersions ||= {})[key] = (store.data.historyVersions[key] || 0) + 1;
    store.data.contextOffsets[key] = 0;
    delete store.data.summaries[key];
  }
}

const isInput = (wire: WireMessage, text: string) =>
  wire.role === 'user' && typeof wire.content === 'string' && wire.content.startsWith(text);

/** One draft from the inputs, in order: their text a paragraph apart, mentions moved along with it. */
function draftOf(inputs: ChatMessage[]): RetractedDraft {
  let text = '';
  const mentions: BotMention[] = [],
    attachments: Attachment[] = [];
  for (const item of inputs) {
    if (item.content) {
      const offset = text ? text.length + 2 : 0;
      text += (text ? '\n\n' : '') + item.content;
      for (const mention of item.mentions || [])
        mentions.push({ ...mention, start: mention.start + offset, end: mention.end + offset });
    }
    for (const file of item.attachments || [])
      if (!attachments.some((known) => known.id === file.id)) attachments.push(file);
  }
  const reply = inputs.find((item) => item.reply)?.reply;
  return { text, mentions, attachments, ...(reply ? { reply } : {}) };
}
