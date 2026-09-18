import test from 'node:test';
import assert from 'node:assert/strict';
import {isExclusiveTool,isSerialTool,runConcurrentTools,writeLockPaths} from '../electron/core/tool-concurrency';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('computer stays exclusive; file writes lock by path instead of globally',()=>{
  assert.equal(isExclusiveTool('computer'),true);
  assert.equal(isExclusiveTool('computer_execute'),true);
  assert.equal(isExclusiveTool('host_file_write'),false);
  assert.equal(isSerialTool('host_file_write'),true);
  assert.equal(isSerialTool('host_file_read'),false);
  assert.equal(isSerialTool('web_search'),false);
  assert.deepEqual(writeLockPaths('file_write',{path:'a/note.md'}),['vm:a/note.md']);
  assert.deepEqual(writeLockPaths('host_file_write',{path:'C:\\proj\\a.ts'}),['host:C:/proj/a.ts']);
  assert.deepEqual(writeLockPaths('apply_patch',{patch:'*** Begin Patch\n*** Add File: src/a.ts\n+a\n*** Update File: src/b.ts\n*** End Patch'}),['host:src/a.ts','host:src/b.ts']);
});

test('independent steps start together and a serial step waits for them',async()=>{
  const started:string[]=[],finished:string[]=[],slow=deferred<void>();
  const items=['read-a','read-b','computer','read-c'];
  const pending=runConcurrentTools(items,item=>item==='computer',2,new AbortController().signal,async item=>{
    started.push(item);
    if(item.startsWith('read-a')||item.startsWith('read-b'))await slow.promise;
    finished.push(item);
  });
  await flush();assert.deepEqual(started,['read-a','read-b']);assert.equal(finished.length,0);
  slow.resolve();await pending;
  assert.deepEqual(started,['read-a','read-b','computer','read-c']);
  assert.ok(finished.indexOf('computer')>=1);
  assert.ok(finished.indexOf('computer')<finished.indexOf('read-c')||started.indexOf('computer')<started.indexOf('read-c'));
});

test('two serial computer steps never overlap',async()=>{
  let active=0,peak=0;
  await runConcurrentTools(['computer','computer'],()=>true,4,new AbortController().signal,async()=>{
    active++;peak=Math.max(peak,active);await flush();active--;
  });
  assert.equal(peak,1);
});
test('independent reads are not capped by a concurrency number',async()=>{
  const started:string[]=[],slow=deferred<void>();
  const items=['a','b','c','d','e'];
  const pending=runConcurrentTools(items,()=>false,1,new AbortController().signal,async item=>{started.push(item);await slow.promise;});
  await flush();assert.equal(started.length,items.length);assert.deepEqual([...started].sort(),items);slow.resolve();await pending;
});
test('writes to different files overlap while the same path stays exclusive',async()=>{
  const active=new Map<string,number>(),peak=new Map<string,number>(),started:string[]=[];
  const slow=deferred<void>();
  const items=['a.ts','b.ts','a.ts'];
  const pending=runConcurrentTools(items,()=>false,4,new AbortController().signal,async item=>{
    started.push(item);active.set(item,(active.get(item)||0)+1);peak.set(item,Math.max(peak.get(item)||0,active.get(item)!));
    if(started.length<3)await slow.promise;
    active.set(item,(active.get(item)||1)-1);
  },item=>['vm:'+item]);
  await flush();assert.deepEqual(new Set(started),new Set(['a.ts','b.ts']));
  slow.resolve();await pending;
  assert.equal(peak.get('a.ts'),1);assert.equal(peak.get('b.ts'),1);assert.equal(started.length,3);
});
