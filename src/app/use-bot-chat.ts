import { useRef, type RefObject } from 'react';
import type { Bot, ChatMessage, Snapshot } from '../../shared/types/core';
import { messageReply } from '../../shared/chat/message-replies';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { activeDesignId } from '../designer/design-canvas-state';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import type { BotConversationData } from './bot-conversation';
import type { Drafts } from './use-drafts';

/**
 * Sending, replying and resuming in the selected bot's direct conversation: its main chat, or the work session
 * `sessionId`. A send clears the draft at once and restores it on failure unless the user has started a new one in
 * the meantime.
 */
export function useBotChat(input: {
  state?: Snapshot;
  bot?: Bot;
  sessionId?: string;
  conversation: BotConversationData;
  drafts: Drafts;
  follow: RefObject<boolean>;
  onNeedModel: () => void;
  onError: (message: string) => void;
}) {
  const { state, bot, sessionId, conversation, drafts, follow, onNeedModel, onError } = input;
  // Drafts are kept per chat: the main chat under the Bot's ID, a work session under its own key.
  const chatKey = (botId: string) => (sessionId ? 'session:' + sessionId : botId);
  const { t } = useI18n(),
    previewWorkbench = usePreviewWorkbench();
  const sending = useRef(new Set<string>());
  const replyTo = (message: ChatMessage) => {
    const owner = state?.bots.find((bot) => bot.id === message.botId);
    if (!owner) return;
    const key = chatKey(owner.id);
    drafts.update((value) => ({
      ...value,
      [key]: {
        ...(value[key] || { text: '', mentions: [] }),
        reply: messageReply(
          message,
          message.role === 'user' ? t('你') : owner.name,
          message.role === 'user' ? 'user' : owner.id,
        ),
      },
    }));
  };
  /**
   * Takes back a message still waiting or being worked on and puts it in the composer to edit. Anything already typed
   * there stays, after it.
   */
  const edit = async (message: ChatMessage) => {
    if (!bot || message.botId !== bot.id) return;
    const key = chatKey(bot.id);
    try {
      const taken = await window.aelion.retractChat({
        botId: bot.id,
        ...(sessionId ? { sessionId } : {}),
        messageId: message.id,
      });
      drafts.update((value) => {
        const typed = value[key],
          offset = typed?.text ? taken.text.length + 2 : 0,
          attachments = [...taken.attachments];
        for (const file of typed?.attachments || [])
          if (!attachments.some((known) => known.id === file.id)) attachments.push(file);
        const reply = taken.reply || typed?.reply;
        return {
          ...value,
          [key]: {
            text: typed?.text ? taken.text + '\n\n' + typed.text : taken.text,
            mentions: [
              ...taken.mentions,
              ...(typed?.mentions || []).map((m) => ({ ...m, start: m.start + offset, end: m.end + offset })),
            ],
            ...(attachments.length ? { attachments } : {}),
            ...(reply ? { reply } : {}),
            restoredFrom: message.id,
          },
        };
      });
    } catch (error) {
      onError(ipcErrorText(error));
    }
  };
  const send = async () => {
    // Read when sending: the draft changes on every keystroke and is not part of this hook's render.
    const key = chatKey(bot?.id || '');
    const draft = drafts.get(key);
    if (!bot || sending.current.has(key) || (!draft.text.trim() && !draft.attachments?.length)) return;
    if (draft.text.length > 32000) {
      onError(t('消息过长，请分段发送'));
      return;
    }
    const currentModel = conversation.currentModel;
    if (!currentModel?.model || currentModel.issue) {
      onNeedModel();
      onError(t('先为这个 Bot 选择模型'));
      return;
    }
    const saved = draft,
      botId = bot.id,
      // The design task on this chat's canvas; the Bot continues it only when the message asks for design work.
      openDesignSessionId = activeDesignId({ kind: 'bot', id: botId, ...(sessionId ? { sessionId } : {}) });
    sending.current.add(key);
    drafts.update((value) => ({ ...value, [key]: { text: '', mentions: [] } }));
    follow.current = true;
    try {
      if (
        !(await previewWorkbench?.send(
          { kind: 'bot', id: botId, ...(sessionId ? { sessionId } : {}) },
          {
            text: saved.text,
            mentions: saved.mentions,
            replyToMessageId: saved.reply?.messageId,
            attachmentIds: saved.attachments?.map((f) => f.id),
          },
        ))
      )
        await window.aelion.send({
          botId,
          ...(sessionId ? { sessionId } : {}),
          ...(openDesignSessionId ? { openDesignSessionId } : {}),
          message: saved.text,
          mentions: saved.mentions,
          replyToMessageId: saved.reply?.messageId,
          attachmentIds: saved.attachments?.map((file) => file.id),
        });
    } catch (error) {
      drafts.update((value) =>
        value[key]?.text || value[key]?.attachments?.length || value[key]?.reply ? value : { ...value, [key]: saved },
      );
      onError(ipcErrorText(error));
    } finally {
      sending.current.delete(key);
    }
  };
  const continueWork = () => {
    const { running, latestRun } = conversation;
    if (!bot || running || !latestRun) return;
    follow.current = true;
    void window.aelion
      .resumeChat({ botId: bot.id, runId: latestRun.id })
      .catch((error) => onError(ipcErrorText(error)));
  };
  return { send, replyTo, edit, continueWork };
}
