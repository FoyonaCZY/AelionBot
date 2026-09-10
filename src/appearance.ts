export type ThemePreference='system'|'light'|'dark';
export interface AppearanceSettings{
  theme:ThemePreference;
  font:'bundled'|'system'|'custom';
  customFont:string;
  codeFont:'bundled'|'system'|'custom';
  customCodeFont:string;
  weight:number;
  textScale:number;
  messageSize:number;
  codeSize:number;
  lineHeight:number;
  zoom:number;
}
export const DEFAULT_APPEARANCE:AppearanceSettings={theme:'system',font:'bundled',customFont:'',codeFont:'bundled',customCodeFont:'',weight:400,textScale:100,messageSize:15,codeSize:13,lineHeight:1.8,zoom:100};
const family=(value:unknown)=>typeof value==='string'&&/^[\p{L}\p{N} ._-]{0,80}$/u.test(value)?value.trim():'';
export function normalizeAppearance(value:unknown):AppearanceSettings{
  const v=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const choice=<T extends string>(key:keyof AppearanceSettings,values:T[],fallback:T)=>values.includes(v[key] as T)?v[key] as T:fallback;
  const number=(key:keyof AppearanceSettings,min:number,max:number,step=1)=>typeof v[key]==='number'&&Number.isFinite(v[key])?Math.round(Math.max(min,Math.min(max,v[key] as number))/step)*step:DEFAULT_APPEARANCE[key] as number;
  return {theme:choice('theme',['system','light','dark'],'system'),font:choice('font',['bundled','system','custom'],'bundled'),customFont:family(v.customFont),codeFont:choice('codeFont',['bundled','system','custom'],'bundled'),customCodeFont:family(v.customCodeFont),weight:number('weight',300,600,100),textScale:number('textScale',85,130),messageSize:number('messageSize',12,22),codeSize:number('codeSize',11,20),lineHeight:Number(number('lineHeight',1.4,2.2,.1).toFixed(1)),zoom:number('zoom',50,200)};
}
export function appearanceVariables(value:AppearanceSettings){
  const v=normalizeAppearance(value),scale=v.textScale/100;
  const px=(size:number)=>`${Number((size*scale).toFixed(3))}px`;
  const bundled="'Inter Variable','Noto Sans SC Variable','Segoe UI','Microsoft YaHei UI',sans-serif";
  const code="'JetBrains Mono Variable','Noto Sans SC Variable',Consolas,monospace";
  return {
    '--font-ui':v.font==='system'?"system-ui,-apple-system,'Segoe UI','Microsoft YaHei UI',sans-serif":v.font==='custom'&&v.customFont?`'${v.customFont}',${bundled}`:bundled,
    '--font-code':v.codeFont==='system'?"'Cascadia Code',Consolas,'Noto Sans SC Variable',monospace":v.codeFont==='custom'&&v.customCodeFont?`'${v.customCodeFont}',${code}`:code,
    '--appearance-text-scale':String(scale),'--text-body':px(v.messageSize),'--text-code':px(v.codeSize),'--text-control':px(14),'--text-caption':px(12),'--text-title':px(22),'--weight-body':String(v.weight),'--weight-label':String(Math.min(700,v.weight+100)),'--weight-heading':String(Math.min(800,v.weight+200)),'--message-leading':String(v.lineHeight),
  };
}
export function resolvedTheme(theme:ThemePreference,systemDark:boolean){return theme==='system'?(systemDark?'dark':'light'):theme;}
