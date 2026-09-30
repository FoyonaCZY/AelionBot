import type { GameView } from '../../shared/types/game-types';
import { PHASE_NAMES } from '../../shared/games/game-boards';
import { translate } from '../../shared/i18n';
import { periodOf, phaseSteps, seatNumber } from './game-view-model';

export function electionLabel(game: GameView, id: string) {
  const e = game.election;
  if (!e || game.phase !== 'election') return '';
  if (e.joining) return translate('待公布');
  if (e.withdrawn.includes(id)) return translate('已退水');
  if (!e.applicants.includes(id)) return translate('警下');
  if (game.phase === 'election' && e.round > 0 && !game.candidates?.includes(id)) return translate('未进 PK');
  return translate(game.phase === 'election' && e.round > 0 ? '警上 · PK' : '警上');
}

const STEP_NAMES = { night: '第 {day} 夜', election: '警长竞选', speech: '发言', vote: '放逐投票' } as const;

/** Countdown ring; turns urgent in the last ten seconds. */
export function GameTimer({
  seconds,
  total,
  syncError,
}: {
  seconds: number | null;
  total: number;
  syncError?: string;
}) {
  if (seconds === null) return null;
  const radius = 11,
    length = 2 * Math.PI * radius,
    urgent = seconds <= 10;
  return (
    <span className={`gg-timer ${urgent ? 'is-urgent' : ''}`} role="timer" aria-label={translate('剩余时间')}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle cx="14" cy="14" r={radius} className="gg-timer-track" />
        <circle
          cx="14"
          cy="14"
          r={radius}
          className="gg-timer-value"
          strokeDasharray={`${(length * Math.min(seconds, total)) / Math.max(total, 1)} ${length}`}
        />
      </svg>
      <b>{syncError ? '—' : seconds}</b>
      <small>{translate('秒')}</small>
    </span>
  );
}

/** Where the day stands: night → (sheriff election) → speeches → exile vote. */
export function GamePhaseSteps({ game }: { game: GameView }) {
  if (periodOf(game) === 'finished')
    return (
      <div className="gg-steps">
        <span className="is-now">{translate('对局结束')}</span>
      </div>
    );
  const steps = phaseSteps(game);
  return (
    <ol className="gg-steps" aria-label={translate('对局阶段')}>
      {steps.map((step, index) => (
        <li key={step.key} className={`is-${step.state}`} aria-current={step.state === 'now' ? 'step' : undefined}>
          {index > 0 && <i aria-hidden="true" />}
          <span>
            {step.state === 'now' && (step.key === 'night' ? '☾ ' : '☀ ')}
            {translate(STEP_NAMES[step.key], { day: game.day })}
            {step.state === 'now' && game.stage && game.stage !== translate(PHASE_NAMES[game.phase])
              ? ` · ${game.stage}`
              : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Who is running for sheriff, pinned above the transcript while the election lasts. */
export function ElectionBoard({ game }: { game: GameView }) {
  const e = game.election;
  if (game.phase !== 'election' || !e) return null;
  const label = (ids: string[]) =>
    ids.length
      ? ids.map((id) =>
          translate('{seat} 号 {name}', {
            seat: seatNumber(game, id),
            name: game.seats[seatNumber(game, id) - 1]?.name || '',
          }),
        )
      : [];
  const running =
    game.phase === 'election' && e.round
      ? game.candidates || []
      : e.applicants.filter((id) => !e.withdrawn.includes(id));
  const below = game.seats.filter((p) => !e.applicants.includes(p.id)).map((p) => p.id);
  return (
    <section className="gg-election" aria-label={translate('警长竞选名单')}>
      {e.joining ? (
        <p>{translate('正在选择是否上警，报名结束后统一公布名单。')}</p>
      ) : (
        <>
          <div>
            <b>{translate(e.round ? 'PK 候选' : '警上')}</b>
            <span className="gg-chip-row">
              {label(running).map((text) => (
                <span className="gg-tag is-accent" key={text}>
                  {text}
                </span>
              ))}
              {!running.length && <span className="gg-muted">{translate('无')}</span>}
            </span>
          </div>
          <div>
            <b>{translate('警下')}</b>
            <span className="gg-muted">
              {below.length
                ? translate('{seats} 号 · 由他们投票', {
                    seats: below.map((id) => seatNumber(game, id)).join(translate('、')),
                  })
                : translate('无')}
            </span>
          </div>
          <div>
            <b>{translate('退水')}</b>
            <span className="gg-muted">
              {e.withdrawn.length ? label(e.withdrawn).join(translate('、')) : translate('暂无')}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
