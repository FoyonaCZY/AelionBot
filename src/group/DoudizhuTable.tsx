import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameView } from '../../shared/types/game-types';
import { RANKS, rankOf, takeCards } from '../../shared/games/doudizhu-rules';
import { translate } from '../../shared/i18n';
import { DiagnosticsDrawer, GameTopbar, useGameTable, type GameTableProps } from './GameTableFrame';
import { GameTimer } from './GamePhaseStatus';
import { SeatAvatar } from './WerewolfTable';
import { PlayingCard } from './CardFaces';
import './card-games.css';
import { GameGlyph } from './GameGlyph';

type Seat = GameView['seats'][number];
const sameRanks = (a: string[], b: string[]) => [...a].sort().join(',') === [...b].sort().join(',');

/** The latest line of table talk from a seat, while it is among the last few lines of the log. */
function recentTalk(game: GameView, seatId: string) {
  return game.logs
    .slice(-5)
    .reverse()
    .find((l) => l.seatId === seatId)?.text;
}

function SeatPanel({ game, seat, side }: { game: GameView; seat: Seat; side: 'left' | 'right' | 'bottom' }) {
  const table = game.cards!;
  const landlord = table.landlordId === seat.id;
  const turn = game.clock?.seatId === seat.id && game.status === 'running';
  const last = table.last[seat.id];
  const talk = recentTalk(game, seat.id);
  const bid = table.bids[seat.id];
  const hand = table.hands?.[seat.id];
  return (
    <section className={`cg-seat is-${side} ${turn ? 'is-turn' : ''}`}>
      <header className="cg-seat-head">
        <span className="cg-seat-avatar">
          <SeatAvatar seat={seat} size={side === 'bottom' ? 30 : 36} />
          {landlord && (
            <span className="cg-crown" title={translate('地主')}>
              <GameGlyph name="crown" size={12} />
            </span>
          )}
        </span>
        <span className="cg-seat-name">
          <b>{seat.human ? translate('你') : seat.name}</b>
          <small>
            {table.landlordId
              ? translate(landlord ? '地主' : '农民')
              : bid === undefined
                ? ''
                : bid
                  ? translate('叫 {count} 分', { count: bid })
                  : translate('不叫')}
            {side !== 'bottom' && ` · ${translate('{count} 张', { count: table.counts[seat.id] })}`}
          </small>
        </span>
        {turn && <span className="cg-thinking">{seat.human ? translate('轮到你') : translate('思考中')}</span>}
      </header>
      {side !== 'bottom' && (
        <div className="cg-backs" aria-hidden="true">
          {hand
            ? hand.map((card) => <PlayingCard key={card} card={card} size="sm" />)
            : Array.from({ length: Math.min(table.counts[seat.id], 20) }, (_, i) => <PlayingCard key={i} size="sm" />)}
        </div>
      )}
      {talk && <p className="cg-talk">{talk}</p>}
      <div className="cg-played" aria-label={translate('本轮出牌')}>
        {last?.pass ? (
          <span className="cg-pass">{translate('不要')}</span>
        ) : last?.cards ? (
          <>
            <span className="cg-play-cards">
              {last.cards.map((card) => (
                <PlayingCard key={card} card={card} size="sm" />
              ))}
            </span>
            <small>{last.label}</small>
          </>
        ) : null}
      </div>
    </section>
  );
}

/** The card counter: how many of each rank this viewer has not seen yet. */
function Counter({ game }: { game: GameView }) {
  const table = game.cards!;
  const known = [...(table.hand || []), ...table.played].map(rankOf);
  return (
    <div className="cg-counter" aria-label={translate('记牌器')}>
      {[...RANKS].reverse().map((rank) => {
        const left = (rank === '小王' || rank === '大王' ? 1 : 4) - known.filter((r) => r === rank).length;
        return (
          <span key={rank} className={left ? '' : 'is-out'}>
            <b>{rank === '小王' ? translate('小') : rank === '大王' ? translate('大') : rank}</b>
            <i>{left}</i>
          </span>
        );
      })}
    </div>
  );
}

