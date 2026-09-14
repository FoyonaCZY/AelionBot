import test from 'node:test';
import assert from 'node:assert/strict';
import {isSerialTool,runConcurrentTools} from '../electron/core/tool-concurrency';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('computer and writes stay serialized; independent tools may overlap',()=>{
  assert.equal(isSerialTool('computer'),true);
  assert.equal(isSerialTool('computer_execute'),true);
  assert.equal(isSerialTool('host_file_write'),true);
  assert.equal(isSerialTool('host_file_read'),false);
  assert.equal(isSerialTool('web_search'),false);
  assert.equal(isSerialTool('python_execute'),false);
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
