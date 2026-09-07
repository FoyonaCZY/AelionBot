import {escapeHtml,formatDate,renderMarkdown} from './content.mjs';

export function icon(name,size=18){
  const shapes={arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',windows:'<path d="m3 5 8-1v7H3zm10-1 8-1v8h-8zM3 13h8v7l-8-1zm10 0h8v8l-8-1z" fill="currentColor" stroke="none"/>'};
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]||shapes.file}</svg>`;
}

function header(site,logo){
  return `<header class="site-header"><div class="nav-shell"><a href="/" class="brand-link" aria-label="AelionBot 首页"><img src="${escapeHtml(logo)}" width="158" height="45" alt="AelionBot"></a><nav id="main-navigation" class="main-nav" aria-label="主导航">${site.navigation.map(link=>`<a href="${escapeHtml(link.href)}"${link.href==='/blog/'?' aria-current="page"':''}${link.external?' target="_blank" rel="noopener noreferrer"':''}>${escapeHtml(link.label)}${link.external?icon('arrow',14):''}</a>`).join('')}</nav><a class="button button-primary nav-download" href="${escapeHtml(site.repository)}/releases/latest" target="_blank" rel="noopener noreferrer">${icon('windows',15)}下载应用${icon('arrow',15)}</a><button class="mobile-menu-button" aria-label="打开导航" aria-controls="main-navigation" aria-expanded="false">${icon('menu',20)}</button></div></header>`;
}

function footer(site,logo){
  return `<footer class="site-footer"><div class="section-shell footer-inner"><a href="/" aria-label="AelionBot 首页"><img src="${escapeHtml(logo)}" width="144" height="41" alt="AelionBot"></a><p>有想法，就一起动手。</p><nav aria-label="页脚导航"><a href="/blog/">博客</a><a href="${escapeHtml(site.repository)}" target="_blank" rel="noopener noreferrer">GitHub</a><a href="${escapeHtml(site.repository)}/releases" target="_blank" rel="noopener noreferrer">版本更新</a><a href="${escapeHtml(site.repository)}/issues" target="_blank" rel="noopener noreferrer">反馈建议</a></nav><span>© ${new Date().getFullYear()} AelionBot</span></div></footer>`;
}

function tags(post){return post.tags.map(tag=>`<span class="post-tag">${escapeHtml(tag)}</span>`).join('');}
function date(post){return `<time datetime="${post.date}">${formatDate(post.date)}</time>`;}

function indexContent(posts){
  return `<main id="main" class="blog-main"><section class="blog-heading"><a class="blog-home-link" href="/">AelionBot ${icon('arrow',14)}</a><div class="blog-eyebrow"><span>THE AELIONBOT JOURNAL</span><span>想法 / 实践 / 记录</span></div><h1>写下新想法。<br><em>也分享新发现。</em></h1><p>AelionBot 的新想法、产品更新与幕后故事。</p></section><section class="post-index" aria-labelledby="post-index-title"><div class="post-index-heading"><h2 id="post-index-title">最新文章</h2><span>${posts.length} 篇记录</span></div>${posts.length?`<ol class="post-list">${posts.map(post=>`<li><article class="post-card"><div class="post-card-meta">${date(post)}<span>${post.readingMinutes} 分钟阅读</span></div><div class="post-card-copy"><div class="post-tags">${tags(post)}</div><h2><a href="${post.url}">${escapeHtml(post.title)}</a></h2><p>${escapeHtml(post.description)}</p><span class="post-card-author">${escapeHtml(post.author)}</span></div><a class="post-card-arrow" href="${post.url}" aria-label="阅读：${escapeHtml(post.title)}">${icon('arrow',21)}</a></article></li>`).join('')}</ol>`:`<div class="blog-empty"><span class="blog-empty-symbol" aria-hidden="true">${icon('file',31)}</span><span class="empty-overline">A NEW PAGE</span><h3>还没有公开的文章。</h3><p>新的文章会在这里和你见面。</p><a class="text-link" href="/">先认识一下 AelionBot${icon('arrow',16)}</a></div>`}</section></main>`;
}

function articleContent(post,posts){
  const {html,toc}=renderMarkdown(post.body);
  const related=posts.filter(item=>item.slug!==post.slug).slice(0,2);
  return `<main id="main" class="article-main"><div class="article-top"><a class="article-back" href="/blog/">${icon('arrow',16)}全部文章</a><header class="article-header"><div class="post-tags">${tags(post)}</div><h1>${escapeHtml(post.title)}</h1><p class="article-description">${escapeHtml(post.description)}</p><div class="article-meta"><span class="author-dot" aria-hidden="true"></span><span>${escapeHtml(post.author)}</span><span class="meta-separator">/</span>${date(post)}<span class="article-reading">${icon('clock',14)}约 ${post.readingMinutes} 分钟</span></div></header></div><div class="article-layout${toc.length?'':' without-toc'}"><article class="article-body" aria-label="文章正文">${html}</article>${toc.length?`<aside class="article-toc"><details open><summary>本文目录<span>↓</span></summary><nav aria-label="本文目录">${toc.map(item=>`<a href="#${encodeURIComponent(item.id)}" class="toc-level-${item.level}">${escapeHtml(item.title)}</a>`).join('')}</nav></details></aside>`:''}</div><div class="article-bottom"><span>记录于 ${formatDate(post.date)}</span><a class="text-link" href="/blog/">返回博客${icon('arrow',16)}</a></div>${related.length?`<section class="related-posts"><h2>继续阅读</h2><div>${related.map(item=>`<a href="${item.url}"><span>${date(item)}</span><h3>${escapeHtml(item.title)}</h3>${icon('arrow',18)}</a>`).join('')}</div></section>`:''}</main>`;
}

function notFoundContent(){return `<main id="main" class="blog-main blog-not-found"><span class="blog-eyebrow">404 / PAGE NOT FOUND</span><h1>没有找到<br><em>这个页面。</em></h1><p>链接可能有误，或内容还未公开。</p><a class="button button-primary" href="/blog/">返回博客${icon('arrow',18)}</a></main>`;}

export function renderBlogDocument({template,site,logo,posts,post,notFound=false,preview=false}){
  posts=posts.filter(item=>item.draft===false);
  if(post&&post.draft!==false&&!preview){post=undefined;notFound=true;}
  const title=notFound?'未找到页面 — AelionBot':post?`${post.title} — AelionBot 博客`:'博客 — AelionBot';
  const description=post?.description||'AelionBot 的新想法、产品更新与幕后故事。';
  const path=notFound?'/404.html':post?.url||'/blog/';
  const main=notFound?notFoundContent():post?articleContent(post,posts):indexContent(posts);
  const body=`<div class="site-app blog-site"><div class="reading-progress" aria-hidden="true"></div><a class="skip-link" href="#main">跳至主要内容</a>${header(site,logo)}${preview?'<div class="draft-notice" role="status"><strong>本地草稿预览</strong><span>只有明确设置 draft: false 的文章才会发布。</span></div>':''}${main}${footer(site,logo)}<span class="copy-status" role="status" aria-live="polite"></span></div>`;
  const values={__BLOG_TITLE__:preview?`草稿预览 · ${title}`:title,__BLOG_DESCRIPTION__:description,__BLOG_CANONICAL__:`${site.origin}${path}`,__BLOG_ROBOTS__:notFound||preview?'noindex, follow':'index, follow',__BLOG_TYPE__:post?'article':'website'};
  let output=template;
  for(const [key,value] of Object.entries(values))output=output.replaceAll(key,escapeHtml(value));
  return output.replace('__BLOG_CONTENT__',body);
}
