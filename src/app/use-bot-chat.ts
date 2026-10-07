import { useRef, type RefObject } from 'react';
import type { Bot, ChatMessage, Snapshot } from '../../shared/types/core';
import { messageReply } from '../../shared/chat/message-replies';
import { usePreviewWorkbench } from '../preview/PreviewWorkbench';
import { ipcErrorText } from '../ui/ipc-error';
import { useI18n } from '../i18n';
import type { BotConversationData } from './bot-conversation';
import type { Drafts } from './use-drafts';

/**
 * Sending, replying and resuming in the selected bot's direct conversation. A send clears the draft at once
 * and restores it on failure unless the user has started a new one in the meantime.
 */
export function useBotChat(input: {
  state?: Snapshot;
  bot?: Bot;
  conversation: BotConversationData;
  drafts: Drafts;
  follow: RefObject<boolean>;
  onNeedModel: () => void;
  onError: (message: string) => void;
}) {
  const { state, bot, conversation, drafts, follow, onNeedModel, onError } = input;
  const { t } = useI18n(),
    previewWorkbench = usePreviewWorkbench();
  const sending = useRef(new Set<string>());
  const replyTo = (message: ChatMessage) => {
    const owner = state?.bots.find((bot) => bot.id === message.botId);
    if (!owner) return;
    drafts.update((value) => ({
      ...value,
      [owner.id]: {
        ...(value[owner.id] || { text: '', mentions: [] }),
        reply: messageReply(
          message,
          message.role === 'user' ? t('你') : owner.name,
          message.role === 'user' ? 'user' : owner.id,
        ),
      },
    }));
  };
  const send = async () => {
    // Read when sending: the draft changes on every keystroke and is not part of this hook's render.
    const draft = drafts.get(bot?.id || '');
    if (!bot || sending.current.has(bot.id) || (!draft.text.trim() && !draft.attachments?.length)) return;
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
      botId = bot.id;
    sending.current.add(botId);
    drafts.update((value) => ({ ...value, [botId]: { text: '', mentions: [] } }));
    follow.current = true;
    try {
      if (
        !(await previewWorkbench?.send(
          { kind: 'bot', id: botId },
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
          message: saved.text,
          mentions: saved.mentions,
          replyToMessageId: saved.reply?.messageId,
          attachmentIds: saved.attachments?.map((file) => file.id),
        });
    } catch (error) {
      drafts.update((value) =>
        value[botId]?.text || value[botId]?.attachments?.length || value[botId]?.reply
          ? value
          : { ...value, [botId]: saved },
      );
      onError(ipcErrorText(error));
    } finally {
      sending.current.delete(botId);
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
  return { send, replyTo, continueWork };
}
