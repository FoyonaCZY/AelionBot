import test from 'node:test';
import assert from 'node:assert/strict';
import {settleLimited} from '../electron/core/games/request-pool';
test('bounded pool limits concurrent requests and continues after individual failure',async()=>{
 let active=0,max=0;const visited:number[]=[];
 const results=await settleLimited(Array.from({length:12},(_,i)=>i),3,new AbortController().signal,async i=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));visited.push(i);active--;if(i===2)throw Error('test failure');});
 assert.equal(max,3);assert.equal(visited.length,12);assert.equal(results[2].status,'rejected');assert.equal(results.filter(r=>r.status==='fulfilled').length,11);
});
test('cancelled pool never starts queued requests',async()=>{
 const c=new AbortController();const calls:number[]=[];
 await assert.rejects(settleLimited([1,2,3,4],1,c.signal,async i=>{calls.push(i);c.abort();}));assert.deepEqual(calls,[1]);
});
