import { memo, useEffect, useId, useRef, useState } from 'react';
import type { ChatMessage } from '../../shared/types/core';
import { readableContent, toolDisplay, toolResult, type RunStep } from '../../shared/chat/activity';
import { stepMeta } from './tool-details-model';
import { AttachmentList } from '../files/Attachments';
import { Icon } from '../ui/Icon';
import { MentionContent } from '../ui/MentionContent';
import { MessageReasoning, useReasoningDisplay } from './MessageReasoning';
import { ToolDetails } from './ToolDetails';
import { useI18n } from '../i18n';
import { shallowEqual } from '../ui/equality';
import { REVEAL_MESSAGE_EVENT } from './reveal-message';
import './run-process.css';

/** Steps kept visible while a run is working and the list is not expanded. */
const LIVE_TAIL = 3;
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
        {display.detail && (
          <span className="run-step-detail" title={display.detail}>
            {display.detail}
          </span>
        )}
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

function NoteStep({ message }: { message: ChatMessage }) {
  const content = readableContent(message.content);
  return (
    <li className="run-step run-step-note" data-message-id={message.id}>
      {content && (
        <div className="markdown">
          <MentionContent content={content} mentions={message.mentions} markdown />
        </div>
      )}
      <AttachmentList files={message.attachments} />
    </li>
  );
}

const durationLabel = (t: ReturnType<typeof useI18n>['t'], ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds >= 60
    ? t('{minutes} 分 {seconds} 秒', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
    : t('{seconds} 秒', { seconds });
};

/**
 * Everything a run did before its answer, folded into one line once the run ends. While the run works the newest
 * steps stay visible so progress is readable without the history growing without bound.
 */
type RunProcessProps = { steps: RunStep[]; running: boolean; durationMs?: number };
export const RunProcess = memo(
  RunProcessView,
  (a: RunProcessProps, b: RunProcessProps) =>
    a.running === b.running &&
    a.durationMs === b.durationMs &&
    a.steps.length === b.steps.length &&
    a.steps.every((step, index) => shallowEqual(step, b.steps[index])),
);
function RunProcessView({ steps: allSteps, running, durationMs }: RunProcessProps) {
  const { t } = useI18n();
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
  const visible = expanded ? steps : running ? steps.slice(-LIVE_TAIL) : [],
    hidden = steps.length - visible.length;
  const summary = running
    ? t('正在处理 · {count} 个步骤', { count: steps.length })
    : durationMs !== undefined
      ? t('已处理 {duration} · {count} 个步骤', { duration: durationLabel(t, durationMs), count: steps.length })
      : t('处理过程 · {count} 个步骤', { count: steps.length });
  return (
    <div className={`run-process ${running ? 'is-running' : ''} ${expanded ? 'is-expanded' : ''}`}>
      <button
        type="button"
        className="run-process-toggle"
        aria-expanded={expanded}
        aria-controls={visible.length ? listId : undefined}
        aria-label={`${summary} · ${t(expanded ? '收起处理过程' : '展开处理过程')}`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="run-process-mark">
          {running ? <span className="run-step-spinner" /> : <Icon name="layers" size={13} />}
        </span>
        <span className="run-process-summary">{summary}</span>
        <Icon name="chevron" size={12} />
      </button>
      {visible.length > 0 && (
        <ol className="run-process-steps" id={listId}>
          {hidden > 0 && (
            <li className="run-step run-step-more">
              <button type="button" onClick={() => setExpanded(true)}>
                {t('还有 {count} 个较早的步骤', { count: hidden })}
              </button>
            </li>
          )}
          {visible.map((step) =>
            step.kind === 'tool' ? (
              <ToolStep key={step.id} message={step.message} />
            ) : step.kind === 'note' ? (
              <NoteStep key={step.id} message={step.message} />
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
