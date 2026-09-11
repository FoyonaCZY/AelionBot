import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ArtifactService} from '../electron/core/artifacts';
import {Store} from '../electron/core/store';
import {DEFAULT_RUNTIME} from '../src/runtime-types';
import {editedBytes,editableText} from '../electron/core/preview-editing';
const python=process.env.AELION_TEST_PYTHON,available=Boolean(python&&spawnSync(python,['--version'],{windowsHide:true,timeout:5000}).status===0);
function fixture(t:test.TestContext){
  const parent=realpathSync.native(tmpdir()),dir=mkdtempSync(join(parent,'aelion-preview-edit-')),work=join(dir,'work');mkdirSync(work);const store=new Store(join(dir,'data'));store.data.runtime={...DEFAULT_RUNTIME,fileCheckpoints:true};
  let race:(()=>void)|undefined;
  const run=async(code:string,input?:Buffer)=>{if(code.includes('NamedTemporaryFile')&&race){const action=race;race=undefined;action();}const result=spawnSync(python!,['-c',code],{cwd:work,input,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:5*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}});return {stdout:result.stdout,stderr:result.stderr,exitCode:result.status??-1,durationMs:1};};
  const vm={executePython:run,execute:(command:string)=>run(command.slice('python3 -c '.length+1,-1).replaceAll("'\\''","'"))};
  t.after(()=>{store.close();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});
  return {work,store,bot:store.data.bots[0].id,service:new ArtifactService(store,vm as any),race:(action:()=>void)=>race=action};
}
test('text edits preserve UTF-8 BOM and CRLF and reject unsafe encodings',()=>{
  const before=Buffer.from('\uFEFF第一行\r\n第二行\r\n');assert.equal(editedBytes('第一行\n改过的第二行\n',before).toString(),'\uFEFF第一行\r\n改过的第二行\r\n');
  assert.throws(()=>editableText(Buffer.from([0xff,0xfe,1,0]),'file'));assert.throws(()=>editedBytes('\0'));assert.throws(()=>editedBytes('中'.repeat(800000)));
  assert.notEqual(editableText(before,'a').revision,editableText(before,'b').revision);
});
test('editing reads complete content beyond the preview cutoff and seals its checkpoint',{skip:!available},async t=>{
  const f=fixture(t),path=join(f.work,'notes.md'),text='正文'.repeat(70000);writeFileSync(path,text);
  const before=await f.service.readEditable(f.bot,'notes.md');assert.equal(before.content.length,140000);
  const saved=await f.service.saveEditable(f.bot,'notes.md',{content:before.content+'\n更新',revision:before.revision});assert.equal(readFileSync(path,'utf8'),text+'\n更新');assert.equal(saved.content,text+'\n更新');assert.notEqual(saved.revision,before.revision);assert.ok(f.store.data.fileCheckpoints?.at(-1)?.afterHash);
});
test('stale revisions and changes during save never overwrite another edit',{skip:!available},async t=>{
  const f=fixture(t),path=join(f.work,'main.py');writeFileSync(path,'original');const first=await f.service.readEditable(f.bot,'main.py');writeFileSync(path,'Bot update');
  await assert.rejects(f.service.saveEditable(f.bot,'main.py',{content:'mine',revision:first.revision}),/其他操作修改/);assert.equal(readFileSync(path,'utf8'),'Bot update');
  const fresh=await f.service.readEditable(f.bot,'main.py');f.race(()=>writeFileSync(path,'late Bot update'));
  await assert.rejects(f.service.saveEditable(f.bot,'main.py',{content:'mine',revision:fresh.revision}),/保存前发生变化/);assert.equal(readFileSync(path,'utf8'),'late Bot update');
});
test('manual editing cannot create a file outside the current workspace',{skip:!available},async t=>{
  const f=fixture(t);await assert.rejects(f.service.readEditable(f.bot,'../private.txt'));
  await assert.rejects(f.service.saveEditable(f.bot,'/etc/hosts',{content:'x',revision:'a'.repeat(64)}));
  await assert.rejects(f.service.readEditable(f.bot,'image.png'),/不支持/);
});
