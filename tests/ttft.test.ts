import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {TokenCountCache} from '../electron/core/token-count-cache';
import {ReplyStreams} from '../electron/core/reply-streams';
import {ModelClient} from '../electron/core/model';
import {DEFAULT_RUNTIME,type UsageRecord} from '../src/runtime-types';
import {protocolRequest} from '../electron/core/model-protocol';

test('long histories reuse token counts beyond the old whole-cache reset threshold',()=>{
 let encodes=0;const cache=new TokenCountCache(text=>{encodes++;return text.length;});
 const history=Array.from({length:2400},(_,i)=>`History ${i}`);
 for(let pass=0;pass<3;pass++)for(const text of history)assert.equal(cache.count(text),text.length);
 assert.equal(encodes,2400);cache.count('New tool result');assert.equal(encodes,2401);
 assert.equal(cache.count(''),0);assert.equal(encodes,2401);
});
test('token counts use bounded LRU eviction and never reuse a count for changed text',()=>{
 let encodes=0;const cache=new TokenCountCache(text=>{encodes++;return text.length;},3);
 for(const text of ['a','bb','ccc','a','dddd','a'])assert.equal(cache.count(text),text.length);
 assert.equal(encodes,4);cache.count('bb');assert.equal(encodes,5);cache.count('ccc');assert.equal(encodes,6);
});
test('the first visible text of each reply bypasses throttling but later chunks remain batched',t=>{
 const snapshots:string[][]=[];const streams=new ReplyStreams(()=>snapshots.push(streams.snapshot().map(r=>r.content)),10000);t.after(()=>streams.dispose());
 const target={botId:'a',runId:'run',time:new Date().toISOString(),main:true};
 const first=streams.begin({...target,id:'one'});first.update('one');assert.equal(snapshots.length,1);
 const second=streams.begin({...target,id:'two'});second.update('<think>private');assert.equal(snapshots.length,1);
 second.update('</think>two');assert.deepEqual(snapshots.at(-1),['one','two']);
 second.update(' more');assert.equal(snapshots.length,2);second.close();assert.equal(snapshots.length,3);
});
for(const toolOnly of [false,true])test(`request timings distinguish first event from text without changing payload (toolOnly=${toolOnly})`,async t=>{
 const records:UsageRecord[]=[],bodies:unknown[]=[];let streamed='';
 const config={baseUrl:'',model:'test',contextTokens:128000,hasKey:false};
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;bodies.push(JSON.parse(raw));
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({choices:[{delta:{role:'assistant'}}]})+'\n\n');
  await new Promise(resolve=>setTimeout(resolve,30));
  const delta=toolOnly?{tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'read',arguments:'{}'}}]}:{content:'Hello'};
  res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:toolOnly?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));config.baseUrl=`http://127.0.0.1:${(server.address() as any).port}/v1`;
 const client=new ModelClient(()=>config,()=>'',undefined,()=>DEFAULT_RUNTIME,record=>records.push(record));
 t.after(()=>{client.dispose();server.closeAllConnections();server.close();});
 const messages=[{role:'user' as const,content:'Read the file'}];
 await client.complete(messages,[],new AbortController().signal,delta=>{streamed+=delta;});
 assert.deepEqual(bodies,[protocolRequest(config,messages,[],65536,'',()=>'',true).body]);
 assert.equal(records.length,1);const timing=records[0].timing!;assert.ok(timing);
 assert.ok(timing.preparationMs!>=0&&timing.responseMs!>=timing.preparationMs!&&timing.firstEventMs!>=timing.responseMs!&&timing.totalMs>=timing.firstEventMs!);
 if(toolOnly){assert.equal(timing.firstTextMs,undefined);assert.equal(streamed,'');}
 else{assert.ok(timing.firstTextMs!>=timing.firstEventMs!);assert.equal(streamed,'Hello');}
 assert.ok(!JSON.stringify(timing).includes('Read the file'));
});
