import { memo, useContext, useEffect, useId, useRef, useState } from 'react';
import type { Bot, ChatMessage } from '../../shared/types/core';
import { readableContent, toolDisplay, toolResult, visibleRunSteps, type RunStep } from '../../shared/chat/activity';
import { stepMeta } from './tool-details-model';
import { AttachmentList } from '../files/Attachments';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { MessageAvatarContext } from '../ui/Message';
import { MentionContent } from '../ui/MentionContent';
import { MessageReasoning, useReasoningDisplay } from './MessageReasoning';
import { ToolDetails } from './ToolDetails';
import { ScreenshotImage } from './ScreenshotImage';
import { useI18n } from '../i18n';
import { shallowEqual } from '../ui/equality';
import { REVEAL_MESSAGE_EVENT } from './reveal-message';
import './run-process.css';

/** Fired by chat search so a folded run opens before the view scrolls to one of its messages. */

const diffCounts = (diff: NonNullable<ChatMessage['diff']>) => ({
  added: diff.files.reduce((sum, file) => sum + file.added, 0),
  removed: diff.files.reduce((sum, file) => sum + file.removed, 0),
});

function toolIcon(tool = '') {
  if (/search|find_files/.test(tool)) return 'search';
  if (/execute|terminal|process|python|code_exec/.test(tool)) return 'terminal';
  if (/^web_|browser/.test(tool)) return 'globe';
  if (tool === 'computer' || tool === 'request_user_control') return 'computer';
  if (/^(bot_|group_|delegation)/.test(tool)) return 'message';
  if (/memory|skill/.test(tool)) return 'memory';
  if (/plan|task|goal|schedule/.test(tool)) return 'check';
  return 'file';
}

