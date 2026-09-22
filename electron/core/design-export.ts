import {readFileSync,realpathSync,statSync,existsSync} from 'node:fs';
import {resolve,relative,dirname,extname,isAbsolute,posix,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {parseHTML} from 'linkedom';
import postcss from 'postcss';
import {zipSync,strToU8} from 'fflate';
import {mime} from './web-preview-resources';
import {printReadyHtml} from './design-pdf';

export interface DesignHtmlExportInput {rootDir:string;htmlPath:string;html?:string;signal?:AbortSignal;}
const MAX_FILE=25*1024*1024,MAX_TOTAL=100*1024*1024,MAX_TEXT=8*1024*1024,MAX_FILES=512;
const allowed=new Set(['html','htm','css','js','mjs','svg','png','jpg','jpeg','gif','webp','avif','ico','woff','woff2','ttf','otf']);
const fontFile=/\.(?:woff2?|ttf|otf)$/i;
const dataType=/^(?:image\/(?:png|jpeg|gif|webp|avif|x-icon|svg\+xml)|font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|x-font-ttf|x-font-opentype)|text\/(?:css|javascript|html))$/i;
function within(root:string,path:string){const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../');}
function cssUnescape(value:string){return value.replace(/\\([0-9a-f]{1,6})(?:\r\n|[\n\r\t\f ])?|\\(?:\r\n|[\n\r\f])|\\([^\n\r\f])/gi,(_all,hex:string,char:string)=>hex?String.fromCodePoint(parseInt(hex,16)||0xfffd):char||'');}
function cssQuote(value:string){return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\a ')+'"';}
function stringEnd(text:string,start:number){const quote=text[start];for(let i=start+1;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]===quote)return i+1;}throw Error('CSS 字符串未闭合');}
function skipSpace(text:string,start:number){let i=start;while(i<text.length){if(/\s/.test(text[i]))i++;else if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);if(end<0)throw Error('CSS 注释未闭合');i=end+2;}else break;}return i;}
/** Token-aware URL rewriting; quoted strings and comments are never interpreted as URLs. */
function cssUrls(text:string,rewrite:(url:string)=>string){
 let out='',i=0;
 while(i<text.length){
  if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);if(end<0)throw Error('CSS 注释未闭合');out+=text.slice(i,end+2);i=end+2;continue;}
  if(text[i]==='"'||text[i]==="'"){const end=stringEnd(text,i);out+=text.slice(i,end);i=end;continue;}
  const identifier=/^(?:[-_a-zA-Z]|\\(?:[0-9a-fA-F]{1,6}\s?|.))(?:[-_a-zA-Z0-9]|\\(?:[0-9a-fA-F]{1,6}\s?|.))*/.exec(text.slice(i));
  if(identifier){const word=identifier[0],next=i+word.length,name=cssUnescape(word).toLowerCase();
   if(name==='url'&&text[next]==='('){let at=skipSpace(text,next+1),url:string;
    if(text[at]==='"'||text[at]==="'"){const end=stringEnd(text,at);url=cssUnescape(text.slice(at+1,end-1));at=skipSpace(text,end);}
    else {const start=at;for(;at<text.length;at++){if(text[at]==='\\'){at++;continue;}if(text[at]===')')break;}url=cssUnescape(text.slice(start,at).trim());}
    if(text[at]!==')')throw Error('CSS url() 无效');out+='url('+cssQuote(rewrite(url))+')';i=at+1;continue;
   }
   // String image-set sources need their own grammar; fail visibly instead of losing an asset.
   if(/^(?:-webkit-)?image-set$/.test(name)&&text[next]==='(')throw Error('导出前请将 image-set() 改为普通 url() 图片引用');
   out+=word;i=next;continue;
  }
  out+=text[i++];
 }
 return out;
}
function srcsetUrls(value:string,rewrite:(url:string)=>string){
 let i=0;const candidates:string[]=[];
 while(i<value.length){while(i<value.length&&/[\s,]/.test(value[i]))i++;if(i===value.length)break;const start=i;while(i<value.length&&!/\s/.test(value[i]))i++;let url=value.slice(start,i);const ended=url.endsWith(',');url=url.replace(/,+$/,'');let descriptor='';
  if(!ended){const from=i;while(i<value.length&&value[i]!==',')i++;descriptor=value.slice(from,i).trim();if(i<value.length)i++;}
  if(descriptor&&!/^(?:\d+w|(?:\d+(?:\.\d+)?|\.\d+)x)$/.test(descriptor))throw Error('图片 srcset 格式不受支持');
  candidates.push(rewrite(url)+(descriptor?' '+descriptor:''));
 }
 return candidates.join(', ');
}

