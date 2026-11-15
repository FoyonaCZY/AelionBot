// What a chat is made of on the phone. The timeline, run steps and live status come from shared/chat/activity, the
// same functions the desktop uses, so both tell the same story; only the presentation is the phone's.
import { memo, useState } from 'react';
import type { Attachment } from '../../../shared/types/attachment-types';
import type { ChatMessage, RunRecord, StreamingReply } from '../../../shared/types/core';
import type { RemoteBot } from '../../../shared/remote/protocol';
import {
  friendlyError,
  liveBotStep,
  readableContent,
  runDurationMs,
  runPresentation,
  runSteps,
  toolDisplay,
} from '../../../shared/chat/activity';
import { streamingReplyText } from '../../../shared/chat/streaming';
import MessageMarkdown from '../../../src/chat/MessageMarkdown';
import { MessageBlockContent, hasBlockMarkers } from '../../../src/chat/MessageBlocks';
import { useI18n } from '../../../src/i18n';
import { useConnection } from '../connection';
import { I } from '../icons';
import { openFile, useFileUrl } from '../files';
import { toast, useLongPress } from '../ui';

const tint = (color: string) => ({ '--bot': color }) as React.CSSProperties;

function duration(ms: number, t: (key: string, values?: Record<string, string | number>) => string) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds >= 60
    ? t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
    : t('{seconds} 秒', { seconds });
}

