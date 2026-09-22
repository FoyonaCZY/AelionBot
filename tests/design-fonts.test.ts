import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {DesignStore} from '../electron/core/design-store';
import {DesignerFiles} from '../electron/core/designer-files';
import {DesignFonts} from '../electron/core/design-fonts';

const inter = readFileSync('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2');
const chinese = readFileSync('node_modules/@fontsource-variable/noto-sans-sc/files/noto-sans-sc-119-wght-normal.woff2');
function setup(t:any, fetcher?: typeof fetch) {
  const root=mkdtempSync(join(tmpdir(),'aelion-design-fonts-'));
  t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes('aelion-design-fonts-'));rmSync(root,{recursive:true,force:true});});
  const store=new Store(join(root,'data')),bot=store.createBot('Designer','',undefined,undefined,{type:'designer'});
  const designs=new DesignStore(store,{} as any,()=>{},()=>join(root,'work'));
  const session=designs.create({botId:bot.id,kind:'prototype',brief:'Font test'}),files=new DesignerFiles(store,designs),cacheDir=join(root,'font-cache');
  const fonts=new DesignFonts({cacheDir,files,fetch:fetcher});
  return {root,store,bot,designs,session,files,fonts,cacheDir};
}
function server(options: {chinese?:boolean; redirect?:boolean; oversized?:boolean; badFont?:boolean}={}) {
  const id=options.chinese?'noto-sans-sc':'inter',family=options.chinese?'Noto Sans SC':'Inter',calls:string[]=[];
  const metadata={id,family,category:'sans-serif',weights:[400,700],styles:['normal'],subsets:options.chinese?['chinese-simplified','latin']:['latin','latin-ext'],defSubset:'latin',license:{type:'OFL-1.1',url:'https://openfontlicense.org'}};
  const fetcher=(async(url:string,init?:RequestInit)=>{
    calls.push(url);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
    if(options.redirect)return new Response('',{status:302,headers:{location:'https://evil.example/font.woff2'}});
    if(url.endsWith('/v1/fonts'))return Response.json([metadata]);
    if(url.includes('/v1/version/'))return Response.json({latest:'5.3.0'});
    assert.match(url,new RegExp('/'+id+'@5\\.3\\.0/'));
    if(url.endsWith('/metadata.json'))return Response.json(metadata);
    if(url.endsWith('/LICENSE'))return new Response('SIL OPEN FONT LICENSE Version 1.1');
    if(url.endsWith('.css')){const weight=url.endsWith('700.css')?700:400;return new Response((options.chinese?['[119]','latin']:['latin','latin-ext']).map(subset=>`/* ${id}-${subset}-${weight}-normal */\n@font-face {font-family:'${family}';font-weight:${weight};src:url(./files/${id}-${subset.replace(/[\[\]]/g,'')}-${weight}-normal.woff2) format('woff2');unicode-range:${subset==='[119]'?'U+4e00-9fff':'U+0000-00ff'};}`).join('\n'));}
    if(url.endsWith('.woff2'))return new Response(new Uint8Array(options.badFont?Buffer.from('this is not a font'):url.includes('-119-')?chinese:inter),{headers:options.oversized?{'content-length':String(30*1024*1024)}:{}});
    throw Error('Unexpected URL '+url);
  }) as typeof fetch;
  return {fetcher,calls};
}
test('imports parse actual metadata, preserve variable weights, and report missing glyphs',async t=>{
  const f=setup(t),path=join(f.root,'brand.woff2');writeFileSync(path,inter);
  const [font]=await f.fonts.importFile(f.session,path,{licenseNote:'Licensed separately by the user'});
  assert.equal(font.family,'Inter');assert.equal(font.source,'import');assert.equal(font.files[0].weight,400);assert.deepEqual(font.files[0].weightRange,[100,900]);
  assert.equal(font.files[0].format,'woff2');assert.equal(f.fonts.list(f.session).length,1);
  assert.match(readFileSync(f.files.absolute(f.session,font.cssPath),'utf8'),/font-weight: 100 900/);
  assert.match(readFileSync(f.files.absolute(f.session,font.license.path!),'utf8'),/Licensed separately/);
  const checked=f.fonts.check(f.session,{text:'Hello 中'});assert.equal(checked.cssValid,true);assert.equal(checked.fonts[0].valid,true);assert.deepEqual(checked.fonts[0].missingCharacters,['中']);
  assert.equal((await f.fonts.importFile(f.session,path))[0].id,font.id);assert.equal(f.fonts.list(f.session).length,1);
});
test('imports reject fake formats, oversized containers, symlink paths, and escaped project font directories',async t=>{
  const f=setup(t),fake=join(f.root,'bad.woff2');writeFileSync(fake,Buffer.from('not a font'.repeat(10)));await assert.rejects(f.fonts.importFile(f.session,fake),/支持|解析/);
  const oversized=Buffer.from(inter);oversized.writeUInt32BE(80*1024*1024,16);writeFileSync(fake,oversized);await assert.rejects(f.fonts.importFile(f.session,fake),/压缩字体/);
  const source=join(f.root,'source');mkdirSync(source);writeFileSync(join(source,'font.woff2'),inter);symlinkSync(source,join(f.root,'linked'),'junction');await assert.rejects(f.fonts.importFile(f.session,join(f.root,'linked','font.woff2')),/符号链接/);
  mkdirSync(join(f.session.workspaceDir!,'assets'));symlinkSync(source,join(f.session.workspaceDir!,'assets','fonts'),'junction');await assert.rejects(f.fonts.importFile(f.session,join(source,'font.woff2')),/任务目录/);
  assert.equal(existsSync(join(source,'fonts.json')),false);
});
test('Fontsource downloads pinned local files and license, then reuses them offline in another project',async t=>{
  const remote=server(),f=setup(t,remote.fetcher);const catalog=await f.fonts.catalog('inter');assert.equal(catalog[0].id,'inter');
  const [font]=await f.fonts.acquire(f.session,{fontId:'inter'});assert.deepEqual(font.weights,[400]);assert.deepEqual(font.subsets,['latin']);assert.equal(font.version,'5.3.0');assert.equal(font.files.length,1);
  assert.ok(remote.calls.some(url=>url.endsWith('/LICENSE')));assert.ok(!remote.calls.some(url=>url.includes('@latest')||url.endsWith('700.css')));
  const css=readFileSync(f.files.absolute(f.session,font.cssPath),'utf8');assert.ok(!css.includes('https:'));assert.match(css,/font-family: "Inter"/);assert.equal(f.fonts.check(f.session,{text:'Hello'}).fonts[0].missingCharacters.length,0);
  const offline=new DesignFonts({files:f.files,cacheDir:f.cacheDir,fetch:(async()=>{throw Error('offline');}) as typeof fetch});
  const other=f.designs.create({botId:f.bot.id,kind:'prototype',brief:'Offline task'});assert.equal((await offline.acquire(other,{fontId:'inter'}))[0].version,'5.3.0');assert.equal((await offline.catalog('Inter'))[0].cached,true);
});
test('Chinese defaults download numbered Unicode slices together with Latin and verify Chinese coverage',async t=>{
  const remote=server({chinese:true}),f=setup(t,remote.fetcher);const [font]=await f.fonts.acquire(f.session,{fontId:'noto-sans-sc'});
  assert.equal(font.files.length,2);assert.deepEqual(font.subsets.sort(),['chinese-simplified','latin']);assert.ok(font.files.some(file=>file.unicodeRange==='U+4e00-9fff'));
  const result=f.fonts.check(f.session,{text:'Hello 中'});assert.deepEqual(result.fonts[0].missingCharacters,[]);assert.equal(result.fonts[0].valid,true);
});
test('downloads reject arbitrary IDs, redirects, size overflow, malformed font bytes, and pre-write guard failures',async t=>{
  for(const mode of [{redirect:true},{oversized:true},{badFont:true}]){const remote=server(mode),f=setup(t,remote.fetcher);await assert.rejects(f.fonts.acquire(f.session,{fontId:'inter'}));assert.equal(existsSync(join(f.session.workspaceDir!,'assets','fonts','fonts.json')),false);}
  const remote=server(),f=setup(t,remote.fetcher);await assert.rejects(f.fonts.acquire(f.session,{fontId:'../../evil'}),/无效/);assert.equal(remote.calls.length,0);
  await assert.rejects(f.fonts.acquire(f.session,{fontId:'inter'},undefined,()=>{throw Error('Task started');}),/Task started/);assert.equal(existsSync(join(f.session.workspaceDir!,'assets')),false);
  const path=join(f.root,'font.woff2');writeFileSync(path,inter);await assert.rejects(f.fonts.importFile(f.session,path,{beforeWrite:()=>{throw Error('Task started');}}),/Task started/);
});
test('modified CSS is preserved, changed bytes are reported, and extra weights merge without losing previous faces',async t=>{
  const remote=server(),f=setup(t,remote.fetcher);const [font]=await f.fonts.acquire(f.session,{fontId:'inter'});
  const [both]=await f.fonts.acquire(f.session,{fontId:'inter',weights:[700]});assert.deepEqual(both.weights,[400,700]);assert.equal(both.files.length,2);
  writeFileSync(f.files.absolute(f.session,font.files[0].path),Buffer.from('changed'));assert.equal(f.fonts.list(f.session)[0].files.length,2);assert.equal(f.fonts.list(f.session)[0].available,false);assert.deepEqual(f.fonts.list(f.session)[0].issues,[font.files[0].path]);assert.equal(f.fonts.check(f.session).fonts[0].valid,false);
  writeFileSync(f.files.absolute(f.session,font.cssPath),'/* user changes */');await assert.rejects(f.fonts.acquire(f.session,{fontId:'inter',subsets:['latin-ext']}),/样式已被修改/);assert.equal(readFileSync(f.files.absolute(f.session,font.cssPath),'utf8'),'/* user changes */');assert.equal(f.fonts.check(f.session).cssValid,false);
});
test('aborted downloads cannot materialize fonts and unsupported subsets fail explicitly',async t=>{
  const remote=server(),f=setup(t,remote.fetcher);const controller=new AbortController();controller.abort();await assert.rejects(f.fonts.acquire(f.session,{fontId:'inter'},controller.signal));assert.equal(existsSync(join(f.session.workspaceDir!,'assets')),false);
  await assert.rejects(f.fonts.acquire(f.session,{fontId:'inter',subsets:['chinese-simplified']}),/不受该字体支持/);
});

