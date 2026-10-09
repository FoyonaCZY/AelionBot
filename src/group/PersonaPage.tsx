import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { TRAITS, mbtiOf, type Trait, type Traits } from '../../shared/persona/persona-model';
import { TRAIT_SEMANTICS } from '../../shared/persona/persona-semantics';
import type { PersonaAction, PersonaView } from '../../shared/types/persona-types';
import type { GameMbti } from '../../shared/games/game-personality';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import {
  TRAIT_POLES,
  dateText,
  episodeChange,
  episodeSource,
  growthSummary,
  historyPoints,
  historyRange,
  relationWord,
  signed,
  statusText,
  traitHint,
  traitName,
} from './persona-view-model';
import { GrowthReviewDetails } from './GrowthReviewDetails';
import './persona-page.css';

type Member = {
  id: string;
  name: string;
  color?: string;
  avatarStyle?: import('../../shared/chat/bot-colors').BotAvatarStyle;
};
const MAX_DISPLAY = 6;

/** A linear radar: the centre is zero and the outer grid is one on every axis. */
function SoulShape({ view, color }: { view: PersonaView; color: string }) {
  const { t, language } = useI18n();
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / TRAITS.length;
    return [100 + Math.cos(angle) * 70 * value, 100 + Math.sin(angle) * 70 * value];
  };
  const polygon = (traits: Traits) => TRAITS.map((key, index) => point(index, traits[key]).join(',')).join(' ');
  const labels = [
    [100, 15],
    [177, 79],
    [147, 180],
    [53, 180],
    [23, 79],
  ];
  return (
    <svg
      className="gp-soul"
      viewBox="-14 0 228 198"
      role="img"
      aria-label={`${t('性格轮廓')}。${TRAITS.map((key) => `${t(traitName(key))} ${view.profile.traits[key].toFixed(3)}`).join('，')}。${t('彩色为当前人格，虚线为出生人格；越向外，该维度数值越高。')}`}
    >
      {[0.25, 0.5, 0.75, 1].map((value) => (
        <polygon
          key={value}
          points={TRAITS.map((_, index) => point(index, value).join(',')).join(' ')}
          className="gp-radar-grid"
        />
      ))}
      {TRAITS.map((key, index) => {
        const [x, y] = point(index, 1);
        return <line key={key} x1="100" y1="100" x2={x} y2={y} className="gp-radar-axis" />;
      })}
      <polygon points={polygon(view.profile.anchor)} className="gp-soul-birth" />
      <polygon points={polygon(view.profile.traits)} style={{ fill: color, stroke: color }} className="gp-soul-now" />
      {TRAITS.map((key, index) => {
        const [x, y] = point(index, view.profile.traits[key]);
        return <circle key={key} cx={x} cy={y} r="2.5" fill={color} className="gp-radar-dot" />;
      })}
      {TRAITS.map((key, index) => (
        <text
          key={key}
          x={labels[index][0]}
          y={labels[index][1]}
          textAnchor={index === 1 ? 'start' : index === 4 ? 'end' : 'middle'}
        >
          <title>{t(traitName(key))}</title>
          {language === 'en' ? key : t(traitName(key))}
        </text>
      ))}
      <text x="104" y="31" className="gp-radar-tick">
        1
      </text>
      <text x="104" y="65" className="gp-radar-tick">
        0.5
      </text>
    </svg>
  );
}

