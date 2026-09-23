import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {join,dirname,resolve,basename} from 'node:path';import {tmpdir} from 'node:os';import {unzipSync} from 'fflate';
import {Store} from '../electron/core/store';import {DesignStore} from '../electron/core/design-store';import {DesignerFiles} from '../electron/core/designer-files';import {DesignFonts} from '../electron/core/design-fonts';import {CanvasExports} from '../electron/core/canvas-export-service';
function fixture(t:test.TestContext){const root=mkdtempSync(join(tmpdir(),'aelion-canvas-export-'));const store=new Store(join(root,'data'));t.after(()=>{store.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-canvas-export-'));rmSync(root,{recursive:true,force:true});});const bot=store.createBot('Design','',undefined,undefined,{type:'designer'}),designs=new DesignStore(store,{} as any,()=>{},()=>join(root,'work')),created=designs.create({botId:bot.id,kind:'prototype',brief:'Export'}),session=designs.get(created.id),files=new DesignerFiles(store,designs),fonts=new DesignFonts({cacheDir:join(root,'font-cache'),files});files.write(session,'page.html',Buffer.from('<html><head><link rel="stylesheet" href="assets/style.css"></head><body><h1>Export this page</h1></body></html>'));files.write(session,'assets/style.css',Buffer.from('h1{color:#123456}'));files.write(session,'private-notes.txt',Buffer.from('not part of the export'));return {root,designs,session,files,fonts};}
test('canvas HTML and ZIP exports use local dependencies and exclude unrelated project files',async t=>{
 const f=fixture(t);let format='html';const service=new CanvasExports({getSession:id=>f.designs.get(id),files:f.files,fonts:f.fonts,choosePath:async()=>join(f.root,'saved.'+format),render:async()=>{throw Error('No renderer needed');}});
 const html=await service.export({id:f.session.id,path:'page.html',format:'html'});assert.ok(html);assert.match(readFileSync(html.path,'utf8'),/data:text\/css;base64/);
 format='zip';const zip=await service.export({id:f.session.id,path:'page.html',format:'zip'});assert.ok(zip);const files=unzipSync(readFileSync(zip.path));assert.ok(files['page.html']);assert.ok(files['assets/style.css']);assert.equal(files['private-notes.txt'],undefined);
});
test('cancelled or invalid exports do not write files or invoke the renderer',async t=>{
 const f=fixture(t);let renders=0,dialogs=0;const service=new CanvasExports({getSession:id=>f.designs.get(id),files:f.files,fonts:f.fonts,choosePath:async()=>{dialogs++;return null;},render:async()=>{renders++;return {bytes:Buffer.from('x'),warnings:[]};}});
 assert.equal(await service.export({id:f.session.id,path:'page.html',format:'pdf'}),null);assert.equal(renders,0);
 await assert.rejects(service.export({id:f.session.id,path:'page.html',format:'fig' as any}),/参数/);
 await assert.rejects(service.export({id:f.session.id,path:'../outside.html',format:'pdf'}));assert.equal(dialogs,1);
});
test('failed rendering and a task changed during the save dialog preserve the existing target',async t=>{
 const f=fixture(t),target=join(f.root,'saved.pdf');writeFileSync(target,'existing document');
 const service=new CanvasExports({getSession:id=>f.designs.get(id),files:f.files,fonts:f.fonts,choosePath:async()=>target,render:async()=>{throw Error('Render failed');}});
 await assert.rejects(service.export({id:f.session.id,path:'page.html',format:'pdf'}),/Render failed/);assert.equal(readFileSync(target,'utf8'),'existing document');
 let calls=0;const changed=new CanvasExports({getSession:()=>++calls===1?f.session:{...f.session},files:f.files,fonts:f.fonts,choosePath:async()=>target,render:async()=>({bytes:Buffer.from('wrong'),warnings:[]})});
 await assert.rejects(changed.export({id:f.session.id,path:'page.html',format:'pdf'}),/任务已更改/);assert.equal(readFileSync(target,'utf8'),'existing document');
});
test('rendered format, viewport and warnings propagate through the unified export service',async t=>{
 const f=fixture(t),target=join(f.root,'saved.sketch');const service=new CanvasExports({getSession:id=>f.designs.get(id),files:f.files,fonts:f.fonts,choosePath:async options=>{assert.equal(options.extension,'sketch');assert.equal(options.name,'page.sketch');return target;},render:async(html,format,viewport)=>{assert.equal(format,'sketch');assert.deepEqual(viewport,{width:900,height:700});assert.match(html,/Export this page/);return {bytes:Buffer.from('fixture output'),warnings:['复杂区域以图片保留']};}});
 const result=await service.export({id:f.session.id,path:'page.html',format:'sketch',viewport:{width:900,height:700}});assert.equal(result?.path,target);assert.equal(result?.warnings.length,1);assert.equal(existsSync(target),true);
});
