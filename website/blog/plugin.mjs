import {readFileSync} from 'node:fs';
import {isAbsolute,join,relative} from 'node:path';
import {loadPosts} from './content.mjs';
import {renderBlogDocument} from './render.mjs';

/** @param {string} root @returns {import('vite').Plugin} */
export function blogPages(root){
  return {name:'aelion-markdown-blog',apply:'serve',configureServer(server){
    const contentRoot=join(root,'content/posts');
    const reload=file=>{const path=relative(contentRoot,file);if(!isAbsolute(path)&&!path.startsWith('..')&&path.endsWith('.md'))server.ws.send({type:'full-reload',path:'*'});};
    server.watcher.add(contentRoot);
    for(const event of ['add','change','unlink'])server.watcher.on(event,reload);
    server.httpServer?.once('close',()=>{for(const event of ['add','change','unlink'])server.watcher.off(event,reload);});
    server.middlewares.use(async(req,res,next)=>{
      if(!req.url)return next();
      const url=new URL(req.url,'http://localhost');
      if(!/^\/blog(?:\/|$)/.test(url.pathname)&&url.pathname!=='/blog.html')return next();
      try{
        const previewMatch=url.pathname.match(/^\/blog\/_preview\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
        const posts=loadPosts(contentRoot),site=JSON.parse(readFileSync(join(root,'site.json'),'utf8'));
        const slug=previewMatch?.[1]||url.pathname.replace(/^\/blog\/?/,'').replace(/\/$/,'');
        const isIndex=!slug||url.pathname==='/blog.html';
        const post=isIndex?undefined:(previewMatch?loadPosts(contentRoot,{includeDrafts:true}):posts).find(item=>item.slug===slug);
        if((isIndex||post)&&!url.pathname.endsWith('/')){res.statusCode=301;res.setHeader('Location',`${isIndex?'/blog/':previewMatch?`/blog/_preview/${post.slug}/`:post.url}${url.search}`);return res.end();}
        const template=readFileSync(join(root,'blog.html'),'utf8');
        const logo=`/@fs/${join(root,'../docs/assets/logo-light.svg').replaceAll('\\','/')}`;
        const html=renderBlogDocument({template,site,logo,posts,post,notFound:!isIndex&&!post,preview:Boolean(previewMatch&&post)});
        res.statusCode=isIndex||post?200:404;
        res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-cache');
        res.end(await server.transformIndexHtml('/blog.html',html,url.pathname));
      }catch(error){server.ssrFixStacktrace(error);next(error);}
    });
  }};
}
