import { memo, useEffect, useId, useRef, useState } from 'react';
import type { ChatMessage } from '../../shared/types/core';
import {
  readableContent,
  runOverview,
  toolDisplay,
  toolResult,
  visibleRunSteps,
  type RunStep,
} from '../../shared/chat/activity';
import { stepMeta } from './tool-details-model';
import { AttachmentList } from '../files/Attachments';
import { Icon } from '../ui/Icon';
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

/** Text the run said between tools. It never carries the avatar: the working status below, and later the answer, do. */
function NoteBubble({ message }: { message: ChatMessage }) {
  const content = readableContent(message.content);
  return (
    <div className="run-note" data-message-id={message.id}>
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

/** The icon for each kind of work runOverview names (shared/chat/activity.ts). */
const KIND_ICONS: Record<string, string> = {
  read: 'file',
  image: 'canvas',
  edit: 'edit',
  write: 'plus',
  command: 'terminal',
  web: 'globe',
  search: 'search',
  computer: 'computer',
  generate: 'sparkle',
  message: 'message',
  mcp: 'plugin',
  plan: 'check',
  skill: 'book',
  memory: 'memory',
  other: 'more',
};

/** Time since the run started, ticking once a second while it works. */
function useElapsed(startedAt?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const started = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(started) ? Math.max(0, now - started) : undefined;
}

/**
 * Everything a run did before its answer, folded into one capsule: its state and time, the kinds of work it did as
 * icons with counts, and the lines it changed, with the images it read stacked beside it. While the run works only
 * its text stays out under the capsule; the steps open on request, and fold again when the answer arrives.
 */
type RunProcessProps = {
  steps: RunStep[];
  running: boolean;
  startedAt?: string;
  durationMs?: number;
};
export const RunProcess = memo(
  RunProcessView,
  (a: RunProcessProps, b: RunProcessProps) =>
    a.running === b.running &&
    a.startedAt === b.startedAt &&
    a.durationMs === b.durationMs &&
    a.steps.length === b.steps.length &&
    a.steps.every((step, index) => shallowEqual(step, b.steps[index])),
);
function RunProcessView({ steps: allSteps, running, startedAt, durationMs }: RunProcessProps) {
  const { t } = useI18n();
  const reasoning = useReasoningDisplay(),
    steps = reasoning === 'hidden' ? allSteps.filter((step) => step.kind !== 'reasoning') : allSteps;
  const [expanded, setExpanded] = useState(false);
  const listId = useId(),
    wasRunning = useRef(running),
    elapsed = useElapsed(running ? startedAt : undefined);
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
  // Folded, a working run keeps only what it said; every tool and thought goes into the capsule.
  const transcript = visibleRunSteps(steps, { running, expanded, stepLimit: 0 });
  const overview = runOverview(steps),
    time = running ? elapsed : durationMs;
  const status = running
    ? time !== undefined
      ? t('处理中 · {duration}', { duration: durationLabel(t, time) })
      : t('处理中')
    : time !== undefined
      ? t('已处理 {duration}', { duration: durationLabel(t, time) })
      : t('处理过程');
  const kinds = overview.parts.length ? overview.parts.map((part) => part.text).join(t('，')) : '';
  const changed = overview.added > 0 || overview.removed > 0;
  const thumbnails = overview.images.slice(-3),
    moreImages = overview.images.length - thumbnails.length;
  return (
    <div className={`run-process ${running ? 'is-running' : ''} ${expanded ? 'is-expanded' : ''}`}>
      <div className="run-process-line">
        <button
          type="button"
          className="run-process-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-label={[status, kinds, t(expanded ? '收起处理过程' : '展开处理过程')].filter(Boolean).join(' · ')}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="run-process-status">
            {running ? (
              <span className="run-process-spinner" />
            ) : (
              <span className="run-process-done">
                <Icon name="check" size={10} />
              </span>
            )}
            {status}
          </span>
          {overview.parts.length > 0 ? (
            <span className="run-process-kinds">
              {overview.parts.map((part) => (
                <span key={part.kind} className="run-process-kind" title={part.text}>
                  <Icon name={KIND_ICONS[part.kind] || 'more'} size={13} />
                  <b>{part.count}</b>
                </span>
              ))}
            </span>
          ) : (
            <span className="run-process-kinds">{t('{count} 个步骤', { count: steps.length })}</span>
          )}
          {changed && (
            <span
              className="run-process-diff"
              title={t('新增 {added} 行，删除 {removed} 行', { added: overview.added, removed: overview.removed })}
            >
              <span className="is-added">+{overview.added}</span>
              <span className="is-removed">−{overview.removed}</span>
            </span>
          )}
          <Icon name="chevron" size={12} />
        </button>
        {thumbnails.length > 0 && (
          <span className="run-process-images" aria-hidden="true" onClick={() => setExpanded(!expanded)}>
            {thumbnails.map((id) => (
              <span key={id} className="run-process-thumb">
                <ScreenshotImage id={id} alt="" />
              </span>
            ))}
            {moreImages > 0 && <span className="run-process-more-images">+{moreImages}</span>}
          </span>
        )}
      </div>
      {transcript.steps.length > 0 && (
        <ol className={running && !expanded ? 'run-transcript' : 'run-process-steps'} id={listId}>
          {transcript.steps.map((step) =>
            step.kind === 'tool' ? (
              <ToolStep key={step.id} message={step.message} />
            ) : step.kind === 'note' ? (
              <li key={step.id} className="run-step run-step-note">
                <NoteBubble message={step.message} />
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
