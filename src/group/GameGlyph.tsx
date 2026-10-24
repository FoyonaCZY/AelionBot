import type { ReactNode } from 'react';

/** Line marks for the AI games, drawn like the app's Icon set: phases of the day, each role (by its id) and a few
    table actions. */
const GLYPHS: Record<string, ReactNode> = {
  moon: <path d="M19.5 14.6A7.8 7.8 0 1 1 9.4 4.5a6.2 6.2 0 0 0 10.1 10.1Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </>
  ),
  wolf: (
    <>
      <path d="M5 3.5 8.6 8h6.8L19 3.5v9c0 4.4-3.1 8-7 8s-7-3.6-7-8Z" />
      <path d="M9.5 12.5h.01M14.5 12.5h.01M10.8 16.3h2.4" strokeWidth="2" />
    </>
  ),
  seer: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  witch: (
    <>
      <path d="M9 3h6M10 3v6.2L5.2 17.6A2.2 2.2 0 0 0 7.1 21h9.8a2.2 2.2 0 0 0 1.9-3.4L14 9.2V3" />
      <path d="M7.4 14.5h9.2" />
    </>
  ),
  hunter: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.2" />
      <path d="M12 2.5V7M12 17v4.5M2.5 12H7M17 12h4.5" />
    </>
  ),
  idiot: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2.5" />
      <path d="M9.5 10h.01M14.5 10h.01" strokeWidth="2" />
      <path d="M9 14a3.2 3.2 0 0 0 6 0" />
    </>
  ),
  guard: <path d="M12 3 19 6v5.2c0 4.4-2.9 8.2-7 9.8-4.1-1.6-7-5.4-7-9.8V6Z" />,
  villager: (
    <>
      <path d="M12 21V7" />
      <path d="M12 7C10 6 9 4.4 9 2.8c2 0 3 1.4 3 3M12 7c2-1 3-2.6 3-4.2-2 0-3 1.4-3 3M12 12.5c-2.4-.4-3.8-2.2-3.8-4.2 2.4 0 3.8 1.4 3.8 3.4M12 12.5c2.4-.4 3.8-2.2 3.8-4.2-2.4 0-3.8 1.4-3.8 3.4M12 17.8c-2.4-.4-3.8-2.2-3.8-4.2 2.4 0 3.8 1.4 3.8 3.4M12 17.8c2.4-.4 3.8-2.2 3.8-4.2-2.4 0-3.8 1.4-3.8 3.4" />
    </>
  ),
  civilian: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20.5v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1" />
    </>
  ),
  undercover: (
    <>
      <path d="M3 11.5h18M6.2 11.5 7.8 5h8.4l1.6 6.5" />
      <circle cx="8.3" cy="16.2" r="2.6" />
      <circle cx="15.7" cy="16.2" r="2.6" />
      <path d="M10.9 16.2h2.2" />
    </>
  ),
  // Dou Di Zhu: two cards fanned. Mahjong: one tile.
  cards: (
    <>
      <rect x="3.5" y="5.5" width="10" height="14" rx="2" transform="rotate(-12 8.5 12.5)" />
      <rect x="10" y="4" width="10" height="14" rx="2" transform="rotate(8 15 11)" />
    </>
  ),
  tile: (
    <>
      <rect x="5.5" y="3" width="13" height="18" rx="2.5" />
      <path d="M12 7.5v9M9 10h6" />
    </>
  ),
  crown: <path d="M4 18h16M5 15 4 7l4.5 3.5L12 5l3.5 5.5L20 7l-1 8Z" />,
  blank: <rect x="4.5" y="4.5" width="15" height="15" rx="3" strokeDasharray="3 2.6" />,
  play: <path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" />,
  arrow: <path d="M7 17 17 7M9 7h8v8" />,
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01" strokeWidth="2.4" />
    </>
  ),
  history: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
      <path d="M3.5 4v4h4M12 7.5V12l3 2" />
    </>
  ),
  mask: (
    <>
      <path d="M3 6c3 1.4 6 1.4 9 0 3 1.4 6 1.4 9 0v4.5c0 4.4-3.6 8-9 9.5-5.4-1.5-9-5.1-9-9.5Z" />
      <path d="M7.5 11c.8-.7 1.9-.7 2.7 0M13.8 11c.8-.7 1.9-.7 2.7 0" />
    </>
  ),
};

export function GameGlyph({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      className="gg-glyph"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[name]}
    </svg>
  );
}
