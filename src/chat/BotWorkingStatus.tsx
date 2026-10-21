import { useEffect, useState } from 'react';
import type { Bot } from '../../shared/types/core';
import { waitingExplanation, type LiveBotProgress } from '../app/live-bot-progress';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import './bot-working-status.css';

export function BotWorkingStatus({
  bot,
  step,
  showName = false,
  onReview,
}: {
  bot: Pick<Bot, 'id' | 'name' | 'color' | 'avatarStyle'>;
  step: LiveBotProgress;
  showName?: boolean;
  onReview?: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!step.since) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [step.since]);
  const slow = waitingExplanation(step, now);
  return (
    <div className="bot-working-status" data-working-bot={bot.id} data-phase={step.phase}>
      <span className="bot-working-avatar" aria-hidden="true">
        <Avatar bot={bot} size={48} activity={step.phase} />
      </span>
      <div className="bot-working-copy">
        {showName && <span className="bot-working-name">{bot.name}</span>}
        <div role="status" aria-live="polite" aria-atomic="true">
          <div className="bot-working-title">
            <span className="bot-working-label">
              {slow && step.waitingOn === 'model' && !step.retry ? t('还在等待模型回复') : step.label}
            </span>
            {slow && <span className="bot-working-tag">{t('等待较久')}</span>}
          </div>
          {step.detail && <p className="bot-working-detail">{step.detail}</p>}
        </div>
        {step.needsInput && onReview && (
          <div className="bot-working-actions">
            <button type="button" onClick={onReview}>
              {t('查看请求')}
              <Icon name="arrow" size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
