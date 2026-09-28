import { ROLE_NAMES, PHASE_NAMES, ACTION_NAMES } from '../../shared/games/game-boards';
import { useI18n } from '../i18n';
import { useEffect, useState } from 'react';
import type { GameTrace, GameView, GameAction } from '../../shared/types/game-types';
const labels: Record<GameTrace['type'], string> = {
  created: '创建对局',
  model_response: '接口返回',
  model_queued: '等待请求名额',
  request_created: '等待行动',
  model_started: '开始决策',
  model_returned: '完成决策',
  model_failed: '请求失败',
  model_cancelled: '请求取消',
  reply_discarded: '回答已过期',
  action_accepted: '行动生效',
  action_rejected: '行动被拒绝',
  timeout: '行动超时',
  transition: '阶段推进',
  pause: '暂停',
  resume: '继续',
  stop: '结束对局',
  recovered: '重启恢复',
  failure_pause: '异常暂停',
};
const phases: Record<string, string> = PHASE_NAMES;
const kinds: Record<string, string> = ACTION_NAMES;
const roles: Record<string, string> = ROLE_NAMES;
export function GameDiagnostics({ game }: { game: GameView }) {
  const { t } = useI18n();
  const [events, setEvents] = useState<GameTrace[]>([]),
    [error, setError] = useState(''),
    [seat, setSeat] = useState(''),
    [mode, setMode] = useState<'decisions' | 'technical'>('decisions');
  const allowed = !game.humanId || game.status === 'finished';
  const name = (id?: string) => {
    const i = game.seats.findIndex((p) => p.id === id);
    return i < 0 ? t('无') : t('{seat} 号 {name}', { seat: i + 1, name: game.seats[i].name });
  };
  const actionText = (a: GameAction, kind?: string) =>
    a.choice !== undefined
      ? kind === 'withdraw'
        ? a.choice
          ? t('退水')
          : t('继续竞选')
        : a.choice
          ? t('上警')
          : t('不上警')
      : a.direction
        ? a.direction === 'clockwise'
          ? t('顺时针发言')
          : t('逆时针发言')
        : a.skip
          ? kind === 'badge'
            ? t('撕毁警徽')
            : kind === 'guard'
              ? t('空守')
              : kind === 'shoot'
                ? t('放弃开枪')
                : t('弃票')
          : a.potion === 'skip'
            ? t('本晚不用药')
            : a.potion === 'save'
              ? t('使用解药救人')
              : a.potion === 'poison'
                ? t('对 {name} 使用毒药', { name: name(a.target) })
                : kind === 'wolf_plan'
                  ? a.text || t('未提出计划')
                  : a.text || `${t(kinds[kind || ''] || '选择')} ${name(a.target)}`;
  useEffect(() => {
    if (!allowed) return;
    let live = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await window.aelion.games.inspect({ id: game.id });
        if (live) {
          setEvents(next);
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [game.id, allowed]);
  const returned = events.filter((e) => e.type === 'model_returned');
  function inputView(e: GameTrace) {
    try {
      const data = JSON.parse(e.input!);
      const shared = data.context.shared,
        personal = data.context.personal;
      const renderLogs = (logs: any[]) => (
        <>
          {logs.map((l: any) => (
            <p key={l.id}>
              {l.seatId ? name(l.seatId) + '：' : ''}
              {l.text}
            </p>
          ))}
        </>
      );
      return (
        <>
          {e.skills && (
            <p>
              <b>{t('已读攻略：')}</b>
              {e.skills.map((s) => s.title).join('、')}
            </p>
          )}
          <p>
            <b>{t('扮演玩家：')}</b>
            {name(data.you)}
          </p>
          {shared && personal ? (
            <>
              <details>
                <summary>{t('共享上下文 · 全员可见')}</summary>
                <p>
                  {t('第 {day} 天 · {phase}', { day: shared.day, phase: t(phases[shared.phase]) })}
                  {t('；玩家座位与存活状态。这里不包含真实身份、性格预设或私有查验。')}
                </p>
                {renderLogs(shared.logs)}
              </details>
              <details>
                <summary>{t('个人上下文 · 仅该玩家可见')}</summary>
                <p>
                  <b>{t('本人身份：')}</b>
                  {t(roles[personal.self.role])}
                  {t(' · 来源：开局分配')}
                </p>
                <p>
                  <b>{t('本局性格：')}</b>
                  {personal.self.mbti || t('未记录')}
                  {t(' · 来源：本局生效配置')}
                </p>
                {personal.self.behaviorPolicy && (
                  <p>
                    <b>{t('行为策略：')}</b>
                    {Object.values(personal.self.behaviorPolicy).join('；')}
                  </p>
                )}
                {personal.teammates.length > 0 && (
                  <p>
                    <b>{t('狼队友：')}</b>
                    {personal.teammates.map((p: any) => name(p.id)).join(t('、'))}
                    {t(' · 来源：狼人相互知晓身份规则，写入本人的私有上下文，非共享信息')}
                  </p>
                )}
                <p>{t('私有事件：由规则按可见权限投递，例如本人的查验、用药结果或狼队行动。')}</p>
                {personal.logs.length ? renderLogs(personal.logs) : <p>{t('暂无私有事件。')}</p>}
              </details>
            </>
          ) : (
            <>
              <p>{t('旧记录未标注上下文来源，不能作为当时来源分类的证据。')}</p>
              <p>
                <b>{t('已知身份：')}</b>
                {data.context.seats
                  .filter((p: any) => p.role)
                  .map((p: any) => `${name(p.id)}：${t(roles[p.role])}`)
                  .join('；')}
              </p>
              <details>
                <summary>{t('当时可见事件（来源未标注）')}</summary>
                {renderLogs(data.context.logs)}
              </details>
            </>
          )}
          <p>
            <b>{t('本次任务：')}</b>
            {t(kinds[data.request.kind])}
            {data.request.targets?.length ? t('；可选 ') + data.request.targets.map(name).join(t('、')) : ''}
            {data.request.source === 'private_action_request' ? t(' · 来源：规则引擎发给本人的行动请求') : ''}
          </p>
          {data.request.witch && (
            <p>
              {t('解药：{save}；毒药：{poison}；可见被袭击者：{victim} · 女巫能力授权，仅本人可见', {
                save: t(data.request.witch.canSave ? '可使用' : '不可使用'),
                poison: t(data.request.witch.canPoison ? '可使用' : '已耗尽'),
                victim: name(data.request.witch.victim),
              })}
            </p>
          )}
          <details>
            <summary>{t('规则与实际加载的攻略')}</summary>
            <p>{e.instruction}</p>
          </details>
        </>
      );
    } catch {
      return <p>{t('旧记录无法解析。')}</p>;
    }
  }
  function personalityView(e: GameTrace) {
    if (e.type !== 'model_returned' || !e.action) return null;
    const started = events
      .filter((t) => t.type === 'model_started' && t.requestId === e.requestId && t.seq < e.seq)
      .at(-1);
    let self: { mbti?: string; behaviorPolicy?: Record<string, string> } | undefined;
    try {
      self = JSON.parse(started?.input || '{}').context?.personal?.self;
    } catch {}
    const dimensions: Record<string, string> = {
      interaction: '交流方式',
      evidence: '关注信息',
      evaluation: '判断偏好',
      commitment: '调整决定',
      risk: '本局风格',
    };
    const tags: Record<string, string> = {
      E: '主动交流',
      I: '先观察',
      S: '关注事实',
      N: '关注关联',
      T: '侧重逻辑',
      F: '关注信任',
      J: '倾向定计划',
      P: '保留选择',
    };
    return (
      <section className="wg-personality-decision">
        <div className="wg-personality-heading">
          <strong>{self?.mbti || t('性格未记录')}</strong>
          {self?.mbti && (
            <span>
              {self.mbti
                .split('')
                .map((c) => t(tags[c]))
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </div>
        <p className="wg-decision-action">{actionText(e.action, e.kind)}</p>
        {e.action.note && (
          <div className="wg-decision-reason">
            <b>{t('判断依据')}</b>
            <p>{e.action.note}</p>
          </div>
        )}
        {e.action.personalityNote ? (
          <div className="wg-decision-reason">
            <b>
              {t('性格影响')} <small>{t('AI 自述')}</small>
            </b>
            <p>{e.action.personalityNote}</p>
          </div>
        ) : null}
        {self?.behaviorPolicy && (
          <details className="wg-personality-details">
            <summary>{t('查看本局性格倾向')}</summary>
            <dl>
              {Object.entries(self.behaviorPolicy).map(([key, value]) => (
                <div key={key}>
                  <dt>{t(dimensions[key] || key)}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </section>
    );
  }
  function detail(e: GameTrace) {
    if (e.type === 'created')
      return t('{count} 位玩家加入对局；{detail}', { count: game.seats.length, detail: e.detail || '' });
    if (e.type === 'transition') return t('当前进入') + t(phases[e.phase]);
    if (e.type === 'request_created') return '';
    return e.detail;
  }
  return (
    <section className="wg-diagnostics" aria-label={t('运行记录')}>
      <div className="gg-config-heading">
        <strong>{t('运行记录')}</strong>
        {allowed && (
          <select aria-label={t('筛选玩家记录')} value={seat} onChange={(e) => setSeat(e.target.value)}>
            <option value="">{t('全部玩家')}</option>
            {game.seats.map((p) => (
              <option key={p.id} value={p.id}>
                {name(p.id)}
              </option>
            ))}
          </select>
        )}
      </div>
      {!allowed ? (
        <>
          <p>{t('完整决策记录在对局结束后开放，避免泄露身份和私有信息。')}</p>
          <div className="wg-traces">
            {game.logs
              .filter((e) => !e.seatId)
              .map((e) => (
                <p key={e.id}>
                  {e.time ? new Date(e.time).toLocaleTimeString('zh-CN') : ''} · {e.text}
                </p>
              ))}
          </div>
        </>
      ) : (
        <>
          {error && <p role="alert">{error}</p>}
          <p>
            {t('调用 {calls} 次 · 平均返回 {seconds} 秒 · 失败 {failed} · 超时 {timeouts}', {
              calls: events.filter((e) => e.type === 'model_started').length,
              seconds: returned.length
                ? (returned.reduce((n, e) => n + (e.elapsedMs || 0), 0) / returned.length / 1000).toFixed(1)
                : '—',
              failed: events.filter((e) => e.type === 'model_failed').length,
              timeouts: events.filter((e) => e.type === 'timeout').length,
            })}
          </p>
          <div className="wg-record-tabs">
            <button aria-pressed={mode === 'decisions'} onClick={() => setMode('decisions')}>
              {t('玩家决策')}
            </button>
            <button aria-pressed={mode === 'technical'} onClick={() => setMode('technical')}>
              {t('调用详情')}
            </button>
          </div>
          {mode === 'decisions' ? (
            <div className="wg-traces wg-decision-cards">
              {returned
                .filter(
                  (e) =>
                    (!seat || e.seatId === seat) &&
                    events.some((t) => t.type === 'action_accepted' && t.requestId === e.requestId && t.seq > e.seq) &&
                    !events.some(
                      (t) =>
                        t.type === 'model_failed' &&
                        t.requestId === e.requestId &&
                        t.attempt === e.attempt &&
                        t.seq > e.seq,
                    ),
                )
                .reverse()
                .map((e) => (
                  <article className="wg-decision-card" key={e.seq}>
                    <header>
                      <strong>{name(e.seatId)}</strong>
                      <span>
                        {t('第 {day} {period}', { day: e.day, period: t(e.phase === 'night' ? '夜' : '天') })} ·{' '}
                        {t(kinds[e.kind || ''])}
                      </span>
                      <time>{new Date(e.time).toLocaleTimeString('zh-CN')}</time>
                    </header>
                    {personalityView(e)}
                  </article>
                ))}
              {!returned.some(
                (e) =>
                  (!seat || e.seatId === seat) &&
                  events.some((t) => t.type === 'action_accepted' && t.requestId === e.requestId && t.seq > e.seq),
              ) && <p>{t('暂无已生效的 AI 决策。请求进度和失败原因可在“调用详情”查看。')}</p>}
            </div>
          ) : (
            <div className="wg-traces">
              {!events.length && !error && <p>{t('暂无决策记录。旧版本对局的模型输入和耗时无法补录。')}</p>}
              {events
                .filter((e) => !seat || !e.seatId || e.seatId === seat)
                .map((e) => (
                  <details key={e.seq}>
                    <summary>
                      <time>{new Date(e.time).toLocaleTimeString('zh-CN')}</time> ·{' '}
                      {e.seatId ? name(e.seatId) + ' · ' : ''}
                      {t(labels[e.type])}
                      {e.kind ? ' · ' + t(kinds[e.kind]) : ''}
                      {e.elapsedMs !== undefined
                        ? ' · ' + t('{seconds} 秒', { seconds: (e.elapsedMs / 1000).toFixed(1) })
                        : ''}
                    </summary>
                    <div>
                      {t('第 {day} {period}', { day: e.day, period: t(e.phase === 'night' ? '夜' : '天') })} ·{' '}
                      {t(phases[e.phase])}
                      {e.attempt && e.attempt > 1 ? t(' · 重试第 {n} 次', { n: e.attempt - 1 }) : ''}
                      {e.model ? ' · ' + e.model : ''}
                    </div>
                    {detail(e) && <p>{detail(e)}</p>}
                    {e.action?.formatNote && (
                      <p>
                        <b>{t('格式兼容：')}</b>
                        {e.action.formatNote}
                      </p>
                    )}
                    {e.metrics && (
                      <p>
                        {t(
                          'HTTP {status} · 响应头 {headers} 秒 · 完整响应 {total} 秒 · 结束原因 {reason} · 输入 / 输出 / 推理 token：{input} / {output} / {reasoning}',
                          {
                            status: e.metrics.httpStatus,
                            headers: (e.metrics.headersMs / 1000).toFixed(1),
                            total: (e.metrics.totalMs / 1000).toFixed(1),
                            reason: e.metrics.finishReason || t('未知'),
                            input: e.metrics.inputTokens ?? '—',
                            output: e.metrics.outputTokens ?? '—',
                            reasoning: e.metrics.reasoningTokens ?? '—',
                          },
                        )}
                      </p>
                    )}
                    {personalityView(e)}
                    {e.type === 'action_accepted' && e.action && (
                      <p>
                        <b>{t(e.kind === 'wolf_plan' ? '夜聊内容：' : '执行结果：')}</b>
                        {actionText(e.action, e.kind)}
                      </p>
                    )}
                    {e.input && inputView(e)}
                  </details>
                ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
