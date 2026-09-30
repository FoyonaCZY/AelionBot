import type { GameView } from '../../shared/types/game-types';
import { PHASE_NAMES } from '../../shared/games/game-boards';
import { translate } from '../../shared/i18n';
export function electionLabel(game: GameView, id: string) {
  const e = game.election;
  if (!e || game.phase !== 'election') return '';
  if (e.joining) return translate('待公布');
  if (e.withdrawn.includes(id)) return translate('已退水');
  if (!e.applicants.includes(id)) return translate('警下');
  if (game.phase === 'election' && e.round > 0 && !game.candidates?.includes(id)) return translate('未进 PK');
  return translate(game.phase === 'election' && e.round > 0 ? '警上 · PK' : '警上');
}
export function GamePhaseStatus({
  game,
  seconds,
  syncError,
}: {
  game: GameView;
  seconds: number | null;
  syncError: string;
}) {
  const night = game.phase === 'night',
    finished = game.status === 'finished';
  const speaker = game.seats.find((p) => p.id === game.clock?.seatId);
  // A finished match keeps its last stage; show how it ended instead.
  const outcome = finished
    ? game.winner
      ? [...game.logs].reverse().find((l) => !l.seatId && !l.audience && l.text.includes('获胜'))?.text ||
        translate(game.winner === 'wolves' ? '狼人获胜' : '好人获胜')
      : translate('本局不计胜负')
    : '';
  const names = (ids: string[]) =>
    ids
      .map((id) => {
        const i = game.seats.findIndex((p) => p.id === id);
        return i < 0 ? '' : translate('{seat} 号 {name}', { seat: i + 1, name: game.seats[i].name });
      })
      .filter(Boolean)
      .join(translate('、')) || translate('无');
  const e = game.election;
  return (
    <div className="wg-phase-panel" data-period={finished ? 'finished' : night ? 'night' : 'day'}>
      <div className="wg-phase-summary">
        <span className="wg-period-icon" aria-hidden="true">
          {finished ? '✓' : night ? '☾' : '☀'}
        </span>
        <div className="wg-phase-title">
          <strong>
            {finished ? translate('对局结束') : translate(night ? '第 {day} 夜' : '第 {day} 天', { day: game.day })}
          </strong>
          <span>
            {outcome || game.stage || translate(PHASE_NAMES[game.phase])}
            {speaker && game.status === 'running'
              ? ` · ${speaker.name}${translate(speaker.human ? '发言中' : '准备发言')}`
              : ''}
          </span>
        </div>
        {seconds !== null && !finished && (
          <div className="wg-time" aria-label={translate('剩余时间')}>
            <strong className={seconds <= 10 ? 'urgent' : ''}>
              {syncError ? '—' : seconds}
              <small> {translate('秒')}</small>
            </strong>
            <span>
              {syncError
                ? translate('连接中断')
                : game.status === 'paused'
                  ? translate('已暂停')
                  : translate('剩余时间')}
            </span>
          </div>
        )}
      </div>
      {e && game.phase === 'election' && (
        <details className="wg-election" aria-label={translate('警长竞选名单')} open={game.phase === 'election'}>
          <summary>{translate('警长竞选名单')}</summary>
          {e.joining ? (
            <p>{translate('正在选择是否上警，报名结束后统一公布名单。')}</p>
          ) : (
            <>
              <div>
                <b>{translate(e.round ? 'PK 候选' : '警上')}</b>
                <span>
                  {names(
                    game.phase === 'election'
                      ? game.candidates || []
                      : e.applicants.filter((id) => !e.withdrawn.includes(id)),
                  )}
                </span>
              </div>
              <div>
                <b>{translate('警下')}</b>
                <span>{names(game.seats.filter((p) => !e.applicants.includes(p.id)).map((p) => p.id))}</span>
              </div>
              {e.withdrawn.length > 0 && (
                <div>
                  <b>{translate('退水')}</b>
                  <span>{names(e.withdrawn)}</span>
                </div>
              )}
            </>
          )}
        </details>
      )}
    </div>
  );
}
