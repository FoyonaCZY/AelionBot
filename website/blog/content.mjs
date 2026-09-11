import {readFileSync,readdirSync} from 'node:fs';
import {basename,join} from 'node:path';
import {parse as parseYaml} from 'yaml';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

export const escapeHtml=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));

function requiredText(value,field,file,max){
  if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new Error(`${file}: ${field} 需要填写 1–${max} 个字符。`);
  return value.trim();
}

export function parsePost(source,file,{includeDrafts=false}={}){
  const match=source.replace(/^\uFEFF/,'').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if(!match)throw new Error(`${file}: 请使用 --- 包围文章信息。`);
  const meta=parseYaml(match[1],{maxAliasCount:30});
  if(!meta||typeof meta!=='object'||Array.isArray(meta))throw new Error(`${file}: 文章信息必须是一个对象。`);
  if(meta.draft!==undefined&&typeof meta.draft!=='boolean')throw new Error(`${file}: draft 只能是 true 或 false，不能加引号。`);
  // Missing an explicit publication choice keeps unfinished writing out of the built site.
  const draft=meta.draft!==false;
  if(draft&&!includeDrafts)return null;
  const title=requiredText(meta.title,'title',file,120);
  const description=requiredText(meta.description,'description',file,260);
  const slug=meta.slug??basename(file,'.md');
  if(typeof slug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||slug.length>100)throw new Error(`${file}: slug 只能使用小写英文字母、数字和短横线。`);
  const date=meta.date;
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error(`${file}: date 需要使用 YYYY-MM-DD。`);
  const instant=new Date(`${date}T00:00:00Z`);
  if(!Number.isFinite(instant.getTime())||instant.toISOString().slice(0,10)!==date)throw new Error(`${file}: date 不是有效日期。`);
  const author=meta.author===undefined?'FoyonaCZY':requiredText(meta.author,'author',file,80);
  if(meta.tags!==undefined&&(!Array.isArray(meta.tags)||meta.tags.length>12||meta.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.trim().length>30)))throw new Error(`${file}: tags 需要是最多 12 个简短标签。`);
  const body=match[2].trim();
  if(!body)throw new Error(`${file}: 公开文章需要填写正文。`);
  const text=body.replace(/```[\s\S]*?```/g,'').replace(/!\[[^\]]*\]\([^)]*\)/g,'');
  const cjk=(text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)||[]).length;
  const words=(text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,' ').match(/[\p{L}\p{N}]+/gu)||[]).length;
  return {title,description,slug,date,author,draft,tags:[...new Set((meta.tags||[]).map(tag=>tag.trim()))],body,readingMinutes:Math.max(1,Math.ceil(cjk/400+words/200)),url:`/blog/${slug}/`};
}

export function loadPosts(directory,options={}){
  const posts=readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.md')).map(entry=>parsePost(readFileSync(join(directory,entry.name),'utf8'),entry.name,options)).filter(Boolean);
  const seen=new Set();
  for(const post of posts){if(seen.has(post.slug))throw new Error(`博客 slug 重复：${post.slug}`);seen.add(post.slug);}
  return posts.sort((a,b)=>b.date.localeCompare(a.date)||a.slug.localeCompare(b.slug));
}

export function renderMarkdown(body){
  const toc=[],seen=new Map(),usedIds=new Set();
  const md=new MarkdownIt({html:false,linkify:true,typographer:false});
  md.renderer.rules.fence=(tokens,index)=>{
    const token=tokens[index],language=token.info.trim().split(/\s+/)[0].toLowerCase();
    const highlighted=language&&hljs.getLanguage(language)?hljs.highlight(token.content,{language,ignoreIllegals:true}).value:escapeHtml(token.content);
    return `<div class="code-block"><div class="code-bar"><span>${escapeHtml(language||'code')}</span><button type="button" data-copy-code aria-label="复制代码">复制代码</button></div><pre><code class="hljs${language?` language-${escapeHtml(language)}`:''}">${highlighted}</code></pre></div>\n`;
  };
  const previousHeading=md.renderer.rules.heading_open;
  md.renderer.rules.heading_open=(tokens,index,options,env,self)=>{
    const token=tokens[index],inline=tokens[index+1];
    const title=(inline?.children||[]).filter(child=>['text','code_inline','image'].includes(child.type)).map(child=>child.content).join('')||inline?.content||'章节';
    const base=title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s+/g,'-')||'section';
    let occurrence=(seen.get(base)||0)+1;
    let id=occurrence===1?base:`${base}-${occurrence}`;
    while(usedIds.has(id)){occurrence++;id=`${base}-${occurrence}`;}
    seen.set(base,occurrence);usedIds.add(id);
    token.attrSet('id',id);
    if(token.tag==='h2'||token.tag==='h3')toc.push({id,title,level:Number(token.tag.slice(1))});
    return previousHeading?previousHeading(tokens,index,options,env,self):self.renderToken(tokens,index,options);
  };
  const previousImage=md.renderer.rules.image;
  md.renderer.rules.image=(tokens,index,options,env,self)=>{
    tokens[index].attrSet('loading','lazy');tokens[index].attrSet('decoding','async');
    return previousImage?previousImage(tokens,index,options,env,self):self.renderToken(tokens,index,options);
  };
  return {html:md.render(body),toc};
}

export function formatDate(date){return new Date(`${date}T00:00:00Z`).toLocaleDateString('en',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'});}
