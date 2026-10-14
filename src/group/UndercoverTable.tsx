import { useEffect, useRef, useState } from 'react';
import type { GameAction, GameView } from '../../shared/types/game-types';
import { ROLE_NAMES as roles } from '../../shared/games/game-boards';
import { translate } from '../../shared/i18n';
import { Icon } from '../ui/Icon';
import { GameActionControls } from './GameActionControls';
import { GameDiagnostics } from './GameDiagnostics';
import { GameTimer } from './GamePhaseStatus';
import { SeatAvatar, Tally } from './WerewolfTable';
import { matchMinutes, seatNumber, transcriptItems } from './game-view-model';

const WINNER: Record<string, string> = { civilian: '平民获胜', undercover: '卧底获胜', blank: '白板获胜' };
const roleClass = (role?: string) => (role === 'undercover' ? 'wolf' : role === 'blank' ? 'god' : role ? 'good' : '');

/** The words, for the viewer: their own while playing, both once the match is over or watched with full view. */
function Words({ game }: { game: GameView }) {
  const words = game.words || {};
  if (words.civilian && words.undercover)
    return (
      <dl className="gg-kv">
        <dt>{translate('平民的词')}</dt>
        <dd>{words.civilian}</dd>
        <dt>{translate('卧底的词')}</dt>
        <dd>{words.undercover}</dd>
      </dl>
    );
  if (!game.humanId) return <p className="gg-muted">{translate('旁观时看不到任何人的词；切到全知视角可以看到。')}</p>;
  return words.own ? (
    <p className="gg-word">
      <b>{words.own}</b>
      <small>{translate('你不知道自己是平民还是卧底，从别人的描述里判断。')}</small>
    </p>
  ) : (
    <p className="gg-word">
      <b>{translate('白板')}</b>
      <small>{translate('你没有拿到词。听别人的描述，尽量不被发现。')}</small>
    </p>
  );
}

function Report({ game, onDiagnostics, onClose }: { game: GameView; onDiagnostics: () => void; onClose: () => void }) {
  const minutes = matchMinutes(game),
    self = game.seats.find((p) => p.id === game.humanId);
  return (
    <div className="gg-report">
      <header
        className={`gg-report-hero is-${game.winner === 'civilian' ? 'village' : game.winner ? 'wolves' : 'none'}`}
      >
        <span className="gg-report-mark" aria-hidden="true">
          🕵
        </span>
        <div>
          <h2>{translate(game.winner ? WINNER[game.winner] : '对局已中止')}</h2>
          <p>
            {game.winner
              ? translate('第 {round} 轮结束', { round: game.day })
              : translate('第 {round} 轮中途结束，不计胜负', { round: game.day })}
            {self?.role ? ` · ${translate('你是{role}', { role: translate(roles[self.role]) })}` : ''}
          </p>
        </div>
        <dl className="gg-kpis">
          {minutes !== undefined && (
            <div>
              <dt>{translate('用时')}</dt>
              <dd>{translate('{count} 分', { count: minutes })}</dd>
            </div>
          )}
          <div>
            <dt>{translate('轮数')}</dt>
            <dd>{translate('{count} 轮', { count: game.day })}</dd>
          </div>
        </dl>
      </header>
      <div className="gg-report-body">
        <div className="gg-report-seats">
          {game.seats.map((seat, index) => (
            <article
              key={seat.id}
              className={`gg-report-seat is-${roleClass(seat.role)} ${seat.alive ? '' : 'is-dead'}`}
            >
              <SeatAvatar seat={seat} size={30} />
              <div>
                <b>
                  {index + 1} {seat.human ? translate('你') : seat.name}
                </b>
                {seat.role && (
                  <span className={`gg-tag is-${roleClass(seat.role)}`}>{translate(roles[seat.role])}</span>
                )}
              </div>
              <small>{translate(seat.alive ? '存活' : '已出局')}</small>
            </article>
          ))}
        </div>
        <aside className="gg-report-timeline" aria-label={translate('词')}>
          <div className="gg-section-label">{translate('词')}</div>
          <Words game={game} />
        </aside>
      </div>
      <footer className="gg-report-actions">
        <button className="secondary-button" onClick={onDiagnostics}>
          {translate('运行记录')}
        </button>
        <span className="gg-spacer" />
        <button className="primary-button" onClick={onClose}>
          {translate('返回群聊')}
        </button>
      </footer>
    </div>
  );
}

