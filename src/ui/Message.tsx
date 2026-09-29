import { memo, useRef } from 'react';
import { previewFeedbackDisplay } from '../../shared/preview/preview-feedback';
import { MessageQuote } from '../chat/MessageQuote';
import { MessageTime } from '../chat/ConversationTime';
import { AttachmentList } from '../files/Attachments';
import { attachmentSummary } from '../../shared/types/attachment-types';
import type { ChatMessage } from '../../shared/types/core';
import { readableContent } from '../../shared/chat/activity';
import { legacyQuestionAnswerData, readableQuestionAnswer } from '../../shared/chat/question-answers';
import { QuestionAnswerMessage } from '../chat/QuestionAnswerMessage';
import { MessageActions } from '../chat/MessagePins';
import { Icon } from './Icon';
import { MentionContent } from './MentionContent';
import { MessageReasoning } from '../chat/MessageReasoning';
import { sameMessage } from '../chat/render-equality';
import { useI18n } from '../i18n';
import '../chat/message-surfaces.css';

type MessageProps = {
  message: ChatMessage;
  allowPins?: boolean;
  onReply?: (message: ChatMessage) => void;
  /** False when the reasoning is already shown elsewhere, e.g. inside the folded run process. */
  showReasoning?: boolean;
};
// Snapshots arrive as fresh structured clones; a message re-renders only when something it shows changed.
// onReply is compared by presence and read through a ref, so a skipped render still calls the latest callback.
const MemoMessage = memo(
  MessageView,
  (a: MessageProps & { reply: ReplyRef }, b: MessageProps & { reply: ReplyRef }) =>
    a.allowPins === b.allowPins &&
    a.showReasoning === b.showReasoning &&
    Boolean(a.onReply) === Boolean(b.onReply) &&
    sameMessage(a.message, b.message),
);
type ReplyRef = { current?: (message: ChatMessage) => void };
export function Message(props: MessageProps) {
  const reply = useRef<(message: ChatMessage) => void>(undefined);
  reply.current = props.onReply;
  return <MemoMessage {...props} reply={reply} />;
}
function MessageView({
  message,
  allowPins = true,
  onReply: hasReply,
  showReasoning = true,
  reply,
}: MessageProps & { reply: ReplyRef }) {
  const onReply = hasReply ? (value: ChatMessage) => reply.current?.(value) : undefined;
  const { t } = useI18n();
  if (!showReasoning && message.reasoning) message = { ...message, reasoning: undefined };
  if (message.scheduled)
    return (
      <>
        <MessageTime id={message.id} time={message.time} />
        <div className="scheduled-trigger" data-message-id={message.id}>
          <div>
            <Icon name="clock" size={15} />
            <span>
              {t('定时任务')} · {message.scheduled.title}
            </span>
          </div>
          <p>{message.content}</p>
        </div>
      </>
    );
  if (message.reaction) return null;
  if (message.role === 'event') return <div className="event-message">{message.content}</div>;
  if (message.role === 'tool') return null;
  if (!message.content && !message.attachments?.length && message.status !== 'running' && !message.reasoning?.text)
    return null;
  const presentation = previewFeedbackDisplay(message);
  const answer =
    message.role === 'user' ? message.questionAnswer || legacyQuestionAnswerData(message.content) : undefined;
  const content =
    message.role === 'assistant'
      ? message.content.startsWith('执行检查发现未解决')
        ? t('发现校验问题，继续检查并修正。')
        : readableContent(message.content)
      : readableQuestionAnswer(presentation.content);
  // A model call that only reasoned before its tool calls leaves a single disclosure line, no bubble.
  if (
    message.role === 'assistant' &&
    message.reasoning?.text &&
    !content &&
    !message.attachments?.length &&
    message.status !== 'running'
  )
    return (
      <div className="message-row assistant reasoning-only" data-message-id={message.id}>
        <MessageReasoning reasoning={message.reasoning} />
      </div>
    );
  return (
    <>
      <MessageTime id={message.id} time={message.time} />
      <div className={`message-row ${message.role}`} data-message-id={message.id}>
        {message.role === 'assistant' && <MessageReasoning reasoning={message.reasoning} />}
        <MessageActions
          messageId={message.id}
          content={content || attachmentSummary(message.attachments)}
          pins={message.pins}
          onReply={
            onReply &&
            !['running', 'cancelled'].includes(message.status || 'done') &&
            (content || message.attachments?.length)
              ? () => onReply({ ...message, content })
              : undefined
          }
          bubbleClassName={`bubble ${answer ? 'question-answer-bubble' : ''} ${message.status === 'failed' ? 'failed' : ''}`}
          onPin={
            allowPins && (content || message.attachments?.length) && (!message.status || message.status === 'done')
              ? (input) => window.aelion.pinChat({ ...input, botId: message.botId })
              : undefined
          }
        >
          {message.reply && <MessageQuote reply={message.reply} />}
          {answer ? (
            <QuestionAnswerMessage answer={answer} />
          ) : content ? (
            message.role === 'assistant' ? (
              <div className="markdown">
                <MentionContent content={content} mentions={presentation.mentions} markdown />
              </div>
            ) : (
              <MentionContent content={content} mentions={presentation.mentions} />
            )
          ) : message.attachments?.length ? null : (
            <span className="typing">
              <i />
              <i />
              <i />
            </span>
          )}
          <AttachmentList files={message.attachments} />
        </MessageActions>
      </div>
    </>
  );
}
