import type { Bot } from '../../shared/types/core';
import type { GroupDelivery, GroupPage } from '../../shared/types/group-types';
import { useI18n } from '../i18n';
import { Avatar } from '../ui/Avatar';
export function GroupDecisionTrail({
  deliveries,
  page,
  bots,
}: {
  deliveries: GroupDelivery[];
  page: GroupPage;
  bots: Bot[];
}) {
  const { t } = useI18n();
  if (!page.laya?.enabled) return null;
  const decisions = new Map(page.laya.decisions.map((decision) => [decision.sourceId, decision]));
  const entries = deliveries.flatMap((delivery) => {
    const bot = bots.find((item) => item.id === delivery.recipientId),
      decision = decisions.get(delivery.layaDecisionId || delivery.id);
    return bot && (decision || ['queued', 'deciding'].includes(delivery.status)) ? [{ bot, delivery, decision }] : [];
  });
  if (!entries.length) return null;
  const percent = (value: number | undefined) => (Number.isFinite(value) ? `${Math.round((value || 0) * 100)}%` : '—');
  return (
    <div className="group-decision-trail" aria-label={t('各 Bot 的参与判断')}>
      {entries.map(({ bot, delivery, decision }) => {
        const choice = decision?.appliedChoice || decision?.choice || 'pending';
        const observe = decision?.probabilities?.observe;
        const participate = decision?.probabilities?.participate;
        return (
          <div key={delivery.id} className="group-decision-card" data-choice={choice}>
            <div className="group-decision-card-head">
              <Avatar bot={bot} size={24} />
              <strong title={bot.name}>{bot.name}</strong>
              <span>{t(choice === 'pending' ? '判断中' : choice === 'observe' ? '旁听' : '参与')}</span>
            </div>
            <div className="group-decision-card-scores">
              <span data-selected={choice === 'observe'}>
                {t('旁听')} {percent(observe)}
              </span>
              <span data-selected={choice === 'participate'}>
                {t('参与')} {percent(participate)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
