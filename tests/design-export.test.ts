import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,basename,resolve,join} from 'node:path';
import {unzipSync} from 'fflate';
import {parseHTML} from 'linkedom';
import {runInNewContext} from 'node:vm';
import {prepareDesignHtml,exportDesignHtmlBundle} from '../electron/core/design-export';
import {mime,webResourceLimit,webResourcePath} from '../electron/core/web-preview-resources';
import {DESIGN_PDF_READY_SCRIPT} from '../electron/core/design-pdf';

function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'aelion-font-export-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-font-export-'));rmSync(root,{recursive:true,force:true});});
 const write=(path:string,bytes:string|Buffer)=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);return target;};
 return {root,write,input:(path='index.html')=>({rootDir:root,htmlPath:join(root,path)})};
}
function fontProject(t:test.TestContext){
 const f=fixture(t);f.write('pages/poster.html','<!doctype html><html><head><link rel="stylesheet" href="../styles/main.css"></head><body><h1>字体测试</h1><img src="../images/a%20b.png"></body></html>');
 f.write('styles/main.css','@import "../assets/fonts/fonts.css" screen; h1 { font-family: Brand; background: url(../images/a\\ b.png) }');
 f.write('assets/fonts/fonts.css','@font-face{font-family:Brand;src:url("./brand/brand.otf") format("opentype");font-weight:400}');
 f.write('assets/fonts/brand/brand.otf',Buffer.from('font-bytes'));f.write('assets/fonts/brand/LICENSE.txt','Font license attribution');
 f.write('images/a b.png',Buffer.from('image-bytes'));
 f.write('assets/fonts/fonts.json',JSON.stringify({version:1,cssSha256:'original',fonts:[{id:'brand',family:'Brand',files:[{path:'assets/fonts/brand/brand.otf'}],license:{name:'OFL',path:'assets/fonts/brand/LICENSE.txt'}},{id:'unused',files:[{path:'assets/fonts/unused.woff2'}],license:{path:'assets/fonts/unused-LICENSE.txt'}}]}));
 f.write('.env','TOKEN=secret');f.write('private.json','secret');return f;
}

