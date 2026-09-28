import { GamePhaseStatus, electionLabel } from './GamePhaseStatus';
import { GameDiagnostics } from './GameDiagnostics';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '../ui/Avatar';
import type { GameView, GameAction } from '../../shared/types/game-types';
import { ROLE_NAMES as roles } from '../../shared/games/game-boards';
import { GameActionControls } from './GameActionControls';
import { translate } from '../../shared/i18n';
export function WerewolfTable({
  game,
  onUpdate,
  onMutationStart,
  syncError,
  omniscient,
  onOmniscient,
  onClose,
}: {
  game: GameView;
  onMutationStart: () => void;
  syncError: string;
  onUpdate: (v: GameView) => void;
  omniscient: boolean;
  onOmniscient: () => void;
  onClose: () => void;
}) {
  const [now, setNow] = useState(Date.now()),
    [confirmStop, setConfirmStop] = useState(false),
    [diagnostics, setDiagnostics] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const [, setText] = useState(''),
    [, setTarget] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const request = game.pending[0];
  const self = game.seats.find((p) => p.id === game.humanId);
  const seconds =
    game.clock && (game.clock.deadlineAt !== undefined || game.clock.remainingMs !== undefined)
      ? Math.max(
          0,
          Math.ceil(
            (game.status === 'paused' ? game.clock.remainingMs || 0 : (game.clock.deadlineAt || now) - now) / 1000,
          ),
        )
      : null;
  const death = game.logs.find(
    (e) =>
      !e.seatId && !!self && e.text.includes(self.name) && (e.text.includes(' 出局。') || e.text.includes(' 被放逐。')),
  );
  useEffect(() => {
    setText('');
    setTarget('');
    setError('');
  }, [request?.id]);
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [game.logs.length]);
  async function perform(action: () => Promise<GameView>) {
    if (busy || syncError) return;
    onMutationStart();
    setBusy(true);
    setError('');
    try {
      onUpdate(await action());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const control = (action: 'pause' | 'resume' | 'stop') =>
    perform(() => window.aelion.games.control({ id: game.id, action }));
  const submit = (action: GameAction) =>
    perform(() => window.aelion.games.act({ id: game.id, requestId: request!.id, action }));
  return (
    <>
      <div className="gg-table-heading">
        <h2>
          {game.status === 'finished'
            ? game.winner === 'wolves'
              ? translate('狼人获胜')
              : game.winner === 'village'
                ? translate('好人获胜')
                : translate('对局结束')
            : translate('狼人杀 · ') +
              translate(game.board === 'guard12' ? '预女猎守' : game.board === 'standard12' ? '预女猎白' : '七人局')}
        </h2>
        <div className="wg-actions">
          <button className="secondary-button" onClick={() => setDiagnostics((v) => !v)}>
            {translate('运行记录')}
          </button>
          {!game.humanId && (
            <button className="secondary-button" aria-pressed={omniscient} onClick={onOmniscient}>
              {translate(omniscient ? '全知视角' : '公共视角')}
            </button>
          )}
          {game.status !== 'finished' && (
            <>
              <button
                className="secondary-button"
                disabled={busy || !!syncError || !!syncError}
                onClick={() => void control(game.status === 'paused' ? 'resume' : 'pause')}
              >
                {translate(game.status === 'paused' ? '继续' : '暂停')}
              </button>
              <button
                className="secondary-button"
                disabled={busy || !!syncError || !!syncError}
                onClick={() => setConfirmStop(true)}
              >
                {translate('结束对局')}
              </button>
            </>
          )}
        </div>
      </div>
      {syncError && (
        <div role="alert" className="wg-confirm">
          {translate('连接中断，当前显示最后一次同步的状态。{error}', { error: syncError })}
        </div>
      )}
      {diagnostics && <GameDiagnostics game={game} />}{' '}
      {confirmStop && (
        <div className="wg-confirm" role="alert">
          <span>{translate('结束后本局不计胜负，并保留操作记录。')}</span>
          <button className="secondary-button" onClick={() => setConfirmStop(false)}>
            {translate('取消')}
          </button>
          <button
            className="primary-button"
            disabled={busy || !!syncError || !!syncError}
            onClick={() => {
              setConfirmStop(false);
              void control('stop');
            }}
          >
            {translate('确认结束')}
          </button>
        </div>
      )}
      {self && !self.alive && game.status !== 'finished' && (
        <div className="wg-death" role="status">
          <strong>{translate('你已出局')}</strong>
          <span>
            {death?.text || translate('你已出局。')}{' '}
            {translate(request ? '请完成遗言、技能或警徽操作。' : '可继续观战。')}
          </span>
        </div>
      )}
      <div className="gg-table">
        <aside className="gg-seats">
          <div className="gg-section-label">
            {translate('玩家')}{' '}
            <span>{translate('{count} 人存活', { count: game.seats.filter((p) => p.alive).length })}</span>
          </div>
          {game.seats.map((p, i) => (
            <div key={p.id} className="gg-seat" style={{ opacity: p.alive ? 1 : 0.5 }}>
              <span className="gg-seat-number">{i + 1}</span>
              <Avatar bot={p} size={32} />
              <div>
                <strong>
                  {p.name}
                  {p.human && p.name !== '你' ? translate(' · 你') : ''}
                </strong>
                <small>
                  {p.role ? roles[p.role] : ''}
                  {game.sheriffId === p.id ? translate(' · 警长') : ''}
                  {p.canVote === false ? translate(' · 无投票权') : ''}
                  {!p.alive ? translate(' · 已出局') : ''}
                </small>
                {electionLabel(game, p.id) && (
                  <span className="wg-election-tag" data-active={game.candidates?.includes(p.id) || undefined}>
                    {electionLabel(game, p.id)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </aside>
        <section className="gg-stage">
          <GamePhaseStatus game={game} seconds={seconds} syncError={syncError} />
          <div className="gg-transcript" ref={feed}>
            {game.logs.map((e) => {
              const player = game.seats.find((p) => p.id === e.seatId);
              return player ? (
                <article className="gg-message group-message" key={e.id}>
                  <Avatar bot={player} size={32} />
                  <div>
                    <strong>{player.name}</strong>
                    <p className="group-message-bubble">{e.text}</p>
                  </div>
                </article>
              ) : (
                <div className="gg-system" key={e.id}>
                  {e.time && (
                    <time>
                      {new Date(e.time).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}{' '}
                      ·{' '}
                    </time>
                  )}
                  {e.text}
                </div>
              );
            })}
          </div>
          <footer className="gg-controls">
            <div className="wg-input">
              {(error || game.error) && (
                <p role="alert" className="group-error">
                  {error || game.error}
                </p>
              )}
              {game.status === 'finished' ? (
                <button className="primary-button" onClick={onClose}>
                  {translate('返回群聊')}
                </button>
              ) : game.status === 'paused' ? (
                <span>{translate('对局已暂停')}</span>
              ) : !request ? (
                <span>
                  {game.seats.find((p) => p.id === game.humanId)?.alive === false
                    ? translate('你已出局，可继续观战。')
                    : translate('等待 AI 行动…')}
                </span>
              ) : (
                <GameActionControls request={request} game={game} busy={busy || !!syncError} submit={submit} />
              )}
            </div>
          </footer>
        </section>
      </div>
    </>
  );
}
