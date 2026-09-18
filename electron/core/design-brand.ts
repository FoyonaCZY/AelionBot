const HEX=/#([0-9a-f]{3,8})\b/gi;
const TOKEN=/--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
function expand(hex:string){
 const value=hex.replace('#','').toLowerCase();
 if(value.length===3||value.length===4)return '#'+[...value.slice(0,3)].map(ch=>ch+ch).join('');
 return '#'+value.slice(0,6);
}
function rgb(hex:string){const v=expand(hex).slice(1);return [parseInt(v.slice(0,2),16),parseInt(v.slice(2,4),16),parseInt(v.slice(4,6),16)] as const;}
function distance(a:string,b:string){const [ar,ag,ab]=rgb(a),[br,bg,bb]=rgb(b);return Math.abs(ar-br)+Math.abs(ag-bg)+Math.abs(ab-bb);}
export interface DesignTokens{
 colors:Record<string,string>;
 fonts:Record<string,string>;
 sizes:Record<string,string>;
 spacing:Record<string,string>;
}
export function parseDesignTokens(css:string):DesignTokens{
 const colors:Record<string,string>={},fonts:Record<string,string>={},sizes:Record<string,string>={},spacing:Record<string,string>={};
 let match:RegExpExecArray|null;TOKEN.lastIndex=0;
 while((match=TOKEN.exec(css))){
  const name=match[1],raw=match[2].trim();
  if(/^#([0-9a-f]{3,8})$/i.test(raw))colors[name]=expand(raw);
  else if(name.startsWith('font'))fonts[name]=raw;
  else if(/^(text|size|type)-/.test(name)||/font-size/.test(name))sizes[name]=raw;
  else if(/^(space|spacing|gap|pad|radius)/.test(name))spacing[name]=raw;
 }
 return {colors,fonts,sizes,spacing};
}
function nearestColor(hex:string,colors:Record<string,string>){
 const entries=Object.entries(colors);if(!entries.length)return;
 return entries.reduce((best,[name,value])=>{const d=distance(hex,value);return !best||d<best.distance?{name,value,distance:d}:best;},undefined as {name:string;value:string;distance:number}|undefined);
}
export function checkDesignBrand(html:string,tokens:DesignTokens){
 const issues:string[]=[],style=html.match(/<style[\s\S]*?<\/style>/gi)?.join('\n')||'';
 const cssWithoutRoot=style.replace(/:root\s*\{[\s\S]*?\}/g,'');
 const hexes=[...new Set((cssWithoutRoot.match(HEX)||[]).map(expand))];
 const offBrand=hexes.filter(hex=>{const near=nearestColor(hex,tokens.colors);return near?near.distance>48:Boolean(Object.keys(tokens.colors).length);});
 if(offBrand.length)issues.push(`有 ${offBrand.length} 处颜色未对齐设计 token（如 ${offBrand.slice(0,3).join('、')}）。`);
 const fontStacks=Object.values(tokens.fonts);
 if(fontStacks.length&&/<style[\s\S]*?font-family\s*:\s*[^;]*(Arial|Inter|Roboto|system-ui)/i.test(html)&&!/var\(--(?:od-)?font-(?:display|body)/.test(html))
  issues.push('字族没有使用设计系统的 --font-display / --font-body。');
 if(Object.keys(tokens.sizes).length&&/<style[\s\S]*?font-size\s*:\s*\d+px/i.test(html)&&!/var\(--text-/.test(html))
  issues.push('字号使用了原始 px，而不是 --text-* token。');
 if(Object.keys(tokens.spacing).length&&/<style[\s\S]*?(?:padding|margin|gap)\s*:\s*\d+px/i.test(html)&&!/var\(--(?:space|spacing|gap|pad)/.test(html))
  issues.push('间距使用了原始 px，而不是 spacing token。');
 return {aligned:!issues.length,issues};
}
export function repairDesignBrand(html:string,tokens:DesignTokens){
 let next=html,changed=false;
 const styleMatch=html.match(/<style[\s\S]*?<\/style>/i);
 if(styleMatch){
  let style=styleMatch[0];
  const roots:string[]=[];
  style=style.replace(/:root\s*\{[\s\S]*?\}/g,block=>{roots.push(block);return `/*__ROOT_${roots.length-1}__*/`;});
  style=style.replace(/#[0-9a-f]{3,8}\b/gi,hex=>{
   const near=nearestColor(hex,tokens.colors);
   if(!near||near.distance>36)return hex;
   if(expand(hex)===near.value&&/var\(--/.test(hex))return hex;
   changed=true;return `var(--${near.name})`;
  });
  if(tokens.fonts['font-display'])style=style.replace(/font-family\s*:\s*[^;]*(Inter|Roboto|Arial|system-ui)[^;]*/gi,()=>{changed=true;return 'font-family:var(--font-display)';});
  style=style.replace(/\/\*__ROOT_(\d+)__\*\//g,(_,index)=>roots[Number(index)]||'');
  if(style!==styleMatch[0])next=html.replace(styleMatch[0],style);
 }
 const check=checkDesignBrand(next,tokens);
 return {html:next,changed,check};
}
export function brandCheckLabel(aligned:boolean,en=false){return aligned?(en?'On brand':'品牌对齐'):(en?'Not on brand':'未对齐品牌');}
