import {build} from 'vite';
import {readFileSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPosts} from '../blog/content.mjs';
import {writeBlogPages} from '../blog/publish.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const posts=loadPosts(join(root,'content/posts'));
const site=JSON.parse(readFileSync(join(root,'site.json'),'utf8'));
function validateMedia(directory){for(const item of readdirSync(directory,{withFileTypes:true})){const file=join(directory,item.name);if(item.isDirectory())validateMedia(file);else if(!item.isFile()||(!['.png','.jpg','.jpeg','.webp','.gif','.svg'].includes(extname(item.name).toLowerCase())&&item.name!=='README.md'))throw new Error(`博客图片目录包含非图片文件：${item.name}`);}}
validateMedia(join(root,'public/blog-media'));
await build({configFile:join(root,'vite.config.ts')});
const output=join(root,'dist'),template=readFileSync(join(output,'blog.html'),'utf8');
const manifest=JSON.parse(readFileSync(join(output,'.vite/manifest.json'),'utf8'));
const logo=Object.values(manifest).find(item=>item.src?.endsWith('docs/assets/logo-light.svg')||item.name==='logo-light.svg');
if(!logo?.file)throw new Error('博客构建未找到官网 Logo。');
const count=writeBlogPages({output,template,site,logo:`/${logo.file}`,posts});
unlinkSync(join(output,'blog.html'));unlinkSync(join(output,'.vite/manifest.json'));rmdirSync(join(output,'.vite'));
unlinkSync(join(output,'blog-media/README.md'));
console.log(`Generated /blog/ and ${count} published article page(s). Drafts are excluded.`);
