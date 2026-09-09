import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {PromptCacheDiagnostics,promptCacheKey} from '../electron/core/prompt-cache';
import {ModelClient} from '../electron/core/model';
import {protocolRequest,nativeKey} from '../electron/core/model-protocol';
import {Store} from '../electron/core/store';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {ContextEngine} from '../electron/core/context-engine';
import {Harness} from '../electron/core/harness';
import {TaskScheduler} from '../electron/core/task-scheduler';
import type {WireMessage,ModelConfig} from '../src/shared';
import type {UsageRecord} from '../src/runtime-types';
import type {VmController} from '../electron/core/vm';

const config:ModelConfig={baseUrl:'http://localhost/v1',model:'fixture',contextTokens:64000,hasKey:false,protocol:'responses'};
const signal=()=>new AbortController().signal;
function fixture(t:test.TestContext,cleanup:()=>void=()=>{}){const parent=realpathSync.native(tmpdir()),dir=mkdtempSync(join(parent,'aelion-prompt-cache-')),store=new Store(dir);t.after(()=>{cleanup();store.close();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});store.data.model.model='fixture';store.data.model.contextTokens=64000;return store;}

test('cache keys follow conversation and purpose rather than changing run IDs',()=>{
 const key=promptCacheKey('provider:model','bot:one','foreground');assert.equal(key,promptCacheKey('provider:model','bot:one','foreground'));
 for(const other of [promptCacheKey('provider:model','bot:two','foreground'),promptCacheKey('provider:model','bot:one:group:a','foreground'),promptCacheKey('provider:model','bot:one','progress'),promptCacheKey('provider:other','bot:one','foreground')])assert.notEqual(key,other);
 assert.ok(key.length<=64);assert.ok(!key.includes('bot:one'));
});

test('diagnostics identify tools, options and input divergence without retaining content',()=>{
 const tracker=new PromptCacheDiagnostics(),prefix='private instruction '.repeat(300),body={model:'fixture',tools:[{name:'read'}],input:[{role:'system',content:prefix},{role:'user',content:'secret one'}]};
 const first=tracker.record('one',body);assert.equal(first.firstDifference,'first-request');
 const same=tracker.record('one',body);assert.equal(same.firstDifference,'none');assert.equal(same.matchingInputPrefixBytes,same.inputBytes);
 const changed=tracker.record('one',{...body,input:[body.input[0],{role:'user',content:'secret two'}]});assert.equal(changed.firstDifferentMessage,1);assert.equal(changed.matchingPrefixMessages,1);assert.ok(changed.matchingInputPrefixBytes>=1024);
 assert.equal(tracker.record('one',{...body,tools:[{name:'write'}]}).firstDifference,'tools');
 assert.equal(tracker.record('one',{...body,model:'other'}).firstDifference,'request-options');
 assert.equal(tracker.record('two',body).compared,false);
 assert.doesNotMatch(JSON.stringify(tracker)+JSON.stringify([first,same,changed]),/private instruction|secret one|secret two/);
});

test('real context assembly keeps changing task state after unchanged history',async t=>{
 let close=()=>{};const store=fixture(t,()=>close()),storage=new CognitiveStore(store);close=()=>storage.close();const bot=store.data.bots[0];
 const model={complete:async()=>{throw Error('No compaction expected');}} as unknown as ModelClient,engine=new ContextEngine(storage,model,()=>{});
 const system:WireMessage={role:'system',content:'Fixed rules'},reference:WireMessage={role:'system',content:'Current project and memory'},history:WireMessage[]=[{role:'user',content:'hi'}];
 const prepare=async(id:string,items:WireMessage[])=>{store.data.runs.push({id,botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0});store.message(bot.id,'user','hi',{runId:id});return engine.prepare({botId:bot.id,runId:id,system,prefixContext:[reference],dynamicContext:[{role:'system',content:'Current time: '+id}],history:items,tools:[],signal:signal()});};
 const first=await prepare('r1',history),nextHistory:WireMessage[]=[...history,{role:'assistant',content:'hello'},{role:'user',content:'hi'}],second=await prepare('r2',nextHistory);
 assert.deepEqual(first.messages.slice(0,3),second.messages.slice(0,3));assert.deepEqual(second.messages.slice(2,5),nextHistory);
 assert.ok(second.messages.slice(5).some(m=>m.content?.includes('r2')));assert.ok(!second.messages.slice(0,5).some(m=>m.content?.includes('r2')));
 assert.deepEqual(history,[{role:'user',content:'hi'}]);
});

