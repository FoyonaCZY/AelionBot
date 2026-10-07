import { displayBotPalette, type BotPalette, type BotSplitPattern } from '../../shared/chat/bot-colors';
import { CHARACTER_ART, type ArtProp, type ArtShape, type CharacterArt } from './bot-character-art';

export const BOT_AVATAR_PATH = 'M31 3C47 3 56 14 56 31C56 46 46 56 29 56C12 56 4 46 4 30C4 14 15 3 31 3Z';
const splitPaths: Record<BotSplitPattern, string> = {
  arc: 'M39-3C16 14 40 33 22 63H63V-3Z',
  diagonal: 'M54-3 14 63H63V-3Z',
  vertical: 'M30-3H63V63H30Z',
  wave: 'M-3 36C13 27 21 47 37 34S53 26 63 31V63H-3Z',
  horizontal: 'M-3 34H63V63H-3Z',
  blocks: 'M30-3H63V30H30ZM-3 30H30V63H-3Z',
};
const EYES = [
  [24, 26],
  [36, 24],
] as const;

const hex = (value: string | undefined, fallback = 'none') =>
  value && /^#[a-f\d]{6}$/i.test(value) ? value : value === 'none' ? 'none' : fallback;
const num = (value: number) => (Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0');
const pathData = (value: string) => (/^[MLHVCSQTAZmlhvcsqtaz\d\s.,-]+$/.test(value) ? value : '');

/** Serializes one artwork shape; only numbers, path commands and hex colours reach the markup. */
function shape(item: ArtShape) {
  const paint = `fill="${hex(item.fill)}"${
    item.stroke
      ? ` stroke="${hex(item.stroke)}" stroke-width="${num(item.width ?? 1)}" stroke-linecap="round" stroke-linejoin="round"`
      : ''
  }${item.opacity === undefined ? '' : ` opacity="${num(item.opacity)}"`}${
    item.rotate ? ` transform="rotate(${item.rotate.map(num).join(' ')})"` : ''
  }`;
  if (item.circle)
    return `<circle cx="${num(item.circle[0])}" cy="${num(item.circle[1])}" r="${num(item.circle[2])}" ${paint}/>`;
  if (item.ellipse)
    return `<ellipse cx="${num(item.ellipse[0])}" cy="${num(item.ellipse[1])}" rx="${num(item.ellipse[2])}" ry="${num(item.ellipse[3])}" ${paint}/>`;
  const d = pathData(item.d || '');
  return d ? `<path d="${d}" ${paint}/>` : '';
}
const shapes = (items: ArtShape[] = []) => items.map(shape).join('');
const props = (items: ArtProp[] = []): AvatarProp[] =>
  items.map((item) => ({
    layer: item.layer || 'front',
    motion: item.motion,
    origin: item.origin,
    busyOnly: Boolean(item.busyOnly),
    markup: shapes(item.shapes),
  }));
const halo = (color: string) =>
  `cx="30" cy="30" r="28.2" fill="none" stroke="${color}" stroke-width="1.4" stroke-dasharray="22 155" stroke-linecap="round"`;

/** A prop drawn with the character, moved by its own animation around `origin` (avatar units, 0–60). */
export interface AvatarProp {
  layer: 'back' | 'front';
  motion: ArtProp['motion'];
  origin: [number, number];
  busyOnly: boolean;
  markup: string;
}
/**
 * An avatar as the parts that move on their own, each SVG markup in the 60×60 avatar box. Drawn back to front: halo,
 * then the body (back, back props, face, eyes, front, front props). `defs` holds what the face refers to by id.
 */
export interface AvatarLayers {
  defs: string;
  /** Attributes of the halo circle. */
  halo: string;
  character: boolean;
  back: string;
  props: AvatarProp[];
  face: string;
  /** Each eye with its centre, the origin of its blink. */
  eyes: { x: number; y: number; markup: string }[];
  front: string;
}

function characterLayers(art: CharacterArt, color: string, id: string): AvatarLayers {
  const clip = `${id}-face`,
    scale = art.eyeScale ?? 1,
    eye = hex(art.eye, '#2b2730'),
    eyeStroke = art.eyeStroke ? ` stroke="${hex(art.eyeStroke[0])}" stroke-width="${num(art.eyeStroke[1])}"` : '',
    blush = art.blush === null ? '' : hex(art.blush, '#f2a3a3');
  const cheeks = blush
    ? `<g class="avatar-blush"><ellipse cx="17.5" cy="35.5" rx="3.3" ry="1.8" fill="${blush}" opacity="0.75" transform="rotate(-8 17.5 35.5)"/><ellipse cx="42.5" cy="32.5" rx="3.3" ry="1.8" fill="${blush}" opacity="0.75" transform="rotate(-8 42.5 32.5)"/></g>`
    : '';
  const detail = art.detail?.length ? `<g clip-path="url(#${clip})">${shapes(art.detail)}</g>` : '';
  return {
    defs: `<defs><clipPath id="${clip}"><path d="${BOT_AVATAR_PATH}"/></clipPath></defs>`,
    halo: halo(color),
    character: true,
    back: shapes(art.back),
    props: props(art.props),
    face: `<path d="${BOT_AVATAR_PATH}" fill="${hex(art.face, '#fbece1')}"/>${detail}${cheeks}`,
    eyes: EYES.map(([x, y]) => ({
      x,
      y,
      markup: `<ellipse cx="${x}" cy="${y}" rx="${num(2.5 * scale)}" ry="${num(5 * scale)}" fill="${eye}"${eyeStroke} transform="rotate(-14 ${x} ${y})"/>`,
    })),
    front: shapes(art.front),
  };
}

// Only validated hex colors, fixed geometry and sanitized IDs enter SVG markup.
export function botAvatarLayers(value: BotPalette, prefix: string): AvatarLayers {
  const { color, avatarStyle: style } = displayBotPalette(value),
    id = prefix.replace(/[^a-z\d_-]/gi, '') || 'avatar';
  if (style?.kind === 'character') {
    const art = CHARACTER_ART[style.character];
    if (art) return characterLayers(art, color, id);
  }
  const paint = style?.kind === 'character' ? undefined : style,
    gradient = `${id}-paint`,
    clip = `${id}-clip`;
  return {
    defs: paint
      ? `<defs>${paint.kind === 'gradient' ? `<linearGradient id="${gradient}" x1="10%" y1="0%" x2="${paint.direction === 'vertical' ? '45%' : '100%'}" y2="100%"><stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="${paint.secondary}"/></linearGradient>` : `<clipPath id="${clip}"><path d="${BOT_AVATAR_PATH}"/></clipPath>`}</defs>`
      : '',
    halo: halo(color),
    character: false,
    back: '',
    props: [],
    face: `<path d="${BOT_AVATAR_PATH}" fill="${paint?.kind === 'gradient' ? `url(#${gradient})` : color}"/>${paint?.kind === 'split' ? `<path d="${splitPaths[paint.pattern]}" fill="${paint.secondary}" clip-path="url(#${clip})"/>` : ''}`,
    eyes: EYES.map(([x, y]) => ({
      x,
      y,
      markup: `<ellipse cx="${x}" cy="${y}" rx="2.5" ry="5" fill="white" transform="rotate(-14 ${x} ${y})"/>`,
    })),
    front: '',
  };
}
/** The avatar as the content of one <svg viewBox="0 0 60 60">, with the same parts as groups. */
export function botAvatarContent(value: BotPalette, prefix: string) {
  const layers = botAvatarLayers(value, prefix);
  const prop = (item: AvatarProp) =>
    `<g class="avatar-prop${item.busyOnly ? ' avatar-prop-busy' : ''}" data-motion="${item.motion}" style="transform-origin:${num(item.origin[0])}px ${num(item.origin[1])}px">${item.markup}</g>`;
  const propsOn = (layer: AvatarProp['layer']) =>
    layers.props
      .filter((item) => item.layer === layer)
      .map(prop)
      .join('');
  const eyes = layers.eyes.map((eye) => `<g class="avatar-eye">${eye.markup}</g>`).join('');
  return `${layers.defs}<circle class="avatar-halo" ${layers.halo}/><g class="avatar-body${layers.character ? ' avatar-character' : ''}">${layers.back}${propsOn('back')}${layers.face}<g class="avatar-gaze">${eyes}</g>${layers.front}${propsOn('front')}</g>`;
}
export function botAvatarDataUrl(value: BotPalette) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><style>.avatar-halo{opacity:0}.avatar-prop-busy{opacity:0}</style>${botAvatarContent(value, 'bot')}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
