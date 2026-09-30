import { ElectionBoard, GamePhaseSteps, GameTimer, electionLabel } from './GamePhaseStatus';
import { GameDiagnostics } from './GameDiagnostics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import type { GameView, GameAction, GameRole } from '../../shared/types/game-types';
import { BOARDS, ROLE_NAMES as roles } from '../../shared/games/game-boards';
import { GameActionControls } from './GameActionControls';
import { translate } from '../../shared/i18n';
import {
  matchMinutes,
  periodOf,
  personalClues,
  reportTimeline,
  seatFate,
  seatNumber,
  transcriptItems,
  type TallyRow,
} from './game-view-model';

type Seat = GameView['seats'][number];
const EMBLEM: Record<GameRole, string> = {
  wolf: '🐺',
  seer: '👁',
  witch: '⚗',
  hunter: '🎯',
  idiot: '🃏',
  guard: '🛡',
  villager: '🌾',
};
const ABILITY: Record<GameRole, string> = {
  wolf: '每晚和狼队友商量，袭击一名玩家。白天隐藏身份，把票引向好人。',
  seer: '每晚查验一名玩家，知道他是好人还是狼人。',
  witch: '有一瓶解药和一瓶毒药，每晚最多用一瓶，不能自救。',
  hunter: '被刀或被放逐时可以开枪带走一人；被毒不能开枪。',
  idiot: '第一次被放逐时翻牌免死，之后失去投票权。',
  guard: '每晚守护一人，不能连续两夜守同一人。',
  villager: '没有技能，靠发言和投票找出狼人。',
};
const camp = (role?: GameRole) => (!role ? '' : role === 'wolf' ? 'wolf' : role === 'villager' ? 'good' : 'god');
const campLabel = (role?: GameRole) =>
  !role
    ? ''
    : role === 'wolf'
      ? translate('狼人阵营')
      : translate(role === 'villager' ? '好人阵营 · 平民' : '好人阵营 · 神职');

function SeatAvatar({ seat, size = 30 }: { seat: Seat; size?: number }) {
  return seat.human ? (
    <span className="gg-human-avatar" style={{ width: size, height: size }}>
      <Icon name="user" size={Math.round(size * 0.55)} />
    </span>
  ) : (
    <Avatar bot={seat} size={size} />
  );
}

function Tally({ game, rows, abstain, day }: { game: GameView; rows: TallyRow[]; abstain: Seat[]; day: number }) {
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return (
    <section className="gg-tally" aria-label={translate('第 {day} 天 · 投票结果', { day })}>
      <header>
        <b>{translate('第 {day} 天 · 投票结果', { day })}</b>
        <span className="gg-muted">
          {translate('{votes} 票', { votes: total })}
          {abstain.length ? translate(' · {count} 人弃票', { count: abstain.length }) : ''}
        </span>
      </header>
      {rows.map((row) => (
        <div className="gg-tally-row" key={row.target.id}>
          <span className="gg-tally-target">
            {translate('{seat} 号 {name}', { seat: seatNumber(game, row.target.id), name: row.target.name })}
          </span>
          <span className="gg-tally-voters">
            {row.voters.map(({ seat, weight }) => (
              <span key={seat.id} title={seat.name} className="gg-tally-voter">
                <SeatAvatar seat={seat} size={18} />
                {weight !== 1 && <small>×{weight}</small>}
              </span>
            ))}
          </span>
          <b>{row.total}</b>
        </div>
      ))}
      {abstain.length > 0 && (
        <div className="gg-tally-row is-abstain">
          <span className="gg-muted">{translate('弃票')}</span>
          <span className="gg-tally-voters">
            {abstain.map((seat) => (
              <span key={seat.id} title={seat.name} className="gg-tally-voter">
                <SeatAvatar seat={seat} size={18} />
              </span>
            ))}
          </span>
          <span />
        </div>
      )}
      {total > 0 && (
        <div className="gg-tally-bar" aria-hidden="true">
          {rows.map((row, index) => (
            <i key={row.target.id} style={{ width: `${(row.total / total) * 100}%`, opacity: index ? 0.45 : 1 }} />
          ))}
        </div>
      )}
    </section>
  );
}

