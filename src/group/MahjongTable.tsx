import { useEffect, useRef, useState } from 'react';
import type { GameView } from '../../shared/types/game-types';
import { tileName } from '../../shared/games/mahjong-rules';
import { translate } from '../../shared/i18n';
import { DiagnosticsDrawer, GameTopbar, useGameTable, type GameTableProps } from './GameTableFrame';
import { GameTimer } from './GamePhaseStatus';
import { SeatAvatar } from './WerewolfTable';
import { MahjongTile } from './CardFaces';
import './card-games.css';

type Seat = GameView['seats'][number];
const MELD_NAMES = { peng: '碰', gang: '明杠', angang: '暗杠' } as const;

function recentTalk(game: GameView, seatId: string) {
  return game.logs
    .slice(-5)
    .reverse()
    .find((l) => l.seatId === seatId)?.text;
}

function SeatArea({
  game,
  seat,
  side,
  children,
}: {
  game: GameView;
  seat: Seat;
  side: 'top' | 'left' | 'right' | 'bottom';
  children?: React.ReactNode;
}) {
  const table = game.tiles!;
  const turn = table.turnId === seat.id && game.status === 'running';
  const talk = recentTalk(game, seat.id);
  const hand = table.hands?.[seat.id];
  const won = table.win?.seatId === seat.id;
  return (
    <section className={`mj-seat is-${side} ${turn ? 'is-turn' : ''} ${won ? 'is-won' : ''}`}>
      <header className="mj-seat-head">
        <SeatAvatar seat={seat} size={28} />
        <span className="mj-seat-name">
          <b>{seat.human ? translate('你') : seat.name}</b>
          <small>
            {translate(table.dealerId === seat.id ? '庄家' : '闲家')}
            {table.scores && ` · ${table.scores[seat.id] > 0 ? '+' : ''}${table.scores[seat.id]}`}
          </small>
        </span>
        {turn && <span className="cg-thinking">{seat.human ? translate('轮到你') : translate('思考中')}</span>}
      </header>
      {talk && <p className="cg-talk">{talk}</p>}
      <div className="mj-row">
        {table.melds[seat.id].map((m, i) => (
          <span key={i} className="mj-meld" title={translate(MELD_NAMES[m.kind])}>
            {Array.from({ length: m.kind === 'peng' ? 3 : 4 }, (_, k) =>
              m.kind === 'angang' && (k === 0 || k === 3) ? (
                <MahjongTile key={k} size="sm" />
              ) : (
                <MahjongTile key={k} tile={m.tile} size="sm" />
              ),
            )}
          </span>
        ))}
        {side !== 'bottom' &&
          (hand
            ? hand.map((tile, i) => <MahjongTile key={i} tile={tile} size="sm" />)
            : Array.from({ length: table.counts[seat.id] }, (_, i) => <MahjongTile key={i} size="sm" />))}
      </div>
      {children}
      <div className="mj-river" aria-label={translate('打出的牌')}>
        {table.discards[seat.id].map((tile, i, all) => (
          <MahjongTile
            key={i}
            tile={tile}
            size="sm"
            active={table.lastDiscard?.seatId === seat.id && i === all.length - 1}
          />
        ))}
      </div>
    </section>
  );
}