function FileChip({ file }: { file: Attachment }) {
  const image = file.mime.startsWith('image/');
  const url = useFileUrl(image ? file.id : undefined);
  const open = () => void openFile(file.id).catch((error: Error) => toast(error.message));
  if (image)
    return (
      <button className="c-image" onClick={open} aria-label={file.name}>
        {url ? <img src={url} alt={file.name} /> : <span className="c-image-wait" />}
      </button>
    );
  const extension = (file.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
  return (
    <button className="c-file" onClick={open}>
      <span className={'c-file-icon is-' + extension.toLowerCase()}>{extension}</span>
      <span className="c-file-text">
        <b>{file.name}</b>
        <small>
          {file.size < 1024 * 1024 ? Math.ceil(file.size / 1024) + ' KB' : (file.size / 1024 / 1024).toFixed(1) + ' MB'}
        </small>
      </span>
      <I name="right" size={16} />
    </button>
  );
}
export function Files({ files }: { files?: Attachment[] }) {
  if (!files?.length) return null;
  return (
    <div className="c-files">
      {files.map((file) => (
        <FileChip key={file.id} file={file} />
      ))}
    </div>
  );
}

export interface PressTarget {
  text: string;
  messageId: string;
}
/** What the row under the newest answer does; the long press offers the same. */
export type AnswerAction = 'copy' | 'speak' | 'quote' | 'more';

export function UserBubble({ message, onPress }: { message: ChatMessage; onPress: (target: PressTarget) => void }) {
  const { t } = useI18n();
  const press = useLongPress(() => onPress({ text: message.content, messageId: message.id }));
  return (
    <div className="c-user">
      <Files files={message.attachments} />
      {message.content.trim() && (
        <div className="c-bubble" {...press}>
          {message.content}
        </div>
      )}
      {message.inputState === 'queued' && <small className="c-user-note">{t('排队中')}</small>}
    </div>
  );
}

function Answer({
  content,
  run,
  messageId,
  onPress,
}: {
  content: string;
  run?: RunRecord;
  messageId: string;
  onPress: (target: PressTarget) => void;
}) {
  const text = readableContent(content);
  const press = useLongPress(() => onPress({ text, messageId }));
  if (!text) return null;
  return (
    <div className="c-answer markdown" {...press}>
      {run?.blocks?.length && hasBlockMarkers(text) ? (
        <MessageBlockContent content={text} blocks={run.blocks} />
      ) : (
        <MessageMarkdown>{text}</MessageMarkdown>
      )}
    </div>
  );
}

/** Under the newest answer: copy, read aloud, quote, and the rest of the long-press menu. */
function AnswerActions({
  message,
  onAction,
}: {
  message: ChatMessage;
  onAction: (action: AnswerAction, target: PressTarget) => void;
}) {
  const { t } = useI18n();
  const { home } = useConnection();
  const text = readableContent(message.content);
  if (!text) return null;
  const target = { text, messageId: message.id };
  return (
    <div className="c-actions">
      <button aria-label={t('复制')} onClick={() => onAction('copy', target)}>
        <I name="copy" size={18} />
      </button>
      {home?.speech.output && (
        <button aria-label={t('朗读')} onClick={() => onAction('speak', target)}>
          <I name="speaker" size={18} />
        </button>
      )}
      <button aria-label={t('引用回复')} onClick={() => onAction('quote', target)}>
        <I name="quote" size={18} />
      </button>
      <button aria-label={t('更多')} onClick={() => onAction('more', target)}>
        <I name="more" size={18} />
      </button>
    </div>
  );
}

/** One run of a Bot: its live status while it works, the folded steps afterwards, its answer and files. */
export const RunView = memo(function RunView({
  messages,
  run,
  isLast,
  bot,
  streams,
  waiting,
  onPress,
  onAction,
}: {
  messages: ChatMessage[];
  run?: RunRecord;
  isLast: boolean;
  bot: RemoteBot;
  streams: StreamingReply[];
  waiting?: 'host_permission' | 'vm_takeover' | 'computer_use' | 'user_input';
  onPress: (target: PressTarget) => void;
  /** Given to the newest answer of the chat: the row of actions under it. */
  onAction?: (action: AnswerAction, target: PressTarget) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const presentation = runPresentation(messages, run);
  const running = presentation.status === 'running';
  const steps = runSteps(messages, { finalId: presentation.final?.id, error: presentation.error });
  // What it does now is shown above the composer; here only that it works, or what it waits for.
  const step = running && isLast ? liveBotStep(messages, run, waiting) : undefined;
  const live =
    running && isLast ? streams.find((reply) => reply.runId === run?.id && reply.purpose !== 'progress') : undefined;
  const liveText = live ? streamingReplyText(live.content) : '';
  const elapsed = runDurationMs(run);
  const notes = running
    ? presentation.notes.filter((message) => message.role === 'assistant' && readableContent(message.content))
    : [];
  return (
    <div className="c-run" style={tint(bot.color)}>
      {notes.map((message) => (
        <div key={message.id} className="c-answer c-progress markdown">
          <MessageMarkdown>{readableContent(message.content)}</MessageMarkdown>
        </div>
      ))}
      {step?.phase === 'waiting' ? (
        <div className="c-wait">
          <i />
          {step.label}
        </div>
      ) : step ? (
        <button className="c-process" onClick={() => setOpen(!open)}>
          <i className="c-process-dot" />
          <span>
            {t('正在处理')}
            {steps.length > 0 && ' · ' + t('{count} 个步骤', { count: steps.length })}
          </span>
          <I name={open ? 'down' : 'right'} size={14} />
        </button>
      ) : (
        steps.length > 0 && (
          <button className="c-process" onClick={() => setOpen(!open)}>
            <I name={presentation.status === 'completed' ? 'check' : 'close'} size={15} stroke={2} />
            <span>
              {elapsed ? t('已处理 {duration}', { duration: duration(elapsed, t) }) : t('已处理')}
              {' · '}
              {t('{count} 个步骤', { count: steps.length })}
            </span>
            <I name={open ? 'down' : 'right'} size={14} />
          </button>
        )
      )}
      {open && (
        <ol className="c-steps">
          {steps.map((item) => {
            if (item.kind === 'tool') {
              const display = toolDisplay(item.message);
              return (
                <li
                  key={item.id}
                  className={
                    item.message.status === 'running' ? 'is-now' : item.message.status === 'failed' ? 'is-failed' : ''
                  }
                >
                  {display.label} {display.detail && <span>{display.detail}</span>}
                </li>
              );
            }
            const text = readableContent(item.message.content) || item.message.reasoning?.text || '';
            return (
              <li key={item.id} className="is-note">
                {text.slice(0, 280)}
              </li>
            );
          })}
        </ol>
      )}
      {liveText && (
        <div className="c-answer markdown is-streaming">
          <MessageMarkdown>{liveText}</MessageMarkdown>
        </div>
      )}
      {presentation.final && (
        <>
          <Answer content={presentation.final.content} run={run} messageId={presentation.final.id} onPress={onPress} />
          <Files files={presentation.final.attachments} />
          {onAction && <AnswerActions message={presentation.final} onAction={onAction} />}
        </>
      )}
      {!running && presentation.error && (
        <p className="c-error">{friendlyError(presentation.error).title || presentation.error}</p>
      )}
    </div>
  );
});

/** A message outside any run: a notice, a peer's note, an answer from before runs existed. */
export function NoteView({
  message,
  onPress,
  onAction,
}: {
  message: ChatMessage;
  onPress: (target: PressTarget) => void;
  onAction?: (action: AnswerAction, target: PressTarget) => void;
}) {
  if (message.role === 'assistant')
    return (
      <>
        <Answer content={message.content} messageId={message.id} onPress={onPress} />
        <Files files={message.attachments} />
        {onAction && <AnswerActions message={message} onAction={onAction} />}
      </>
    );
  const text = readableContent(message.content);
  return text ? <p className="c-note">{text.slice(0, 400)}</p> : null;
}
