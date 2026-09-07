import {displayBotPalette,type BotPalette,type BotSplitPattern} from './bot-colors';

export const BOT_AVATAR_PATH='M31 3C47 3 56 14 56 31C56 46 46 56 29 56C12 56 4 46 4 30C4 14 15 3 31 3Z';
const splitPaths:Record<BotSplitPattern,string>={
  arc:'M39-3C16 14 40 33 22 63H63V-3Z',diagonal:'M54-3 14 63H63V-3Z',vertical:'M30-3H63V63H30Z',
  wave:'M-3 36C13 27 21 47 37 34S53 26 63 31V63H-3Z',horizontal:'M-3 34H63V63H-3Z',blocks:'M30-3H63V30H30ZM-3 30H30V63H-3Z'
};

// Only validated hex colors, fixed geometry and sanitized IDs enter SVG markup.
export function botAvatarContent(value:BotPalette,prefix:string){
  const {color,avatarStyle:style}=displayBotPalette(value),id=prefix.replace(/[^a-z\d_-]/gi,'')||'avatar',gradient=`${id}-paint`,clip=`${id}-clip`;
  const defs=style?`<defs>${style.kind==='gradient'?`<linearGradient id="${gradient}" x1="10%" y1="0%" x2="${style.direction==='vertical'?'45%':'100%'}" y2="100%"><stop offset="0%" stop-color="${color}"/><stop offset="100%" stop-color="${style.secondary}"/></linearGradient>`:`<clipPath id="${clip}"><path d="${BOT_AVATAR_PATH}"/></clipPath>`}</defs>`:'';
  return `${defs}<circle class="avatar-halo" cx="30" cy="30" r="28.2" fill="none" stroke="${color}" stroke-width="1.4" stroke-dasharray="22 155" stroke-linecap="round"/><g class="avatar-body"><path d="${BOT_AVATAR_PATH}" fill="${style?.kind==='gradient'?`url(#${gradient})`:color}"/>${style?.kind==='split'?`<path d="${splitPaths[style.pattern]}" fill="${style.secondary}" clip-path="url(#${clip})"/>`:''}<g class="avatar-gaze"><g class="avatar-eye"><ellipse cx="24" cy="26" rx="2.5" ry="5" fill="white" transform="rotate(-14 24 26)"/></g><g class="avatar-eye"><ellipse cx="36" cy="24" rx="2.5" ry="5" fill="white" transform="rotate(-14 36 24)"/></g></g></g>`;
}
export function botAvatarDataUrl(value:BotPalette){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><style>.avatar-halo{opacity:0}</style>${botAvatarContent(value,'bot')}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
