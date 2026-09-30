import { useState } from 'react';
import type { DesignComment, DesignFinding, DesignSession } from '../../shared/types/designer-types';
import { primaryDesignArtifact as primaryArtifact } from '../../shared/preview/designer-canvas';
import { PreviewIcon } from '../preview/PreviewIcon';
import { useI18n } from '../i18n';
import { deliveryState } from './designer-round';

/**
 * Deliverables, checks and the accept action, kept out of the conversation scroll so they stay
 * reachable however long the thread grows. Compact by default; the detail list is opt-in.
 */
export function DesignerDelivery({
  task,
  findings,
  blocking,
  comments,
  busy,
  running = false,
  onStop,
  onShow,
  onAccept,
}: {
  running?: boolean;
  onStop?: () => void;
  task: DesignSession;
  findings: Array<DesignFinding & { path: string }>;
  blocking: number;
  comments: DesignComment[];
  busy: boolean;
  onShow: (index?: number) => void;
  onAccept: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const primary = task.artifacts.find((artifact) => primaryArtifact(task.kind, artifact.path)) || task.artifacts[0];
  const details = task.artifacts.length + comments.length + findings.length + task.checks.length;
  const accepted = task.status === 'completed';
  const formatCheck = task.checks.find((check) => check.id === 'format');
  const canAccept = Boolean(primary && formatCheck?.status === 'passed');
  const state = deliveryState({ accepted, running, blocking, canAccept });
  const advisory = findings.filter((f) => f.level !== 'P0').length;
  if (!details && !accepted && !running) return null;
  const firstBlocking = findings.find((f) => f.level === 'P0');
  const primaryIndex = primary ? Math.max(0, task.artifacts.indexOf(primary)) : 0;
  return (
    <section className="designer-delivery-bar" data-state={state} aria-label={t('交付成果')}>
      <div className="designer-delivery-status" role="status">
        <span className="designer-delivery-dot" aria-hidden="true" />
        <b>
          {
            {
              running: t('生成中'),
              blocked: t('有 {count} 个阻塞问题', { count: blocking }),
              pending: t('待确认'),
              accepted: t('已确认'),
              empty: t('还没有可交付的文件'),
            }[state]
          }
        </b>
        <span className="designer-delivery-detail">
          {state === 'blocked'
            ? firstBlocking?.message
            : state === 'running'
              ? primary?.name || ''
              : primary
                ? primary.name + (task.artifacts.length > 1 ? ' +' + (task.artifacts.length - 1) : '')
                : ''}
        </span>
        {state === 'pending' && advisory > 0 && (
          <span className="designer-delivery-pill">{t('{count} 条建议', { count: advisory })}</span>
        )}
        <span className="designer-delivery-space" />
        {state === 'running' && onStop && (
          <button type="button" className="designer-delivery-button" onClick={onStop}>
            {t('停止')}
          </button>
        )}
        {state !== 'running' && details > 0 && (
          <button
            type="button"
            className="designer-delivery-button"
            aria-expanded={open}
            aria-controls={'design-details-' + task.id}
            onClick={() => setOpen((value) => !value)}
          >
            {t(open ? '收起' : '查看')}
          </button>
        )}
        {state === 'pending' && (
          <button type="button" className="designer-delivery-button is-primary" disabled={busy} onClick={onAccept}>
            {t('确认交付')}
          </button>
        )}
        {state === 'accepted' && primary && (
          <button type="button" className="designer-delivery-button" onClick={() => onShow(primaryIndex)}>
            {t('打开')}
          </button>
        )}
      </div>
      {open && (
        <div className="designer-delivery-details" id={'design-details-' + task.id}>
          {task.artifacts.map((artifact, index) => (
            <button
              key={artifact.path}
              className="designer-artifact"
              title={artifact.name}
              onClick={() => onShow(index)}
            >
              <PreviewIcon name={artifact.kind === 'pptx' || artifact.kind === 'pdf' ? 'pages' : 'code'} />
              <span>{artifact.name}</span>
              <small>{Math.ceil(artifact.bytes / 1024)} KB</small>
              <PreviewIcon name="right" />
            </button>
          ))}
          {comments.length > 0 && (
            <ul className="designer-comments">
              {comments.map((comment) => (
                <li key={comment.id}>
                  <strong>{comment.designId ? `#${comment.designId}` : comment.path}</strong>
                  <span>{comment.text}</span>
                </li>
              ))}
            </ul>
          )}
          {task.checks.length > 0 && (
            <div className="designer-checks">
              {task.checks.map((check) => (
                <span key={check.id} data-status={check.status}>
                  {check.status === 'passed' ? '✓' : check.status === 'failed' ? '!' : '○'} {check.label}
                </span>
              ))}
            </div>
          )}
          {findings.length > 0 && (
            <ul className="designer-findings">
              {findings.slice(0, 12).map((finding) => (
                <li key={finding.path + finding.id} data-level={finding.level}>
                  <span className="designer-finding-level">{finding.level}</span>
                  <span className="designer-finding-body">
                    <strong>{finding.message}</strong>
                    <small>{finding.hint}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
