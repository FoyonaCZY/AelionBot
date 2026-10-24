import type { ReactNode } from 'react';
import { rankOf, suitOf } from '../../shared/games/doudizhu-rules';
import { suitOf as tileSuit, tileName } from '../../shared/games/mahjong-rules';

/** Suits drawn as paths, so they never fall back to a colour emoji or a font without them. */
const SUIT_PATHS: Record<string, string> = {
  '♠': 'M12 2.6c-1.6 2-8.4 6.3-8.4 11 0 2.6 2 4.5 4.4 4.5 1.4 0 2.6-.6 3.3-1.6-.2 1.9-1 3.5-2.4 5h6.2c-1.4-1.5-2.2-3.1-2.4-5 .7 1 1.9 1.6 3.3 1.6 2.4 0 4.4-1.9 4.4-4.5 0-4.7-6.8-9-8.4-11Z',
  '♥': 'M12 21.2c-1.4-1.3-9.2-7.4-9.2-12.6C2.8 5.6 5 3.4 7.8 3.4c1.9 0 3.4 1 4.2 2.6.8-1.6 2.3-2.6 4.2-2.6 2.8 0 5 2.2 5 5.2 0 5.2-7.8 11.3-9.2 12.6Z',
  '♣': 'M12 2.8a4.1 4.1 0 0 0-3.7 5.9A4.1 4.1 0 1 0 9.6 16.6c.8 0 1.5-.2 2.1-.6-.2 2-1 3.6-2.5 5.2h5.6c-1.5-1.6-2.3-3.2-2.5-5.2.6.4 1.3.6 2.1.6a4.1 4.1 0 1 0 1.3-7.9A4.1 4.1 0 0 0 12 2.8Z',
  '♦': 'M12 2.2 19.6 12 12 21.8 4.4 12Z',
};
function Suit({ suit, className }: { suit: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d={SUIT_PATHS[suit]} fill="currentColor" />
    </svg>
  );
}
const FACES = ['J', 'Q', 'K'];

/**
 * A playing card. The corner index (rank over suit) is all that shows while cards overlap in a hand, so it is the
 * part drawn with most care; it repeats upside down in the opposite corner. The middle holds one large pip, a framed
 * letter for J/Q/K, or a crown for a joker. Jokers read JOKER down the corner, red for the big one. A patterned back
 * when `card` is omitted.
 */
