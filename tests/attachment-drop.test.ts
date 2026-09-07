import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,symlinkSync,truncateSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {unzipSync,strFromU8} from 'fflate';
import {Store} from '../electron/core/store';
import {Attachments} from '../electron/core/attachments';
import {AttachmentDrops,directoryAttachment} from '../electron/core/attachment-drop';

function fixture(t:test.TestContext){
  const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-drop-')),store=new Store(join(root,'data')),attachments=new Attachments(store),bot=store.data.bots[0],scope={kind:'bot' as const,id:bot.id};
  const workspaces:string[]=[],drops=new AttachmentDrops(attachments,(_scope,path)=>{workspaces.push(path);return path;});
  t.after(()=>{store.close();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});
  return {root,store,attachments,scope,drops,workspaces};
}
test('folder drops can become a workspace or a ZIP containing the original files and empty directories',async t=>{
  const f=fixture(t),folder=join(f.root,'项目');mkdirSync(join(folder,'empty'),{recursive:true});mkdirSync(join(folder,'src'));writeFileSync(join(folder,'src','代码.ts'),'export const value = "中文";');writeFileSync(join(folder,'image.png'),Buffer.from([0,1,2,255]));
  const [choice]=await f.drops.prepare(f.scope,[folder]);assert.equal(choice.kind,'directory');assert.equal('path' in choice,false);
  const workspace=await f.drops.apply(f.scope,[choice.id],'workspace');assert.equal(workspace.workspaceDir,realpathSync(folder));assert.equal(workspace.attachments.length,0);
  const [second]=await f.drops.prepare(f.scope,[folder]),result=await f.drops.apply(f.scope,[second.id],'attach');assert.equal(result.attachments[0].name,'项目.zip');
  const files=unzipSync(f.attachments.bytes(result.attachments[0].id));assert.equal(strFromU8(files['项目/src/代码.ts']),'export const value = "中文";');assert.deepEqual(files['项目/image.png'],new Uint8Array([0,1,2,255]));assert.ok(files['项目/empty/']);
});
test('drop choices are bound to one conversation and can be applied only once',async t=>{
  const f=fixture(t),file=join(f.root,'hello.txt');writeFileSync(file,'original');const other=f.store.createBot('其他','测试'),[choice]=await f.drops.prepare(f.scope,[file]);
  await assert.rejects(f.drops.apply({kind:'bot',id:other.id},[choice.id],'attach'),/不属于/);
  const result=await f.drops.apply(f.scope,[choice.id],'attach');assert.equal(f.attachments.bytes(result.attachments[0].id).toString(),'original');await assert.rejects(f.drops.apply(f.scope,[choice.id],'attach'),/过期/);assert.equal(f.workspaces.length,0);
});
test('directory attachments reject symlinks and excessive input before reading outside the selection',async t=>{
  const f=fixture(t),folder=join(f.root,'selected'),outside=join(f.root,'outside');mkdirSync(folder);mkdirSync(outside);writeFileSync(join(outside,'private.txt'),'outside');symlinkSync(outside,join(folder,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(directoryAttachment(folder),/符号链接/);
  const large=join(f.root,'large');mkdirSync(large);const path=join(large,'sparse');writeFileSync(path,'');truncateSync(path,100*1024*1024+1);await assert.rejects(directoryAttachment(large),/100 MB/);
});
test('a removed selection produces a recoverable error and never imports a replacement path',async t=>{
  const f=fixture(t),file=join(f.root,'temporary.txt');writeFileSync(file,'original');const [choice]=await f.drops.prepare(f.scope,[file]);rmSync(file);await assert.rejects(f.drops.apply(f.scope,[choice.id],'attach'));assert.equal(f.store.data.attachments.length,0);
});
