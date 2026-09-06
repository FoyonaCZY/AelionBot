import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {escapeHtml} from './content.mjs';
import {renderBlogDocument} from './render.mjs';

export function writeBlogPages({output,template,site,logo,posts}){
  const published=posts.filter(post=>post.draft===false);
  const render=options=>renderBlogDocument({template,site,logo,posts:published,...options});
  const blogRoot=resolve(output,'blog');
  mkdirSync(blogRoot,{recursive:true});
  writeFileSync(join(blogRoot,'index.html'),render({}));
  for(const post of published){
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug))throw new Error('Invalid post path.');
    const directory=resolve(blogRoot,post.slug);
    if(!directory.startsWith(blogRoot+sep))throw new Error('Article output must stay inside the blog directory.');
    mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'index.html'),render({post}));
  }
  writeFileSync(join(output,'404.html'),render({notFound:true}));
  const urls=[{path:'/'},{path:'/blog/'},...published.map(post=>({path:post.url,date:post.date}))];
  writeFileSync(join(output,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(item=>`<url><loc>${escapeHtml(site.origin+item.path)}</loc>${item.date?`<lastmod>${item.date}</lastmod>`:''}</url>`).join('')}</urlset>\n`);
  writeFileSync(join(output,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${site.origin}/sitemap.xml\n`);
  return published.length;
}
