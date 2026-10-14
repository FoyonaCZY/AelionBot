import { useEffect, useState, type ReactNode } from 'react';
import type { GameAction, GameView } from '../../shared/types/game-types';
import { translate } from '../../shared/i18n';
import { Icon } from '../ui/Icon';
import { GameDiagnostics } from './GameDiagnostics';
import { GameTimer } from './GamePhaseStatus';

/** What every game table receives from the AI games dialog. */
export interface GameTableProps {
  game: GameView;
  onMutationStart: () => void;
  syncError: string;
  onUpdate: (v: GameView) => void;
  omniscient: boolean;
  onOmniscient: () => void;
  onClose: () => void;
}

/**
 * State shared by every game table: a ticking clock for the countdown, and one action at a time sent to the
 * runtime, with its error shown until the next request.
 */
export function useGameTable({ game, onUpdate, onMutationStart, syncError }: GameTableProps) {
  const [now, setNow] = useState(Date.now()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const request = game.pending[0];
  useEffect(() => {
    setError('');
  }, [request?.id]);
  const seconds =
    game.clock && (game.clock.deadlineAt !== undefined || game.clock.remainingMs !== undefined)
      ? Math.max(
          0,
          Math.ceil(
            (game.status === 'paused' ? game.clock.remainingMs || 0 : (game.clock.deadlineAt || now) - now) / 1000,
          ),
        )
      : null;
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
  return {
    request,
    self: game.seats.find((p) => p.id === game.humanId),
    speaker: game.seats.find((p) => p.id === game.clock?.seatId),
    seconds,
    busy,
    error,
    control: (action: 'pause' | 'resume' | 'stop') =>
      perform(() => window.aelion.games.control({ id: game.id, action })),
    submit: (action: GameAction) =>
      perform(() => window.aelion.games.act({ id: game.id, requestId: request!.id, action })),
  };
}

export function DiagnosticsDrawer({ game, onClose }: { game: GameView; onClose: () => void }) {
  return (
    <aside className="gg-drawer" aria-label={translate('运行记录')}>
      <header>
        <b>{translate('运行记录')}</b>
        <span className="gg-spacer" />
        <button className="icon-button" aria-label={translate('关闭运行记录')} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <GameDiagnostics game={game} />
    </aside>
  );
}

/**
 * The bar above every table: game name, where the match is, the countdown, pause and the menu (run record,
 * full view for an all-AI match, stop). Stopping asks for confirmation below the bar.
 */
export function GameTopbar({
  game,
  title,
  subtitle,
  steps,
  seconds,
  total,
  syncError,
  busy,
  omniscient,
  onOmniscient,
  onDiagnostics,
  control,
}: {
  game: GameView;
  title: string;
  subtitle: string;
  steps?: ReactNode;
  seconds: number | null;
  total: number;
  syncError: string;
  busy: boolean;
  omniscient: boolean;
  onOmniscient: () => void;
  onDiagnostics: () => void;
  control: (action: 'pause' | 'resume' | 'stop') => Promise<void>;
}) {
  const [menu, setMenu] = useState(false),
    [confirmStop, setConfirmStop] = useState(false);
  return (
    <>
      <div className="gg-topbar">
        <strong>
          {title}
          <small>{subtitle}</small>
        </strong>
        {steps ?? <span className="gg-spacer" />}
        {game.status === 'paused' ? (
          <span className="gg-tag">{translate('已暂停')}</span>
        ) : (
          <GameTimer seconds={seconds} total={total} syncError={syncError} />
        )}
        <button
          className="icon-button"
          aria-label={translate(game.status === 'paused' ? '继续' : '暂停')}
          title={translate(game.status === 'paused' ? '继续' : '暂停')}
          disabled={busy || !!syncError}
          onClick={() => void control(game.status === 'paused' ? 'resume' : 'pause')}
        >
          {game.status === 'paused' ? <span aria-hidden="true">▶</span> : <Icon name="pause" size={15} />}
        </button>
        <div className="gg-menu">
          <button
            className="icon-button"
            aria-label={translate('更多操作')}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {menu && (
            <div className="gg-menu-list" role="menu" onClick={() => setMenu(false)}>
              <button role="menuitem" onClick={onDiagnostics}>
                {translate('运行记录')}
              </button>
              {!game.humanId && (
                <button role="menuitem" aria-pressed={omniscient} onClick={onOmniscient}>
                  {translate(omniscient ? '切换到公共视角' : '切换到全知视角')}
                </button>
              )}
              <button
                role="menuitem"
                className="is-danger"
                disabled={busy || !!syncError}
                onClick={() => setConfirmStop(true)}
              >
                {translate('结束对局')}
              </button>
            </div>
          )}
        </div>
      </div>
      {syncError && (
        <div role="alert" className="gg-banner is-warning">
          {translate('连接中断，当前显示最后一次同步的状态。{error}', { error: syncError })}
        </div>
      )}
      {confirmStop && (
        <div className="gg-banner is-warning" role="alert">
          <span>{translate('结束后本局不计胜负，并保留操作记录。')}</span>
          <span className="gg-spacer" />
          <button className="secondary-button" onClick={() => setConfirmStop(false)}>
            {translate('取消')}
          </button>
          <button
            className="primary-button"
            disabled={busy || !!syncError}
            onClick={() => {
              setConfirmStop(false);
              void control('stop');
            }}
          >
            {translate('确认结束')}
          </button>
        </div>
      )}
    </>
  );
}
