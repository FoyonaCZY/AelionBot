import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {PreviewFileOpener,type PreviewOpenSource} from '../electron/core/preview-open';
import {windowsOpenWithCommand,WINDOWS_OPEN_WITH_SCRIPT} from '../electron/core/open-with-windows';
import {Attachments} from '../electron/core/attachments';
import {Store} from '../electron/core/store';
import {previewOpenTarget} from '../src/preview-open';
function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'aelion-open-'));
 t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-open-'));rmSync(root,{recursive:true,force:true});});
 const events:Array<{action:string;path:string}>=[];
 let source:PreviewOpenSource={name:'原始 文稿.md',key:'attachment:test',bytes:Buffer.from('original')};
 const opener=new PreviewFileOpener({cacheDir:join(root,'copies'),resolve:async()=>source,open:async path=>{events.push({action:'default',path});return '';},choose:async path=>{events.push({action:'choose',path});return false;},reveal:path=>{events.push({action:'folder',path});}});
 return {root,events,opener,setSource:(value:PreviewOpenSource)=>source=value};
}
const target={kind:'attachment' as const,id:'test'};
test('open menu dispatches default app, chooser and containing folder for the same named local copy',async t=>{
 const f=fixture(t);assert.equal(await f.opener.open({target,action:'default'}),true);assert.equal(await f.opener.open({target,action:'choose'}),false);await f.opener.open({target,action:'folder'});
 assert.deepEqual(f.events.map(e=>e.action),['default','choose','folder']);assert.equal(new Set(f.events.map(e=>e.path)).size,1);
 assert.equal(basename(f.events[0].path),'原始 文稿.md');assert.equal(readFileSync(f.events[0].path,'utf8'),'original');
 writeFileSync(f.events[0].path,'external edits');await f.opener.open({target,action:'default'});assert.equal(readFileSync(f.events[0].path,'utf8'),'external edits','reopening must not overwrite edits in the external copy');
});
test('local designs open and reveal their original path without creating a copy',async t=>{
 const f=fixture(t),path=join(f.root,'design.html');writeFileSync(path,'<h1>Design</h1>');f.setSource({path});
 await f.opener.open({target,action:'default'});await f.opener.open({target,action:'folder'});assert.ok(f.events.every(event=>event.path===path));
 await assert.rejects(f.opener.open({target,action:'delete' as any}),/无效/);assert.equal(f.events.length,2);
 f.setSource({path:join(f.root,'missing')});await assert.rejects(f.opener.open({target,action:'default'}));assert.equal(f.events.length,2);
});
test('a symlinked cached file cannot redirect an open action',async t=>{
 const f=fixture(t);await f.opener.open({target,action:'default'});const path=f.events[0].path,other=join(f.root,'other.txt');writeFileSync(other,'unrelated');rmSync(path);
 try{symlinkSync(other,path,'file');}catch(error){if((error as NodeJS.ErrnoException).code==='EPERM'){t.skip('Symlink permission unavailable');return;}throw error;}
 await assert.rejects(f.opener.open({target,action:'default'}),/无效/);assert.equal(f.events.length,1);
});
test('original attachment paths persist privately and missing originals fall back to the attachment',t=>{
 const f=fixture(t),data=join(f.root,'data'),store=new Store(data),files=new Attachments(store),bot=store.data.bots[0],path=join(f.root,'中文 文件.txt');writeFileSync(path,'source');
 const [file]=files.importPaths({kind:'bot',id:bot.id},[path]);assert.equal(files.originalPath(file.id),realpathSync(path));assert.equal('sourcePath' in files.metadata(file.id),false);
 store.close();const reloaded=new Store(data);t.after(()=>reloaded.close());const reopened=new Attachments(reloaded);assert.equal(reopened.originalPath(file.id),realpathSync(path));rmSync(path);assert.equal(reopened.originalPath(file.id),undefined);assert.equal(reopened.bytes(file.id).toString(),'source');
});
test('Windows chooser keeps hostile filenames out of executable PowerShell code',()=>{
 const path=String.raw`C:\designs\中文 ' $(not-a-command) & document.txt`,command=windowsOpenWithCommand(path,'12345');
 assert.equal(command.options.env.AELION_OPEN_FILE,path);assert.equal(command.options.env.AELION_OPEN_OWNER,'12345');assert.equal(command.options.windowsHide,true);
 assert.equal(Buffer.from(command.args.at(-1)!,'base64').toString('utf16le'),WINDOWS_OPEN_WITH_SCRIPT);assert.ok(!WINDOWS_OPEN_WITH_SCRIPT.includes(path));
});
test('Windows Open With interop compiles against the installed runtime',{skip:process.platform!=='win32'},()=>{
 const command=windowsOpenWithCommand('unused');
 const script=WINDOWS_OPEN_WITH_SCRIPT.split('$info=')[0]+"\nif(-not [AelionOpenWith].GetMethod('SHOpenWithDialog')){throw 'missing method'}";
 execFileSync(command.file,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000});
});
test('preview actions resolve workspace and attachment IDs without accepting arbitrary host paths',()=>{
 assert.deepEqual(previewOpenTarget({id:'attachment:abc'}),{kind:'attachment',id:'abc'});
 assert.deepEqual(previewOpenTarget({id:'file',workspace:{botId:'bot',path:'index.html'}}),{kind:'workspace',botId:'bot',path:'index.html'});
 assert.equal(previewOpenTarget({id:'C:/secret.txt'}),undefined);
});
