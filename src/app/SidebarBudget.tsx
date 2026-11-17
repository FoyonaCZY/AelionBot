import { useEffect, useRef } from 'react';
import { budgetAlertText, formatMoney, type SpendingView } from '../../shared/model-pricing';
import { Icon } from '../ui/Icon';
import { currentLanguage, useI18n } from '../i18n';
import './updates.css';

/** Beside the settings link while a budget is used up; opens the usage page. */
export function SidebarBudget({ spending, onOpen }: { spending?: SpendingView; onOpen: () => void }) {
  const { t } = useI18n();
  const status =
    spending?.day.level === 'exceeded'
      ? spending.day
      : spending?.month.level === 'exceeded'
        ? spending.month
        : undefined;
  if (!spending || !status?.budget) return null;
  const money = (value: number) => formatMoney(value, spending.settings.currency, currentLanguage(), 2);
  return (
    <button
      className="sidebar-update"
      aria-label={t('查看预算')}
      title={`${t(status === spending.day ? '今日花费已超出预算' : '本月花费已超出预算')} · ${money(status.spent)} / ${money(status.budget)}`}
      onClick={onOpen}
    >
      <Icon name="alert" size={14} />
      <span>{t('超预算')}</span>
    </button>
  );
}

/** Says once that a budget was nearly or fully used, when that happens while the app is open. */
export function useSpendingAlert(spending: SpendingView | undefined, notify: (text: string) => void) {
  const { t } = useI18n();
  const seen = useRef<string | undefined>(undefined),
    alert = spending?.alert,
    id = alert ? `${alert.id}@${alert.at}` : '';
  useEffect(() => {
    if (!spending) return;
    // What was announced before this launch is not said again.
    if (seen.current === undefined || !alert || id === seen.current) {
      seen.current = id;
      return;
    }
    seen.current = id;
    const status = spending[alert.period],
      money = (value: number) => formatMoney(value, spending.settings.currency, currentLanguage(), 2);
    notify(
      t(budgetAlertText(alert.period, alert.level, spending.paused), {
        spent: money(status.spent),
        budget: money(status.budget ?? 0),
      }),
    );
  }, [id, Boolean(spending)]);
}
