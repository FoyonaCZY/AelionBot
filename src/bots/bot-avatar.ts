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
const props = (items: ArtProp[] = [], layer: 'back' | 'front') =>
  items
    .filter((item) => (item.layer || 'front') === layer)
    .map(
      (item) =>
        `<g class="avatar-prop${item.busyOnly ? ' avatar-prop-busy' : ''}" data-motion="${item.motion}" style="transform-origin:${num(item.origin[0])}px ${num(item.origin[1])}px">${shapes(item.shapes)}</g>`,
    )
    .join('');

function characterContent(art: CharacterArt, color: string, id: string) {
  const clip = `${id}-face`,
    scale = art.eyeScale ?? 1,
    eye = hex(art.eye, '#2b2730'),
    eyeStroke = art.eyeStroke ? ` stroke="${hex(art.eyeStroke[0])}" stroke-width="${num(art.eyeStroke[1])}"` : '',
    blush = art.blush === null ? '' : hex(art.blush, '#f2a3a3');
  const eyes = EYES.map(
    ([x, y]) =>
      `<g class="avatar-eye"><ellipse cx="${x}" cy="${y}" rx="${num(2.5 * scale)}" ry="${num(5 * scale)}" fill="${eye}"${eyeStroke} transform="rotate(-14 ${x} ${y})"/></g>`,
  ).join('');
  const cheeks = blush
    ? `<g class="avatar-blush"><ellipse cx="17.5" cy="35.5" rx="3.3" ry="1.8" fill="${blush}" opacity="0.75" transform="rotate(-8 17.5 35.5)"/><ellipse cx="42.5" cy="32.5" rx="3.3" ry="1.8" fill="${blush}" opacity="0.75" transform="rotate(-8 42.5 32.5)"/></g>`
    : '';
  const detail = art.detail?.length ? `<g clip-path="url(#${clip})">${shapes(art.detail)}</g>` : '';
  return `<defs><clipPath id="${clip}"><path d="${BOT_AVATAR_PATH}"/></clipPath></defs><circle class="avatar-halo" cx="30" cy="30" r="28.2" fill="none" stroke="${color}" stroke-width="1.4" stroke-dasharray="22 155" stroke-linecap="round"/><g class="avatar-body avatar-character">${shapes(art.back)}${props(art.props, 'back')}<path d="${BOT_AVATAR_PATH}" fill="${hex(art.face, '#fbece1')}"/>${detail}${cheeks}<g class="avatar-gaze">${eyes}</g>${shapes(art.front)}${props(art.props, 'front')}</g>`;
}

// Only validated hex colors, fixed geometry and sanitized IDs enter SVG markup.
export function botAvatarContent(value: BotPalette, prefix: string) {
  const { color, avatarStyle: style } = displayBotPalette(value),
    id = prefix.replace(/[^a-z\d_-]/gi, '') || 'avatar';
  if (style?.kind === 'character') {
    const art = CHARACTER_ART[style.character];
    if (art) return characterContent(art, color, id);
  }
  const paint = style?.kind === 'character' ? undefined : style,
    gradient = `${id}-paint`,
    clip = `${id}-clip`;
  const defs = paint
    ? `<defs>${paint.kind === 'gradient' ? `<linearGradient id="${gradient}" x1="10%" y1="0%" x2="${paint.direction === 'vertical' ? '45%' : '100%'}" y2="100%"><stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="${paint.secondary}"/></linearGradient>` : `<clipPath id="${clip}"><path d="${BOT_AVATAR_PATH}"/></clipPath>`}</defs>`
    : '';
  return `${defs}<circle class="avatar-halo" cx="30" cy="30" r="28.2" fill="none" stroke="${color}" stroke-width="1.4" stroke-dasharray="22 155" stroke-linecap="round"/><g class="avatar-body"><path d="${BOT_AVATAR_PATH}" fill="${paint?.kind === 'gradient' ? `url(#${gradient})` : color}"/>${paint?.kind === 'split' ? `<path d="${splitPaths[paint.pattern]}" fill="${paint.secondary}" clip-path="url(#${clip})"/>` : ''}<g class="avatar-gaze"><g class="avatar-eye"><ellipse cx="24" cy="26" rx="2.5" ry="5" fill="white" transform="rotate(-14 24 26)"/></g><g class="avatar-eye"><ellipse cx="36" cy="24" rx="2.5" ry="5" fill="white" transform="rotate(-14 36 24)"/></g></g></g>`;
}
export function botAvatarDataUrl(value: BotPalette) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><style>.avatar-halo{opacity:0}.avatar-prop-busy{opacity:0}</style>${botAvatarContent(value, 'bot')}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