test('same-Bot runs keep the system prefix stable while current time and reaction targets stay fresh',async t=>{
 const store=fixture(t),captured:WireMessage[][]=[];const model={complete:async(messages:WireMessage[])=>{captured.push(structuredClone(messages));return {content:'hello',calls:[],finishReason:'stop'};}} as unknown as ModelClient;
 const harness=new Harness(store,{} as VmController,model,()=>{}),scheduler=new TaskScheduler(store,{ready:()=>false,send:()=>{}},()=>{});harness.setTaskScheduler(scheduler);t.after(()=>scheduler.dispose());
 await harness.run(store.data.bots[0].id,'hi');await harness.run(store.data.bots[0].id,'hi');
 assert.equal(captured.length,2);assert.deepEqual(captured[0].slice(0,2),captured[1].slice(0,2));
 assert.ok(!captured[0][0].content?.includes('当前时间：'));assert.ok(captured[1].at(-1)?.content?.includes('当前时间：'));
 assert.ok(captured[1].at(-1)?.content?.includes('可回应的消息：'));assert.notEqual(captured[0].at(-1)?.content,captured[1].at(-1)?.content);
});

test('Anthropic breakpoints cover stable sections and history without mutating replayed reasoning',()=>{
 const cfg={...config,protocol:'anthropic' as const},messages:WireMessage[]=[{role:'system',content:'stable'},{role:'system',content:'project'},{role:'user',content:'hi'},{role:'assistant',content:'hello',native:{protocol:'anthropic',key:nativeKey(cfg),data:[{type:'thinking',thinking:'opaque',signature:'signed'},{type:'text',text:'hello',cache_control:{type:'ephemeral'}}]}},{role:'system',content:'fresh runtime'}];
 const before=JSON.stringify(messages),body=protocolRequest(cfg,messages,[],1024,'',()=> '').body as any;
 assert.equal(JSON.stringify(messages),before);assert.equal(body.system.length,2);assert.equal(body.system[0].cache_control.type,'ephemeral');
 assert.equal((JSON.stringify(body).match(/cache_control/g)||[]).length,4);
 const assistant=body.messages.find((m:any)=>m.role==='assistant');assert.equal(assistant.content[0].signature,'signed');assert.equal(assistant.content[0].cache_control,undefined);
 assert.equal(body.messages.at(-1).content.at(-1).cache_control,undefined);
});

async function endpoint(t:test.TestContext,handler:(body:any)=>{status?:number;body:any}){
 const requests:any[]=[];const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);const response=handler(body);res.writeHead(response.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(response.body));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});return {requests,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`};
}
const reply={id:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'hello'}]}],usage:{input_tokens:1200,output_tokens:1,input_tokens_details:{cached_tokens:1024}}};

test('Responses sends a stable key and records fingerprints on real HTTP requests',async t=>{
 const api=await endpoint(t,()=>({body:reply})),records:UsageRecord[]=[],model=new ModelClient(()=>({...config,baseUrl:api.url}),()=>'',undefined,undefined,record=>records.push(record));
 for(const runId of ['one','two'])await model.complete([{role:'user',content:'hi'}],[],signal(),undefined,{botId:'bot',runId,retries:0});
 assert.equal(api.requests[0].prompt_cache_key,api.requests[1].prompt_cache_key);assert.ok(api.requests[0].prompt_cache_key);assert.equal(api.requests[0].store,false);
 assert.equal(records[1].requestCache?.firstDifference,'none');assert.equal(records[1].usage?.cachedTokens,1024);
});

test('explicit unsupported cache-key rejection falls back once without disabling unrelated errors',async t=>{
 const api=await endpoint(t,body=>body.prompt_cache_key?{status:400,body:{error:{param:'prompt_cache_key',message:'Unknown parameter: prompt_cache_key'}}}:{body:reply}),records:UsageRecord[]=[],model=new ModelClient(()=>({...config,baseUrl:api.url}),()=>'',undefined,undefined,record=>records.push(record));
 for(const runId of ['one','two'])await model.complete([{role:'user',content:'hi'}],[],signal(),undefined,{botId:'bot',runId,retries:0});
 assert.equal(api.requests.length,3);assert.ok(api.requests[0].prompt_cache_key);assert.equal(api.requests[1].prompt_cache_key,undefined);assert.equal(api.requests[2].prompt_cache_key,undefined);assert.equal(records[0].requestCache?.cacheKeyRejected,true);
 const invalid=await endpoint(t,()=>({status:400,body:{error:{param:'reasoning',message:'Unsupported reasoning effort'}}}));
 const bad=new ModelClient(()=>({...config,baseUrl:invalid.url}),()=>'');await assert.rejects(bad.complete([{role:'user',content:'hi'}],[],signal(),undefined,{botId:'bot',retries:0}),/reasoning/);assert.equal(invalid.requests.length,1);
});