export function UndercoverTable({
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
    [diagnostics, setDiagnostics] = useState(false),
    [menu, setMenu] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const feed = useRef<HTMLDivElement>(null);
  const request = game.pending[0];
  const self = game.seats.find((p) => p.id === game.humanId);
  const finished = game.status === 'finished' || game.phase === 'finished';
  useEffect(() => {
    setError('');
  }, [request?.id]);
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [game.logs.length]);
  const seconds =
    game.clock && (game.clock.deadlineAt !== undefined || game.clock.remainingMs !== undefined)
      ? Math.max(
          0,
          Math.ceil(
            (game.status === 'paused' ? game.clock.remainingMs || 0 : (game.clock.deadlineAt || now) - now) / 1000,
          ),
        )
      : null;
  const total = request?.kind === 'describe' ? 90 : 45;
  const speaker = game.seats.find((p) => p.id === game.clock?.seatId);
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
  const drawer = diagnostics && (
    <aside className="gg-drawer" aria-label={translate('运行记录')}>
      <header>
        <b>{translate('运行记录')}</b>
        <span className="gg-spacer" />
        <button className="icon-button" aria-label={translate('关闭运行记录')} onClick={() => setDiagnostics(false)}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <GameDiagnostics game={game} />
    </aside>
  );
  if (finished)
    return (
      <div className="gg-table-root" data-period="finished">
        <Report game={game} onDiagnostics={() => setDiagnostics(true)} onClose={onClose} />
        {drawer}
      </div>
    );
  const phase =
    game.phase === 'vote' ? translate('投票') : game.phase === 'resolution' ? translate('白板猜词') : translate('描述');
  return (
    <div className="gg-table-root" data-period="day">
      <div className="gg-topbar">
        <strong>
          {translate('谁是卧底')}
          <small>
            {translate('第 {round} 轮 · {phase}', { round: game.day, phase })} ·{' '}
            {translate(game.humanId ? '你参与' : omniscient ? '旁观 · 全知视角' : '旁观')}
          </small>
        </strong>
        <span className="gg-spacer" />
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
              <button role="menuitem" onClick={() => setDiagnostics(true)}>
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
      {self && !self.alive && !request && (
        <div className="gg-banner is-out" role="status">
          <b>{translate('你已出局')}</b>
          <span>{translate('可继续观战。')}</span>
        </div>
      )}
      <div className={`gg-table ${self && !self.alive && !request ? 'is-spectating' : ''}`}>
        <ul className="gg-rail" aria-label={translate('玩家')}>
          <li className="gg-section-label">
            <span>{translate('玩家')}</span>
            <span>{translate('{count} 人存活', { count: game.seats.filter((p) => p.alive).length })}</span>
          </li>
          {game.seats.map((p, i) => (
            <li
              key={p.id}
              className={`gg-seat ${p.alive ? '' : 'is-dead'} ${p.id === game.humanId ? 'is-me' : ''} ${game.clock?.seatId === p.id ? 'is-speaking' : ''}`}
            >
              <span className="gg-seat-number">{i + 1}</span>
              <SeatAvatar seat={p} />
              <span className="gg-seat-name">
                {p.human ? translate('你') : p.name}
                {p.role && <small>{translate(roles[p.role])}</small>}
              </span>
              {game.clock?.seatId === p.id && game.status === 'running' ? (
                <span className="gg-tag is-accent">{translate('描述中')}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <section className="gg-stage">
          <div className="gg-transcript" ref={feed}>
            {transcriptItems(game).map((item) => {
              if (item.kind === 'tally')
                return <Tally key={'t' + item.id} game={game} rows={item.rows} abstain={item.abstain} day={item.day} />;
              const e = item.log;
              const player = game.seats.find((p) => p.id === e.seatId);
              if (player)
                return (
                  <article className={`gg-message ${player.human ? 'is-me' : ''}`} key={e.id}>
                    <SeatAvatar seat={player} />
                    <div>
                      <div className="gg-message-who">
                        <b>
                          {translate('{seat} 号 {name}', {
                            seat: seatNumber(game, player.id),
                            name: player.human ? translate('你') : player.name,
                          })}
                        </b>
                      </div>
                      <p className="gg-bubble">{e.text}</p>
                    </div>
                  </article>
                );
              return (
                <div
                  className={`gg-system ${e.scope === 'personal' ? 'is-private' : ''} ${/^第 \d+ 轮描述/.test(e.text) ? 'is-big' : ''}`}
                  key={e.id}
                >
                  {e.scope === 'personal' && <span className="gg-private-mark">{translate('只有你能看到')}</span>}
                  {e.text}
                </div>
              );
            })}
            {game.status === 'running' && !request && speaker && !speaker.human && (
              <div className="gg-system">
                {translate('{name} 正在思考', { name: speaker.name })}
                <span className="gg-typing" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>
          <footer className={`gg-dock ${request ? 'is-active' : ''}`}>
            {(error || game.error) && (
              <p role="alert" className="group-error">
                {error || game.error}
              </p>
            )}
            {game.status === 'paused' ? (
              <span className="gg-dock-idle">{translate('对局已暂停')}</span>
            ) : !request ? (
              <span className="gg-dock-idle">
                {self?.alive === false
                  ? translate('你已出局，可继续观战。')
                  : speaker
                    ? translate('等待 {name} 行动…', { name: speaker.human ? translate('你') : speaker.name })
                    : translate('等待 AI 行动…')}
              </span>
            ) : (
              <GameActionControls
                request={request}
                game={game}
                busy={busy || !!syncError}
                submit={submit}
                timer={<GameTimer seconds={seconds} total={total} syncError={syncError} />}
              />
            )}
          </footer>
        </section>
        <aside className="gg-side">
          <section className="gg-card">
            <h4>
              <span>{translate(game.humanId ? '我的词' : '词')}</span>
            </h4>
            <Words game={game} />
          </section>
          <section className="gg-card">
            <h4>
              <span>{translate('场上')}</span>
            </h4>
            <dl className="gg-kv">
              <dt>{translate('存活')}</dt>
              <dd>{translate('{count} 人', { count: game.seats.filter((p) => p.alive).length })}</dd>
              <dt>{translate('已出局')}</dt>
              <dd>
                {game.seats
                  .filter((p) => !p.alive && p.role)
                  .map((p) => `${seatNumber(game, p.id)} ${translate(roles[p.role!])}`)
                  .join('、') || translate('无')}
              </dd>
            </dl>
          </section>
        </aside>
      </div>
      {drawer}
    </div>
  );
}
