import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,relative} from 'node:path';
import {parseHTML} from 'linkedom';
import {Parser} from 'htmlparser2';
import type {DesignSession} from '../../src/designer-types';
import type {DesignFont} from '../../src/design-font-types';
import type {DesignerFiles} from './designer-files';

export type DesignFontRole='body'|'display'|'mono';
const START='<!-- aelion:project-fonts -->',END='<!-- /aelion:project-fonts -->';
const attribute=(value:string)=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const cssFamily=(value:string)=>'"'+value.replace(/[\\"<>\u0000-\u001f\u007f]/g,char=>'\\'+char.codePointAt(0)!.toString(16)+' ')+'"';
export async function designHtmlPath(files:DesignerFiles,session:DesignSession,input?:string){
  const path=input||session.artifacts.find(item=>item.kind==='html')?.path||(await files.list(session.botId,session.id)).find(item=>/\.html?$/i.test(item.path))?.path;
  if(!path||!/\.html?$/i.test(path))throw Error('请先生成 HTML 作品，再应用字体或导出项目');
  files.absolute(session,path);return path;
}
export async function designFontText(files:DesignerFiles,session:DesignSession,input?:string){
  const path=await designHtmlPath(files,session,input),bytes=await files.read(session.botId,files.virtual(session,path),8*1024*1024);
  const {document}=parseHTML(bytes.toString('utf8'));for(const element of document.querySelectorAll('script,style,template'))element.remove();
  return (document.body?.textContent||document.documentElement?.textContent||'').replace(/\s+/g,' ').slice(0,20000);
}
function markupAnchors(html:string){
  const starts:Array<{start:number;end:number}>=[],ends:Array<{start:number;end:number}>=[];
  let templateDepth=0,headClose:number|undefined,bodyOpen:number|undefined,htmlOpenEnd:number|undefined;
  const parser=new Parser({
    onopentag(name){if(name==='template')templateDepth++;if(templateDepth)return;if(name==='body')bodyOpen??=parser.startIndex;if(name==='html')htmlOpenEnd??=parser.endIndex+1;},
    onclosetag(name,implied){if(name==='template'){templateDepth=Math.max(0,templateDepth-1);return;}if(!templateDepth&&name==='head'&&!implied)headClose??=parser.startIndex;},
    oncomment(text){if(templateDepth)return;const value=text.trim(),range={start:parser.startIndex,end:parser.endIndex+1};if(value==='aelion:project-fonts')starts.push(range);if(value==='/aelion:project-fonts')ends.push(range);},
  },{decodeEntities:false});parser.write(html);parser.end();
  if(starts.length!==ends.length||starts.length>1||starts.length&&starts[0].end>ends[0].start)throw Error('字体样式标记不完整，请先修复 HTML');
  return {start:starts[0],end:ends[0],headClose,bodyOpen,htmlOpenEnd};
}
/** Patch only our managed block. All unrelated markup, whitespace and user edits stay byte-for-byte. */
export async function applyDesignFont(files:DesignerFiles,session:DesignSession,fonts:DesignFont[],input:{fontId:string;role:DesignFontRole;path?:string},beforeWrite?:()=>void){
  if(!['body','display','mono'].includes(input.role))throw Error('字体用途无效');
  const font=fonts.find(item=>item.id===input.fontId);if(!font)throw Error('字体不在当前项目中，请先添加');if(font.available===false)throw Error('字体文件或样式异常，请重新添加字体后再应用');
  const path=await designHtmlPath(files,session,input.path),absolute=files.absolute(session,path),source=await files.read(session.botId,files.virtual(session,path),8*1024*1024),html=source.toString('utf8');
  const anchors=markupAnchors(html),{start,end}=anchors;
  const old=start&&end?html.slice(start.end,end.start):'',roles:Partial<Record<DesignFontRole,string>>={};
  if(old){const {document}=parseHTML('<html><body>'+old+'</body></html>');const value=document.querySelector('style[data-font-roles]')?.getAttribute('data-font-roles');if(value){try{const data=JSON.parse(value);for(const role of ['body','display','mono'] as const)if(typeof data[role]==='string')roles[role]=data[role];}catch{throw Error('字体样式记录无效，请先修复 HTML');}}}
  roles[input.role]=font.id;
  const selected=Object.entries(roles).map(([role,id])=>{const item=fonts.find(font=>font.id===id);if(!item||item.available===false)throw Error('之前应用的字体已丢失或变更，请重新添加');return {role:role as DesignFontRole,font:item};});
  const links=[...new Set(selected.map(item=>item.font.cssPath))].map(css=>{
    const target=files.absolute(session,css);readFileSync(target);const href=relative(dirname(absolute),target).replaceAll('\\','/').split('/').map(segment=>segment==='..'?segment:encodeURIComponent(segment)).join('/');
    return '<link rel="stylesheet" href="'+attribute(href)+'">';
  }).join('\n');
  const headings='h1,h2,h3,h4,h5,h6',code='pre,code,kbd,samp';
  const icons='[class*="icon" i],[class*="material-symbol" i],.fa,.fas,.far,.fab,.fal,.fad,[data-icon],[role="img"]';
  const selectors:Record<DesignFontRole,string>={
    body:':is(body,p,li,td,th,label,input,textarea,button,select,div,span,a,blockquote,figcaption,dd,dt):not(:is('+headings+','+code+') *):not('+icons+'):not(:is('+icons+') *)',
    display:':is('+headings+'),:is('+headings+') :is(span,a,em,strong,small):not('+icons+'):not(:is('+icons+') *)',
    mono:':is('+code+'),:is('+code+') :is(span,a,b,em,strong):not('+icons+'):not(:is('+icons+') *)',
  };
  const rules=selected.map(({role,font})=>{const family=cssFamily(font.family),fallback=role==='mono'?'monospace':'sans-serif';return ':root{--font-'+role+':'+family+','+fallback+'}\n'+selectors[role]+'{font-family:var(--font-'+role+')!important}';}).join('\n');
  const block=START+'\n'+links+'\n<style data-font-roles="'+attribute(JSON.stringify(roles))+'">\n'+rules+'\nbutton,input,select,textarea{font-family:inherit}\n</style>\n'+END;
  let updated:string;
  if(start&&end)updated=html.slice(0,start.start)+block+html.slice(end.end);
  else if(anchors.headClose!==undefined)updated=html.slice(0,anchors.headClose)+block+'\n'+html.slice(anchors.headClose);
  else if(anchors.bodyOpen!==undefined)updated=html.slice(0,anchors.bodyOpen)+block+'\n'+html.slice(anchors.bodyOpen);
  else if(anchors.htmlOpenEnd!==undefined)updated=html.slice(0,anchors.htmlOpenEnd)+'<head>'+block+'</head>'+html.slice(anchors.htmlOpenEnd);
  else updated=(html.startsWith('\ufeff')?'\ufeff':'')+block+'\n'+html.replace(/^\ufeff/,'');
  beforeWrite?.();
  const result=files.write(session,path,Buffer.from(updated),createHash('sha256').update(source).digest('hex'));
  return {...result,family:font.family,role:input.role,cssPath:font.cssPath};
}