test('WOFF table allocation sizes cannot bypass a smaller declared sfnt size',async t=>{
  const f=setup(t),path=join(f.root,'hostile.woff2');
  const woff2=Buffer.alloc(80);woff2.write('wOF2');woff2.writeUInt32BE(0x10000,4);woff2.writeUInt32BE(80,8);woff2.writeUInt16BE(1,12);woff2.writeUInt32BE(200,16);woff2.writeUInt32BE(1,20);
  woff2[48]=0;Buffer.from([0x81,0x80,0x80,0x80,0]).copy(woff2,49);writeFileSync(path,woff2);
  await assert.rejects(f.fonts.importFile(f.session,path),/字体表超过解压大小限制/);
  const woff=Buffer.alloc(65);woff.write('wOFF');woff.writeUInt32BE(0x10000,4);woff.writeUInt32BE(65,8);woff.writeUInt16BE(1,12);woff.writeUInt32BE(200,16);woff.write('cmap',44);woff.writeUInt32BE(64,48);woff.writeUInt32BE(1,52);woff.writeUInt32BE(0x40000000,56);writeFileSync(path,woff);
  await assert.rejects(f.fonts.importFile(f.session,path),/字体表超过解压大小限制/);
});
test('offline font search falls back to installed metadata when the full catalog was never cached',async t=>{
  const remote=server(),f=setup(t,remote.fetcher);await f.fonts.acquire(f.session,{fontId:'inter'});assert.ok(!remote.calls.some(url=>url.endsWith('/v1/fonts')));
  const offline=new DesignFonts({files:f.files,cacheDir:f.cacheDir,fetch:(async()=>{throw Error('offline');}) as typeof fetch});
  const found=await offline.catalog('Inter');assert.equal(found[0].family,'Inter');assert.equal(found[0].cached,true);
});
test('invalid manifest data fails explicitly while missing font files remain visible as unavailable',async t=>{
  const remote=server(),f=setup(t,remote.fetcher);const [font]=await f.fonts.acquire(f.session,{fontId:'inter'});
  const css=f.files.absolute(f.session,font.cssPath);writeFileSync(css,'changed CSS');assert.equal(f.fonts.list(f.session)[0].available,false);assert.ok(f.fonts.list(f.session)[0].issues?.includes(font.cssPath));
  const manifest=f.files.absolute(f.session,'assets/fonts/fonts.json');writeFileSync(manifest,'not json');assert.throws(()=>f.fonts.list(f.session),/项目字体记录无效/);
});
