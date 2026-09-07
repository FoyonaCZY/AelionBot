export type BotSplitPattern='arc'|'diagonal'|'vertical'|'wave'|'horizontal'|'blocks';
export type BotAvatarStyle={kind:'gradient';secondary:string;direction:'diagonal'|'vertical'}|{kind:'split';secondary:string;pattern:BotSplitPattern};
export interface BotPalette {color:string;avatarStyle?:BotAvatarStyle;}
export interface BotPalettePreset extends BotPalette {id:string;name:string;}
export const BOT_SPLIT_PATTERNS:Record<BotSplitPattern,string>={arc:'弧线',diagonal:'斜切',vertical:'左右',wave:'波纹',horizontal:'上下',blocks:'色块'};
export const DEFAULT_BOT_PALETTE:BotPalette={color:'#8b6bea'};

export const BOT_PALETTES:readonly BotPalettePreset[]=[
  {id:'blue',name:'天空蓝',color:'#268bfa'},
  {id:'purple',name:'原版紫',color:'#8b6bea'},
  {id:'green',name:'薄荷绿',color:'#19a887'},
  {id:'orange',name:'暖橙',color:'#ed8c35'},
  {id:'mist',name:'雾蓝',color:'#5482b8'},
  {id:'rose',name:'豆沙',color:'#c77391'},
  {id:'clay',name:'陶土',color:'#c37c60'},
  {id:'moss',name:'苔绿',color:'#748c70'},
  {id:'teal',name:'青灰',color:'#4f8987'},
  {id:'graphite',name:'石墨',color:'#66707c'},
  {id:'dusk',name:'暮光',color:'#8d65d8',avatarStyle:{kind:'gradient',secondary:'#4d8ac4',direction:'diagonal'}},
  {id:'berry',name:'莓果',color:'#9468c5',avatarStyle:{kind:'gradient',secondary:'#d27697',direction:'diagonal'}},
  {id:'sunset',name:'日落',color:'#c06e6c',avatarStyle:{kind:'gradient',secondary:'#c89a56',direction:'vertical'}},
  {id:'sea',name:'海风',color:'#518f85',avatarStyle:{kind:'gradient',secondary:'#75a2b4',direction:'diagonal'}},
  {id:'aurora',name:'极光',color:'#6675c8',avatarStyle:{kind:'gradient',secondary:'#56a39e',direction:'diagonal'}},
  {id:'lilac',name:'丁香',color:'#6672aa',avatarStyle:{kind:'gradient',secondary:'#aa83c5',direction:'vertical'}},
  {id:'blueberry',name:'蓝莓',color:'#6d88c1',avatarStyle:{kind:'split',secondary:'#9a7fc6',pattern:'arc'}},
  {id:'pink-purple',name:'粉紫',color:'#c681a0',avatarStyle:{kind:'split',secondary:'#8e7bb8',pattern:'vertical'}},
  {id:'shore',name:'海岸',color:'#578c80',avatarStyle:{kind:'split',secondary:'#83aba6',pattern:'wave'}},
  {id:'apricot',name:'紫杏',color:'#9175bb',avatarStyle:{kind:'split',secondary:'#c7956c',pattern:'diagonal'}},
  {id:'tide',name:'潮汐',color:'#729ca9',avatarStyle:{kind:'split',secondary:'#657baf',pattern:'horizontal'}},
  {id:'rose-moss',name:'莓绿',color:'#c1809f',avatarStyle:{kind:'split',secondary:'#829a84',pattern:'blocks'}}
];
export const BOT_COLORS=BOT_PALETTES.filter(palette=>!palette.avatarStyle).map(palette=>palette.color);
export const isBotHexColor=(value:unknown):value is string=>typeof value==='string'&&/^#[a-f\d]{6}$/i.test(value);

export function normalizeBotAvatarStyle(value:unknown):BotAvatarStyle|undefined{
  if(value===undefined||value===null)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('无效的 Bot 头像配色');
  const style=value as Record<string,unknown>;
  if(!isBotHexColor(style.secondary))throw new Error('请使用有效的六位颜色值');
  if(style.kind==='gradient'&&(style.direction==='diagonal'||style.direction==='vertical'))return {kind:'gradient',secondary:style.secondary.toLowerCase(),direction:style.direction};
  if(style.kind==='split'&&typeof style.pattern==='string'&&Object.hasOwn(BOT_SPLIT_PATTERNS,style.pattern))return {kind:'split',secondary:style.secondary.toLowerCase(),pattern:style.pattern as BotSplitPattern};
  throw new Error('无效的 Bot 头像配色');
}
export function normalizeBotPalette(value:{color:unknown;avatarStyle?:unknown}):BotPalette{
  if(!isBotHexColor(value.color))throw new Error('请使用有效的六位颜色值');
  const avatarStyle=normalizeBotAvatarStyle(value.avatarStyle);
  return {color:value.color.toLowerCase(),...(avatarStyle?{avatarStyle}:{})};
}
export function displayBotPalette(value:{color?:string;avatarStyle?:unknown}):BotPalette{
  let color=value.color||DEFAULT_BOT_PALETTE.color;
  if(/^#[a-f\d]{3}$/i.test(color))color='#'+color.slice(1).split('').map(letter=>letter+letter).join('');
  if(!isBotHexColor(color))color=DEFAULT_BOT_PALETTE.color;
  try{return normalizeBotPalette({color,avatarStyle:value.avatarStyle});}catch{return {color:color.toLowerCase()};}
}
export const botPaletteKey=(value:BotPalette)=>JSON.stringify(displayBotPalette(value));
export function randomBotPalette(previous?:BotPalette):BotPalette{
  const key=previous&&botPaletteKey(previous),choices=BOT_PALETTES.filter(palette=>botPaletteKey(palette)!==key);
  return normalizeBotPalette(choices[Math.floor(Math.random()*choices.length)]);
}
export function randomBotColor(previous?:string){
  const choices=BOT_COLORS.filter(color=>color!==previous);
  return choices[Math.floor(Math.random()*choices.length)];
}
export function botIdentity(bot:{id:string;name:string;color:string;avatarStyle?:BotAvatarStyle}){
  return {id:bot.id,name:bot.name,color:bot.color,...(bot.avatarStyle?{avatarStyle:{...bot.avatarStyle}}:{})};
}