export function MahjongTable(props: GameTableProps) {
  const { game, syncError, omniscient, onOmniscient, onClose } = props;
  const { request, seconds, busy, error, control, submit } = useGameTable(props);
  const [diagnostics, setDiagnostics] = useState(false);
  const [focus, setFocus] = useState<string>();
  const feed = useRef<HTMLOListElement>(null);
  const table = game.tiles!;
  const finished = game.status === 'finished' || game.phase === 'finished';
  useEffect(() => setFocus(undefined), [request?.id]);
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [game.logs.length]);
  const me = Math.max(
    0,
    game.seats.findIndex((p) => p.id === game.humanId),
  );
  const seatAt = (k: number) => game.seats[(me + k) % 4];
  const bottom = seatAt(0);
  const hand = table.hand || table.hands?.[bottom.id] || [];
  const turn = request?.kind === 'discard';
  const discardOf = (tile: string) => request?.options?.find((o) => o.id === `d:${tile}`);
  const specials = request?.options?.filter((o) => !o.id.startsWith('d:')) || [];
  const focused = focus ? discardOf(focus) : undefined;
  const total = (game.clock?.totalMs || 30000) / 1000;
  const drawer = <DiagnosticsDrawer game={game} open={diagnostics} onClose={() => setDiagnostics(false)} />;
  const win = table.win;
  const fan = win?.fans.reduce((sum, f) => sum + f.fan, 0) || 0;
  const nameOf = (id?: string) => {
    const seat = game.seats.find((p) => p.id === id);
    return seat?.human ? translate('你') : seat?.name || '';
  };
  return (
    <div className="gg-table-root mj-root" data-period={finished ? 'finished' : 'day'} data-game="mahjong">
      <GameTopbar
        game={game}
        title={translate('麻将')}
        subtitle={`${finished ? translate('对局结束') : translate('剩 {count} 张', { count: table.wall })} · ${translate(game.humanId ? '你参与' : omniscient ? '旁观 · 全知视角' : '旁观')}`}
        seconds={finished ? null : seconds}
        total={total}
        syncError={syncError}
        busy={busy}
        omniscient={omniscient}
        onOmniscient={onOmniscient}
        onDiagnostics={() => setDiagnostics(true)}
        control={control}
      />
      <div className="cg-layout">
        <div className="mj-felt">
          <SeatArea game={game} seat={seatAt(2)} side="top" />
          <SeatArea game={game} seat={seatAt(3)} side="left" />
          <div className="mj-center">
            {finished ? (
              <div className={`cg-result ${win ? 'is-landlord' : ''}`}>
                <h2>
                  {win
                    ? win.selfDrawn
                      ? translate('{name} 自摸', { name: nameOf(win.seatId) })
                      : translate('{name} 和牌', { name: nameOf(win.seatId) })
                    : translate(game.winner === 'draw' ? '流局' : '对局已中止')}
                </h2>
                {win && (
                  <>
                    <p className="mj-win-tile">
                      <MahjongTile tile={win.tile} />
                      {!win.selfDrawn && <span>{translate('{name} 点炮', { name: nameOf(win.fromId) })}</span>}
                    </p>
                    <p className="gg-muted">
                      {[
                        ...win.fans.map((f) => `${translate(f.name)} ${f.fan}`),
                        translate('共 {count} 番', { count: fan }),
                      ].join(' · ')}
                    </p>
                  </>
                )}
                <div className="cg-result-actions">
                  <button className="secondary-button" onClick={() => setDiagnostics(true)}>
                    {translate('运行记录')}
                  </button>
                  <button className="primary-button" onClick={onClose}>
                    {translate('返回群聊')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mj-wall">
                <b>{table.wall}</b>
                <small>{translate('牌墙剩余')}</small>
                {table.lastDiscard && (
                  <span className="mj-last">
                    <MahjongTile tile={table.lastDiscard.tile} />
                    <small>{translate('{name} 打出', { name: nameOf(table.lastDiscard.seatId) })}</small>
                  </span>
                )}
              </div>
            )}
          </div>
          <SeatArea game={game} seat={seatAt(1)} side="right" />
          <SeatArea game={game} seat={bottom} side="bottom">
            <div className={`mj-hand ${turn ? 'is-live' : ''}`}>
              {hand.length ? (
                hand.map((tile, i) => {
                  const option = discardOf(tile);
                  const drawn = !!table.drawn && i === hand.length - 1 && tile === table.drawn;
                  return (
                    <span key={i} className={drawn ? 'mj-drawn' : undefined}>
                      <MahjongTile
                        tile={tile}
                        active={focus === tile}
                        disabled={!turn || busy || !option}
                        title={option?.hint}
                        onClick={() => (focus === tile && option ? void submit({ target: option.id }) : setFocus(tile))}
                      />
                    </span>
                  );
                })
              ) : (
                <span className="gg-muted">{translate('旁观时看不到手牌；切到全知视角可以看到所有人的牌。')}</span>
              )}
            </div>
            <footer className="cg-actions">
              {(error || game.error) && (
                <p role="alert" className="group-error">
                  {error || game.error}
                </p>
              )}
              {request ? (
                <>
                  <span className="cg-pick">
                    {request.kind === 'claim'
                      ? translate('{name} 打出 {tile}', {
                          name: nameOf(table.lastDiscard?.seatId),
                          tile: table.lastDiscard ? tileName(table.lastDiscard.tile) : '',
                        })
                      : focused
                        ? `${focused.label} · ${focused.hint}`
                        : translate('点一张牌查看打后的进张，再点一次打出')}
                  </span>
                  <span className="gg-spacer" />
                  <GameTimer seconds={seconds} total={total} syncError={syncError} />
                  {request.canPass && (
                    <button className="secondary-button" disabled={busy} onClick={() => void submit({ skip: true })}>
                      {translate('过')}
                    </button>
                  )}
                  {specials.map((o) => (
                    <button
                      key={o.id}
                      className={o.id === 'hu' || request.kind === 'claim' ? 'primary-button' : 'secondary-button'}
                      disabled={busy}
                      onClick={() => void submit({ target: o.id })}
                    >
                      {o.label}
                    </button>
                  ))}
                  {turn && focused && (
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void submit({ target: focused.id })}
                    >
                      {translate('打出')}
                    </button>
                  )}
                </>
              ) : !finished ? (
                <span className="gg-muted">
                  {game.status === 'paused'
                    ? translate('对局已暂停')
                    : translate('等待 {name} 行动…', { name: nameOf(table.turnId) || 'AI' })}
                </span>
              ) : null}
            </footer>
          </SeatArea>
        </div>
        <aside className="cg-side">
          <div className="gg-section-label">
            <span>{translate('牌局记录')}</span>
          </div>
          <ol className="cg-log" ref={feed}>
            {game.logs
              .filter((l) => l.scope !== 'personal')
              .map((l) => {
                const seat = game.seats.find((p) => p.id === l.seatId);
                return (
                  <li key={l.id} className={seat ? 'is-talk' : ''}>
                    {seat ? (
                      <>
                        <b>{seat.human ? translate('你') : seat.name}</b>
                        {l.text}
                      </>
                    ) : (
                      l.text
                    )}
                  </li>
                );
              })}
          </ol>
        </aside>
      </div>
      {drawer}
    </div>
  );
}
