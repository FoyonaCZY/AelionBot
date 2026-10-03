/**
 * Artwork for character avatars on the Bot's 60×60 face. Every character keeps the original blob face and the two
 * slanted eyes (so blinking, gaze and body motion work as before) and adds layers around them:
 *   back   – behind the face (long hair, ears, collars, helmets)
 *   detail – on the face, clipped to it, under the eyes (masks, patches, whiskers, cheeks)
 *   front  – over the face (bangs, hats, glasses)
 *   props  – small groups that move while the Bot is thinking, working or waiting
 * Shapes are fixed constants; the renderer still validates every value before it enters SVG markup.
 */
type PropMotion = 'sway' | 'twitch' | 'flutter' | 'rise' | 'fall' | 'glow';
export interface ArtShape {
  d?: string;
  circle?: [number, number, number];
  ellipse?: [number, number, number, number];
  fill?: string;
  stroke?: string;
  width?: number;
  opacity?: number;
  rotate?: [number, number, number];
}
export interface ArtProp {
  motion: PropMotion;
  origin: [number, number];
  layer?: 'back' | 'front';
  /** Only shown while the Bot is busy (smoke, sparkles, falling petals). */
  busyOnly?: boolean;
  shapes: ArtShape[];
}
export interface CharacterArt {
  face: string;
  eye?: string;
  eyeStroke?: [string, number];
  eyeScale?: number;
  /** Cheek colour; null for none. */
  blush?: string | null;
  back?: ArtShape[];
  detail?: ArtShape[];
  front?: ArtShape[];
  props?: ArtProp[];
}

const INK = '#2b2730',
  SKIN = '#fbece1',
  PALE = '#f8f6f4';
/** Anime bangs with three strands between and beside the eyes, framing the face down to the cheeks. */
const BANGS =
  'M3 31C2 13 14 1 31 1C48 1 58 13 57 30C55 24 52 19 47 16L46 22C43 17 39 14 35 13L32 19C30 15 27 13 23 14L20 20C18 17 15 17 12 20C9 23 7 27 6 33Z';
const line = (d: string, stroke: string, width: number, opacity?: number): ArtShape => ({
  d,
  stroke,
  width,
  fill: 'none',
  ...(opacity === undefined ? {} : { opacity }),
});
const star = (x: number, y: number, r: number) =>
  `M${x} ${y - r}L${x + r * 0.3} ${y - r * 0.3}L${x + r} ${y}L${x + r * 0.3} ${y + r * 0.3}L${x} ${y + r}L${x - r * 0.3} ${y + r * 0.3}L${x - r} ${y}L${x - r * 0.3} ${y - r * 0.3}Z`;

