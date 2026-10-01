import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import { setComputerCardOpen, useComputerCard } from './computer-card';

/** Shown in the conversation header only while the floating computer card is closed. */
export function ComputerCardToggle() {
  const { t } = useI18n();
  const { open, online } = useComputerCard();
  if (open) return null;
  const label = t('显示工作电脑和定时任务');
  return (
    <button
      type="button"
      className="icon-button computer-card-toggle"
      aria-label={label}
      title={label}
      onClick={() => setComputerCardOpen(true)}
    >
      <Icon name="computer" size={18} />
      {online && <span className="computer-card-toggle-dot" aria-hidden="true" />}
    </button>
  );
}