class HtmlResources {
 readonly root:string;readonly entry:string;readonly files=new Map<string,Buffer>();private embedded=new Map<string,Buffer>();private raw=new Map<string,Buffer>();private pending=new Set<string>();private total=0;
 constructor(private input:DesignHtmlExportInput,private inline:boolean){this.root=realpathSync(input.rootDir);this.entry=this.check(resolve(input.htmlPath));if(!/\.html?$/i.test(this.entry))throw Error('只能导出 HTML 项目');}
 private check(path:string,license=false){
  this.input.signal?.throwIfAborted();if(!within(this.root,path))throw Error('导出资源必须位于当前设计目录');
  const rel=relative(this.root,path).replaceAll('\\','/');if(!rel||rel.split('/').some(p=>p.startsWith('.')||p.includes(':'))||/\0|[\r\n]/.test(rel))throw Error('不能导出隐藏文件或无效路径');
  if(!license&&!allowed.has(extname(path).slice(1).toLowerCase()))throw Error('不支持的导出资源：'+rel);
  if(!existsSync(path))throw Error('导出资源不存在：'+rel);if(!within(this.root,realpathSync(path)))throw Error('导出资源链接越过设计目录：'+rel);return path;
 }
 private name(path:string){return relative(this.root,path).replaceAll('\\','/');}
 private read(path:string,license=false){
  const saved=this.raw.get(path);if(saved)return saved;this.check(path,license);const stat=statSync(path),limit=/\.(?:html?|css|js|mjs|svg)$/i.test(path)||license?MAX_TEXT:MAX_FILE;
  if(!stat.isFile()||stat.size>limit)throw Error('导出资源超过大小限制：'+this.name(path));
  const bytes=readFileSync(path);this.total+=bytes.length;if(bytes.length>limit||this.total>MAX_TOTAL||this.raw.size>=MAX_FILES)throw Error('导出资源总量超过限制（100 MB / 512 个文件）');
  this.raw.set(path,bytes);return bytes;
 }
 private reference(url:string,from:string,depth:number,inline=this.inline){
  const value=url.trim();if(!value||value.startsWith('#'))return value;if(depth>20)throw Error('导出资源嵌套超过限制');
  if(value.startsWith('data:')){
   const match=/^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(value);if(!match||!dataType.test(match[1]))throw Error('不支持的 data URL 资源');
   const bytes=match[2]?Buffer.from(match[3],'base64'):Buffer.from(decodeURIComponent(match[3]));if(bytes.length>MAX_FILE)throw Error('内嵌资源超过 25 MB');
   const type=match[1].toLowerCase();if(type==='text/css')return this.data(this.css(bytes.toString('utf8'),from,depth+1,true),type);if(type==='image/svg+xml')return this.data(this.html(bytes.toString('utf8'),from,depth+1,true,true),type);if(type==='text/html')throw Error('导出不支持内嵌子页面');return value;
  }
  if(/^[a-z][a-z\d+.-]*:|^\/\//i.test(value))throw Error('请先将远程或 file: 资源保存到设计目录：'+value.slice(0,180));
  const cut=value.search(/[?#]/),pathname=decodeURIComponent(cut<0?value:value.slice(0,cut)),fragment=value.includes('#')?value.slice(value.indexOf('#')):'';
  if(!pathname||pathname.startsWith('/')||pathname.includes('\\')||pathname.includes('\0')||pathname.includes(':'))throw Error('资源必须使用设计目录内的相对路径：'+value);
  const path=this.check(resolve(dirname(from),pathname)),bytes=this.asset(path,depth+1,inline),type=mime[extname(path).slice(1).toLowerCase()];
  if(inline)return this.data(bytes,type)+fragment;
  return posix.relative(posix.dirname(this.name(from)),this.name(path)).split('/').map(part=>encodeURIComponent(part)).join('/')+fragment;
 }
 private data(value:Buffer|string,type:string){return 'data:'+type+';base64,'+Buffer.from(value).toString('base64');}
 private css(source:string,path:string,depth:number,inline=this.inline){
  const ast=postcss.parse(source,{from:path,map:false});ast.walkDecls(decl=>{decl.value=cssUrls(decl.value,url=>this.reference(url,path,depth,inline));});
  ast.walkAtRules(rule=>{
   if(cssUnescape(rule.name).toLowerCase()==='import'){
    const start=skipSpace(rule.params,0);if(rule.params[start]==='"'||rule.params[start]==="'"){const end=stringEnd(rule.params,start);rule.params=rule.params.slice(0,start)+cssQuote(this.reference(cssUnescape(rule.params.slice(start+1,end-1)),path,depth,inline))+cssUrls(rule.params.slice(end),url=>this.reference(url,path,depth,inline));return;}
   }
   rule.params=cssUrls(rule.params,url=>this.reference(url,path,depth,inline));
  });return ast.toString();
 }
 private html(source:string,path:string,depth:number,svg=false,inline=this.inline){
  const {document}=parseHTML(svg?source:printReadyHtml(source));
  if(document.querySelector('base[href]'))throw Error('导出前请移除 HTML 的 base 标签，并使用相对资源路径');
  if(document.querySelector('iframe,frame,object,embed'))throw Error('导出暂不支持嵌入的子页面；请将内容放入当前 HTML');
  for(const node of document.querySelectorAll('style'))node.textContent=this.css(node.textContent||'',path,depth,inline);
  for(const node of document.querySelectorAll('*')){
   if(node.hasAttribute('style'))node.setAttribute('style',this.css(node.getAttribute('style')!,path,depth,inline));
   const tag=node.tagName.toLowerCase();
   if(tag==='script'&&node.getAttribute('type')?.toLowerCase()==='module')throw Error('导出前请将 JavaScript 模块打包为一个普通脚本');
   for(const attr of ['src','poster','background','srcset','imagesrcset'])if(node.hasAttribute(attr))node.setAttribute(attr,attr.endsWith('srcset')?srcsetUrls(node.getAttribute(attr)!,url=>this.reference(url,path,depth,inline)):this.reference(node.getAttribute(attr)!,path,depth,inline));
   if(tag==='link'&&node.hasAttribute('href')){
    const rel=(node.getAttribute('rel')||'').toLowerCase().split(/\s+/);
    if(rel.some(x=>['stylesheet','icon','apple-touch-icon','mask-icon','preload','modulepreload','manifest'].includes(x))){node.setAttribute('href',this.reference(node.getAttribute('href')!,path,depth,inline));node.removeAttribute('integrity');}
    else if(rel.some(x=>['preconnect','dns-prefetch','prefetch'].includes(x)))node.remove();
   }
   if(tag==='use'&&['href','xlink:href'].some(attr=>node.hasAttribute(attr)&&!node.getAttribute(attr)!.trim().startsWith('#')))throw Error('导出前请将外部 SVG 图标内嵌到 HTML 中');
   if(['image','use','feimage'].includes(tag)||tag==='script'&&(svg||node.namespaceURI==='http://www.w3.org/2000/svg'))for(const attr of ['href','xlink:href'])if(node.hasAttribute(attr))node.setAttribute(attr,this.reference(node.getAttribute(attr)!,path,depth,inline));
   if(['fill','stroke','filter','clip-path','mask','cursor'].some(a=>node.hasAttribute(a)))for(const attr of ['fill','stroke','filter','clip-path','mask','cursor'])if(node.hasAttribute(attr))node.setAttribute(attr,cssUrls(node.getAttribute(attr)!,url=>this.reference(url,path,depth,inline)));
   if(tag==='script')node.removeAttribute('integrity');
  }
  if(inline&&!svg){
   for(const meta of document.querySelectorAll('meta[http-equiv]'))if(['content-security-policy','refresh'].includes((meta.getAttribute('http-equiv')||'').toLowerCase()))meta.remove();
   const policy=document.createElement('meta');policy.setAttribute('http-equiv','Content-Security-Policy');policy.setAttribute('content',"default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline' data:; script-src 'unsafe-inline' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; media-src data:");document.head.prepend(policy);
  }
  return document.toString();
 }
 private asset(path:string,depth:number,inline=this.inline):Buffer{
  const output=inline?this.embedded:this.files,cached=output.get(this.name(path));if(cached)return cached;
  if(this.pending.has(path))throw Error('资源存在循环引用：'+this.name(path));this.pending.add(path);
  try{
   let bytes=path===this.entry&&this.input.html!==undefined?Buffer.from(this.input.html):this.read(path);if(bytes.length>MAX_FILE)throw Error('HTML 超过导出大小限制');
   const ext=extname(path).toLowerCase();if(ext==='.css')bytes=Buffer.from(this.css(bytes.toString('utf8'),path,depth,inline));else if(['.html','.htm','.svg'].includes(ext))bytes=Buffer.from(this.html(bytes.toString('utf8'),path,depth,ext==='.svg',inline));
   if(bytes.length>200*1024*1024)throw Error('内嵌 HTML 超过 200 MB');output.set(this.name(path),bytes);return bytes;
  }finally{this.pending.delete(path);}
 }
 document(){return this.asset(this.entry,0).toString('utf8');}
 licenses(){
  const manifest=resolve(this.root,'assets/fonts/fonts.json');if(!existsSync(manifest))return;
  let data:any;try{data=JSON.parse(this.read(manifest,true).toString('utf8'));}catch{throw Error('字体授权记录不可读，请重新添加项目字体');}
  if(data.version!==1||!Array.isArray(data.fonts))throw Error('字体授权记录格式无效');
  for(const [path,bytes]of this.raw)if(fontFile.test(path)&&!this.files.has(this.name(path)))this.files.set(this.name(path),bytes);
  const used=new Set([...this.files.keys()].filter(path=>fontFile.test(path)));
  const fonts=data.fonts.filter((font:any)=>Array.isArray(font.files)&&font.files.some((file:any)=>used.has(file.path))).map((font:any)=>{
   const files=font.files.filter((file:any)=>used.has(file.path));
   if(typeof font.license?.path==='string'){
    const license=font.license.path;
    if(!/^assets\/fonts\/[a-zA-Z0-9_-]+\/LICENSE\.txt$/.test(license)||!files.some((file:any)=>posix.dirname(file.path)===posix.dirname(license)))throw Error('字体授权文件必须位于对应字体目录');
    const path=this.check(resolve(this.root,license),true);this.files.set(this.name(path),this.read(path,true));
   }
   const {id,family,source,version,weights,styles,subsets,cssPath,license,addedAt}=font;
   return {id,family,source,version,weights,styles,subsets,files,cssPath,license,addedAt};
  });
  const css=this.files.get('assets/fonts/fonts.css');
  if(fonts.length)this.files.set('assets/fonts/fonts.json',Buffer.from(JSON.stringify({version:1,fonts,cssSha256:css?createHash('sha256').update(css).digest('hex'):''},null,2)+'\n'));
 }
 bundle(){
  this.document();this.licenses();const files:Record<string,Uint8Array>={};for(const [path,bytes]of this.files)files[path]=bytes;
  const resources=[...this.files].map(([path,bytes])=>({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
  files['aelion-export.json']=strToU8(JSON.stringify({version:1,entry:this.name(this.entry),resources,notes:['此压缩包包含 HTML/CSS 静态引用的本地资源。JavaScript 运行时请求的资源需要单独提供。']},null,2)+'\n');
  if(this.name(this.entry)!=='index.html'&&!files['index.html'])files['index.html']=strToU8('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url='+this.name(this.entry).split('/').map(encodeURIComponent).join('/')+'"><title>'+basename(this.entry).replace(/[<>&"]/g,'')+'</title>');
  return Buffer.from(zipSync(files,{level:6}));
 }
}
/** Resolve local assets before printing from a data URL. Network/file URLs fail explicitly. */
export async function prepareDesignHtml(input:DesignHtmlExportInput){return new HtmlResources(input,true).document();}
/** Package only statically referenced resources, plus the matching project font licenses. */
export async function exportDesignHtmlBundle(input:DesignHtmlExportInput){return new HtmlResources(input,false).bundle();}
export {DESIGN_PDF_READY_SCRIPT} from './design-pdf';