export function DoudizhuTable(props: GameTableProps) {
  const { game, syncError, omniscient, onOmniscient, onClose } = props;
  const { request, self, seconds, busy, error, control, submit } = useGameTable(props);
  const [diagnostics, setDiagnostics] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const hint = useRef(0);
  const feed = useRef<HTMLOListElement>(null);
  const table = game.cards!;
  const finished = game.status === 'finished' || game.phase === 'finished';
  useEffect(() => {
    setSelected([]);
    hint.current = 0;
  }, [request?.id]);
  useEffect(() => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [game.logs.length]);
  const me = Math.max(
    0,
    game.seats.findIndex((p) => p.id === game.humanId),
  );
  const seatAt = (k: number) => game.seats[(me + k) % 3];
  const bottom = seatAt(0);
  const hand = table.hand || table.hands?.[bottom.id] || [];
  const playing = request?.kind === 'play';
  const picked = useMemo(() => {
    if (!playing || !selected.length) return undefined;
    const ranks = selected.map(rankOf);
    return request!.options?.find((o) => o.cards && sameRanks(o.cards, ranks));
  }, [playing, selected, request]);
  const total = (game.clock?.totalMs || 45000) / 1000;
  const toggle = (card: string) =>
    setSelected((current) => (current.includes(card) ? current.filter((c) => c !== card) : [...current, card]));
  function suggest() {
    const options = request?.options || [];
    if (!options.length) return;
    const option = options[hint.current++ % options.length];
    setSelected(takeCards(hand, option.cards || [])?.taken || []);
  }
  const subtitle = finished
    ? translate('对局结束')
    : game.phase === 'bid'
      ? translate('叫地主')
      : translate('底分 {bid} · {times} 倍', { bid: Math.max(1, table.bid), times: table.multiplier });
  const drawer = diagnostics && <DiagnosticsDrawer game={game} onClose={() => setDiagnostics(false)} />;
  return (
    <div className="gg-table-root cg-root" data-period={finished ? 'finished' : 'day'} data-game="doudizhu">
      <GameTopbar
        game={game}
        title={translate('斗地主')}
        subtitle={`${subtitle} · ${translate(game.humanId ? '你参与' : omniscient ? '旁观 · 全知视角' : '旁观')}`}
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
        <div className="cg-felt">
          <SeatPanel game={game} seat={seatAt(2)} side="left" />
          <div className="cg-center">
            {table.kitty ? (
              <div className="cg-kitty" aria-label={translate('底牌')}>
                <small>{translate('底牌')}</small>
                {table.kitty.map((card) => (
                  <PlayingCard key={card} card={card} size="sm" />
                ))}
              </div>
            ) : (
              <div className="cg-kitty is-hidden" aria-label={translate('底牌')}>
                <small>{translate('底牌')}</small>
                <PlayingCard size="sm" />
                <PlayingCard size="sm" />
                <PlayingCard size="sm" />
              </div>
            )}
            {finished && (
              <div className={`cg-result is-${game.winner === 'landlord' ? 'landlord' : 'farmer'}`}>
                <h2>{translate(game.winner === 'landlord' ? '地主获胜' : game.winner ? '农民获胜' : '对局已中止')}</h2>
                {table.scores && (
                  <ul>
                    {game.seats.map((p) => (
                      <li key={p.id}>
                        <span>{p.human ? translate('你') : p.name}</span>
                        <b className={table.scores![p.id] > 0 ? 'is-up' : 'is-down'}>
                          {table.scores![p.id] > 0 ? '+' : ''}
                          {table.scores![p.id]}
                        </b>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="gg-muted">
                  {translate('底分 {bid} · {times} 倍', { bid: Math.max(1, table.bid), times: table.multiplier })}
                  {table.spring ? ' · ' + translate('春天') : ''}
                </p>
                <div className="cg-result-actions">
                  <button className="secondary-button" onClick={() => setDiagnostics(true)}>
                    {translate('运行记录')}
                  </button>
                  <button className="primary-button" onClick={onClose}>
                    {translate('返回群聊')}
                  </button>
                </div>
              </div>
            )}
          </div>
          <SeatPanel game={game} seat={seatAt(1)} side="right" />
          <div className="cg-mine">
            <SeatPanel game={game} seat={bottom} side="bottom" />
            <div className={`cg-hand ${playing ? 'is-live' : ''}`}>
              {hand.length ? (
                hand.map((card) => (
                  <PlayingCard
                    key={card}
                    card={card}
                    selected={selected.includes(card)}
                    disabled={!playing || busy}
                    onClick={() => toggle(card)}
                  />
                ))
              ) : (
                <span className="gg-muted">
                  {finished ? '' : translate('旁观时看不到手牌；切到全知视角可以看到所有人的牌。')}
                </span>
              )}
            </div>
            <footer className="cg-actions">
              {(error || game.error) && (
                <p role="alert" className="group-error">
                  {error || game.error}
                </p>
              )}
              {request?.kind === 'bid' ? (
                <>
                  <span className="gg-muted">{translate('要不要叫地主？')}</span>
                  <span className="gg-spacer" />
                  <GameTimer seconds={seconds} total={total} syncError={syncError} />
                  <button className="secondary-button" disabled={busy} onClick={() => void submit({ skip: true })}>
                    {translate('不叫')}
                  </button>
                  {[1, 2, 3].map((n) => (
                    <button
                      key={n}
                      className={n === 3 ? 'primary-button' : 'secondary-button'}
                      disabled={busy || !request.targets.includes(`bid${n}`)}
                      onClick={() => void submit({ target: `bid${n}` })}
                    >
                      {translate('{count} 分', { count: n })}
                    </button>
                  ))}
                </>
              ) : playing ? (
                <>
                  <span className={`cg-pick ${selected.length && !picked ? 'is-bad' : ''}`}>
                    {picked
                      ? picked.label
                      : selected.length
                        ? translate(table.lead && request.canPass ? '压不过，或不是合法牌型' : '不是合法牌型')
                        : !request.options?.length
                          ? translate('没有能压过的牌')
                          : translate(request.canPass ? '选牌压过上家，或者不要' : '由你先出，选好牌后出牌')}
                  </span>
                  <span className="gg-spacer" />
                  <GameTimer seconds={seconds} total={total} syncError={syncError} />
                  {request.canPass && (
                    <button className="secondary-button" disabled={busy} onClick={() => void submit({ skip: true })}>
                      {translate('不要')}
                    </button>
                  )}
                  <button className="secondary-button" disabled={busy || !request.options?.length} onClick={suggest}>
                    {translate('提示')}
                  </button>
                  <button
                    className="primary-button"
                    disabled={busy || !picked}
                    onClick={() => picked && void submit({ target: picked.id })}
                  >
                    {translate('出牌')}
                  </button>
                </>
              ) : !finished ? (
                <span className="gg-muted">
                  {game.status === 'paused'
                    ? translate('对局已暂停')
                    : translate('等待 {name} 行动…', {
                        name: game.seats.find((p) => p.id === game.clock?.seatId)?.name || 'AI',
                      })}
                </span>
              ) : null}
            </footer>
          </div>
        </div>
        <aside className="cg-side">
          <div className="gg-section-label">
            <span>{translate('记牌器')}</span>
            <span>{translate(self ? '不含你的手牌' : '已出的牌之外')}</span>
          </div>
          <Counter game={game} />
          <div className="gg-section-label cg-log-label">
            <span>{translate('出牌记录')}</span>
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
