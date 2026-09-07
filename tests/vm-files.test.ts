import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync,symlinkSync,chmodSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readVmFile,patchVmFile,VM_WRITE} from '../electron/core/vm-files';
import {Store} from '../electron/core/store';
import {FileCheckpoints} from '../electron/core/file-checkpoints';
import {DEFAULT_RUNTIME} from '../src/runtime-types';
import {vmPython} from '../electron/core/vm-python';
import type {VmController} from '../electron/core/vm';
const python=process.env.AELION_TEST_PYTHON,available=Boolean(python&&spawnSync(python,['--version'],{windowsHide:true,timeout:5000}).status===0),hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function fixture(t:test.TestContext){
 const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-vm-files-')),work=join(root,'work');mkdirSync(work);const store=new Store(join(root,'data'));store.data.runtime={...DEFAULT_RUNTIME,fileCheckpoints:true};
 const run=(code:string,input?:Buffer)=>{const result=spawnSync(python!,['-c',code],{cwd:work,input,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}});return Promise.resolve({stdout:result.stdout,stderr:result.stderr,exitCode:result.status??-1,durationMs:1});};
 const vm={executePython:(code:string,input:Buffer)=>run(code,input),execute:(command:string)=>run(command.slice('python3 -c '.length+1,-1).replaceAll("'\\''","'"))} as unknown as VmController,checkpoints=new FileCheckpoints(store,vm);
 t.after(()=>{store.close();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});return {root,work,store,vm,checkpoints,bot:store.data.bots[0]};
}
test('VM file reads share line paging and hashes, and precise edits preserve bytes and checkpoints',{skip:!available},async t=>{
 const f=fixture(t),path=join(f.work,'source.txt'),before='\ufefffirst\r\n旧值\r\nlast\r\n';writeFileSync(path,before);if(process.platform!=='win32')chmodSync(path,0o755);
 const read=await readVmFile(f.vm,f.bot.id,'source.txt',{startLine:2,lineCount:1,withLineNumbers:true},new AbortController().signal);assert.equal(read.stdout,'2 | 旧值\r\n');assert.equal(read.sha256,hash(before));
 const edited=await patchVmFile(f.vm,f.checkpoints,f.bot.id,'run','source.txt',{oldText:'旧值\n',newText:'新值\n',expectedSha256:read.sha256},new AbortController().signal);assert.equal(edited.exitCode,0);assert.equal(readFileSync(path,'utf8'),before.replace('旧值','新值'));assert.equal(f.checkpoints.list(f.bot.id)[0].afterHash,hash(readFileSync(path)));if(process.platform!=='win32')assert.equal(statSync(path).mode&0o777,0o755);
 await assert.rejects(patchVmFile(f.vm,f.checkpoints,f.bot.id,'run','source.txt',{oldText:'新值',newText:'wrong',expectedSha256:read.sha256},new AbortController().signal),error=>(error as any).code==='FILE_CHANGED');
});
test('VM native files reject paths outside their workspace and oversized reads',{skip:!available},async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'outside.txt'),'private');await assert.rejects(readVmFile(f.vm,f.bot.id,'../outside.txt',{},new AbortController().signal),error=>(error as any).code==='PATH_OUTSIDE_WORKSPACE');
 const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'file.txt'),'private');symlinkSync(outside,join(f.work,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(readVmFile(f.vm,f.bot.id,'linked/file.txt',{},new AbortController().signal),error=>(error as any).code==='PATH_OUTSIDE_WORKSPACE');
 writeFileSync(join(f.work,'large.txt'),'x'.repeat(2*1024*1024+1));await assert.rejects(readVmFile(f.vm,f.bot.id,'large.txt',{},new AbortController().signal),error=>(error as any).code==='FILE_TOO_LARGE');
});
test('VM writes atomically replace files only when an optional expected hash still matches',{skip:!available},async t=>{
 const f=fixture(t),path=join(f.work,'file.txt');writeFileSync(path,'before');
 const denied=await vmPython(f.vm,f.bot.id,{path:'file.txt',content:'wrong',expectedSha256:hash('stale')},VM_WRITE,new AbortController().signal);assert.notEqual(denied.exitCode,0);assert.equal(readFileSync(path,'utf8'),'before');
 const written=await vmPython(f.vm,f.bot.id,{path:'file.txt',content:'after',expectedSha256:hash('before')},VM_WRITE,new AbortController().signal);assert.equal(written.exitCode,0,written.stderr);assert.equal(JSON.parse(written.stdout).sha256,hash('after'));
});
