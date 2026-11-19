import { formatTeachingClock } from '../../shared/teaching/teaching-events';
import type { TeachingTarget } from '../../shared/types/teaching-types';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import './teaching.css';

export function TeachingBar({
  finishing,
  target,
  seconds,
  stepCount,
  micActive,
  micMuted,
  onToggleMute,
  onFinish,
  onCancel,
}: {
  finishing: boolean;
  target: TeachingTarget;
  seconds: number;
  stepCount: number;
  micActive: boolean;
  micMuted: boolean;
  onToggleMute: () => void;
  onFinish: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="teaching-bar" role="status" aria-live="polite">
      {finishing ? (
        <>
          <span className="teaching-bar-spinner" aria-hidden="true" />
          <span className="teaching-bar-meta">{t('正在整理演示与语音时间轴…')}</span>
        </>
      ) : (
        <>
          <span className="teaching-bar-dot" aria-hidden="true" />
          <span className="teaching-bar-timer" role="timer">
            {formatTeachingClock(seconds * 1000)}
          </span>
          <span className="teaching-bar-meta">
            {target === 'host' ? t('这台电脑') : t('工作电脑')} · {t('{count} 步', { count: stepCount })}
          </span>
          <div className="teaching-bar-actions">
            {micActive && (
              <button
                type="button"
                className={`icon-button teaching-bar-mic ${micMuted ? 'is-muted' : ''}`}
                aria-label={micMuted ? t('取消静音') : t('静音麦克风')}
                title={micMuted ? t('取消静音') : t('静音麦克风')}
                aria-pressed={micMuted}
                onClick={onToggleMute}
              >
                <Icon name={micMuted ? 'micOff' : 'mic'} size={16} />
              </button>
            )}
            <button type="button" className="primary-button" onClick={onFinish}>
              {t('完成演示')}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={t('取消演示')}
              title={t('取消演示')}
              onClick={onCancel}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
