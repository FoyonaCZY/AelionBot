import { useEffect, useState } from 'react';
import { formatTeachingClock, selectBoundedItems } from '../../shared/teaching/teaching-events';
import { TEACHING_LIMITS, type TeachingDraft, type TeachingNarrationSegment } from '../../shared/types/teaching-types';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import './teaching.css';

export function TeachingReviewDialog({
  draft,
  sending,
  onSend,
  onDiscard,
}: {
  draft: TeachingDraft;
  sending: boolean;
  onSend: (input: {
    title: string;
    notes: string;
    narration: TeachingNarrationSegment[];
    selectedKeyframeIds: string[];
  }) => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [narration, setNarration] = useState<TeachingNarrationSegment[]>(draft.narration);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    selectBoundedItems(draft.keyframes, TEACHING_LIMITS.maxAttachedKeyframes).map((frame) => frame.id),
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) {
        event.preventDefault();
        onDiscard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sending, onDiscard]);

  const toggleKeyframe = (id: string) => {
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= TEACHING_LIMITS.maxAttachedKeyframes) return current;
      return [...current, id];
    });
  };

  const updateSegment = (index: number, text: string) => {
    setNarration((current) => current.map((item, i) => (i === index ? { ...item, text } : item)));
  };

  const removeSegment = (index: number) => {
    setNarration((current) => current.filter((_, i) => i !== index));
  };

  const addSegment = () => {
    const startMs = narration.length ? narration.at(-1)!.endMs : 0;
    setNarration((current) => [...current, { startMs, endMs: startMs, clock: formatTeachingClock(startMs), text: '' }]);
  };

  const selectedSet = new Set(selectedIds);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !sending) onDiscard();
      }}
    >
      <section className="modal teaching-review-modal" role="dialog" aria-modal="true" aria-label={t('确认演示内容')}>
        <header>
          <h2>{t('确认演示内容')}</h2>
          <div className="modal-header-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={t('关闭对话框')}
              disabled={sending}
              onClick={onDiscard}
            >
              <Icon name="close" />
            </button>
          </div>
        </header>
        <div className="teaching-body">
          <div className="teaching-summary-row">
            <span className="teaching-status-pill is-ok">
              {draft.target === 'host' ? t('这台电脑') : t('工作电脑')}
            </span>
            <span className="teaching-status-pill">{formatTeachingClock(draft.durationMs)}</span>
            <span className="teaching-status-pill">{t('{count} 步', { count: draft.steps.length })}</span>
            <span className="teaching-status-pill">{t('{count} 张关键帧', { count: draft.keyframes.length })}</span>
          </div>

          {draft.narrationWarning && (
            <div className="teaching-notice" role="status">
              <span>{draft.narrationWarning}</span>
            </div>
          )}

          <div className="teaching-meta-grid">
            <div className="teaching-field">
              <label htmlFor="teaching-skill-title">{t('技能名称（可选）')}</label>
              <input
                id="teaching-skill-title"
                className="teaching-input"
                value={title}
                placeholder={t('例如：导出月度报表')}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="teaching-field">
              <label htmlFor="teaching-skill-notes">{t('补充说明（可选）')}</label>
              <textarea
                id="teaching-skill-notes"
                className="teaching-textarea"
                value={notes}
                placeholder={t('补充规则、参数或注意事项')}
                maxLength={2000}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
          </div>

          <div className="teaching-field">
            <div className="teaching-field-head">
              <span className="teaching-section-title">{t('语音讲解时间轴')}</span>
              <button type="button" className="text-button" onClick={addSegment}>
                {t('添加一行')}
              </button>
            </div>
            {narration.length ? (
              <div className="teaching-narration-list">
                {narration.map((segment, index) => (
                  <div className="teaching-narration-row" key={`${segment.startMs}-${index}`}>
                    <span className="teaching-clock-chip">{segment.clock}</span>
                    <input
                      className="teaching-input"
                      value={segment.text}
                      aria-label={t('讲解内容 {clock}', { clock: segment.clock })}
                      onChange={(event) => updateSegment(index, event.target.value)}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('删除讲解')}
                      onClick={() => removeSegment(index)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="teaching-empty">{t('本次没有语音转写内容')}</div>
            )}
          </div>

          <div className="teaching-field">
            <span className="teaching-section-title">{t('记录的操作步骤')}</span>
            {draft.steps.length ? (
              <div className="teaching-steps-box">
                {draft.steps.map((step) => (
                  <div className="teaching-step-row" key={step.id}>
                    <span className="teaching-clock-chip">{step.clock}</span>
                    <span>{step.summary}</span>
                    {step.windowTitle && !step.summary.includes(step.windowTitle) && (
                      <span className="teaching-step-window">{step.windowTitle}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="teaching-empty">{t('未记录到点击或输入步骤')}</div>
            )}
          </div>

          {draft.keyframes.length > 0 && (
            <div className="teaching-field">
              <div className="teaching-field-head">
                <span className="teaching-section-title">{t('关键帧截图')}</span>
                <span className="teaching-status-pill">
                  {t('已选 {selected}/{max}', {
                    selected: selectedIds.length,
                    max: Math.min(draft.keyframes.length, TEACHING_LIMITS.maxAttachedKeyframes),
                  })}
                </span>
              </div>
              <div className="teaching-keyframes-grid">
                {draft.keyframes.map((frame) => {
                  const selected = selectedSet.has(frame.id);
                  const limitReached = !selected && selectedIds.length >= TEACHING_LIMITS.maxAttachedKeyframes;
                  return (
                    <label key={frame.id} className={`teaching-keyframe-card ${selected ? 'is-selected' : ''}`}>
                      <img src={frame.dataUrl} alt={frame.label} />
                      <div className="teaching-keyframe-foot">
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={limitReached}
                          onChange={() => toggleKeyframe(frame.id)}
                        />
                        <span>{frame.clock}</span>
                        <span className="teaching-keyframe-label" title={frame.label}>
                          {frame.label}
                        </span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="teaching-footer">
          <button type="button" className="secondary-button" disabled={sending} onClick={onDiscard}>
            {t('放弃')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={sending}
            onClick={() =>
              onSend({
                title,
                notes,
                narration,
                selectedKeyframeIds: selectedIds,
              })
            }
          >
            {sending ? t('正在发送…') : t('交给 Bot 生成技能')}
          </button>
        </div>
      </section>
    </div>
  );
}
