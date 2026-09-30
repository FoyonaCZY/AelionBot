import { useEffect, useId, useRef, useState } from 'react';
import type { AttachmentScope } from '../../shared/types/attachment-types';
import type { Bot } from '../../shared/types/core';
import type { WorkItem, WorkAction } from '../../shared/types/work-types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import './work-items.css';

const labels = {
  planning: '正在规划',
  ready: '等待确认',
  running: '执行中',
  paused: '已暂停',
  blocked: '需要处理',
  completed: '已完成',
  cancelled: '已取消',
};
/** Upcoming steps shown after the current one before the rest fold into "N more". */
const UPCOMING = 2;
type Step = NonNullable<WorkItem['plan']>['steps'][number];

function KindMark({ kind }: { kind: WorkItem['kind'] }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      {kind === 'plan' ? (
        <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" strokeLinecap="round" />
      ) : (
        <>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}
function StepRow({ step, index }: { step: Step; index: number }) {
  const { t } = useI18n();
  return (
    <li data-status={step.status}>
      <span
        className="work-step-mark"
        role="img"
        aria-label={
          step.status === 'done'
            ? t('已完成')
            : step.status === 'skipped'
              ? t('已跳过')
              : step.status === 'working'
                ? t('进行中')
                : t('第 {index} 步', { index: index + 1 })
        }
      >
        {step.status === 'done' ? (
          <Icon name="check" size={10} />
        ) : step.status === 'skipped' ? (
          '−'
        ) : step.status === 'working' ? null : (
          index + 1
        )}
      </span>
      <div>
        <strong>{step.title}</strong>
        {step.status === 'working' && step.acceptance && <p>{step.acceptance}</p>}
        {step.note && <p className="work-step-note">{step.note}</p>}
      </div>
    </li>
  );
}
/** Done steps fold into one line and upcoming ones beyond the next few do too, so the current step stays in view. */
function StepList({ steps, full }: { steps: Step[]; full: boolean }) {
  const { t } = useI18n();
  const [showDone, setShowDone] = useState(false),
    [showRest, setShowRest] = useState(false);
  const current = steps.findIndex((step) => step.status === 'working' || step.status === 'pending');
  const finished = current < 0 ? steps.length : current;
  const doneFold = !full && !showDone && finished > 1;
  const restStart = current < 0 ? steps.length : current + 1 + UPCOMING;
  const restFold = !full && !showRest && steps.length - restStart > 1;
  return (
    <ol className="work-steps">
      {doneFold ? (
        <li className="work-step-fold" data-status="done">
          <span className="work-step-mark" aria-hidden="true">
            <Icon name="check" size={10} />
          </span>
          <button type="button" onClick={() => setShowDone(true)}>
            {t('已完成 {count} 步', { count: finished })}
          </button>
        </li>
      ) : null}
      {steps.map((step, index) =>
        (doneFold && index < finished) || (restFold && index >= restStart) ? null : (
          <StepRow key={step.id} step={step} index={index} />
        ),
      )}
      {restFold ? (
        <li className="work-step-fold">
          <span className="work-step-mark" aria-hidden="true">
            ⋯
          </span>
          <button type="button" onClick={() => setShowRest(true)}>
            {t('还有 {count} 步', { count: steps.length - restStart })}
          </button>
        </li>
      ) : null}
    </ol>
  );
}
function WorkMenu({
  pending,
  onCancel,
  onCopy,
  workspaceDir,
}: {
  pending: boolean;
  onCancel: () => void;
  onCopy: () => void;
  workspaceDir?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const menuId = useId(),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node))
        setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <div className="work-menu" ref={root}>
      <button
        type="button"
        className="work-icon-button"
        aria-label={t('更多操作')}
        title={t('更多操作')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="6" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div className="work-menu-list" role="menu" id={menuId}>
          <button type="button" role="menuitem" onClick={() => choose(onCopy)}>
            <Icon name="copy" size={13} />
            {t('复制目标')}
          </button>
          {workspaceDir && (
            <button
              type="button"
              role="menuitem"
              title={workspaceDir}
              onClick={() => choose(() => void navigator.clipboard?.writeText(workspaceDir))}
            >
              <Icon name="folder" size={13} />
              {t('复制工作目录')}
            </button>
          )}
          <div className="work-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            disabled={pending}
            onClick={() => choose(onCancel)}
          >
            <Icon name="close" size={13} />
            {t('取消')}
          </button>
        </div>
      )}
    </div>
  );
}
function WorkCard({ item, bots }: { item: WorkItem; bots: Bot[] }) {
  const { t } = useI18n();
  const bodyId = useId();
  // Only states that need a decision open by themselves; running work stays a one-line strip.
  const needsDecision = item.status === 'ready' || item.status === 'blocked';
  const [open, setOpen] = useState(needsDecision),
    [fullObjective, setFullObjective] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (item.status === 'ready' || item.status === 'blocked') setOpen(true);
    else if (item.status === 'running') setOpen(false);
  }, [item.status]);
  const act = async (action: WorkAction['action']) => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await window.aelion.workAction({ id: item.id, action });
    } catch (error) {
      setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
    } finally {
      setPending(false);
    }
  };
  const ended = ['completed', 'cancelled'].includes(item.status),
    active = Boolean(item.activeRunId),
    steps = item.plan?.steps || [],
    done = steps.filter((step) => step.status === 'done' || step.status === 'skipped').length,
    currentIndex = steps.findIndex((step) => step.status === 'working'),
    current = currentIndex >= 0 ? steps[currentIndex] : undefined,
    bot = bots.find((bot) => bot.id === item.botId),
    kind = t(item.kind === 'plan' ? '计划' : '目标');
  const startLabel = pending
    ? t('正在处理…')
    : item.kind === 'plan' && !item.approvedAt
      ? steps.length
        ? t('开始执行')
        : t('继续规划')
      : t('继续执行');
  return (
    <section
      className={`work-card companion-surface work-${item.status} ${open ? 'is-open' : ''}`}
      data-work-id={item.id}
      aria-label={t('{kind}：{objective}', { kind, objective: item.objective })}
    >
      <div className="work-card-heading">
        <button
          type="button"
          className="work-card-toggle"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          aria-label={t('{action}{kind}：{objective}', {
            action: t(open ? '收起' : '展开'),
            kind,
            objective: item.objective,
          })}
          onClick={() => setOpen(!open)}
        >
          <span className={`work-kind work-kind-${item.kind}`}>
            <KindMark kind={item.kind} />
            {kind}
          </span>
          <span className="work-card-title" title={item.objective}>
            {item.objective}
          </span>
        </button>
        <span className="work-status">
          {t(labels[item.status])}
          {item.status === 'ready' && steps.length > 0 && <> · {t('{count} 步', { count: steps.length })}</>}
        </span>
        {item.scope.kind === 'group' && bot && (
          <span className="work-owner" title={bot.name}>
            <Avatar bot={bot} size={20} />
          </span>
        )}
        {active && !ended && (
          <button
            type="button"
            className="work-icon-button"
            aria-label={item.status === 'paused' ? t('正在暂停…') : t('暂停')}
            title={item.status === 'paused' ? t('正在暂停…') : t('暂停')}
            disabled={pending || ['paused', 'blocked'].includes(item.status)}
            onClick={() => void act('pause')}
          >
            <Icon name="pause" size={13} />
          </button>
        )}
        {!ended && (
          <WorkMenu
            pending={pending}
            onCancel={() => void act('cancel')}
            onCopy={() => void navigator.clipboard?.writeText(item.objective)}
            workspaceDir={item.workspaceDir}
          />
        )}
      </div>
      {steps.length > 0 && item.status !== 'ready' && (
        <div
          className="work-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          aria-label={t('已处理 {done} 步，共 {total} 步', { done, total: steps.length })}
        >
          {steps.map((step) => (
            <i key={step.id} data-status={step.status} />
          ))}
        </div>
      )}
      {!open && (current || steps.length > 0) && (
        <div className="work-now" onClick={() => setOpen(true)} aria-hidden="true">
          {current && <span className="work-now-index">{t('第 {index} 步', { index: currentIndex + 1 })}</span>}
          <span className="work-now-title">
            {current?.title || (done === steps.length ? t('步骤都已完成') : steps[done]?.title)}
          </span>
          <span className="work-progress-count">
            {done} / {steps.length}
          </span>
        </div>
      )}
      {open && (
        <div className="work-card-body" id={bodyId}>
          {/* A short objective already reads in full in the title; only a long one is repeated here. */}
          {item.objective.length > 40 && (
            <p className={`work-objective ${fullObjective ? 'is-full' : ''}`}>{item.objective}</p>
          )}
          {item.objective.length > 90 && (
            <button type="button" className="work-text-button" onClick={() => setFullObjective(!fullObjective)}>
              {fullObjective ? t('收起全文') : t('展开全文')}
            </button>
          )}
          {steps.length > 0 && <StepList steps={steps} full={item.status === 'ready'} />}
          {item.summary && <p className="work-summary">{item.summary}</p>}
        </div>
      )}
      {item.reason && !ended && <p className="work-reason">{item.reason}</p>}
      {!ended && !active && (
        <div className="work-card-actions">
          {open && item.workspaceDir && (
            <span className="work-directory" title={item.workspaceDir}>
              <Icon name="folder" size={12} />
              <span>{item.workspaceDir}</span>
            </span>
          )}
          <button
            type="button"
            className="work-start companion-button companion-primary"
            disabled={pending}
            onClick={() => void act('start')}
          >
            {startLabel}
          </button>
        </div>
      )}
      {open && active && item.workspaceDir && (
        <div className="work-card-actions is-quiet">
          <span className="work-directory" title={item.workspaceDir}>
            <Icon name="folder" size={12} />
            <span>{item.workspaceDir}</span>
          </span>
        </div>
      )}
      {error && (
        <p className="work-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function WorkItemsPanel({
  items = [],
  scope,
  bots,
}: {
  items?: WorkItem[];
  scope: AttachmentScope;
  bots: Bot[];
}) {
  const active = items
    .filter(
      (item) =>
        item.scope.kind === scope.kind &&
        item.scope.id === scope.id &&
        bots.some((bot) => bot.id === item.botId) &&
        !['completed', 'cancelled'].includes(item.status),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return active.length ? (
    <div className="work-items-panel">
      {active.map((item) => (
        <WorkCard key={item.id} item={item} bots={bots} />
      ))}
    </div>
  ) : null;
}