function ToolStep({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const display = toolDisplay(message),
    status = message.status || 'done',
    running = status === 'running',
    image = message.tool === 'view_image' ? message.screenshotId : undefined,
    meta = running ? undefined : stepMeta(toolResult(message));
  return (
    <li
      className={`run-step run-step-tool is-${status} ${meta?.tone === 'bad' ? 'is-failed' : ''} ${toolIcon(message.tool) === 'terminal' ? 'is-command' : ''}`}
    >
      <button
        type="button"
        className="run-step-row"
        aria-expanded={running ? undefined : open}
        aria-controls={open ? bodyId : undefined}
        disabled={running}
        onClick={() => setOpen(!open)}
      >
        <span className="run-step-icon">
          <Icon name={toolIcon(message.tool)} size={13} />
        </span>
        <span className="run-step-label">{display.label}</span>
        {image ? (
          <span className="run-step-image" title={display.detail}>
            <ScreenshotImage id={image} alt={display.detail || t('查看图片')} />
          </span>
        ) : display.detail ? (
          <span className="run-step-detail" title={display.detail}>
            {display.detail}
          </span>
        ) : null}
        {message.diff && (
          <span
            className="run-step-diff"
            aria-label={t('新增 {added} 行，删除 {removed} 行', diffCounts(message.diff))}
          >
            <span className="is-added">+{diffCounts(message.diff).added}</span>
            <span className="is-removed">−{diffCounts(message.diff).removed}</span>
          </span>
        )}
        {meta && <span className={`run-step-meta ${meta.tone ? 'is-' + meta.tone : ''}`}>{meta.text}</span>}
        <span
          className="run-step-state"
          aria-label={running ? t('进行中') : status === 'failed' ? t('失败') : undefined}
        >
          {running ? (
            <span className="run-step-spinner" />
          ) : status === 'failed' ? (
            <Icon name="alert" size={12} />
          ) : (
            <Icon name="chevron" size={11} />
          )}
        </span>
      </button>
      {open && !running && (
        <div className="run-step-body" id={bodyId}>
          <ToolDetails message={message} />
        </div>
      )}
    </li>
  );
}

function NoteBubble({
  message,
  avatar,
  showAvatar,
}: {
  message: ChatMessage;
  avatar?: Pick<Bot, 'id' | 'name' | 'color' | 'avatarStyle'>;
  showAvatar: boolean;
}) {
  const content = readableContent(message.content);
  return (
    <div className="run-note" data-message-id={message.id}>
      {showAvatar && avatar && (
        <span className="run-note-avatar" aria-hidden="true">
          <Avatar bot={avatar} size={30} />
        </span>
      )}
      <div className="bubble run-note-bubble">
        {content && (
          <div className="markdown">
            <MentionContent content={content} mentions={message.mentions} markdown />
          </div>
        )}
        <AttachmentList files={message.attachments} />
      </div>
    </div>
  );
}

const durationLabel = (t: ReturnType<typeof useI18n>['t'], ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds >= 60
    ? t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
    : t('{seconds} 秒', { seconds });
};

/**
 * Everything a run did before its answer. While it works the transcript stays open and talks in bubbles; once the
 * answer arrives the transcript folds into one line and only opens on request.
 */
type RunProcessProps = {
  steps: RunStep[];
  running: boolean;
  durationMs?: number;
  /** A final answer follows in its own bubble, so no transcript bubble needs the avatar. */
  answerFollows?: boolean;
};
export const RunProcess = memo(
  RunProcessView,
  (a: RunProcessProps, b: RunProcessProps) =>
    a.running === b.running &&
    a.durationMs === b.durationMs &&
    a.answerFollows === b.answerFollows &&
    a.steps.length === b.steps.length &&
    a.steps.every((step, index) => shallowEqual(step, b.steps[index])),
);
function RunProcessView({ steps: allSteps, running, durationMs, answerFollows = false }: RunProcessProps) {
  const { t } = useI18n();
  const avatar = useContext(MessageAvatarContext);
  const reasoning = useReasoningDisplay(),
    steps = reasoning === 'hidden' ? allSteps.filter((step) => step.kind !== 'reasoning') : allSteps;
  const [expanded, setExpanded] = useState(false);
  const listId = useId(),
    wasRunning = useRef(running);
  // The answer takes over once the run ends: fold the process even if it was opened while working.
  useEffect(() => {
    if (wasRunning.current && !running) setExpanded(false);
    wasRunning.current = running;
  }, [running]);
  const ids = steps.map((step) => step.id).join('|');
  useEffect(() => {
    const reveal = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (ids.split('|').includes(id)) setExpanded(true);
    };
    window.addEventListener(REVEAL_MESSAGE_EVENT, reveal);
    return () => window.removeEventListener(REVEAL_MESSAGE_EVENT, reveal);
  }, [ids]);
  if (!steps.length) return null;
  const transcript = visibleRunSteps(steps, { running, expanded }),
    lastNote = [...steps].reverse().find((step) => step.kind === 'note')?.id,
    // While working the newest text bubble carries the avatar; once the answer exists the answer carries it.
    avatarNote = answerFollows ? undefined : lastNote;
  const summary = running
    ? t('正在处理 · {count} 个步骤', { count: steps.length })
    : durationMs !== undefined
      ? t('已处理 {duration} · {count} 个步骤', { duration: durationLabel(t, durationMs), count: steps.length })
      : t('处理过程 · {count} 个步骤', { count: steps.length });
  return (
    <div className={`run-process ${running ? 'is-running' : ''} ${expanded ? 'is-expanded' : ''}`}>
      {!running && (
        <button
          type="button"
          className="run-process-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-label={`${summary} · ${t(expanded ? '收起处理过程' : '展开处理过程')}`}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="run-process-mark">
            <Icon name="layers" size={13} />
          </span>
          <span className="run-process-summary">{summary}</span>
          <Icon name="chevron" size={12} />
        </button>
      )}
      {(running || expanded) && transcript.steps.length > 0 && (
        <ol className={running ? 'run-transcript' : 'run-process-steps'} id={listId}>
          {transcript.hiddenTools > 0 && (
            <li className="run-step run-step-more">
              <button type="button" onClick={() => setExpanded(true)}>
                {t('还有 {count} 个较早的步骤', { count: transcript.hiddenTools })}
              </button>
            </li>
          )}
          {transcript.steps.map((step) =>
            step.kind === 'tool' ? (
              <ToolStep key={step.id} message={step.message} />
            ) : step.kind === 'note' ? (
              <li key={step.id} className="run-step run-step-note">
                <NoteBubble message={step.message} avatar={avatar} showAvatar={step.id === avatarNote} />
              </li>
            ) : (
              <li key={step.id} className="run-step run-step-reasoning" data-message-id={step.message.id}>
                <MessageReasoning reasoning={step.message.reasoning} />
              </li>
            ),
          )}
        </ol>
      )}
    </div>
  );
}