export function PlayingCard({
  card,
  size = 'md',
  selected,
  onClick,
  disabled,
}: {
  card?: string;
  size?: 'sm' | 'md';
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  if (!card) return <span className={`cg-card is-back is-${size}`} aria-hidden="true" />;
  const rank = rankOf(card),
    suit = suitOf(card),
    joker = !suit;
  const red = suit === '♥' || suit === '♦' || rank === '大王';
  const className = `cg-card is-${size} ${red ? 'is-red' : 'is-black'} ${joker ? 'is-joker' : ''} ${selected ? 'is-selected' : ''}`;
  const index = joker ? (
    <span className="cg-index is-joker" aria-hidden="true">
      {'JOKER'.split('').map((letter, i) => (
        <i key={i}>{letter}</i>
      ))}
    </span>
  ) : (
    <span className="cg-index" aria-hidden="true">
      <b>{rank}</b>
      <Suit suit={suit} />
    </span>
  );
  const middle: ReactNode = joker ? (
    <svg className="cg-crown-art" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 18.5h17l1.3-10.4-5.4 3.9L12 4.5l-4.4 7.5-5.4-3.9Z" fill="currentColor" />
      <circle cx="12" cy="3.6" r="1.4" fill="currentColor" />
      <path d="M4 20.6h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ) : FACES.includes(rank) ? (
    <span className="cg-face" aria-hidden="true">
      <b>{rank}</b>
      <Suit suit={suit} />
    </span>
  ) : (
    <Suit suit={suit} className={`cg-pip ${rank === 'A' ? 'is-ace' : ''}`} />
  );
  const face = (
    <>
      {index}
      {size === 'md' && (
        <>
          <span className="cg-middle">{middle}</span>
          <span className="cg-index-end">{index}</span>
        </>
      )}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className={className}
      aria-pressed={selected}
      aria-label={card}
      disabled={disabled}
      onClick={onClick}
    >
      {face}
    </button>
  ) : (
    <span className={className} aria-label={card}>
      {face}
    </span>
  );
}

const NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const BLUE = '#1f56a6',
  GREEN = '#21754a',
  RED = '#c2362a';
type Pip = [x: number, y: number, colour: string];

/** 筒: rings with a filled centre, in the classic arrangements and colours. */
const CIRCLES: Record<number, { r: number; pips: Pip[] }> = {
  2: {
    r: 5.6,
    pips: [
      [15, 11, GREEN],
      [15, 29, BLUE],
    ],
  },
  3: {
    r: 5,
    pips: [
      [8, 9, BLUE],
      [15, 20, RED],
      [22, 31, GREEN],
    ],
  },
  4: {
    r: 5,
    pips: [
      [9, 11, BLUE],
      [21, 11, GREEN],
      [9, 29, GREEN],
      [21, 29, BLUE],
    ],
  },
  5: {
    r: 4.6,
    pips: [
      [8.5, 9, BLUE],
      [21.5, 9, GREEN],
      [15, 20, RED],
      [8.5, 31, GREEN],
      [21.5, 31, BLUE],
    ],
  },
  6: {
    r: 4.5,
    pips: [
      [9, 8.5, GREEN],
      [21, 8.5, GREEN],
      [9, 20, RED],
      [21, 20, RED],
      [9, 31.5, RED],
      [21, 31.5, RED],
    ],
  },
  7: {
    r: 3.7,
    pips: [
      [7, 6, GREEN],
      [15, 10, GREEN],
      [23, 14, GREEN],
      [10, 23.5, RED],
      [20, 23.5, RED],
      [10, 33, RED],
      [20, 33, RED],
    ],
  },
  8: {
    r: 3.9,
    pips: [6.5, 15.5, 24.5, 33.5].flatMap((y) => [[9.5, y, BLUE] as Pip, [20.5, y, BLUE] as Pip]),
  },
  9: {
    r: 3.8,
    pips: [
      [9, BLUE],
      [20, RED],
      [31, GREEN],
    ].flatMap(([y, colour]) => [7, 15, 23].map((x) => [x, y, colour] as Pip)),
  },
};
/** 条: bamboo sticks, a node in the middle of each; the classic red sticks where the set has them. */
const STICKS: Record<number, { h: number; pips: Pip[] }> = {
  2: {
    h: 12,
    pips: [
      [15, 10.5, GREEN],
      [15, 29.5, GREEN],
    ],
  },
  3: {
    h: 12,
    pips: [
      [15, 10.5, GREEN],
      [9.5, 29.5, GREEN],
      [20.5, 29.5, GREEN],
    ],
  },
  4: {
    h: 12,
    pips: [
      [9.5, 10.5, GREEN],
      [20.5, 10.5, GREEN],
      [9.5, 29.5, GREEN],
      [20.5, 29.5, GREEN],
    ],
  },
  5: {
    h: 11,
    pips: [
      [8, 9.5, GREEN],
      [22, 9.5, GREEN],
      [15, 20, RED],
      [8, 30.5, GREEN],
      [22, 30.5, GREEN],
    ],
  },
  6: { h: 12, pips: [10.5, 29.5].flatMap((y) => [7, 15, 23].map((x) => [x, y, GREEN] as Pip)) },
  7: {
    h: 9.5,
    pips: [[15, 6.5, RED] as Pip, ...[20, 32.5].flatMap((y) => [7, 15, 23].map((x) => [x, y, GREEN] as Pip))],
  },
  8: { h: 12, pips: [10.5, 29.5].flatMap((y) => [5.5, 12, 18, 24.5].map((x) => [x, y, GREEN] as Pip)) },
  9: {
    h: 9.5,
    pips: [7, 20, 33].flatMap((y) => [7, 15, 23].map((x) => [x, y, x === 15 ? RED : GREEN] as Pip)),
  },
};

/** Written on a tile: a brush character, outlined in its own colour so it reads bold. */
function Glyph({ y, size, colour, children }: { y: number; size: number; colour: string; children: string }) {
  return (
    <text x="15" y={y} className="mj-glyph" fontSize={size} fill={colour} stroke={colour} strokeWidth={size * 0.045}>
      {children}
    </text>
  );
}

/** The picture on a tile face, in a 30×40 box. */
function tileArt(tile: string): ReactNode {
  const suit = tileSuit(tile),
    n = Number(tile[0]);
  if (suit === 'm')
    return (
      <>
        <Glyph y={17} size={16} colour="#1d1b22">
          {NUMBERS[n - 1]}
        </Glyph>
        <Glyph y={35.5} size={15} colour={RED}>
          万
        </Glyph>
      </>
    );
  if (suit === 'p') {
    if (n === 1)
      return (
        <g>
          <circle cx="15" cy="20" r="11.5" fill="none" stroke={GREEN} strokeWidth="1.6" />
          <circle cx="15" cy="20" r="8.6" fill="none" stroke={BLUE} strokeWidth="2.6" strokeDasharray="2.2 1.4" />
          <circle cx="15" cy="20" r="5" fill={RED} />
          <circle cx="15" cy="20" r="1.8" fill="#fbf7ec" />
        </g>
      );
    const { r, pips } = CIRCLES[n];
    return pips.map(([x, y, colour], i) => (
      <g key={i}>
        <circle cx={x} cy={y} r={r} fill="none" stroke={colour} strokeWidth={r * 0.32} />
        <circle cx={x} cy={y} r={r * 0.42} fill={colour} />
      </g>
    ));
  }
  if (suit === 's') {
    if (n === 1)
      // 一条 is traditionally a bird; here a tall bamboo with a red crest and two leaves.
      return (
        <g>
          <rect x="13" y="7" width="4" height="29" rx="2" fill={GREEN} />
          <path d="M13 16h4M13 26h4" stroke="#fbf7ec" strokeWidth="1" />
          <path
            d="M17 13c4-1 6.5-3.5 7.5-6.5-3.5.4-6.2 2.4-7.5 6.5ZM13 21c-4-1-6.5-3.5-7.5-6.5 3.5.4 6.2 2.4 7.5 6.5Z"
            fill={GREEN}
          />
          <circle cx="15" cy="5" r="2.6" fill={RED} />
        </g>
      );
    const { h, pips } = STICKS[n];
    const w = n === 8 ? 3.4 : 3.8;
    return pips.map(([x, y, colour], i) => (
      <g key={i}>
        <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={w / 2} fill={colour} />
        <path d={`M${x - w / 2} ${y}h${w}`} stroke="#fbf7ec" strokeWidth="0.9" />
      </g>
    ));
  }
  if (tile === 'P')
    // 白: an empty frame, as on a real tile.
    return (
      <g fill="none" stroke={BLUE}>
        <rect x="6" y="7" width="18" height="26" rx="2.5" strokeWidth="2" />
        <rect x="9" y="10" width="12" height="20" rx="1.5" strokeWidth="0.9" />
      </g>
    );
  return (
    <Glyph y={28.5} size={22} colour={tile === 'C' ? RED : tile === 'F' ? GREEN : '#1c2a4a'}>
      {tileName(tile)}
    </Glyph>
  );
}

/**
 * A mahjong tile: an ivory face on a green back, the two layers showing along the lower edge as on a real tile.
 * Circles and bamboo are drawn, characters and honours written in a brush face. A green back when `tile` is omitted.
 */
export function MahjongTile({
  tile,
  size = 'md',
  active,
  dim,
  onClick,
  disabled,
  title,
}: {
  tile?: string;
  size?: 'sm' | 'md';
  active?: boolean;
  dim?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  if (!tile) return <span className={`mj-tile is-back is-${size}`} aria-hidden="true" />;
  const className = `mj-tile is-${size} ${active ? 'is-active' : ''} ${dim ? 'is-dim' : ''}`;
  const face = (
    <svg className="mj-face" viewBox="0 0 30 40" aria-hidden="true">
      {tileArt(tile)}
    </svg>
  );
  return onClick ? (
    <button
      type="button"
      className={className}
      aria-label={tileName(tile)}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {face}
    </button>
  ) : (
    <span className={className} aria-label={tileName(tile)} title={title}>
      {face}
    </span>
  );
}
