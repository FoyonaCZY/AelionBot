import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {DesignSystems} from '../electron/core/design-systems';
import {DesignStore} from '../electron/core/design-store';
import {DesignPlugins} from '../electron/core/design-plugins';
import {parseDesignTokens,checkDesignBrand,repairDesignBrand,brandCheckLabel} from '../electron/core/design-brand';
import {printReadyHtml,renderDesignPdf} from '../electron/core/design-pdf';
import {DesignerLoop} from '../electron/core/designer-loop';
import {DesignerFiles} from '../electron/core/designer-files';
import {emptyCanvasHtml,pickDesignPreviewFiles,commentsFromAnnotations,commentDesignId,deviceFrameKind,previewFeedbackAlwaysVisible,primaryDesignArtifact} from '../src/designer-canvas';
import {designPluginCopy,designPluginTriggerLabel,filterDesignPlugins} from '../src/designer-plugin-copy';
import {designerPlaybook,designerPlaybookName} from '../electron/core/designer-playbooks';
import {readFileSync as read} from 'node:fs';

function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'aelion-studio-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-studio-'));rmSync(root,{recursive:true,force:true});});
 const store=new Store(join(root,'data'));
 const bot=store.createBot('Designer','Design',undefined,undefined,{type:'designer'});
 store.data.model.model='fixture';
 return {root,store,bot};
}
function catalog(root:string,version='a'.repeat(40),color='#cc3333'){
 const dir=join(root,version);mkdirSync(join(dir,'sample'),{recursive:true});
 const texts={'DESIGN.md':'# Sample\nUse a restrained type scale.','tokens.css':`:root {--od-color-primary:${color};--font-display:Georgia,serif;--text-lg:32px;--space-m:16px;}`,'components.html':'<main>Reference</main>'};
 const files=Object.entries(texts).map(([path,body])=>{writeFileSync(join(dir,'sample',path),body);return {path,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')};});
 writeFileSync(join(dir,'catalog.json'),JSON.stringify({version:1,sourceCommit:version,sourceUrl:'https://example.test',systems:[{id:'sample',name:'Sample',category:'Product',description:'Test fixture',version,bytes:files.reduce((n,f)=>n+f.bytes,0),colors:['#123456'],source:'https://example.test',license:'Apache-2.0',files}]}));
 return dir;
}

test('empty canvas and preview helpers cover the five task kinds without writing files',()=>{
 for(const kind of ['prototype','ppt','clone','mobile','document'] as const){
  const html=emptyCanvasHtml(kind,'A <Brand>');
  assert.match(html,/data-design-id="empty-canvas"/);
  assert.doesNotMatch(html,/网页画布|文件一写入|A &lt;Brand&gt;|empty-slide|device-frame/);
  assert.equal(deviceFrameKind(kind),kind==='mobile'?'phone':kind==='ppt'?'slide':kind==='document'?'page':undefined);
  assert.equal(primaryDesignArtifact(kind,kind==='ppt'?'deck.pptx':'index.html'),true);
 }
 assert.equal(previewFeedbackAlwaysVisible(false),true);
 const files=pickDesignPreviewFiles('prototype',[{name:'about.html',path:'designers/b/t/about.html',size:12},{name:'index.html',path:'designers/b/t/index.html',size:40}]);
 assert.equal(files[0].name,'index.html');
 const deck=pickDesignPreviewFiles('ppt',[{name:'deck.html',path:'designers/b/t/deck.html',size:20},{name:'notes.html',path:'designers/b/t/notes.html',size:8}]);
 assert.equal(deck[0].name,'deck.html');
});

test('element annotations become scoped canvas comments keyed by data-design-id',t=>{
 assert.equal(commentDesignId({selector:'h1[data-design-id="hero"]',text:'x'}),'hero');
 const comments=commentsFromAnnotations('designers/b/t/index.html','改小字号',[{id:'m1',type:'element',x:.1,y:.1,color:'#3975c6',designId:'hero',selector:'h1',text:'改小字号'}],[]);
 assert.equal(comments.length,1);assert.equal(comments[0].designId,'hero');assert.equal(comments[0].status,'open');
 const {root,store,bot}=fixture(t),systems=new DesignSystems(catalog(root)),designs=new DesignStore(store,systems);
 const task=designs.create({botId:bot.id,kind:'prototype',brief:'Page'});
 designs.addComments(task.id,comments);
 assert.equal(designs.get(task.id).comments?.length,1);
 assert.match(designs.frame(designs.get(task.id)),/"designId":"hero"/);
});

test('custom DESIGN.md packages import, pin with a 40-hex version, and sit beside bundled systems',t=>{
 const {root}=fixture(t),bundled=catalog(root),customRoot=join(root,'custom'),archive=join(root,'archive');
 const pack=join(root,'My Brand Pack');mkdirSync(pack);
 writeFileSync(join(pack,'DESIGN.md'),'# Local Brand\nUse ochre and ink.');
 writeFileSync(join(pack,'tokens.css'),':root{--od-color-primary:#b97559;}');
 const systems=new DesignSystems(bundled,archive,customRoot);
 const imported=systems.importFolder(pack);
 assert.equal(imported.origin,'custom');
 assert.match(imported.id,/^custom-my-brand-pack$/);
 assert.match(imported.version,/^[a-f0-9]{40}$/);
 assert.equal(systems.list().filter(item=>item.origin==='custom').length,1);
 assert.equal(systems.list().filter(item=>item.origin==='bundled').length,1);
 assert.match(systems.read(imported.id,'DESIGN.md').toString(),/ochre/);
 assert.ok(existsSync(join(archive,imported.version,imported.id,'pinned-manifest.json')));
 const empty=join(root,'empty');mkdirSync(empty);writeFileSync(join(empty,'README.md'),'nope');
 assert.throws(()=>systems.importFolder(empty),/DESIGN\.md/);
});

test('brand checks repair nearby token colors and stay visible without blocking format',()=>{
 const tokens=parseDesignTokens(':root{--od-color-primary:#112233;--font-display:Georgia,serif;--text-lg:32px;--space-m:16px}');
 const html='<html><style>:root{--od-color-primary:#112233}h1{color:#122334;font-family:Inter,sans-serif}</style><body><h1>Hi</h1></body></html>';
 const repaired=repairDesignBrand(html,tokens);
 assert.equal(repaired.changed,true);
 assert.match(repaired.html,/var\(--od-color-primary\)/);
 assert.match(repaired.html,/var\(--font-display\)/);
 assert.equal(brandCheckLabel(true),'品牌对齐');
 assert.equal(brandCheckLabel(false,true),'Not on brand');
 const off=checkDesignBrand('<html><style>h1{color:#ff00aa;font-family:Arial}</style><h1>x</h1></html>',tokens);
 assert.equal(off.aligned,false);assert.ok(off.issues.length);
});

test('first-party plugins list from disk and bind to a task without becoming default skills',t=>{
 const {root,store,bot}=fixture(t),plugins=new DesignPlugins(resolve('assets/design-plugins'));
 const listed=plugins.list();
 assert.deepEqual(listed.map(item=>item.id).sort(),['copy-tone','spacing-audit']);
 const spacing=listed.find(item=>item.id==='spacing-audit')!;
 assert.equal(spacing.name,'间距节奏');
 assert.match(spacing.description,/间距/);
 assert.doesNotMatch(spacing.name,/Spacing audit/i);
 assert.equal(designPluginCopy(spacing).name,'间距节奏');
 assert.equal(designPluginCopy(listed.find(item=>item.id==='copy-tone')!).name,'文案语气');
 assert.equal(designPluginTriggerLabel(0,[],false),'可选检查');
 assert.equal(designPluginTriggerLabel(2,['间距节奏','文案语气'],false),'已选 2 项检查');
 const crowded=Array.from({length:24},(_,i)=>({id:'check-'+i,name:'检查 '+i,description:'用途 '+i,bytes:1}));
 assert.equal(filterDesignPlugins(crowded,'检查 23').map(item=>item.id).join(),'check-23');
 assert.match(plugins.read('spacing-audit').content,/# Spacing audit/);
 assert.match(plugins.read('copy-tone').content,/# Copy tone/);
 assert.match(plugins.read('spacing-audit').content,/spacing tokens/);
 const systems=new DesignSystems(catalog(root)),designs=new DesignStore(store,systems,()=>{},()=>join(root,'ws'),plugins);
 const task=designs.create({botId:bot.id,kind:'mobile',brief:'App',plugins:['spacing-audit']});
 assert.deepEqual(task.plugins,['spacing-audit']);
 assert.throws(()=>designs.create({botId:bot.id,kind:'prototype',brief:'x',plugins:['../secret']}),/插件无效/);
 assert.match(JSON.stringify(designs.snapshot().plugins),/spacing-audit/);
});

test('PDF export requires a %PDF- header and wraps fragment HTML',async()=>{
 assert.match(printReadyHtml('<h1>Hi</h1>'),/<html/i);
 const pdf=await renderDesignPdf('<html><body>Hi</body></html>',async()=>Buffer.from('%PDF-1.4\n%fixture\n'));
 assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
 await assert.rejects(renderDesignPdf('<html></html>',async()=>Buffer.from('not-pdf')),/不是 PDF/);
});

test('mobile and document playbooks stay first-party and publish HTML as the primary artifact',()=>{
 assert.equal(designerPlaybookName('mobile'),'mobile');
 assert.equal(designerPlaybookName('document'),'document');
 assert.match(designerPlaybook('mobile'),/data-design-id/);
 assert.match(designerPlaybook('document'),/design_export_pdf/);
});

test('studio source keeps docked feedback and portals into the canvas host',()=>{
 const preview=read(resolve('src/FilePreview.tsx'),'utf8');
 assert.doesNotMatch(preview,/display:\s*modal\s*\?\s*undefined\s*:\s*'none'/);
 assert.match(preview,/data-layout=\{wantsStudio\?'studio'/);
 assert.match(preview,/portalTarget\|\|document\.body/);
 const workspace=read(resolve('src/DesignerWorkspace.tsx'),'utf8');
 assert.match(workspace,/data-designer-canvas=\{task\.id\}/);
 assert.match(workspace,/emptyCanvasHtml/);
 assert.match(read(resolve('src/App.tsx'),'utf8'),/purpose="image"/);
 assert.doesNotMatch(workspace,/deviceFrame/);
 assert.doesNotMatch(workspace,/expanded:\s*true/);
 assert.match(workspace,/DESIGN_TASK_KINDS/);
 assert.match(workspace,/studioFacade/);
 assert.match(workspace,/designer-bauhaus-hero/);
 assert.match(workspace,/KIND_ICONS/);
 assert.match(workspace,/designer-system-control/);
 assert.match(workspace,/BotComposer/);
 assert.match(workspace,/最近设计/);
 assert.match(workspace,/DesignPluginPicker/);
 assert.match(workspace,/designer-plugin-control/);
 assert.doesNotMatch(workspace,/className="designer-plugins"/);
 assert.doesNotMatch(workspace,/plugins\.map\(plugin=><button/);
 const studio=read(resolve('src/designer-studio.css'),'utf8');
 assert.match(studio,/\.fp-layer\.is-studio\{[^}]*inset:0/);
 assert.match(studio,/\.fp-layer\.is-studio \.fp-web-frame\{[^}]*height:100%/);
 assert.match(studio,/grid-template-columns:minmax\(320px,\.85fr\) minmax\(0,1\.25fr\)/);
 assert.doesNotMatch(studio,/left:var\(--preview-chat-width/);
 assert.doesNotMatch(studio,/\.designer-canvas\{[^}]*position:fixed/);
 assert.doesNotMatch(studio,/\.designer-delivery\{display:none\}/);
 const workbench=read(resolve('src/preview-workbench.css'),'utf8');
 assert.doesNotMatch(workbench,/data-layout=studio/);
 assert.match(preview,/!modal&&!wantsStudio&&<button className="fp-resize-handle"/);
 assert.match(preview,/if\(wantsStudio\)return/);
 const app=read(resolve('src/App.tsx'),'utf8');
 assert.doesNotMatch(app,/info\?\.studio/);
 const loop=read(resolve('electron/core/designer-loop.ts'),'utf8');
 assert.match(loop,/hostedImageGeneration:false/);
 assert.match(loop,/hostedGeneratedImages/);
 assert.match(loop,/openLivePreview/);
});

test('publish records a visible brand check and will not overwrite a user-saved HTML file',async t=>{
 const {root,store,bot}=fixture(t),systems=new DesignSystems(catalog(root)),designs=new DesignStore(store,systems);
 const task=designs.create({botId:bot.id,kind:'prototype',brief:'Brand page',systemId:'sample'});
 const files=new DesignerFiles(store,designs);
 const html='<!doctype html><html><style>:root{--od-color-primary:#cc3333}h1{color:#cc3434}</style><body><h1 data-design-id="hero">Hello</h1></body></html>';
 mkdirSync(task.workspaceDir!,{recursive:true});
 writeFileSync(join(task.workspaceDir!,'index.html'),html);
 const path=task.workspacePath+'/index.html';
 let step=0;
 const artifacts={read:(_bot:string,file:string)=>files.read(_bot,file),collect:async()=>{}};
 const shared={openToolSession:()=>({definitions:[],invoke:async(name:string)=>{if(name==='message_attach')return {attached:true};return {};},close:()=>{},pending:()=>[]})};
 const context={observe:()=>{},prepare:async(input:any)=>({messages:[input.system,...(input.prefixContext||[]),...input.history],maxOutputTokens:8192,stats:{calibration:1,estimatedTokens:2000},calibrationEstimate:2000,recordUsage:()=>{}})};
 const attachments={wire:(_b:string,content:string)=>({content})},interactions={pendingQuestions:()=>[],permission:async()=>{}};
 const loop=new DesignerLoop(store,designs,systems,files,{complete:async()=>({content:step++?'Ready':'Checking',calls:step===1?[{id:randomUUID(),type:'function',function:{name:'design_publish',arguments:JSON.stringify({paths:[path]})}}]:[],finishReason:'stop'})} as any,context as any,shared as any,artifacts as any,attachments as any,interactions as any,()=>{});
 await loop.run(bot.id,'Deliver',{designSessionId:task.id});
 const published=designs.get(task.id);
 assert.equal(published.checks.find(c=>c.id==='format')?.status,'passed');
 assert.ok(published.checks.some(c=>c.id==='brand'));
 const locked=designs.get(task.id);
 locked.userEdits=[{id:'u1',path,revision:'abc',time:new Date().toISOString(),summary:'user'}];
 designs.save();
 const before=readFileSync(join(task.workspaceDir!,'index.html'),'utf8');
 step=0;
 const second=new DesignerLoop(store,designs,systems,files,{complete:async()=>({content:step++?'Ready':'Checking',calls:step===1?[{id:randomUUID(),type:'function',function:{name:'design_publish',arguments:JSON.stringify({paths:[path]})}}]:[],finishReason:'stop'})} as any,context as any,shared as any,artifacts as any,attachments as any,interactions as any,()=>{});
 await second.run(bot.id,'Deliver again',{designSessionId:task.id});
 assert.equal(readFileSync(join(task.workspaceDir!,'index.html'),'utf8'),before);
});
