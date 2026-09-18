import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {parseHTML,DOMParser} from 'linkedom';
import {boundedInteger,textPage,FileToolError} from './file-text';
import {abortable} from './abortable';

const LIMIT=2*1024*1024;
const BOT_UA='AelionBot/0.15 (+https://aelion.chat)';
const SEARCH_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEARCH_CACHE_MS=5*60*1000;
function requestHeaders(url:URL){
 const search=/(?:^|\.)(?:bing\.com|duckduckgo\.com|brave\.com)$/.test(url.hostname);
 return {'User-Agent':search?SEARCH_UA:BOT_UA,Accept:'text/html,application/xhtml+xml,application/rss+xml,application/xml,text/plain,application/json','Accept-Language':'en-US,en;q=0.8,zh-CN;q=0.6','Accept-Encoding':'identity'};
}
type SearchHit={title:string;url:string;snippet:string};
function cleanHit(title:string,url:string,snippet:string):SearchHit|undefined{
 try{return {title:title.replace(/\s+/g,' ').trim().slice(0,300),url:publicWebUrl(url).href,snippet:snippet.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,1000)};}catch{return;}
}
function uniqueHits(results:SearchHit[],limit:number){
 return [...new Map(results.filter(item=>item.url&&item.title).map(item=>[item.url,item])).values()].slice(0,limit);
}
export function publicWebUrl(value:unknown){
 if(typeof value!=='string'||value.length>4000)throw new FileToolError('INVALID_URL','请输入有效的网页 URL');
 let url:URL;try{url=new URL(value);}catch{throw new FileToolError('INVALID_URL','请输入包含 https:// 的完整 URL');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new FileToolError('INVALID_URL','网页工具仅访问无嵌入凭据的 HTTP/HTTPS 地址');
 const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'');
 if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||isIP(host)&&!publicAddress(host))throw new FileToolError('PRIVATE_NETWORK','网页工具不访问本机、内网或云元数据地址');
 url.hash='';return url;
}
export function publicAddress(address:string){
 if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19)||a>=224);}
 if(isIP(address)===6){const value=address.toLowerCase();return /^[23][0-9a-f]{3}:/.test(value)&&! /^(?:2001:0{0,4}:|2001:0?db8:|2002:)/.test(value);}
 return false;
}
export interface WebDocument {url:string;body:string;contentType:string;}
export type WebLoader=(url:string,signal:AbortSignal)=>Promise<WebDocument>;
export async function loadPublicPage(value:string,signal:AbortSignal):Promise<WebDocument>{
 let url=publicWebUrl(value);
 const combined=AbortSignal.any([signal,AbortSignal.timeout(20000)]);
 for(let redirects=0;redirects<=5;redirects++){
  combined.throwIfAborted();const addresses=await abortable(combined,()=>lookup(url.hostname.replace(/^\[|\]$/g,''),{all:true}));combined.throwIfAborted();
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new FileToolError('PRIVATE_NETWORK','目标解析到本机或内网地址，已停止请求');
  const selected=addresses[0];
  const response=await new Promise<{status:number;headers:Record<string,any>;bytes:Buffer}>((resolve,reject)=>{
   const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{signal:combined,family:selected.family,headers:requestHeaders(url),lookup:((_host:any,_options:any,done:any)=>done(null,selected.address,selected.family)) as any},res=>{
    const chunks:Buffer[]=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>LIMIT){req.destroy(new FileToolError('WEB_TOO_LARGE','网页超过 2 MB，请缩小读取范围'));return;}chunks.push(chunk);});res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode||0,headers:res.headers,bytes:Buffer.concat(chunks)}));
   });req.on('error',reject);req.end();
  });
  if([301,302,303,307,308].includes(response.status)&&response.headers.location){url=publicWebUrl(new URL(response.headers.location,url).href);continue;}
  if(response.status<200||response.status>=300)throw new FileToolError('WEB_HTTP_ERROR',`网页返回 HTTP ${response.status}`);
  let bytes=response.bytes;const encoding=response.headers['content-encoding'];if(encoding==='gzip')bytes=gunzipSync(bytes,{maxOutputLength:LIMIT});else if(encoding==='deflate')bytes=inflateSync(bytes,{maxOutputLength:LIMIT});else if(encoding==='br')bytes=brotliDecompressSync(bytes,{maxOutputLength:LIMIT});
  const contentType=String(response.headers['content-type']||'text/html');if(!/text\/|json|xml/.test(contentType))throw new FileToolError('WEB_UNSUPPORTED_CONTENT','该地址不是文本网页，请通过附件或下载工具处理');
  const charset=/charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]||'utf-8';let body:string;try{body=new TextDecoder(charset).decode(bytes);}catch{body=bytes.toString('utf8');}
  return {url:url.href,body,contentType};
 }
 throw new FileToolError('WEB_REDIRECT_LIMIT','网页重定向次数过多');
}
export function extractWebPage(document:WebDocument){
 if(!/html/i.test(document.contentType))return {title:document.url,text:document.body,links:[] as Array<{text:string;url:string}>};
 const {document:dom}=parseHTML(document.body),title=dom.querySelector('title')?.textContent?.trim()||document.url;
 for(const node of dom.querySelectorAll('script,style,noscript,svg,iframe,object,template'))node.remove();
 const links=[...dom.querySelectorAll('a[href]')].flatMap(node=>{try{const url=publicWebUrl(new URL(node.getAttribute('href')!,document.url).href);return [{text:(node.textContent||'').replace(/\s+/g,' ').trim().slice(0,200),url:url.href}];}catch{return [];}}).slice(0,100);
 const main=dom.querySelector('article')||dom.querySelector('main')||dom.body;
 for(const node of main.querySelectorAll('p,div,section,article,li,h1,h2,h3,h4,pre,br,tr'))node.appendChild(dom.createTextNode('\n'));
 const text=(main.textContent||'').replace(/[^\S\n]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
 return {title,text,links};
}
const SEARCH_ENGINES=[
 {name:'bing',url:(q:string)=>`https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}`,parse:(page:WebDocument)=>parseBingRss(page.body)},
 {name:'bing',url:(q:string)=>`https://www.bing.com/search?q=${encodeURIComponent(q)}`,parse:(page:WebDocument)=>parseBingHtml(page)},
 {name:'duckduckgo',url:(q:string)=>`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,parse:(page:WebDocument)=>parseDuckDuckGoHtml(page)},
 {name:'duckduckgo',url:(q:string)=>`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,parse:(page:WebDocument)=>parseDuckDuckGoLite(page)},
 {name:'brave',url:(q:string)=>`https://search.brave.com/search?q=${encodeURIComponent(q)}`,parse:(page:WebDocument)=>parseBraveHtml(page)},
] as const;
function parseBingRss(body:string){
 const doc=new DOMParser().parseFromString(body,'text/xml');
 return [...doc.querySelectorAll('item')].flatMap(item=>{const hit=cleanHit(item.querySelector('title')?.textContent||'',item.querySelector('link')?.textContent||'',item.querySelector('description')?.textContent||'');return hit?[hit]:[];});
}
function parseBingHtml(page:WebDocument){
 const {document}=parseHTML(page.body);
 return [...document.querySelectorAll('li.b_algo')].flatMap(item=>{
  const link=item.querySelector('h2 a, .b_title a, a[href]');
  const hit=cleanHit(link?.textContent||'',link?.getAttribute('href')||'',item.querySelector('.b_caption p, .b_lineclamp, p')?.textContent||'');
  return hit?[hit]:[];
 });
}
function parseDuckDuckGoHtml(page:WebDocument){
 const {document}=parseHTML(page.body);
 return [...document.querySelectorAll('.result')].flatMap(item=>{
  const link=item.querySelector('a.result__a');if(!link)return [];
  try{const target=new URL(link.getAttribute('href')!,page.url);const hit=cleanHit(link.textContent||'',target.searchParams.get('uddg')||target.href,item.querySelector('.result__snippet')?.textContent||'');return hit?[hit]:[];}catch{return [];}
 });
}
function parseDuckDuckGoLite(page:WebDocument){
 const {document}=parseHTML(page.body);
 return [...document.querySelectorAll('a.result-link')].flatMap((link,index)=>{
  const hit=cleanHit(link.textContent||'',link.getAttribute('href')||'',document.querySelectorAll('.result-snippet')[index]?.textContent||'');
  return hit?[hit]:[];
 });
}
function parseBraveHtml(page:WebDocument){
 const {document}=parseHTML(page.body);
 return [...document.querySelectorAll('[data-type="web"], .snippet')].flatMap(item=>{
  const link=item.querySelector('a[href^="http"]');if(!link)return [];
  const hit=cleanHit(link.textContent||'',link.getAttribute('href')||'',item.querySelector('.snippet-description, .snippet-content, p')?.textContent||'');
  return hit?[hit]:[];
 });
}
export class WebTools {
 private pages=new Map<string,{botId:string;url:string;title:string;text:string;links:Array<{text:string;url:string}>;time:number}>();
 private searches=new Map<string,{time:number;value:{query:string;engine:string;untrusted:true;results:SearchHit[]}}>();
 constructor(private load:WebLoader=loadPublicPage){}
 async read(botId:string,args:Record<string,unknown>,signal:AbortSignal){
  const maxChars=boundedInteger(args.maxChars,12000,100,32000,'maxChars'),offset=boundedInteger(args.offset,0,0,Number.MAX_SAFE_INTEGER,'offset');
  let page:ReturnType<WebTools['get']>,id:string;
  if(typeof args.id==='string'){id=args.id;page=this.get(botId,id);}else{
   const url=publicWebUrl(args.url).href,doc=await this.load(url,signal);signal.throwIfAborted();const parsed=extractWebPage(doc);id=createHash('sha256').update(botId+'\0'+doc.url+'\0'+doc.body).digest('hex').slice(0,32);page={botId,url:doc.url,...parsed,time:Date.now()};this.pages.delete(id);this.pages.set(id,page);while(this.pages.size>32)this.pages.delete(this.pages.keys().next().value!);
  }
  return {id,url:page.url,title:page.title,source:'web',untrusted:true,...textPage(page.text,{offset,maxChars}),links:page.links};
 }
 private get(botId:string,id:string){const page=this.pages.get(id);if(!page||page.botId!==botId||Date.now()-page.time>30*60000)throw new FileToolError('WEB_PAGE_EXPIRED','网页结果不存在或已过期，请重新打开 URL');return page;}
 async search(botId:string,args:Record<string,unknown>,signal:AbortSignal){
  if(typeof args.query!=='string'||!args.query.trim()||args.query.length>1000)throw new FileToolError('INVALID_ARGUMENT','搜索词需要 1–1000 字符');
  const query=args.query.trim(),limit=boundedInteger(args.limit,5,1,10,'limit'),cacheKey=`${botId}\0${query.toLowerCase()}\0${limit}`;
  const cached=this.searches.get(cacheKey);if(cached&&Date.now()-cached.time<SEARCH_CACHE_MS)return cached.value;
  let lastError:unknown;
  for(const engine of SEARCH_ENGINES){
   signal.throwIfAborted();try{
    const page=await this.load(engine.url(query),signal);signal.throwIfAborted();
    const results=uniqueHits(engine.parse(page),limit);
    if(!results.length)throw new Error('搜索服务未返回可读取的结果，可能被限流或需要浏览器验证');
    const value={query,engine:engine.name,untrusted:true as const,results};this.searches.delete(cacheKey);this.searches.set(cacheKey, {time:Date.now(),value});while(this.searches.size>32)this.searches.delete(this.searches.keys().next().value!);
    return value;
   }catch(error){signal.throwIfAborted();lastError=error;}
  }
  throw new FileToolError('WEB_SEARCH_UNAVAILABLE',`网页搜索暂不可用：${lastError instanceof Error?lastError.message:'网络错误'}。可稍后重试，或使用已配置的搜索 MCP/浏览器。`);
 }
 clearBot(botId:string){for(const [id,page] of this.pages)if(page.botId===botId)this.pages.delete(id);for(const key of this.searches.keys())if(key.startsWith(botId+'\0'))this.searches.delete(key);}
}