function RoleReveal({ seat, board, onClose }: { seat: Seat; board?: GameView['board']; onClose: () => void }) {
  const [left, setLeft] = useState(8);
  useEffect(() => {
    const timer = setInterval(() => setLeft((value) => value - 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (left <= 0) onClose();
  }, [left, onClose]);
  if (!seat.role) return null;
  return (
    <div className="gg-reveal" role="dialog" aria-modal="true" aria-label={translate('你的身份')}>
      <div className={`gg-reveal-card is-${camp(seat.role)}`}>
        <span className="gg-reveal-emblem" aria-hidden="true">
          {EMBLEM[seat.role]}
        </span>
        <small>{translate('你的身份')}</small>
        <h3>{translate(roles[seat.role])}</h3>
        <p className="gg-reveal-camp">
          {campLabel(seat.role)}
          {board ? ` · ${translate(BOARDS[board].name)}` : ''}
        </p>
        <p>{translate(ABILITY[seat.role])}</p>
        <button className="primary-button" onClick={onClose} autoFocus>
          {translate('我记住了')}
        </button>
        <span className="gg-muted">
          {translate('{seconds} 秒后天黑 · 身份只显示在你的屏幕上', { seconds: Math.max(left, 0) })}
        </span>
      </div>
    </div>
  );
}

function Report({ game, onDiagnostics, onClose }: { game: GameView; onDiagnostics: () => void; onClose: () => void }) {
  const minutes = matchMinutes(game),
    alive = game.seats.filter((p) => p.alive).length,
    self = game.seats.find((p) => p.id === game.humanId);
  const title =
    game.winner === 'wolves'
      ? translate('狼人获胜')
      : game.winner === 'village'
        ? translate('好人获胜')
        : translate('对局已中止');
  return (
    <div className="gg-report">
      <header className={`gg-report-hero is-${game.winner || 'none'}`}>
        <span className="gg-report-mark" aria-hidden="true">
          {game.winner === 'wolves' ? '☾' : '☀'}
        </span>
        <div>
          <h2>{title}</h2>
          <p>
            {game.winner
              ? translate('第 {day} 天结束', { day: game.day })
              : translate('第 {day} 天中途结束，不计胜负', { day: game.day })}
            {self?.role
              ? ` · ${translate('你是{role}', { role: translate(roles[self.role]) })}`
              : game.humanId
                ? ''
                : ` · ${translate('旁观')}`}
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
            <dd>{translate('{count} 天', { count: game.day })}</dd>
          </div>
          <div>
            <dt>{translate('存活')}</dt>
            <dd>
              {alive} / {game.seats.length}
            </dd>
          </div>
        </dl>
      </header>
      <div className="gg-report-body">
        <div className="gg-report-seats">
          {game.seats.map((seat, index) => {
            const fate = seatFate(game, seat);
            return (
              <article key={seat.id} className={`gg-report-seat is-${camp(seat.role)} ${seat.alive ? '' : 'is-dead'}`}>
                <SeatAvatar seat={seat} size={30} />
                <div>
                  <b>
                    {index + 1} {seat.human ? translate('你') : seat.name}
                  </b>
                  {seat.role && (
                    <span className={`gg-tag is-${camp(seat.role)}`}>
                      {translate(roles[seat.role])}
                      {game.sheriffId === seat.id ? translate(' · 警长') : ''}
                    </span>
                  )}
                </div>
                <small>
                  {seat.alive
                    ? translate(game.winner ? '存活' : '中止时存活')
                    : fate
                      ? translate('第 {day} 天{text}', { day: fate.day, text: translate(fate.text) })
                      : translate('已出局')}
                </small>
              </article>
            );
          })}
        </div>
        <aside className="gg-report-timeline" aria-label={translate('关键事件')}>
          <div className="gg-section-label">{translate('关键事件')}</div>
          <ol>
            {reportTimeline(game).map((log) => (
              <li key={log.id}>
                <span>{translate(log.phase === 'night' ? '第 {day} 夜' : '第 {day} 天', { day: log.day })}</span>
                <p>{log.text}</p>
              </li>
            ))}
          </ol>
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
    [diagnostics, setDiagnostics] = useState(false),
    [menu, setMenu] = useState(false),
    [peek, setPeek] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const request = game.pending[0];
  const self = game.seats.find((p) => p.id === game.humanId);
  const period = periodOf(game),
    finished = period === 'finished';
  const revealKey = `aelion:game-reveal:${game.id}`;
  const [revealed, setRevealed] = useState(() => {
    try {
      return localStorage.getItem(revealKey) === '1';
    } catch {
      return true;
    }
  });
  const closeReveal = useCallback(() => {
    setRevealed(true);
    try {
      localStorage.setItem(revealKey, '1');
    } catch {}
  }, [revealKey]);
  const seconds =
    game.clock && (game.clock.deadlineAt !== undefined || game.clock.remainingMs !== undefined)
      ? Math.max(
          0,
          Math.ceil(
            (game.status === 'paused' ? game.clock.remainingMs || 0 : (game.clock.deadlineAt || now) - now) / 1000,
          ),
        )
      : null;
  const speaker = game.seats.find((p) => p.id === game.clock?.seatId);
  const totalSeconds = request
    ? ['speak', 'wolf_plan', 'campaign', 'pk_speak', 'last_words'].includes(request.kind)
      ? 120
      : 45
    : speaker && !speaker.human
      ? 60
      : 45;
  const death = game.logs.find(
    (e) =>
      !e.seatId && !!self && e.text.includes(self.name) && (e.text.includes(' 出局。') || e.text.includes(' 被放逐。')),
  );
  useEffect(() => {
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
  const clues = personalClues(game);
  const known = game.seats.filter((p) => p.role);
  const aliveOf = (test: (role: GameRole) => boolean) =>
    game.seats.filter((p) => p.alive && p.role && test(p.role)).length;
  const boardName = game.board ? translate(BOARDS[game.board].name) : translate('七人局');
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
  return (
    <div className="gg-table-root" data-period={period}>
      <div className="gg-topbar">
        <strong>
          {translate('狼人杀')}
          <small>
            {boardName} · {translate(game.humanId ? '你参与' : omniscient ? '旁观 · 全知视角' : '旁观')}
          </small>
        </strong>
        <GamePhaseSteps game={game} />
        {game.status === 'paused' ? (
          <span className="gg-tag">{translate('已暂停')}</span>
        ) : (
          <GameTimer seconds={seconds} total={totalSeconds} syncError={syncError} />
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
      {self && !self.alive && (
        <div className="gg-banner is-out" role="status">
          <b>{translate('你已出局')}</b>
          <span>
            {death?.text || translate('你已出局。')}{' '}
            {translate(request ? '请完成遗言、技能或警徽操作。' : '可继续观战。')}
          </span>
        </div>
      )}
      <div className={`gg-table ${self && !self.alive && !request ? 'is-spectating' : ''}`}>
        <ul className="gg-rail" aria-label={translate('玩家')}>
          <li className="gg-section-label">
            <span>{translate('玩家')}</span>
            <span>{translate('{count} 人存活', { count: game.seats.filter((p) => p.alive).length })}</span>
          </li>
          {game.seats.map((p, i) => {
            const tag = electionLabel(game, p.id);
            const sub = [
              p.role ? translate(roles[p.role]) : '',
              p.human && p.name !== '你' ? translate('你') : '',
              p.canVote === false ? translate('无投票权') : '',
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li
                key={p.id}
                className={`gg-seat ${p.alive ? '' : 'is-dead'} ${p.id === game.humanId ? 'is-me' : ''} ${game.clock?.seatId === p.id ? 'is-speaking' : ''}`}
              >
                <span className="gg-seat-number">{i + 1}</span>
                <SeatAvatar seat={p} />
                <span className="gg-seat-name">
                  {p.human ? translate('你') : p.name}
                  {sub && <small>{sub}</small>}
                </span>
                {game.sheriffId === p.id ? (
                  <span className="gg-tag is-sheriff">{translate('警长')}</span>
                ) : tag ? (
                  <span
                    className={`gg-tag ${game.candidates?.includes(p.id) || tag === translate('警上') ? 'is-accent' : ''}`}
                  >
                    {tag}
                  </span>
                ) : game.clock?.seatId === p.id && game.status === 'running' ? (
                  <span className="gg-tag is-accent">{translate('发言中')}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <section className="gg-stage">
          <div className="gg-transcript" ref={feed}>
            <ElectionBoard game={game} />
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
                        {e.scope === 'personal' && <span className="gg-tag">{translate('仅狼队可见')}</span>}
                      </div>
                      <p className="gg-bubble">{e.text}</p>
                    </div>
                  </article>
                );
              const night = /^第 \d+ 夜$/.test(e.text) || e.text.startsWith('天黑');
              return (
                <div
                  className={`gg-system ${e.scope === 'personal' ? 'is-private' : ''} ${night || e.text.startsWith('天亮') ? 'is-big' : ''}`}
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
                timer={<GameTimer seconds={seconds} total={totalSeconds} syncError={syncError} />}
              />
            )}
          </footer>
        </section>
        <aside className="gg-side">
          {self?.role ? (
            <section className="gg-card">
              <h4>
                <span>{translate('我的身份')}</span>
                <span className="gg-muted">{translate('按住查看')}</span>
              </h4>
              <button
                type="button"
                className={`gg-identity is-${camp(self.role)} ${peek ? 'is-peeking' : ''}`}
                onPointerDown={() => setPeek(true)}
                onPointerUp={() => setPeek(false)}
                onPointerLeave={() => setPeek(false)}
                onFocus={() => setPeek(true)}
                onBlur={() => setPeek(false)}
                aria-label={translate('按住查看身份')}
              >
                <span className="gg-identity-emblem" aria-hidden="true">
                  {EMBLEM[self.role]}
                </span>
                <span>
                  <b>{translate(roles[self.role])}</b>
                  <small>{campLabel(self.role)}</small>
                </span>
              </button>
            </section>
          ) : null}
          {game.humanId && (
            <section className="gg-card">
              <h4>
                <span>{translate('我的线索')}</span>
                {clues.length > 0 && (
                  <span className="gg-muted">{translate('{count} 条', { count: clues.length })}</span>
                )}
              </h4>
              {clues.length ? (
                <ul className="gg-clues">
                  {clues.map((clue) => (
                    <li key={clue.id}>
                      <span className="gg-muted">
                        {translate(clue.phase === 'night' ? '第 {day} 夜' : '第 {day} 天', { day: clue.day })}
                      </span>
                      <span
                        className={/是狼人/.test(clue.text) ? 'is-wolf' : /是好人/.test(clue.text) ? 'is-good' : ''}
                      >
                        {clue.text.replace(/^查验结果：/, '')}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="gg-muted">{translate('夜里的查验、用药等私有结果会记在这里。')}</p>
              )}
            </section>
          )}
          <section className="gg-card">
            <h4>
              <span>{translate('场上')}</span>
            </h4>
            <dl className="gg-kv">
              <dt>{translate('存活')}</dt>
              <dd>{translate('{count} 人', { count: game.seats.filter((p) => p.alive).length })}</dd>
              {known.length === game.seats.length ? (
                <>
                  <dt>{translate('狼人')}</dt>
                  <dd>{aliveOf((role) => role === 'wolf')}</dd>
                  <dt>{translate('神职')}</dt>
                  <dd>{aliveOf((role) => role !== 'wolf' && role !== 'villager')}</dd>
                  <dt>{translate('平民')}</dt>
                  <dd>{aliveOf((role) => role === 'villager')}</dd>
                </>
              ) : (
                <>
                  <dt>{translate('板子')}</dt>
                  <dd>{game.board ? translate(BOARDS[game.board].description) : boardName}</dd>
                </>
              )}
              {game.sheriffId && (
                <>
                  <dt>{translate('警长')}</dt>
                  <dd>
                    {translate('{seat} 号 {name}', {
                      seat: seatNumber(game, game.sheriffId),
                      name: game.seats[seatNumber(game, game.sheriffId) - 1]?.name || '',
                    })}
                  </dd>
                </>
              )}
            </dl>
          </section>
        </aside>
      </div>
      {drawer}
      {self?.role && !revealed && game.day === 1 && game.phase === 'night' && (
        <RoleReveal seat={self} board={game.board} onClose={closeReveal} />
      )}
    </div>
  );
}
