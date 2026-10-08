import type { GrowthReviewRecord } from '../../shared/types/persona-growth-types';
import { TRAITS } from '../../shared/persona/persona-model';
import { useI18n } from '../i18n';
import { dateText, signed, traitName } from './persona-view-model';

const STATUSES: Record<GrowthReviewRecord['status'], string> = {
  running: '正在评估',
  applied: '已应用变化',
  unchanged: '保持不变',
  rejected: '证据未通过核验',
  failed: '评估未完成',
  stale: '档案已变更，本次未应用',
  reverted: '已撤销变化',
};
const ATTRIBUTIONS = {
  trait: '持续人格倾向',
  skill: '技巧变化',
  relationship: '关系反应',
  temporary: '临时状态',
  uncertain: '证据不足',
  stable: '原有倾向',
};

/** Read-only audit for persona growth. */
export function GrowthReviewDetails({ review }: { review: GrowthReviewRecord }) {
  const { t } = useI18n();
  return (
    <article className="gp-review-record">
      <div className="gp-review-heading">
        <b>{t(STATUSES[review.status])}</b>
        <small>{dateText(review.completedAt || review.createdAt)}</small>
      </div>
      <p>{review.summary}</p>
      <div className="gp-review-deltas" aria-label={t('本次实际变化')}>
        {TRAITS.map((key) => (
          <span key={key}>
            {t(traitName(key))} <b>{signed(review.delta[key], 4)}</b>
          </span>
        ))}
      </div>
      {review.assessment && (
        <details>
          <summary>{t('判断依据与反例')}</summary>
          {TRAITS.map((key) => {
            const assessment = review.assessment!.traits[key];
            return (
              <section className="gp-review-trait" key={key}>
                <b>
                  {t(traitName(key))} · {t(ATTRIBUTIONS[assessment.attribution])}
                </b>
                <p>{assessment.reason}</p>
                {(['evidence', 'counterEvidence'] as const).map((kind) => (
                  <div key={kind}>
                    <small>{t(kind === 'evidence' ? '支持证据' : '反向证据')}</small>
                    {assessment[kind].length ? (
                      <ul>
                        {assessment[kind].map((reference, i) => {
                          const observation = review.observations.find((item) => item.id === reference.observationId);
                          return (
                            <li key={reference.observationId + '-' + i}>
                              <q>{reference.quote}</q>
                              {observation && (
                                <details>
                                  <summary>
                                    {t('查看当时记录')} · {dateText(observation.createdAt)}
                                  </summary>
                                  <pre>{observation.text}</pre>
                                </details>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="gg-muted">{t('未列出；不代表不存在。')}</p>
                    )}
                  </div>
                ))}
              </section>
            );
          })}
        </details>
      )}
      <small className="gg-muted">
        {review.policyVersion}
        {review.model ? ` · ${review.model.model}` : ''}
      </small>
    </article>
  );
}
