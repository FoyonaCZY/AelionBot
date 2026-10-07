import type { Bot } from '../../shared/types/core';
import type { GroupDelivery, GroupPage } from '../../shared/types/group-types';
import { useI18n } from '../i18n';
import { Avatar } from '../ui/Avatar';
export function GroupDecisionTrail({
  deliveries,
  laya,
  bots,
}: {
  deliveries: GroupDelivery[];
  laya: GroupPage['laya'];
  bots: Bot[];
}) {
  const { t } = useI18n();
  if (!laya?.enabled) return null;
  const decisions = new Map(laya.decisions.map((decision) => [decision.sourceId, decision]));
  const entries = deliveries.flatMap((delivery) => {
    const bot = bots.find((item) => item.id === delivery.recipientId),
      decision = decisions.get(delivery.layaDecisionId || delivery.id);
    return bot && (decision || ['queued', 'deciding', 'limited'].includes(delivery.status))
      ? [{ bot, delivery, decision }]
      : [];
  });
  if (!entries.length) return null;
  const percent = (value: number | undefined) => (Number.isFinite(value) ? `${Math.round((value || 0) * 100)}%` : '—');
  return (
    <div className="group-decision-trail" aria-label={t('各 Bot 的回应判断')}>
      {entries.map(({ bot, delivery, decision }) => {
        const choice = decision?.appliedChoice || decision?.choice || 'pending';
        const observe = decision?.probabilities?.observe;
        const participate = decision?.probabilities?.participate;
        // Queued without a decision: waiting for the addressed member to answer first, or not yet judged.
        const label =
          delivery.status === 'limited'
            ? '已限流'
            : choice === 'observe'
              ? '不回应'
              : choice === 'participate'
                ? '回应'
                : delivery.status === 'queued' && !delivery.triage
                  ? '等被点名的先答'
                  : '判断中';
        return (
          <div key={delivery.id} className="group-decision-card" data-choice={choice}>
            <div className="group-decision-card-head">
              <Avatar bot={bot} size={24} />
              <strong title={bot.name}>{bot.name}</strong>
              <span>{t(label)}</span>
            </div>
            <div className="group-decision-card-scores">
              <span data-selected={choice === 'observe'}>
                {t('不回应')} {percent(observe)}
              </span>
              <span data-selected={choice === 'participate'}>
                {t('回应')} {percent(participate)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