export const CHARACTER_ART: Record<string, CharacterArt> = {
  'silver-witch': {
    face: PALE,
    back: [
      { d: 'M8 14C0 28 -1 46 1 60H59C61 46 60 28 52 14Z', fill: '#d6d5e3' },
      { d: 'M13 60C15 53 21 50 30 50C39 50 45 53 47 60Z', fill: INK },
    ],
    front: [
      { d: BANGS, fill: '#f1f0f6' },
      line('M31 2C28 6 25 10 23 14M35 13C38 9 42 6 47 5', '#cfcde0', 1.1),
      { d: 'M50 15C56 25 58 41 55 58H50C53 44 52 29 46 18Z', fill: '#e8e7f0' },
    ],
    props: [
      {
        motion: 'flutter',
        origin: [47, 12],
        shapes: [
          { d: 'M47 12C43 5 39 7 40 11C41 14 45 14 47 12Z', fill: '#8fd3b3', stroke: INK, width: 1 },
          { d: 'M47 12C51 5 55 7 54 11C53 14 49 14 47 12Z', fill: '#8fd3b3', stroke: INK, width: 1 },
          { d: 'M47 12C44 14 43 17 45 17.5C46.5 18 47 15 47 12Z', fill: '#7cc4a3', stroke: INK, width: 0.8 },
          { d: 'M47 12C50 14 51 17 49 17.5C47.5 18 47 15 47 12Z', fill: '#7cc4a3', stroke: INK, width: 0.8 },
        ],
      },
    ],
  },
  'straw-captain': {
    face: SKIN,
    back: [
      { d: 'M6 17L1 25L6 25L2 32L8 30L6 36L11 31Z', fill: INK },
      { d: 'M54 15L59 23L54 23L58 30L52 28L54 34L49 29Z', fill: INK },
    ],
    detail: [line('M17.5 34L22.5 34.8M19 33L18.7 35.8M21 33.4L20.8 36', '#c66b5b', 0.9)],
    props: [
      {
        motion: 'sway',
        origin: [30, 14],
        shapes: [
          { d: 'M0 15C7 7 53 5 60 13C56 19 4 21 0 15Z', fill: '#e8c46a', stroke: '#c9a04a', width: 0.8 },
          { d: 'M14 13C14 4 21 0 30 0C39 0 46 4 46 12Z', fill: '#f1d27d' },
          { d: 'M14 9.5C24 7.5 37 7.5 46 8.5V12.5C37 11 24 11 14 13Z', fill: '#d94b3d' },
        ],
      },
    ],
  },
  'fox-ninja': {
    face: SKIN,
    back: [
      {
        d: 'M4 26L0 15L9 15L5 5L16 9L18 0L26 6L31 0L35 6L43 0L45 9L55 5L52 15L60 16L56 26Z',
        fill: '#f6c945',
        stroke: '#e1ad2b',
        width: 0.8,
      },
    ],
    detail: [
      line('M10 35L17 36M10 38.5L17 38.8M11 42L17 41', '#b9876b', 1),
      line('M43 34L50 32.5M43 37L50 36.5M43 40L49 40.5', '#b9876b', 1),
    ],
    front: [
      { d: 'M3 24L6 31L8 26L11 30L12 22Z', fill: '#f6c945' },
      { d: 'M57 20L56 28L53 24L51 28L49 19Z', fill: '#f6c945' },
      { d: 'M2 19C12 12 47 9 58 14V19.5C47 15 13 17.5 2 24.5Z', fill: '#2e3a5f' },
      { d: 'M18.5 12.6L41.5 10.9L42 17.2L19 18.9Z', fill: '#c7cfda', stroke: '#8a95a5', width: 0.9 },
      { circle: [20.6, 14.3, 0.6], fill: '#8a95a5' },
      { circle: [39.8, 12.6, 0.6], fill: '#8a95a5' },
    ],
    props: [
      {
        motion: 'sway',
        origin: [56, 16],
        shapes: [
          { d: 'M56 15C59 19 60 24 59 31L56.5 30C57.5 25 56 20 54 17Z', fill: '#2e3a5f' },
          { d: 'M55 16C57 22 56 28 53 33L51 31.5C54 27 54 22 53 18Z', fill: '#26304f' },
        ],
      },
    ],
  },
  'golden-fighter': {
    face: SKIN,
    back: [
      {
        d: 'M4 30L1 17L8 19L4 6L15 12L16 0L25 8L30 0L35 8L44 0L45 12L56 6L52 19L59 17L56 30Z',
        fill: '#ffd84a',
        stroke: '#e7b829',
        width: 0.8,
      },
    ],
    front: [
      {
        d: 'M6 23C8 10 18 3 31 3C44 3 53 10 55 22L49 16L47 21L42 13L39 17L33 11L30 16L26 11L23 17L19 12L16 19L12 15Z',
        fill: '#ffd84a',
      },
      line('M19 19.5L25.5 20.8M34.5 16.8L40.5 15.2', INK, 1.3),
    ],
    props: [
      {
        motion: 'glow',
        origin: [30, 30],
        layer: 'back',
        busyOnly: true,
        shapes: [{ circle: [30, 30, 29.6], fill: '#ffe98a', opacity: 0.55 }],
      },
      {
        motion: 'glow',
        origin: [30, 30],
        busyOnly: true,
        shapes: [line('M4 44L8 39L7 43L11 40M50 42L54 37L53 41L57 38', '#f2b705', 1.3)],
      },
    ],
  },
  'twin-tail-diva': {
    face: SKIN,
    back: [{ d: 'M7 18C5 30 6 40 8 46H52C54 40 55 30 53 18Z', fill: '#2ea79f' }],
    front: [
      { d: BANGS, fill: '#3ec5bb' },
      { d: 'M6 9.5L11.5 8L12.5 13.5L7 15Z', fill: INK },
      { d: 'M48.5 8L54 9.5L53 15L47.5 13.5Z', fill: INK },
      line('M7.4 11.2L11.8 10M48.6 10L53 11.2', '#e46b9a', 0.9),
      { circle: [5.2, 31, 3], fill: '#4a4f5a' },
      line('M6 33.5C8 39 12 42 17 42.5', '#4a4f5a', 1.1),
      { circle: [17.6, 42.6, 1.2], fill: '#4a4f5a' },
    ],
    props: [
      {
        motion: 'sway',
        origin: [9, 12],
        layer: 'back',
        shapes: [{ d: 'M9 10C0 18 -1 40 2 60H12C8 44 8 26 13 15Z', fill: '#3ec5bb' }],
      },
      {
        motion: 'sway',
        origin: [51, 12],
        layer: 'back',
        shapes: [{ d: 'M51 10C60 18 61 40 58 60H48C52 44 52 26 47 15Z', fill: '#3ec5bb' }],
      },
    ],
  },
  'cat-girl': {
    face: SKIN,
    back: [{ d: 'M7 16C3 30 4 44 7 52H53C56 44 57 30 53 16Z', fill: '#e48fae' }],
    detail: [line('M27 40Q28.5 42 30 40Q31.5 42 33 40', '#c06b7d', 0.9)],
    front: [{ d: BANGS, fill: '#f3a3bf' }],
    props: [
      {
        motion: 'twitch',
        origin: [15, 11],
        layer: 'back',
        shapes: [
          { d: 'M7 17L8 0L23 7Z', fill: '#f3a3bf' },
          { d: 'M10 12.5L10.5 4.5L18 8.2Z', fill: '#ffd9e5' },
        ],
      },
      {
        motion: 'twitch',
        origin: [45, 9],
        layer: 'back',
        shapes: [
          { d: 'M37 6L52 0L53 15Z', fill: '#f3a3bf' },
          { d: 'M41.5 6.6L49.4 3.4L49.8 11.6Z', fill: '#ffd9e5' },
        ],
      },
    ],
  },
  'green-swordsman': {
    face: SKIN,
    front: [
      {
        d: 'M4 24C3 10 15 2 31 2C46 2 57 10 56 22L52 17L50 21L46 14L43 18L38 12L35 16L30 11L27 16L22 12L19 17L15 13L12 19L8 16Z',
        fill: '#4c9b62',
      },
      { d: 'M5 16C10 4 50 2 56 14C50 9.5 12 10.5 5 16Z', fill: INK },
      { circle: [4.6, 36, 1.1], fill: '#e8c25a' },
      { circle: [4.9, 39.6, 1.1], fill: '#e8c25a' },
      { circle: [5.5, 43.1, 1.1], fill: '#e8c25a' },
    ],
    props: [
      {
        motion: 'sway',
        origin: [7, 14],
        shapes: [
          { d: 'M7 13C3 15 1 19 1 24L3.5 23.5C3.5 20 5 17 8 15Z', fill: INK },
          { d: 'M7 14C5 18 5 22 7 26L5 26.5C3 22.5 3 18 5 14Z', fill: '#3a353f' },
        ],
      },
    ],
  },
  'moon-magician': {
    face: SKIN,
    back: [
      { d: 'M8 18C6 30 7 40 9 46H51C53 40 54 30 52 18Z', fill: '#e8bf55' },
      { circle: [9, 9, 6.5], fill: '#f7d26b', stroke: '#e2b74e', width: 0.8 },
      { circle: [51, 9, 6.5], fill: '#f7d26b', stroke: '#e2b74e', width: 0.8 },
    ],
    front: [
      { d: BANGS, fill: '#f7d26b' },
      line('M14 15C22 11 38 11 46 14', '#f2c94c', 1.2),
      { circle: [30, 12.4, 1.7], fill: '#e2475c' },
    ],
    props: [
      {
        motion: 'sway',
        origin: [9, 13],
        layer: 'back',
        shapes: [{ d: 'M8 12C1 22 0 42 3 60H11C8 44 8 26 13 15Z', fill: '#f7d26b' }],
      },
      {
        motion: 'sway',
        origin: [51, 13],
        layer: 'back',
        shapes: [{ d: 'M52 12C59 22 60 42 57 60H49C52 44 52 26 47 15Z', fill: '#f7d26b' }],
      },
      {
        motion: 'glow',
        origin: [30, 40],
        busyOnly: true,
        shapes: [
          { d: star(8, 42, 3), fill: '#ffc7dc' },
          { d: star(52, 38, 2.4), fill: '#ffe58a' },
        ],
      },
    ],
  },
  'blue-pilot': {
    face: '#fbf1ea',
    eye: '#a33a3a',
    back: [{ d: 'M5 16C1 30 2 44 7 50H53C58 44 59 30 55 16Z', fill: '#93b6de' }],
    front: [
      {
        d: 'M3 34C1 14 14 1 31 1C48 1 59 14 57 33L54 32L52 22L49 25L47 16L44 19L41 14L38 18L34 13L31 18L28 13L25 18L22 14L19 19L16 15L13 21L10 18L8 27L6 25Z',
        fill: '#a8c8ec',
      },
      { d: 'M4.5 20L10 18.5L11 24L5.5 25.5Z', fill: '#c4352f' },
      { d: 'M50 17.5L55.5 19L54.5 24.5L49 23Z', fill: '#c4352f' },
    ],
    props: [
      {
        motion: 'glow',
        origin: [30, 22],
        shapes: [
          { circle: [7.7, 22, 0.9], fill: '#ffb3a8' },
          { circle: [52.3, 21, 0.9], fill: '#ffb3a8' },
        ],
      },
    ],
  },
  'spark-mouse': {
    face: '#ffd83d',
    blush: null,
    detail: [
      { ellipse: [14.5, 38.5, 4.4, 3], fill: '#f39a3d', rotate: [-8, 14.5, 38.5] },
      { ellipse: [45.5, 35.5, 4.4, 3], fill: '#f39a3d', rotate: [-8, 45.5, 35.5] },
      line('M11.5 38.8L13.5 37L15 39.2L17.2 37.4M42.5 35.8L44.5 34L46 36.2L48.2 34.4', '#fff3c4', 0.9),
      { d: 'M0 48C10 46 16 50 22 48C28 46 34 50 40 48C46 46 52 50 60 47V60H0Z', fill: '#f1c21b' },
      { d: 'M29.6 33.4L31.4 33.1L30.6 34.3Z', fill: INK },
      line('M26.5 39Q28.5 41 30.5 39Q32.5 41 34.5 39', '#7a4b1a', 0.9),
    ],
    props: [
      {
        motion: 'twitch',
        origin: [16, 11],
        layer: 'back',
        shapes: [
          { d: 'M11 15L2 1L21 8Z', fill: '#ffd83d', stroke: '#e6b820', width: 0.8 },
          { d: 'M2 1L5.6 6.6L8.6 3.7Z', fill: INK },
        ],
      },
      {
        motion: 'twitch',
        origin: [44, 9],
        layer: 'back',
        shapes: [
          { d: 'M39 7L58 1L49 15Z', fill: '#ffd83d', stroke: '#e6b820', width: 0.8 },
          { d: 'M58 1L54.1 6.4L51.3 3.4Z', fill: INK },
        ],
      },
      {
        motion: 'glow',
        origin: [30, 40],
        busyOnly: true,
        shapes: [line('M3 46L6.5 42L5.5 45.5L9 43M51 44L54.5 40L53.5 43.5L57 41', '#f4a300', 1.3)],
      },
    ],
  },
  'pocket-cat': {
    face: '#2ba6e8',
    blush: '#f4a7b9',
    back: [
      { d: 'M9 17L8 2L22 9Z', fill: '#2ba6e8' },
      { d: 'M38 7L52 1L52 16Z', fill: '#2ba6e8' },
      { d: 'M11 13L10.6 6L17 9.4Z', fill: '#9fd8f6' },
      { d: 'M42 7.4L49 4.6L49.2 12Z', fill: '#9fd8f6' },
    ],
    detail: [
      { d: 'M10 37C10 26 19 19 30 19C41 19 50 25 50 36C50 47 41 53 30 53C19 53 10 48 10 37Z', fill: '#ffffff' },
      { d: 'M28.4 34.4L31.6 34L30.2 35.8Z', fill: '#f07a8a' },
      line('M27 39Q28.5 41 30 39.2Q31.5 41 33 38.8', INK, 0.9),
      line('M14 37.5L20 38.2M40 36L46 35', '#7fb9d9', 0.8),
    ],
    front: [{ d: 'M11 51C18 55.5 42 55.5 49 50.5L50 54.5C42 59 18 59 10 55Z', fill: '#e2403a' }],
    props: [
      {
        motion: 'sway',
        origin: [30, 55],
        shapes: [
          { circle: [30, 57.2, 2.7], fill: '#f6c945', stroke: '#c9971f', width: 0.7 },
          line('M28 57H32', '#c9971f', 0.7),
        ],
      },
    ],
  },
  'forest-spirit': {
    face: '#8f9aa7',
    eyeStroke: ['#ffffff', 1.4],
    blush: null,
    detail: [
      { d: 'M13 56C14 46 21 41 30 41C39 41 46 46 47 56Z', fill: '#dfe3e6' },
      line('M24 47L26 45.5L28 47M32 47L34 45.5L36 47M28 51L30 49.5L32 51', '#8f9aa7', 0.9),
      { d: 'M28 30.6L32.4 30L30.4 32.4Z', fill: '#4b525c' },
      line('M7 33L16 34.5M7 37L16 37.5M44 32L53 30.5M44 35.5L53 35', '#5b6470', 0.9),
    ],
    props: [
      {
        motion: 'twitch',
        origin: [17, 9],
        layer: 'back',
        shapes: [{ d: 'M12 13L15 0L22 9Z', fill: '#8f9aa7' }],
      },
      {
        motion: 'twitch',
        origin: [43, 7],
        layer: 'back',
        shapes: [{ d: 'M38 8L46 0L49 12Z', fill: '#8f9aa7' }],
      },
      {
        motion: 'sway',
        origin: [30, 4],
        shapes: [
          { d: 'M30 4.5C25 3 23.5 0 26 0C29 0 31 2 30 4.5Z', fill: '#5fae5a' },
          line('M30 4.5L30.5 6.5', '#3f7a3c', 0.8),
        ],
      },
    ],
  },
  'masked-spirit': {
    face: '#f3f0ec',
    eye: '#1f1c24',
    blush: null,
    back: [{ d: 'M4 28C4 9 16 0 30 0C44 0 56 9 56 28L60 60H0Z', fill: '#24212a' }],
    detail: [line('M27.5 44.5H32.5', '#4a4450', 1)],
    props: [
      {
        motion: 'glow',
        origin: [30, 26],
        shapes: [
          { d: 'M21.5 15.8L26.5 15L24.3 18.6Z', fill: '#8b6aa6' },
          { d: 'M22.6 33L25.8 32.4L24.6 38.5Z', fill: '#8b6aa6' },
          { d: 'M33.5 13.8L38.5 13L36.3 16.6Z', fill: '#8b6aa6' },
          { d: 'M34.6 31L37.8 30.4L36.6 36.5Z', fill: '#8b6aa6' },
        ],
      },
    ],
  },
  'sakura-girl': {
    face: SKIN,
    back: [{ d: 'M6 14C1 30 1 48 3 60H57C59 48 59 30 54 14Z', fill: INK }],
    front: [
      { d: 'M4 24C4 10 15 1 31 1C47 1 57 10 57 23C49 16.5 13 17.5 4 24Z', fill: INK },
      { d: 'M3 22V46C4 48 7 48 8 46V21Z', fill: INK },
      { d: 'M57 20V44C56 46 53 46 52 44V19Z', fill: INK },
      { circle: [47, 9.6, 2], fill: '#f6a8c0' },
      { circle: [49.5, 11.6, 2], fill: '#f6a8c0' },
      { circle: [48.6, 14.5, 2], fill: '#f6a8c0' },
      { circle: [45.4, 14.5, 2], fill: '#f6a8c0' },
      { circle: [44.5, 11.6, 2], fill: '#f6a8c0' },
      { circle: [47, 12.4, 1.2], fill: '#f6d36b' },
    ],
    props: [
      {
        motion: 'fall',
        origin: [46, 20],
        busyOnly: true,
        shapes: [{ d: 'M46 22C44 20 45 18 47 19C48 20 48 22 46 22Z', fill: '#f6a8c0' }],
      },
    ],
  },
  'goggle-helper': {
    face: '#f8d84a',
    eyeScale: 0.82,
    blush: null,
    detail: [
      { d: 'M0 45H60V60H0Z', fill: '#3e6fb2' },
      { d: 'M24 48H36V54H24Z', fill: '#355f99', stroke: '#2c4f80', width: 0.6 },
      { d: 'M0 26L60 16V24L0 34Z', fill: INK },
      { circle: [24, 26, 6.6], fill: '#d7dde3', stroke: '#8a939e', width: 1.4 },
      { circle: [24, 26, 4.9], fill: '#ffffff', stroke: '#b8c0c8', width: 0.6 },
      { circle: [36, 24, 6.6], fill: '#d7dde3', stroke: '#8a939e', width: 1.4 },
      { circle: [36, 24, 4.9], fill: '#ffffff', stroke: '#b8c0c8', width: 0.6 },
      line('M25 40C28 43 33 43 36 39', INK, 1),
    ],
    props: [
      {
        motion: 'sway',
        origin: [30, 4],
        shapes: [line('M28 4C27 2 25 1 23 1M30 3.6C30 1.6 31 0.6 32.6 0.4M32 4C33.5 2.5 35.5 2 37.5 2.4', INK, 0.9)],
      },
    ],
  },
  'pipe-detective': {
    face: SKIN,
    front: [
      { d: 'M8 16C5 20 5 27 8 31L12 18Z', fill: '#a8865a' },
      { d: 'M52 15C55 19 55 26 52 30L48 17Z', fill: '#a8865a' },
      { d: 'M8 18C8 6 18 0 30 0C42 0 52 6 52 17C40 13 20 13 8 18Z', fill: '#a8865a' },
      line('M14 6L17 15.5M22 2L24.5 14M30 0V13M37.5 1L36.5 13M45 5L43.5 14.5', '#8c6c45', 0.8, 0.75),
      { d: 'M15 15C21 12 39 12 45 14C43 18.5 17 19 15 15Z', fill: '#94744b' },
      { d: 'M27 1L30 3L33 1V4.2L30 3.5L27 4.2Z', fill: '#7a5c38' },
      line('M34 41.5C36 44 38 45 41 45', '#4a2f1a', 1.6),
      { d: 'M40 44H46V49C46 51 40 51 40 49Z', fill: '#6a4426' },
    ],
    props: [
      {
        motion: 'rise',
        origin: [43, 42],
        busyOnly: true,
        shapes: [
          { circle: [43.5, 40, 1.6], fill: '#d6d2cc', opacity: 0.85 },
          { circle: [45.5, 35.8, 2.1], fill: '#d6d2cc', opacity: 0.7 },
          { circle: [43.8, 31, 2.5], fill: '#d6d2cc', opacity: 0.55 },
        ],
      },
    ],
  },
  'glasses-wizard': {
    face: SKIN,
    back: [
      { d: 'M4 28C1 12 13 0 30 0C47 0 59 12 56 28Z', fill: INK },
      { d: 'M10 52C18 58 42 58 50 52L52 60H8Z', fill: '#a33a3a' },
      line('M14 55L16 60M22 57L23 60M38 57L37 60M46 55L44 60', '#e2b54a', 1.6),
    ],
    front: [
      {
        d: 'M5 24C5 10 16 3 30 3C44 3 55 10 55 22L51 17L48 21L45 14L41 18L38 12L33 17L30 11L26 17L23 12L20 18L16 13L13 19L9 16Z',
        fill: INK,
      },
      { circle: [24, 26, 5.8], fill: 'none', stroke: '#3d3540', width: 1.3 },
      { circle: [36, 24, 5.8], fill: 'none', stroke: '#3d3540', width: 1.3 },
      line('M29.6 25.4L30.4 24.6M18.3 26.5L5 25M41.7 23.2L55 21', '#3d3540', 1.3),
    ],
    props: [
      {
        motion: 'glow',
        origin: [55, 41],
        busyOnly: true,
        shapes: [line('M46 51L55 42', '#6b4a2e', 1.6), { d: star(56, 40.6, 3), fill: '#ffe58a' }],
      },
    ],
  },
  'dark-knight': {
    face: '#25222b',
    eye: '#d2564a',
    blush: null,
    back: [{ d: 'M5 30C4 44 1 52 0 58H60C59 52 56 44 55 30Z', fill: '#2f2b35' }],
    detail: [
      line('M14 12C20 6 30 4 38 6', '#4b4655', 1.6),
      line('M15 20C22 17 38 15 45 17', '#3c3744', 1.2),
      { d: 'M27 31L33 30L30 38Z', fill: '#3b3643' },
      { d: 'M24 41L36 40L33 50L27 50.5Z', fill: '#3a3542' },
      line('M27.5 43V49M30 42.5V50M32.5 42.5V49', '#55505d', 0.7),
    ],
    props: [
      {
        motion: 'glow',
        origin: [30, 52],
        shapes: [
          { circle: [22, 52, 0.9], fill: '#ff6b5f' },
          { circle: [38, 51.4, 0.9], fill: '#6bc4ff' },
        ],
      },
    ],
  },
  'armor-hero': {
    face: '#c8323a',
    eye: '#f2fdff',
    eyeStroke: ['#9a6c1f', 0.7],
    blush: null,
    detail: [
      { d: 'M13 18C18 14 42 12 47 16L46 38C46 46 39 52 30 52C21 52 14 46 14 38Z', fill: '#e9b44c' },
      line('M13 18L19 22M47 16L41 20.5M15 34L20 40M45 32L40 39', '#b98a2f', 0.8),
      line('M25 44.5L35 43.8', '#b98a2f', 1),
    ],
    props: [
      {
        motion: 'glow',
        origin: [30, 30],
        layer: 'back',
        busyOnly: true,
        shapes: [{ circle: [30, 30, 29.6], fill: '#bfefff', opacity: 0.5 }],
      },
    ],
  },
  'web-hero': {
    face: '#d63b3b',
    eye: '#ffffff',
    eyeStroke: ['#1f1c24', 1.6],
    eyeScale: 1.3,
    blush: null,
    detail: [
      line('M30 28V0M30 28L58 13M30 28L60 35M30 28L47 60M30 28L13 60M30 28L0 37M30 28L2 11', '#7a1c1c', 0.7),
      line('M23 22Q30 19 37 21Q40 27 38 33Q30 37 22 34Q19 28 23 22Z', '#7a1c1c', 0.7),
      line('M15 14Q30 8 45 12Q52 26 48 41Q30 49 12 43Q7 28 15 14Z', '#7a1c1c', 0.7),
      line('M8 6Q30 -3 52 4Q63 26 57 49Q30 61 3 51Q-4 28 8 6Z', '#7a1c1c', 0.7),
    ],
  },
  'night-guardian': {
    face: SKIN,
    eye: '#ffffff',
    blush: null,
    back: [
      { d: 'M11 13L11 0L20 7Z', fill: '#323846' },
      { d: 'M49 12L49 0L40 6Z', fill: '#323846' },
    ],
    detail: [
      {
        d: 'M0 34C2 21 6 12 12 8C20 4 40 3 48 7C55 11 59 21 60 33C52 31 46 33 42 37C39 33 35 32 30 32C25 32 21 33 18 37C14 33 8 32 0 34Z',
        fill: '#323846',
      },
      line('M26 45C28 46 32 46 34 44.5', '#9a6a55', 0.9),
    ],
  },
  'sea-pirate': {
    face: SKIN,
    back: [
      { d: 'M5 20C1 34 2 48 5 56H11C8 46 8 34 10 22Z', fill: '#3b2a22' },
      { d: 'M55 18C59 32 58 46 55 54H49C52 44 52 32 50 20Z', fill: '#3b2a22' },
      { circle: [6.5, 50, 1.3], fill: '#d8b04a' },
      { circle: [53.5, 48, 1.3], fill: '#c23b33' },
    ],
    detail: [
      { d: 'M24 42C27 40 33 40 36 41.5C33 43 27 43.5 24 42Z', fill: '#3b2a22' },
      { d: 'M29 44.5H31L30.6 50H29.4Z', fill: '#3b2a22' },
    ],
    front: [
      { d: 'M5 21C7 12 53 10 55 19C46 16 14 17 5 21Z', fill: '#c23b33' },
      { d: 'M2 14C8 16 14 10 30 10C46 10 52 15 58 12C56 4 46 0 30 0C14 0 4 5 2 14Z', fill: INK },
      line('M2 14C8 16 14 10 30 10C46 10 52 15 58 12', '#d8b04a', 1.2),
      { circle: [30, 5, 2.2], fill: '#f3efe6' },
      line('M27 8.6L33 7.4M27 7.4L33 8.6', '#f3efe6', 0.8),
      { d: 'M19 21C21 19 27 19 28.5 22.5C28 28 26 31 23.5 31C20 31 18.5 26 19 21Z', fill: INK },
      line('M19.5 22L5 15M28 21.5L50 13', INK, 1),
    ],
  },
  'green-alien': {
    face: '#9be15d',
    eye: '#1d2b16',
    eyeScale: 1.35,
    detail: [line('M27 41Q30 43 33 40.5', '#4b7a2a', 0.9)],
    props: [
      {
        motion: 'sway',
        origin: [21, 8],
        layer: 'back',
        shapes: [line('M21 9C18 5 16 3 13 2.5', '#7cc23f', 1.6), { circle: [12.5, 2.6, 2.1], fill: '#c8f58f' }],
      },
      {
        motion: 'sway',
        origin: [39, 7],
        layer: 'back',
        shapes: [line('M39 8C42 4 44 2.5 47 2', '#7cc23f', 1.6), { circle: [47.6, 2.2, 2.1], fill: '#c8f58f' }],
      },
    ],
  },
  astronaut: {
    face: SKIN,
    back: [{ circle: [30, 30, 29.5], fill: '#eef2f7', stroke: '#b7c2cf', width: 1.2 }],
    front: [
      {
        d: 'M8 22C9 10 18 4 30 4C42 4 51 10 52 20C46 16 40 15 35 15L33 18L30 15C22 15 14 17 8 22Z',
        fill: '#6a4a35',
      },
      { circle: [30, 30, 27], fill: '#bfe3ff', opacity: 0.16 },
      { circle: [30, 30, 27], fill: 'none', stroke: '#c6d0dc', width: 1.4 },
    ],
    props: [
      {
        motion: 'glow',
        origin: [18, 10],
        shapes: [line('M11 15C15 9.5 20 6.5 26 5.5', '#ffffff', 2.2, 0.85)],
      },
    ],
  },
  chef: {
    face: SKIN,
    back: [{ d: 'M12 54L30 60L48 54V60H12Z', fill: '#d65a4c' }],
    front: [
      { d: 'M5 24C5 18 8 15 12 14V22Z', fill: '#6b4a33' },
      { d: 'M55 22C55 17 52 14 48 13V21Z', fill: '#6b4a33' },
      {
        d: 'M13 15C7 14 6 5 13 4C14 -1 23 -1 26 2C28 -1 36 -1 37 3C43 1 50 5 48 11C51 13 49 16 46 15Z',
        fill: '#ffffff',
        stroke: '#d9dde2',
        width: 0.9,
      },
      { d: 'M12 11.5C22 9.5 38 9.5 48 11V17C38 15.5 22 15.5 12 17.5Z', fill: '#ffffff', stroke: '#d9dde2', width: 0.9 },
    ],
    props: [
      {
        motion: 'twitch',
        origin: [30, 38],
        shapes: [
          {
            d: 'M30 37.5C27 35 22 36 20.5 39C23 38.5 25 40 27 39.5C28.5 39 29.5 38.5 30 37.5C30.5 38.5 31.5 39 33 39.5C35 40 37 38.5 39.5 39C38 36 33 35 30 37.5Z',
            fill: '#6b4a33',
          },
        ],
      },
    ],
  },
  doctor: {
    face: SKIN,
    back: [
      line('M14 50C16 58 26 60 30 60C34 60 44 58 46 50', '#3f9a98', 1.8),
      { circle: [30, 58, 2], fill: '#c7cfd6' },
    ],
    front: [
      {
        d: 'M4 26C3 11 15 2 30 2C45 2 57 11 56 24C52 18 46 14 39 13C33 15 25 15 18 14C12 16 7 20 4 26Z',
        fill: '#5a3e2b',
      },
      line('M5 17C14 10 46 9 55 15', '#cfd6dc', 2.4),
      { circle: [30, 10, 5], fill: '#e8edf1', stroke: '#a9b3bc', width: 1 },
      { circle: [30, 10, 1.2], fill: '#7f8b95' },
    ],
    props: [
      {
        motion: 'glow',
        origin: [28, 8],
        shapes: [line('M27 8.2L28.8 7', '#ffffff', 1.2)],
      },
    ],
  },
  cowboy: {
    face: SKIN,
    back: [{ d: 'M10 52L30 60L50 52L52 60H8Z', fill: '#c4433a' }],
    props: [
      {
        motion: 'sway',
        origin: [30, 12],
        shapes: [
          { d: 'M15 11C15 3 20 -1 25 1C28 2 32 2 35 1C40 -1 45 3 45 11Z', fill: '#9a5f35' },
          { d: 'M15 8.5H45V11.5H15Z', fill: '#5a3620' },
          { d: 'M0 10C4 16 10 13 15 11H45C50 13 56 16 60 10C58 18 48 18 30 18C12 18 2 18 0 10Z', fill: '#b06a3b' },
        ],
      },
      {
        motion: 'sway',
        origin: [34, 41],
        shapes: [line('M34 41L45 37', '#e2c46a', 1.2)],
      },
    ],
  },
  firefighter: {
    face: SKIN,
    detail: [{ ellipse: [44, 38, 3, 1.4], fill: '#7a6a66', opacity: 0.35 }],
    front: [
      { d: 'M5 18C5 6 16 -1 30 -1C44 -1 55 6 55 17Z', fill: '#d9482b' },
      line('M30 -1V4', '#c23d22', 2),
      {
        d: 'M2 17C10 14 50 13 58 16C59 19 58 20.5 56 20.5C48 18 12 19 4 21.5C2 20.5 1 19 2 17Z',
        fill: '#c23d22',
      },
      { d: 'M25 4H35V11C35 14 32 15.5 30 16C28 15.5 25 14 25 11Z', fill: '#f2c14e', stroke: '#c79a2c', width: 0.8 },
    ],
    props: [
      {
        motion: 'glow',
        origin: [30, 9],
        shapes: [{ circle: [30, 9.6, 1.5], fill: '#ffe9a8' }],
      },
    ],
  },
  'rock-star': {
    face: SKIN,
    back: [
      { d: 'M4 26C3 14 12 5 22 4L22 14C14 15 8 19 4 26Z', fill: '#3a333f' },
      { d: 'M56 24C57 12 48 4 38 3L38 13C46 14 52 18 56 24Z', fill: '#3a333f' },
      {
        d: 'M19 14L15 2L22 6L24 0L28 5L31 0L33 5L37 0L38 6L45 1L41 14Z',
        fill: '#e0457b',
      },
    ],
    detail: [{ d: 'M33 12L27 22H32L25 34L37 19H32L37 12Z', fill: '#e2474b', opacity: 0.9 }],
    front: [
      { d: 'M18 13C22 8 38 8 42 12L38 17C34 14 26 14 22 17Z', fill: '#e0457b' },
      { circle: [5, 38, 1.4], fill: '#d9d9e0' },
    ],
    props: [
      {
        motion: 'rise',
        origin: [52, 32],
        busyOnly: true,
        shapes: [
          line('M51 33V26L55 25V31', INK, 1),
          { ellipse: [50, 33.2, 1.5, 1.1], fill: INK },
          { ellipse: [54, 31.2, 1.5, 1.1], fill: INK },
        ],
      },
    ],
  },
  'cyber-hacker': {
    face: '#f3dccb',
    blush: null,
    back: [{ d: 'M2 34C0 12 14 -1 30 -1C46 -1 60 12 58 34L60 60H0Z', fill: '#2e3440' }],
    detail: [line('M44 40H48L50 42', '#22e1d6', 0.8)],
    front: [
      { d: 'M4 34C4 16 15 4 30 4C45 4 56 16 56 33C54 18 44 8 30 8C16 8 6 18 4 34Z', fill: '#3b4352' },
      { d: 'M10 23L50 17L51 28L11 34Z', fill: '#22e1d6', opacity: 0.35 },
      { d: 'M10 23L50 17L51 28L11 34Z', fill: 'none', stroke: '#22e1d6', width: 1 },
    ],
    props: [
      {
        motion: 'glow',
        origin: [30, 25],
        shapes: [line('M11.5 28.6L50.5 22.6', '#b9fffa', 1.2)],
      },
    ],
  },
  maid: {
    face: SKIN,
    back: [
      { d: 'M5 16C1 30 2 44 8 50H52C58 44 59 30 55 16Z', fill: INK },
      { d: 'M14 54C20 58 40 58 46 54L48 60H12Z', fill: '#ffffff' },
    ],
    front: [
      { d: BANGS, fill: INK },
      {
        d: 'M10 9C14 4 22 1 30 1C38 1 46 4 50 9C47 11 45 8 43 10C41 7 38 9 36 7C34 9 32 6 30 8C28 6 26 9 24 7C22 9 19 7 17 10C15 8 13 11 10 9Z',
        fill: '#ffffff',
        stroke: '#d7d3dc',
        width: 0.8,
      },
    ],
    props: [
      {
        motion: 'sway',
        origin: [30, 57],
        shapes: [
          { d: 'M30 57L25 54.5V59.5ZM30 57L35 54.5V59.5Z', fill: '#6b5a8e' },
          { circle: [30, 57, 1.2], fill: '#5a4a7a' },
        ],
      },
    ],
  },
  samurai: {
    face: SKIN,
    back: [
      { d: 'M26 6C24 1 27 0 30 0C33 0 36 1 34 6Z', fill: INK },
      { d: 'M5 28C2 14 14 3 30 3C46 3 58 14 55 28Z', fill: INK },
    ],
    front: [
      { d: 'M5 24C6 12 16 5 30 5C44 5 54 12 55 23C48 17 40 15 30 15C20 15 12 17 5 24Z', fill: INK },
      { d: 'M4 21C12 14 48 12 56 18V21.5C48 16.5 12 18 4 25Z', fill: '#ffffff', stroke: '#d9d4cf', width: 0.6 },
      { circle: [30, 16.4, 2], fill: '#d6403a' },
    ],
    props: [
      {
        motion: 'sway',
        origin: [5, 23],
        shapes: [
          { d: 'M5 22C1 25 0 30 1 35L3 34C3 30 4 26 6 24Z', fill: '#ffffff', stroke: '#d9d4cf', width: 0.5 },
          { d: 'M5 23C3 28 4 32 6 36L4 36.5C2 32 2 27 4 23Z', fill: '#f1ece6', stroke: '#d9d4cf', width: 0.5 },
        ],
      },
    ],
  },
  vampire: {
    face: '#efe9f2',
    back: [
      { d: 'M0 60L1 33L13 47L30 52L47 47L59 33L60 60Z', fill: '#1f1b24' },
      { d: 'M4 41L13 49L30 54L47 49L56 41L57 60H3Z', fill: '#9c2236' },
    ],
    detail: [
      line('M24 41C28 42 32 42 36 40.5', '#8a3a48', 0.9),
      { d: 'M26 41.4L27.2 44.6L28.4 41.6Z', fill: '#ffffff' },
      { d: 'M31.8 41.4L33 44.4L34.2 41Z', fill: '#ffffff' },
    ],
    front: [
      {
        d: 'M4 24C4 10 15 1 30 1C45 1 56 10 56 23C50 16 42 12 36 12L30 17L24 12C17 12 10 16 4 24Z',
        fill: '#26222b',
      },
    ],
    props: [
      {
        motion: 'flutter',
        origin: [51, 8],
        shapes: [
          {
            d: 'M51 8C49 5 46 5 44 7C46 7 47 9 47 10C48 9 50 9 51 10C52 9 54 9 55 10C55 9 56 7 58 7C56 5 53 5 51 8Z',
            fill: INK,
          },
        ],
      },
    ],
  },
  'forest-elf': {
    face: SKIN,
    back: [{ d: 'M7 14C1 30 1 48 3 60H57C59 48 59 30 53 14Z', fill: '#f2d27a' }],
    front: [
      { d: BANGS, fill: '#f6dc8c' },
      line('M6 17C14 11 46 10 54 15', '#5f9a52', 1.4),
      { d: 'M30 11C27 8.5 27.5 6 30 5.5C32.5 6 33 8.5 30 11Z', fill: '#6fb35f' },
    ],
    props: [
      {
        motion: 'twitch',
        origin: [7, 29],
        shapes: [{ d: 'M9 26C6 22 2 18 0 14C1 20 2 27 5 33Z', fill: '#f8e2d2', stroke: '#e6c3ae', width: 0.7 }],
      },
      {
        motion: 'twitch',
        origin: [53, 27],
        shapes: [{ d: 'M51 24C54 20 58 16 60 12C59 18 58 25 55 31Z', fill: '#f8e2d2', stroke: '#e6c3ae', width: 0.7 }],
      },
    ],
  },
  panda: {
    face: '#fafafa',
    eye: '#ffffff',
    eyeScale: 0.7,
    detail: [
      { ellipse: [23.4, 26.6, 5.6, 7.2], fill: INK, rotate: [28, 23.4, 26.6] },
      { ellipse: [36.6, 24.6, 5.6, 7.2], fill: INK, rotate: [-48, 36.6, 24.6] },
      { d: 'M27.5 34L32.5 33.4L30 36.5Z', fill: INK },
      line('M27 39.5Q30 41.5 33 39', INK, 0.9),
    ],
    props: [
      {
        motion: 'twitch',
        origin: [10, 10],
        layer: 'back',
        shapes: [{ circle: [10, 9, 7], fill: INK }],
      },
      {
        motion: 'twitch',
        origin: [50, 8],
        layer: 'back',
        shapes: [{ circle: [50, 7, 7], fill: INK }],
      },
    ],
  },
  santa: {
    face: SKIN,
    blush: '#f0a0a0',
    front: [
      {
        d: 'M5 34C6 48 16 58 30 58C44 58 55 48 55 33C50 38 44 41 38 40C35 38 25 38 22 40C16 41 10 39 5 34Z',
        fill: '#ffffff',
        stroke: '#e2e0dc',
        width: 0.6,
      },
      {
        d: 'M30 38C26 35 21 36 19 39.5C22 39 25 41 28 40C29 39.5 30 39 30 38C30 39 31 39.5 32 40C35 41 38 39 41 39.5C39 36 34 35 30 38Z',
        fill: '#ffffff',
        stroke: '#dedbd6',
        width: 0.6,
      },
      { d: 'M6 19C6 8 16 1 30 1C37 1 42 3 46 6C38 10 14 13 6 19Z', fill: '#d6403a' },
      { d: 'M4 19C12 13 46 11 54 16V21C46 16 12 18 4 24Z', fill: '#ffffff', stroke: '#e2e0dc', width: 0.6 },
    ],
    props: [
      {
        motion: 'sway',
        origin: [46, 8],
        shapes: [
          { d: 'M44 5C50 6 55 10 56 15L52 16C51 12 48 10 43 9Z', fill: '#d6403a' },
          { circle: [55.2, 16.6, 3], fill: '#ffffff', stroke: '#e2e0dc', width: 0.6 },
        ],
      },
    ],
  },
};
