import type { ChatMessage, RunRecord, StreamingReply as Reply, ModelConfig } from '../../shared/types/core';
import { contextNeedsChange } from '../../shared/chat/context-issue';
import { StreamingReply } from './StreamingReply';
import { friendlyError, runDurationMs, runPresentation, runSteps } from '../../shared/chat/activity';
import { Icon } from '../ui/Icon';
import { Message } from '../ui/Message';
import { useI18n } from '../i18n';
import './activity.css';
import { OperationDenial } from './OperationDenial';
import { RunProcess } from './RunProcess';

export function RunMessage({
  messages,
  isLast = true,
  run,
  stream,
  latest,
  canContinue,
  onContinue,
  onSettings,
  onReply,
  model,
}: {
  messages: ChatMessage[];
  allMessages?: ChatMessage[];
  isLast?: boolean;
  run?: RunRecord;
  stream?: Reply;
  latest: boolean;
  canContinue: boolean;
  waiting?: 'host_permission' | 'vm_takeover' | 'user_input';
  reviewing?: boolean;
  onContinue: () => void;
  onSettings: (tab: 'model' | 'computer' | 'mcp') => void;
  onScreen?: (url: string) => void;
  onReply?: (message: ChatMessage) => void;
  model?: ModelConfig;
}) {
  const { t } = useI18n();
  const view = runPresentation(messages, run);
  const running = isLast && view.status === 'running',
    failed = isLast && ['failed', 'interrupted'].includes(view.status),
    cancelled = isLast && view.status === 'cancelled';
  const notice = friendlyError(view.error);
  const contextBlocked = contextNeedsChange(run?.contextIssue, model),
    settingsChanged = Boolean(run?.contextIssue && model && !contextBlocked),
    description = settingsChanged
      ? t('模型设置已更新，可重新整理记录并继续原任务。')
      : notice.context && run?.contextIssue?.estimatedTokens && run.contextIssue.inputBudget
        ? t('预计需要 {estimated} token，当前输入预算 {budget}。工作记录已保留，请调整模型设置后继续。', {
            estimated: run.contextIssue.estimatedTokens.toLocaleString(),
            budget: run.contextIssue.inputBudget.toLocaleString(),
          })
        : notice.description;
  // Everything before the answer (reasoning, progress text, tool steps) folds into one process line, in the
  // order it happened. Only the final answer stays in the chat as a full message.
  const final = isLast ? view.final : undefined;
  const steps = runSteps(messages, { finalId: final?.id, error: view.error });
  const showError = failed && latest,
    showStopped = cancelled && latest && !run?.groupUpdated && !run?.inputUpdated;
  const denials = messages.filter((message) => message.operationDenial);
  if (!steps.length && !denials.length && !showError && !showStopped && !(stream && running) && !final) return null;
  return (
    <div
      className="run-message"
      data-run-id={run?.id || messages[0]?.runId}
      data-run-segment={messages[0]?.id}
      data-run-terminal={isLast}
    >
      <RunProcess steps={steps} running={running} durationMs={isLast ? runDurationMs(run) : undefined} />
      {denials.map((message) => (
        <OperationDenial key={message.id} denial={message.operationDenial!} />
      ))}
      {showError && (
        <div className="run-notice" role="status">
          <span className="run-notice-icon">
            <Icon name="alert" size={18} />
          </span>
          <div>
            <strong>{notice.title}</strong>
            <p>{description}</p>
            {(canContinue || notice.settings) && (
              <div className="run-notice-actions">
                {canContinue && !contextBlocked && (
                  <button onClick={onContinue}>
                    {notice.context ? t('整理记录并继续') : t('继续处理')}
                    <Icon name="arrow" size={13} />
                  </button>
                )}
                {notice.settings && <button onClick={() => onSettings(notice.settings!)}>{t('检查设置')}</button>}
              </div>
            )}
            <details className="run-error-details">
              <summary>{t('查看详情')}</summary>
              {run && <p>{t('任务 {id} · {count} 个工具步骤', { id: run.id, count: run.toolCalls })}</p>}
              <pre>{view.error.slice(0, 12000)}</pre>
            </details>
          </div>
        </div>
      )}
      {showStopped && (
        <div className="run-stopped">
          <p>
            {view.error?.startsWith('用户拒绝') || view.error?.startsWith('用户取消')
              ? view.error
              : t('已停止，完成的操作和文件仍然保留。')}
          </p>
          {canContinue && (
            <button onClick={onContinue}>
              {t('继续处理')}
              <Icon name="arrow" size={13} />
            </button>
          )}
        </div>
      )}
      {stream && running && <StreamingReply reply={stream} />}
      {final && <Message message={final} allowPins={!run?.groupOrigin} onReply={onReply} showReasoning={false} />}
    </div>
  );
}
