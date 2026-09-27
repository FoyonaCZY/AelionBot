import { useState } from 'react';
import type { DesignComment, DesignFinding, DesignSession } from '../../shared/types/designer-types';
import { primaryDesignArtifact as primaryArtifact } from '../../shared/preview/designer-canvas';
import { Icon } from '../ui/Icon';
import { PreviewIcon } from '../preview/PreviewIcon';

/**
 * Deliverables, checks and the accept action, kept out of the conversation scroll so they stay
 * reachable however long the thread grows. Compact by default; the detail list is opt-in.
 */
export function DesignerDelivery({
  task,
  en,
  findings,
  blocking,
  comments,
  busy,
  onShow,
  onAccept,
}: {
  task: DesignSession;
  en: boolean;
  findings: Array<DesignFinding & { path: string }>;
  blocking: number;
  comments: DesignComment[];
  busy: boolean;
  onShow: (index?: number) => void;
  onAccept: () => void;
}) {
  const [open, setOpen] = useState(false);
  const primary = task.artifacts.find((artifact) => primaryArtifact(task.kind, artifact.path)) || task.artifacts[0];
  const details = task.artifacts.length + comments.length + findings.length + task.checks.length;
  const accepted = task.status === 'completed';
  const formatCheck = task.checks.find((check) => check.id === 'format');
  const canAccept = Boolean(primary && formatCheck?.status === 'passed');
  const issues = blocking + findings.filter((f) => f.level === 'P1').length;
  const checkLabel = issues
    ? en
      ? `${issues} issues`
      : `${issues} 项问题`
    : formatCheck?.status === 'passed'
      ? en
        ? 'Checked'
        : '检查通过'
      : formatCheck?.status === 'failed'
        ? en
          ? 'Check failed'
          : '检查未通过'
        : '';
  if (!details && !accepted) return null;
  return (
    <section className="designer-delivery-bar" aria-label={en ? 'Deliverables' : '交付成果'}>
      <div className="designer-delivery-row">
        {primary ? (
          <button
            type="button"
            className="designer-delivery-primary"
            onClick={() => onShow(Math.max(0, task.artifacts.indexOf(primary)))}
            title={primary.name}
          >
            <span className="designer-delivery-file-icon">
              <PreviewIcon name={primary.kind === 'pptx' || primary.kind === 'pdf' ? 'pages' : 'code'} />
            </span>
            <span>{primary.name}</span>
            {task.artifacts.length > 1 && <small>+{task.artifacts.length - 1}</small>}
          </button>
        ) : (
          <span className="designer-delivery-label">
            <Icon name="check" size={15} />
            {en ? 'Review' : '检查'}
          </span>
        )}
        <div className="designer-delivery-actions">
          {details > 0 && (
            <button
              type="button"
              className="designer-delivery-toggle"
              title={checkLabel || undefined}
              aria-expanded={open}
              aria-controls={'design-details-' + task.id}
              onClick={() => setOpen((value) => !value)}
            >
              {checkLabel && (
                <span
                  className="designer-delivery-check"
                  data-warning={issues > 0 || formatCheck?.status === 'failed' || undefined}
                  title={checkLabel}
                >
                  <Icon name={issues > 0 || formatCheck?.status === 'failed' ? 'alert' : 'check'} size={14} />
                  {issues > 0 && <b>{issues}</b>}
                </span>
              )}
              <span>{en ? 'Details' : '详情'}</span>
              <Icon name="down" size={12} />
            </button>
          )}
          {(primary || accepted) && (
            <button
              type="button"
              className="designer-accept"
              disabled={busy || accepted || !canAccept}
              data-accepted={accepted || undefined}
              title={
                !canAccept && !accepted ? (en ? 'Complete the file check first' : '文件检查通过后可确认') : undefined
              }
              onClick={onAccept}
            >
              <Icon name="check" size={14} />
              {accepted ? (en ? 'Accepted' : '已确认') : en ? 'Accept' : '确认完成'}
            </button>
          )}
        </div>
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
