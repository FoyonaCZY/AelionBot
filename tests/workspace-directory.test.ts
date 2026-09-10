import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {WORKSPACE_DIRECTORY_SCRIPT} from '../electron/core/workspace-directory';
import {ArtifactService} from '../electron/core/artifacts';

const python=process.env.AELION_TEST_PYTHON||(process.platform==='win32'?'python':'python3');
const available=spawnSync(python,['--version'],{windowsHide:true,timeout:5000}).status===0;
function fixture(t:test.TestContext){const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'aelion-tree-')),root=join(dir,'work');mkdirSync(root);t.after(()=>{assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});return {dir,root,read:(path:string)=>spawnSync(python,['-c',WORKSPACE_DIRECTORY_SCRIPT],{cwd:root,input:JSON.stringify({path}),encoding:'utf8',windowsHide:true,timeout:10000})};}
test('directory browser reads one level, includes empty folders and supports deep navigation',{skip:!available},t=>{
  const f=fixture(t);mkdirSync(join(f.root,'src','deep','a','b','c'),{recursive:true});mkdirSync(join(f.root,'empty'));writeFileSync(join(f.root,'src','deep','a','b','c','test.py'),'print(1)');writeFileSync(join(f.root,'readme.md'),'hello');
  const top=f.read('');assert.equal(top.status,0,top.stderr);const data=JSON.parse(top.stdout);assert.deepEqual(data.entries.map((e:any)=>e.name),['empty','src','readme.md']);assert.equal(data.entries[0].kind,'directory');assert.equal(JSON.parse(f.read('empty').stdout).entries.length,0);assert.equal(JSON.parse(f.read('src/deep/a/b/c').stdout).entries[0].path,'src/deep/a/b/c/test.py');
});
test('resolved directories cannot escape through parent paths or links',{skip:!available},t=>{
  const f=fixture(t);const outside=join(f.dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'private.txt'),'private');symlinkSync(outside,join(f.root,'link'),process.platform==='win32'?'junction':'dir');
  assert.notEqual(f.read('../outside').status,0);assert.notEqual(f.read('link').status,0);
});
test('invalid directory paths are rejected before any VM operation',async()=>{
  let calls=0;const service=new ArtifactService({bot:()=>({id:'bot'})} as any,{executePython:async()=>{calls++;return {exitCode:0,stdout:'{"entries":[]}'}}} as any);
  for(const path of ['../secret','/etc','C:\\Users','file:///etc/passwd','x\0y'])await assert.rejects(service.directory('bot',path));
  assert.equal(calls,0);await service.directory('bot','');assert.equal(calls,1);
});