export function PersonaPage({
  members,
  presets,
  initialBotId,
  onUnsavedChange,
}: {
  members: Member[];
  presets: Record<string, GameMbti>;
  initialBotId?: string;
  onUnsavedChange?: (dirty: boolean) => void;
}) {
  const { t, language } = useI18n();
  const [selected, setSelected] = useState(initialBotId || members[0]?.id || '');
  const [views, setViews] = useState<Record<string, PersonaView>>({});
  const [draft, setDraft] = useState<Traits | null>(null);
  useEffect(() => {
    onUnsavedChange?.(!!draft);
  }, [draft, onUnsavedChange]);
  const [scope, setScope] = useState<'all' | 'game' | 'chat'>('all');
  const [showMore, setShowMore] = useState(false);
  const [section, setSection] = useState<'personality' | 'growth' | 'relations' | 'settings'>('personality');
  const [readErrors, setReadErrors] = useState<Record<string, boolean>>({});
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const ids = members.map((m) => m.id).join('\n');
  const revisions = useRef<Record<string, number>>({});
  const busyRef = useRef(false);
  useEffect(() => {
    let live = true;
    for (const m of members) {
      const revision = (revisions.current[m.id] || 0) + 1;
      revisions.current[m.id] = revision;
      void window.aelion
        .personaProfile({ botId: m.id, mbti: presets[m.id] })
        .then((v) => {
          if (live && revisions.current[m.id] === revision) setViews((current) => ({ ...current, [m.id]: v }));
        })
        .catch(() => {
          if (live && revisions.current[m.id] === revision) setReadErrors((current) => ({ ...current, [m.id]: true }));
        });
    }
    return () => {
      live = false;
    };
  }, [ids, JSON.stringify(presets), reload]);
  const member = members.find((m) => m.id === selected) || members[0];
  const view = member && views[member.id];
  const selectedBotId = member?.id;
  const selectedPreset = selectedBotId ? presets[selectedBotId] : undefined;
  const reviewing = !!view?.growthReview?.running;
  useEffect(() => {
    if (!selectedBotId) return;
    let live = true,
      fetching = false;
    const refresh = async () => {
      if (fetching || busyRef.current) return;
      fetching = true;
      const revision = (revisions.current[selectedBotId] || 0) + 1;
      revisions.current[selectedBotId] = revision;
      try {
        const next = await window.aelion.personaProfile({ botId: selectedBotId, mbti: selectedPreset });
        if (live && !busyRef.current && revisions.current[selectedBotId] === revision)
          setViews((current) => ({ ...current, [selectedBotId]: next }));
      } catch {
        /* Preserve the last readable profile and the user's edit preview. */
        if (live && revisions.current[selectedBotId] === revision)
          setReadErrors((current) => ({ ...current, [selectedBotId]: true }));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), reviewing ? 2000 : 10000);
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [selectedBotId, selectedPreset, reviewing]);
  const nameOf = (id: string) => (id === 'user' ? t('你') : members.find((m) => m.id === id)?.name);
  async function update(input: PersonaAction, label: string) {
    if (!member) return;
    busyRef.current = true;
    revisions.current[member.id] = (revisions.current[member.id] || 0) + 1;
    setBusy(label);
    setError('');
    try {
      const next = await window.aelion.updatePersona({
        ...input,
        botId: member.id,
        mbti: presets[member.id],
      });
      setViews((v) => ({ ...v, [member.id]: next }));
      if (input.action !== 'reviewGrowth' && input.action !== 'undoGrowthReview') setDraft(null);
      if (input.action === 'draft') setSection('personality');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy('');
    }
  }
  if (!members.length)
    return (
      <main className="gp-empty">
        <p className="gg-muted">{t('群里还没有 Bot。邀请 Bot 进群后，它们的人格会显示在这里。')}</p>
      </main>
    );
  const traits = draft || view?.profile.traits;
  const episodes = (view?.episodes || []).filter((e) => scope === 'all' || e.scope === scope);
  const reach = view ? historyRange(view) : 0.02;
  const color = member?.color || '#8e7ca2';
  const summary = traits
    ? TRAITS.filter((key) => traits[key] < 0.4 || traits[key] > 0.6)
        .sort((a, b) => Math.abs(traits[b] - 0.5) - Math.abs(traits[a] - 0.5))
        .slice(0, 2)
        .map((key) => t(traitHint(key, traits[key])))
        .join(language === 'en' ? ' · ' : '；')
    : '';
  return (
    <main className="gp-page" style={{ '--gp-bot-color': color } as CSSProperties}>
      <nav className="gp-list" aria-label={t('群里的 Bot')}>
        {members.map((m) => (
          <button
            key={m.id}
            className={`gp-row ${m.id === member?.id ? 'is-on' : ''}`}
            aria-current={m.id === member?.id ? 'true' : undefined}
            title={views[m.id] ? t(statusText(views[m.id])) : m.name}
            disabled={!!busy || !!draft}
            onClick={() => {
              setSelected(m.id);
              setDraft(null);
              setError('');
              setShowMore(false);
            }}
          >
            <Avatar bot={{ ...m, color: m.color || '#8e7ca2' }} size={28} />
            <span className="gp-row-copy">
              <strong>{m.name}</strong>
            </span>
            {views[m.id] && !views[m.id].profile.confirmed && <span className="gp-draft-dot" aria-label={t('初稿')} />}
          </button>
        ))}
      </nav>
      {!view && member && (
        <div className="gp-loading" role="status">
          <p>{t(readErrors[member.id] ? '无法读取人格档案，请重试。' : '正在读取人格…')}</p>
          {readErrors[member.id] && (
            <button
              className="secondary-button"
              onClick={() => {
                setReadErrors({});
                setReload((value) => value + 1);
              }}
            >
              {t('重新读取')}
            </button>
          )}
        </div>
      )}
      {view && traits && member && (
        <section className="gp-detail" key={member.id} aria-label={t('{name}的人格', { name: member.name })}>
          <header className="gp-profile-header">
            <Avatar bot={{ ...member, color }} size={64} />
            <div className="gp-identity">
              <div className="gp-name-line">
                <h1>{member.name}</h1>
                <span
                  className="gp-mbti"
                  title={t('按五维规则生成的参考标签，并非 MBTI 测量结果')}
                  aria-label={t('参考标签：{mbti}', { mbti: mbtiOf(traits) })}
                >
                  {mbtiOf(traits)}
                </span>
              </div>
              <p className="gp-summary">{summary || t('各维度倾向适中')}</p>
              <p className={`gp-status ${view.profile.confirmed ? '' : 'is-draft'}`}>
                {!view.profile.confirmed && <span>{t('初稿')}</span>}
                {view.profile.locked && <span>{t('成长已锁定')}</span>}
              </p>
            </div>
            <div className="gp-actions">
              {draft ? (
                <>
                  <button className="secondary-button" disabled={!!busy} onClick={() => setDraft(null)}>
                    {t('取消')}
                  </button>
                  <button
                    className="primary-button"
                    disabled={!!busy}
                    onClick={() => void update({ action: 'set', traits: draft }, 'set')}
                  >
                    {t('保存为出生人格')}
                  </button>
                </>
              ) : (
                <>
                  {!view.profile.confirmed && (
                    <button
                      className="primary-button"
                      disabled={!!busy}
                      onClick={() => void update({ action: 'confirm' }, 'confirm')}
                    >
                      {t('确认')}
                    </button>
                  )}
                  <button
                    className="secondary-button"
                    disabled={!!busy}
                    onClick={() => {
                      setSection('personality');
                      setDraft({ ...view.profile.traits });
                    }}
                  >
                    <Icon name="sliders" size={16} />
                    {t('手动调整')}
                  </button>
                </>
              )}
            </div>
          </header>
          <nav className="gp-tabs" aria-label={t('人格档案')}>
            {(
              [
                ['personality', '性格'],
                ['growth', '经历与成长'],
                ['relations', '关系'],
                ['settings', '设置'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={section === value}
                disabled={!!draft || !!busy}
                onClick={() => setSection(value)}
              >
                {t(label)}
              </button>
            ))}
          </nav>
          {error && (
            <p className="gp-error" role="alert">
              {error}
            </p>
          )}
          <div className="gp-layout">
            <div className="gp-main" hidden={section !== 'personality' && section !== 'growth'}>
              <section
                className="gp-section gp-personality"
                hidden={section !== 'personality'}
                aria-labelledby="gp-personality-title"
              >
                <header className="gp-section-head">
                  <h2 id="gp-personality-title">{t('现在的性格')}</h2>
                  <span className="gp-shape-key">
                    <i className="is-now" style={{ background: color }} />
                    {t(draft ? '调整预览' : '现在')}
                    <i className="is-birth" />
                    {t('出生时')}
                  </span>
                </header>
                <div className="gp-personality-body">
                  <div className="gp-traits">
                    {TRAITS.map((key: Trait) => {
                      const birth = view.profile.anchor[key],
                        now = traits[key];
                      const description = t('出生 {birth} · 现在 {now} · 变化 {delta}', {
                        birth: birth.toFixed(3),
                        now: now.toFixed(3),
                        delta: signed(now - birth, 3),
                      });
                      return (
                        <div className="gp-trait" key={key}>
                          <div className="gp-trait-label">
                            <span className="gp-trait-name">{t(traitName(key))}</span>
                            <small className="gp-trait-hint">{t(traitHint(key, now))}</small>
                          </div>
                          <div className="gp-trait-scale" title={description}>
                            <span className="gp-pole">{t(TRAIT_POLES[key][0])}</span>
                            {draft ? (
                              <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.05}
                                value={now}
                                disabled={!!busy}
                                aria-label={t(traitName(key))}
                                onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
                              />
                            ) : (
                              <span className="gp-track" role="img" aria-label={`${t(traitName(key))}：${description}`}>
                                <i className="gp-dot is-birth" style={{ left: `${birth * 100}%` }} />
                                <i className="gp-dot is-now" style={{ left: `${now * 100}%`, background: color }} />
                              </span>
                            )}
                            <span className="gp-pole is-high">{t(TRAIT_POLES[key][1])}</span>
                            <span className="gp-value">{now.toFixed(3)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <details className="gp-definitions">
                  <summary>{t('性格图与五维说明')}</summary>
                  <figure className="gp-shape">
                    <SoulShape view={{ ...view, profile: { ...view.profile, traits } }} color={color} />
                    <figcaption className="gp-shape-note">
                      {t('彩色为当前人格，虚线为出生人格；越向外，该维度数值越高。')}
                    </figcaption>
                  </figure>
                  <dl>
                    {TRAITS.map((key) => (
                      <div key={key}>
                        <dt>{t(traitName(key))}</dt>
                        <dd>
                          {t(TRAIT_SEMANTICS[key].definition)}
                          <small>
                            {(language === 'en'
                              ? TRAIT_SEMANTICS[key].facetsEnglish
                              : TRAIT_SEMANTICS[key].facets.map((facet) => t(facet))
                            ).join(' · ')}
                          </small>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p>{t('五维概览，不代表完整人格。')}</p>
                  <p>{t('定义参考 BFI-2。每维包含三个侧面，当前分数只表示总体倾向，不代表三个侧面分别测过。')}</p>
                  <p>{t('负性情绪描述情绪体验倾向，其中“抑郁”指低落倾向，不是疾病诊断。')}</p>
                  <p>{t('按五维规则生成的参考标签，并非 MBTI 测量结果')}</p>
                </details>
              </section>
              <section
                className="gp-section gp-experiences"
                hidden={section !== 'growth'}
                aria-labelledby="gp-experiences-title"
              >
                <header className="gp-section-head">
                  <h2 id="gp-experiences-title">{t('最近经历')}</h2>
                  <span className="gg-seg gp-seg" role="radiogroup" aria-label={t('经历来源')}>
                    {(['all', 'game', 'chat'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={scope === value}
                        className={scope === value ? 'is-on' : ''}
                        onClick={() => {
                          setScope(value);
                          setShowMore(false);
                        }}
                      >
                        {t(value === 'all' ? '全部' : value === 'game' ? '游戏' : '群聊')}
                      </button>
                    ))}
                  </span>
                </header>
                {episodes.length ? (
                  <>
                    <ol className="gp-episodes">
                      {episodes.slice(0, showMore ? undefined : 3).map((episode, index) => (
                        <li key={episode.id} className={index === 0 ? 'is-featured' : ''}>
                          <time className="gp-episode-date" dateTime={new Date(episode.createdAt).toISOString()}>
                            {dateText(episode.createdAt)}
                          </time>
                          <div className="gp-episode-body">
                            <p className="gp-episode-text">{episode.summary}</p>
                            <div className="gp-episode-meta">
                              <span>{t(episodeSource(episode))}</span>
                              <span className={episodeChange(episode) ? 'is-changed' : ''}>
                                {episodeChange(episode)
                                  ? episodeChange(episode)!.replace(/^\S+/, (label) => t(label))
                                  : null}
                              </span>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                    {episodes.length > 3 && (
                      <button
                        className="gp-text-button"
                        aria-expanded={showMore}
                        onClick={() => setShowMore(!showMore)}
                      >
                        {showMore ? t('收起经历') : t('更多经历（{count}）', { count: episodes.length - 3 })}
                      </button>
                    )}
                  </>
                ) : (
                  <p className="gg-muted">
                    {t(
                      scope === 'all'
                        ? '还没有经历。打完一局游戏后，这里会留下可核对的事实记录。'
                        : scope === 'game'
                          ? '还没有游戏经历。'
                          : '还没有群聊经历。',
                    )}
                  </p>
                )}
              </section>
              <section
                className="gp-section gp-growth-section"
                hidden={section !== 'growth'}
                aria-labelledby="gp-growth-title"
              >
                <header className="gp-section-head">
                  <h2 id="gp-growth-title">{t('最近的变化')}</h2>
                  {view.growthReview?.running && (
                    <span className="gg-muted" role="status">
                      {t('正在评估')}
                    </span>
                  )}
                </header>
                <p className="gp-growth-summary">{t(growthSummary(view))}</p>
                <details className="gp-review">
                  <summary>{t('查看变化曲线')}</summary>
                  <div className="gp-growth" aria-label={t('成长趋势')}>
                    {TRAITS.map((key) => {
                      const points = historyPoints(view, key, 100, 40, reach * 2),
                        end = points[points.length - 1];
                      const delta = signed(view.profile.traits[key] - view.profile.anchor[key], 3);
                      return (
                        <figure key={key} className="gp-mini" title={`${t(traitName(key))} ${delta}`}>
                          <figcaption>
                            <span>{t(traitName(key))}</span>
                            <b>{delta}</b>
                          </figcaption>
                          <div className="gp-mini-plot">
                            <svg
                              viewBox="0 0 100 40"
                              preserveAspectRatio="none"
                              role="img"
                              aria-label={`${t(traitName(key))} ${delta}`}
                            >
                              <line x1="0" x2="100" y1="20" y2="20" className="gp-mini-base" />
                              <polyline
                                points={points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}
                                className="gp-mini-line"
                              />
                            </svg>
                            <i className="gp-mini-dot" style={{ top: `${(end[1] / 40) * 100}%` }} />
                          </div>
                        </figure>
                      );
                    })}
                  </div>
                  <p className="gg-muted gp-chart-note">
                    {t(
                      '从左到右是历次记录，中线是出生值；向上表示数值升高，向下表示降低。五张图共用 ±{range} 的变化刻度，展示所有来源的累计变化。',
                      { range: reach.toFixed(2) },
                    )}
                  </p>
                </details>
                {view.profile.locked && <p className="gg-muted">{t('成长已锁定，仍会记录经历。')}</p>}
                {view.growthReview && (
                  <details className="gp-review">
                    <summary>{t('查看成长依据')}</summary>
                    <div className="gp-review-heading">
                      <b>{t('跨局成长评估')}</b>
                      <span className="gg-tag">{t(view.growthReview.running ? '正在评估' : '自动积累经历')}</span>
                    </div>
                    <p>
                      {t('待评估：{matches} 局、{observations} 条行为记录', {
                        matches: view.growthReview.eligibleMatches,
                        observations: view.growthReview.eligibleObservations,
                      })}
                    </p>
                    <p className="gg-muted">
                      {t('至少 {matches} 局、{observations} 条记录后尝试；同一行为在不同角色下的表现也要能核对。', {
                        matches: view.growthReview.minMatches,
                        observations: view.growthReview.minObservations,
                      })}
                    </p>
                    {view.growthReview.reason && <p className="gg-muted">{view.growthReview.reason}</p>}
                    {!!view.growthReview.nextEligibleAt && view.growthReview.nextEligibleAt > Date.now() && (
                      <p className="gg-muted">
                        {t('下次可评估：{time}', {
                          time: new Date(view.growthReview.nextEligibleAt).toLocaleString(language),
                        })}
                      </p>
                    )}
                    <div className="gp-review-actions">
                      <button
                        className="secondary-button"
                        disabled={
                          !!busy ||
                          view.growthReview.running ||
                          view.profile.locked ||
                          !!draft ||
                          view.growthReview.eligibleMatches < view.growthReview.minMatches ||
                          view.growthReview.eligibleObservations < view.growthReview.minObservations ||
                          (!!view.growthReview.nextEligibleAt && view.growthReview.nextEligibleAt > Date.now())
                        }
                        onClick={() => void update({ action: 'reviewGrowth' }, 'reviewGrowth')}
                      >
                        {t('尝试评估积累的经历')}
                      </button>
                      {view.growthReview.canUndoReviewId && (
                        <button
                          className="secondary-button"
                          disabled={!!busy || view.growthReview.running || !!draft}
                          onClick={() => {
                            if (
                              window.confirm(
                                t('撤销最近一次自动人格变化？原评估和撤销记录都会保留，关系与共同经历不变。'),
                              )
                            )
                              void update(
                                { action: 'undoGrowthReview', reviewId: view.growthReview!.canUndoReviewId! },
                                'undoGrowthReview',
                              );
                          }}
                        >
                          {t('撤销最近一次变化')}
                        </button>
                      )}
                    </div>
                    {view.growthReview.latest && <GrowthReviewDetails review={view.growthReview.latest} />}
                    {view.growthReview.recent.filter((review) => review.id !== view.growthReview!.latest?.id).length >
                      0 && (
                      <details>
                        <summary>{t('更早的成长评估')}</summary>
                        {view.growthReview.recent
                          .filter((review) => review.id !== view.growthReview!.latest?.id)
                          .map((review) => (
                            <GrowthReviewDetails key={review.id} review={review} />
                          ))}
                      </details>
                    )}
                  </details>
                )}
              </section>
            </div>
            <div className="gp-aside" hidden={section !== 'relations'}>
              <section className="gp-section" aria-labelledby="gp-relations-title">
                <header className="gp-section-head">
                  <h2 id="gp-relations-title">{t('关系')}</h2>
                </header>
                {view.relations.filter((relation) => nameOf(relation.id)).length ? (
                  <ul className="gp-relations">
                    {[...view.relations]
                      .filter((relation) => nameOf(relation.id))
                      .sort((a, b) => (a.id === 'user' ? -1 : b.id === 'user' ? 1 : 0))
                      .slice(0, MAX_DISPLAY)
                      .map((relation) => {
                        const other = members.find((m) => m.id === relation.id);
                        return (
                          <li key={relation.id}>
                            {other ? (
                              <Avatar bot={{ ...other, color: other.color || '#8e7ca2' }} size={36} />
                            ) : (
                              <span className="gg-human-avatar gp-you" aria-hidden="true">
                                <Icon name="user" size={18} />
                              </span>
                            )}
                            <span className="gp-relation-copy">
                              <b>{nameOf(relation.id)}</b>
                              <small>{t(relationWord(relation.affinity))}</small>
                            </span>
                          </li>
                        );
                      })}
                  </ul>
                ) : (
                  <p className="gg-muted">{t('还没有关系记录。')}</p>
                )}
              </section>
              <section className="gp-section" aria-labelledby="gp-memories-title">
                <header className="gp-section-head">
                  <h2 id="gp-memories-title">{t('共同经历')}</h2>
                </header>
                {view.highlights.length ? (
                  <ul className="gp-memories">
                    {view.highlights.slice(0, 4).map((highlight) => (
                      <li key={highlight.id}>
                        <span>{highlight.summary.replaceAll('你', member.name)}</span>
                        <small>{dateText(highlight.createdAt)}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="gg-muted">{t('共同经历会随着相处逐渐积累。')}</p>
                )}
              </section>
            </div>
            <section className="gp-settings" hidden={section !== 'settings'} aria-label={t('人格设置')}>
              <div className="gp-settings-body">
                <div className="gp-setting-row">
                  <p>
                    {t(
                      view.profile.n > 0
                        ? '已有成长记录，先重置成长才能重新估计'
                        : '从 SOUL 估计五维，调用一次模型，结果需你确认。',
                    )}
                  </p>
                  <button
                    className="secondary-button"
                    disabled={!!busy || !!draft || view.profile.n > 0}
                    title={t(
                      view.profile.n > 0
                        ? '已有成长记录，先重置成长才能重新估计'
                        : '参照 BFI-2 定义，从角色设定估计五维；调用一次模型，结果需你确认',
                    )}
                    onClick={() => void update({ action: 'draft' }, 'draft')}
                  >
                    {t(busy === 'draft' ? '估计中…' : '按 SOUL 重新估计')}
                  </button>
                </div>
                <div className="gp-setting-row">
                  <p>{t('暂停人格变化，继续记录经历。')}</p>
                  <label className="gp-lock">
                    <input
                      type="checkbox"
                      checked={view.profile.locked}
                      disabled={!!busy || !!draft}
                      onChange={(e) => void update({ action: 'lock', locked: e.target.checked }, 'lock')}
                    />
                    {t('锁定成长')}
                  </label>
                </div>
                <div className="gp-setting-row">
                  <p>{t('恢复出生人格，保留关系与共同经历。')}</p>
                  <button
                    className="secondary-button"
                    disabled={!!busy || !!draft || !view.profile.n}
                    onClick={() => {
                      if (window.confirm(t('重置后人格回到出生时的样子，成长记录会删除；关系和共同经历保留。')))
                        void update({ action: 'reset' }, 'reset');
                    }}
                  >
                    {t('重置成长')}
                  </button>
                </div>
              </div>
              <p className="gg-muted">{t('私聊沿用原有 SOUL；游戏人格、成长和关系不会注入私聊。')}</p>
            </section>
          </div>
        </section>
      )}
    </main>
  );
}
