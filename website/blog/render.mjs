import {escapeHtml,formatDate,renderMarkdown} from './content.mjs';
import {blogText} from '../src/blog/labels.mjs';
const label=(key,n='')=>`<span data-blog-label="${key}" data-count="${n}">${escapeHtml(blogText(key,'en',n))}</span>`;
const languageSelect='<select class="site-language-switcher" aria-label="Language"><option value="en">English</option><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option></select>';

export function icon(name,size=18){
  const shapes={arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',windows:'<path d="m3 5 8-1v7H3zm10-1 8-1v8h-8zM3 13h8v7l-8-1zm10 0h8v8l-8-1z" fill="currentColor" stroke="none"/>'};
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]||shapes.file}</svg>`;
}

function header(site,logo){
  return `<header class="site-header"><div class="nav-shell"><a href="/" class="brand-link" aria-label="AelionBot"><img src="${escapeHtml(logo)}" width="158" height="45" alt="AelionBot"></a><nav id="main-navigation" class="main-nav" aria-label="Navigation">${site.navigation.map(link=>`<a href="${escapeHtml(link.href)}"${link.href==='/blog/'?' aria-current="page"':''}${link.external?' target="_blank" rel="noopener noreferrer"':''}>${link.href==='/blog/'?label('blog'):escapeHtml(link.label)}${link.external?icon('arrow',14):''}</a>`).join('')}</nav><a class="button button-primary nav-download" href="${escapeHtml(site.repository)}/releases/latest" target="_blank" rel="noopener noreferrer">${icon('windows',15)}${label('download')}${icon('arrow',15)}</a>${languageSelect}<button class="mobile-menu-button" aria-label="Open navigation" aria-controls="main-navigation" aria-expanded="false">${icon('menu',20)}</button></div></header>`;
}

function footer(site,logo){
  return `<footer class="site-footer"><div class="section-shell footer-inner"><a href="/" aria-label="AelionBot"><img src="${escapeHtml(logo)}" width="144" height="41" alt="AelionBot"></a><p>${label('tagline')}</p><nav aria-label="Footer"><a href="/blog/">${label('blog')}</a><a href="${escapeHtml(site.repository)}" target="_blank" rel="noopener noreferrer">GitHub</a><a href="${escapeHtml(site.repository)}/releases" target="_blank" rel="noopener noreferrer">${label('releases')}</a><a href="${escapeHtml(site.repository)}/issues" target="_blank" rel="noopener noreferrer">${label('feedback')}</a></nav><span>© ${new Date().getFullYear()} AelionBot</span></div></footer>`;
}

function tags(post){return post.tags.map(tag=>`<span class="post-tag">${escapeHtml(tag)}</span>`).join('');}
function date(post){return `<time datetime="${post.date}">${formatDate(post.date)}</time>`;}

function indexContent(posts){
  return `<main id="main" class="blog-main"><section class="blog-heading"><a class="blog-home-link" href="/">AelionBot ${icon('arrow',14)}</a><div class="blog-eyebrow"><span>THE AELIONBOT JOURNAL</span><span>${label('topics')}</span></div><h1>${label('heading')}<br><em>${label('headingEnd')}</em></h1><p>${label('description')}</p></section><section class="post-index" aria-labelledby="post-index-title"><div class="post-index-heading"><h2 id="post-index-title">${label('latest')}</h2><span>${label('count',posts.length)}</span></div>${posts.length?`<ol class="post-list">${posts.map(post=>`<li><article class="post-card"><div class="post-card-meta">${date(post)}<span>${label('readTime',post.readingMinutes)}</span></div><div class="post-card-copy"><div class="post-tags">${tags(post)}</div><h2><a href="${post.url}">${escapeHtml(post.title)}</a></h2><p>${escapeHtml(post.description)}</p><span class="post-card-author">${escapeHtml(post.author)}</span></div><a class="post-card-arrow" href="${post.url}" aria-label="${escapeHtml(post.title)}">${icon('arrow',21)}</a></article></li>`).join('')}</ol>`:`<div class="blog-empty"><span class="blog-empty-symbol" aria-hidden="true">${icon('file',31)}</span><span class="empty-overline">A NEW PAGE</span><h3>${label('empty')}</h3><p>${label('emptyDescription')}</p><a class="text-link" href="/">${label('meet')}${icon('arrow',16)}</a></div>`}</section></main>`;
}

function articleContent(post,posts){
  const {html,toc}=renderMarkdown(post.body);
  const related=posts.filter(item=>item.slug!==post.slug).slice(0,2);
  return `<main id="main" class="article-main"><div class="article-top"><a class="article-back" href="/blog/">${icon('arrow',16)}${label('all')}</a><header class="article-header"><div class="post-tags">${tags(post)}</div><h1>${escapeHtml(post.title)}</h1><p class="article-description">${escapeHtml(post.description)}</p><div class="article-meta"><span class="author-dot" aria-hidden="true"></span><span>${escapeHtml(post.author)}</span><span class="meta-separator">/</span>${date(post)}<span class="article-reading">${icon('clock',14)}${label('readTime',post.readingMinutes)}</span></div></header></div><div class="article-layout${toc.length?'':' without-toc'}"><article class="article-body" aria-label="Article">${html}</article>${toc.length?`<aside class="article-toc"><details open><summary>${label('contents')}<span>↓</span></summary><nav aria-label="On this page">${toc.map(item=>`<a href="#${encodeURIComponent(item.id)}" class="toc-level-${item.level}">${escapeHtml(item.title)}</a>`).join('')}</nav></details></aside>`:''}</div><div class="article-bottom"><span>${date(post)}</span><a class="text-link" href="/blog/">${label('back')}${icon('arrow',16)}</a></div>${related.length?`<section class="related-posts"><h2>${label('related')}</h2><div>${related.map(item=>`<a href="${item.url}"><span>${date(item)}</span><h3>${escapeHtml(item.title)}</h3>${icon('arrow',18)}</a>`).join('')}</div></section>`:''}</main>`;
}

function notFoundContent(){return `<main id="main" class="blog-main blog-not-found"><span class="blog-eyebrow">404 / PAGE NOT FOUND</span><h1>${label('missing')}</h1><p>${label('missingDescription')}</p><a class="button button-primary" href="/blog/">${label('back')}${icon('arrow',18)}</a></main>`;}

export function renderBlogDocument({template,site,logo,posts,post,notFound=false,preview=false}){
  posts=posts.filter(item=>item.draft===false);
  if(post&&post.draft!==false&&!preview){post=undefined;notFound=true;}
  const title=notFound?'Page not found — AelionBot':post?`${post.title} — AelionBot Blog`:'Blog — AelionBot';
  const description=post?.description||blogText('description');
  const path=notFound?'/404.html':post?.url||'/blog/';
  const main=notFound?notFoundContent():post?articleContent(post,posts):indexContent(posts);
  const body=`<div class="site-app blog-site"><div class="reading-progress" aria-hidden="true"></div><a class="skip-link" href="#main">${label('skip')}</a>${header(site,logo)}${preview?'<div class="draft-notice" role="status"><strong data-blog-label="draft">本地草稿预览</strong><span data-blog-label="draftDescription">只有明确设置 draft: false 的文章才会发布。</span></div>':''}${main}${footer(site,logo)}<span class="copy-status" role="status" aria-live="polite"></span></div>`;
  const values={__BLOG_TITLE__:preview?`草稿预览 · ${title}`:title,__BLOG_DESCRIPTION__:description,__BLOG_CANONICAL__:`${site.origin}${path}`,__BLOG_ROBOTS__:notFound||preview?'noindex, follow':'index, follow',__BLOG_TYPE__:post?'article':'website'};
  let output=template;
  for(const [key,value] of Object.entries(values))output=output.replaceAll(key,escapeHtml(value));
  return output.replace('__BLOG_CONTENT__',body);
}