test('PDF embeds CSS imports, escaped local images and OTF fonts, and blocks external requests',async t=>{
 const f=fontProject(t),html=await prepareDesignHtml(f.input('pages/poster.html')),{document}=parseHTML(html);
 const css=Buffer.from(document.querySelector('link')!.getAttribute('href')!.split(',')[1],'base64').toString();
 assert.match(css,/url\("data:image\/png;base64,/);assert.match(css,/@import "data:text\/css;base64,[^"]+" screen/);
 const imported=Buffer.from(/@import "data:text\/css;base64,([^"]+)"/.exec(css)![1],'base64').toString();assert.match(imported,/data:font\/otf;base64,/);
 assert.match(document.querySelector('img')!.getAttribute('src')!,/^data:image\/png;base64,/);
 assert.match(document.querySelector('meta[http-equiv]')!.getAttribute('content')!,/connect-src 'none'/);assert.ok(!html.includes('TOKEN=secret'));
});

test('ZIP includes only referenced files and matching font license records, with a working entry',async t=>{
 const f=fontProject(t),files=unzipSync(await exportDesignHtmlBundle(f.input('pages/poster.html'))),names=Object.keys(files);
 for(const name of ['pages/poster.html','styles/main.css','assets/fonts/fonts.css','assets/fonts/brand/brand.otf','assets/fonts/brand/LICENSE.txt','images/a b.png','index.html','aelion-export.json'])assert.ok(names.includes(name),name);
 assert.ok(!names.some(name=>name.includes('unused')||name==='.env'||name==='private.json'));
 const manifest=JSON.parse(Buffer.from(files['assets/fonts/fonts.json']).toString());assert.equal(manifest.fonts.length,1);assert.equal(manifest.fonts[0].id,'brand');
 const report=JSON.parse(Buffer.from(files['aelion-export.json']).toString());assert.equal(report.entry,'pages/poster.html');assert.ok(report.resources.every((r:{sha256:string})=>/^[a-f0-9]{64}$/.test(r.sha256)));
 assert.match(Buffer.from(files['styles/main.css']).toString(),/\.\.\/images\/a%20b.png/);
});

test('inline CSS, SVG references, srcsets and data image URLs survive export',async t=>{
 const f=fixture(t);f.write('index.html','<html><body style="background:url(a.png)"><style>.x:after {content: "url(missing.png)"} /* url(no.png) */</style><img srcset="a.png 1x, b.png 2x"><svg><image href="icons.svg"/></svg><img src="data:image/png;base64,aGVsbG8="></body></html>');f.write('a.png','a');f.write('b.png','b');f.write('icons.svg','<svg xmlns="http://www.w3.org/2000/svg"><g id="mark"><image href="a.png"/></g></svg>');
 const html=await prepareDesignHtml(f.input());assert.match(html,/data:image\/png;base64,YQ==/);assert.match(html,/data:image\/svg\+xml;base64,/);assert.match(html,/url\(missing.png\)/);
 const {document}=parseHTML(html);assert.match(document.querySelector('img')!.getAttribute('srcset')!,/data:image\/png;base64,YQ== 1x, data:image\/png;base64,Yg== 2x/);
});

test('CSS url matching decodes escapes and ignores strings and comments',async t=>{
 const f=fixture(t);f.write('index.html','<html><style>@import url("style.css") print; h1 {background: u\\72l(a.png);content:"url(not-real.png)"}</style><h1>A</h1></html>');f.write('style.css','/* url(missing.png) */h1{background:url("a.png")}');f.write('a.png','x');
 const html=await prepareDesignHtml(f.input());assert.match(html,/data:image\/png;base64,eA==/);assert.match(html,/data:text\/css;base64,/);assert.match(html,/url\(not-real.png\)/);
});

test('remote, file, absolute, hidden and escaping references fail explicitly',async t=>{
 const f=fixture(t);f.write('index.html','<html></html>');f.write('.secret.png','secret');
 for(const url of ['https://cdn.example/font.woff2','//cdn.example/image.png','file:///C:/secret.png','/secret.png','../outside.png','%2e%2e/outside.png','.secret.png','assets/%2e%2e/%2e%2e/outside.png','C:/secret.png']){
  await assert.rejects(prepareDesignHtml({...f.input(),html:`<html><img src="${url}"></html>`}),/远程|相对路径|当前设计目录|隐藏文件/);
 }
 await assert.rejects(prepareDesignHtml({...f.input(),html:'<style>@import "https://example.com/fonts.css";</style>'}),/远程/);
});

test('missing resources, malformed CSS and cyclic imports do not yield broken exports',async t=>{
 const f=fixture(t);f.write('index.html','<link rel="stylesheet" href="a.css">');f.write('a.css','@import "b.css";');f.write('b.css','@import "a.css";');
 await assert.rejects(prepareDesignHtml(f.input()),/循环/);await assert.rejects(exportDesignHtmlBundle({...f.input(),html:'<img src="missing.png">'}),/不存在/);
 await assert.rejects(prepareDesignHtml({...f.input(),html:'<style>h1{background:url("broken.png)}</style>'}),/Unclosed|未闭合/);
});

test('resource symlinks cannot escape the project root',async t=>{
 const f=fixture(t),outside=fixture(t);outside.write('secret.png','private');f.write('index.html','<img src="linked/secret.png">');
 try{symlinkSync(outside.root,join(f.root,'linked'),process.platform==='win32'?'junction':'dir');}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Symlinks are unavailable');return;}throw error;}
 await assert.rejects(prepareDesignHtml(f.input()),/链接越过/);
});

test('fonts allow 25 MB, while larger files and aborted exports fail',async t=>{
 const f=fixture(t);f.write('index.html','<style>@font-face{font-family:X;src:url(large.woff2)}</style>');f.write('large.woff2',Buffer.alloc(25*1024*1024+1));await assert.rejects(prepareDesignHtml(f.input()),/大小限制/);
 const controller=new AbortController();controller.abort();await assert.rejects(prepareDesignHtml({...f.input(),signal:controller.signal}),{name:'AbortError'});
 assert.equal(mime.otf,'font/otf');assert.equal(webResourcePath('/assets/font.otf'),'assets/font.otf');assert.equal(webResourceLimit('a.otf'),25*1024*1024);assert.equal(webResourceLimit('a.png'),15*1024*1024);
});

test('unsupported dynamic project structures fail visibly instead of losing dependencies',async t=>{
 const f=fixture(t);f.write('index.html','<html></html>');
 for(const html of ['<iframe src="page.html"></iframe>','<base href="https://example.com/">','<script type="module">import "./entry.js"</script>','<svg><use href="icons.svg#icon"/></svg>','<style>h1{background:image-set("a.png" 1x)}</style>'])await assert.rejects(exportDesignHtmlBundle({...f.input(),html}),/导出/);
});

function printEnvironment(fail=false){
 const loaded:Array<{font:string;text:string}>=[];
 const face={family:'Brand',status:'unloaded'};
 const fonts={load:async(font:string,text:string)=>{loaded.push({font,text});if(fail)throw Error('Font decode failed');face.status='loaded';return [face];},check:()=>!fail,ready:Promise.resolve(),*[Symbol.iterator](){yield face;}};
 let current=0,decoded=0;
 const document={body:{},documentElement:{},fonts,createTreeWalker:()=>({nextNode:()=>current++?null:{parentElement:{tagName:'H1'},textContent:'实际文本'}}),querySelectorAll:()=>[],images:[{loading:'lazy',getAttribute:()=>'image.png',async decode(){assert.equal(this.loading,'eager','export must trigger below-fold lazy images');decoded++;},naturalWidth:32}]};
 const context={document,NodeFilter:{SHOW_TEXT:4},getComputedStyle:()=>({fontStyle:'normal',fontWeight:'700',fontSize:'24px',fontFamily:'Brand, sans-serif'}),setTimeout,clearTimeout,requestAnimationFrame:(callback:()=>void)=>callback()};
 return {context,loaded,decoded:()=>decoded};
}

test('PDF waits for the actual text, weight, font metrics and image decode',async()=>{
 const f=printEnvironment(),result=await runInNewContext(DESIGN_PDF_READY_SCRIPT,f.context);
 assert.equal(result.fonts,1);assert.equal(result.images,1);assert.equal(f.decoded(),1);assert.deepEqual(f.loaded,[{font:'normal 700 24px Brand, sans-serif',text:'实际文本'}]);
});

test('PDF fails when the requested font cannot load instead of printing its fallback',async()=>{
 const f=printEnvironment(true);await assert.rejects(runInNewContext(DESIGN_PDF_READY_SCRIPT,f.context),/Font decode failed/);assert.equal(f.decoded(),0);
});
test('encoded CSS and SVG resource links cannot bypass remote-resource checks',async t=>{
 const f=fixture(t);f.write('index.html','<html></html>');
 const sources=[
  '<style>@\\69mport "https://example.com/style.css";</style>',
  '<style>h1{background:u\\72l("h\\74tps://example.com/a.png")}</style>',
  '<link rel="preload" as="font" href="https://example.com/font.woff2">',
  '<svg><script href="https://example.com/code.js"/></svg>',
  '<iframe srcdoc="&lt;img src=https://example.com/a.png&gt;"></iframe>',
  '<object data="https://example.com/page.html"></object>',
  '<img src="data:image/svg+xml;base64,'+Buffer.from('<svg><image href="https://example.com/image.png"/></svg>').toString('base64')+'">'
 ];
 for(const html of sources)await assert.rejects(prepareDesignHtml({...f.input(),html}),/远程|子页面|At-rule without name/);
});

test('inline SVG data URLs embed their own local resources even in the portable ZIP',async t=>{
 const f=fixture(t);f.write('a.png','image');f.write('index.html','<img src="data:image/svg+xml;base64,'+Buffer.from('<svg><image href="a.png"/></svg>').toString('base64')+'">');
 const files=unzipSync(await exportDesignHtmlBundle(f.input())),html=Buffer.from(files['index.html']).toString();
 const {document}=parseHTML(html),svg=Buffer.from(document.querySelector('img')!.getAttribute('src')!.split(',')[1],'base64').toString();assert.match(svg,/data:image\/png;base64,aW1hZ2U=/);
});

test('font license metadata cannot include an unrelated project file',async t=>{
 const f=fontProject(t);f.write('assets/fonts/fonts.json',JSON.stringify({version:1,fonts:[{id:'brand',files:[{path:'assets/fonts/brand/brand.otf'}],license:{path:'private.json'}}]}));
 await assert.rejects(exportDesignHtmlBundle(f.input('pages/poster.html')),/授权文件必须位于对应字体目录/);
});

test('CSS source-map metadata is not loaded while collecting export resources',async t=>{
 const f=fixture(t);f.write('index.html','<style>h1{color:red}/*# sourceMappingURL=data:application/json;base64,eA==*/</style><h1>Text</h1>');
 assert.match(await prepareDesignHtml(f.input()),/h1\{color:red\}/);
});
