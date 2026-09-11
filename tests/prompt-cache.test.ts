import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {PromptCacheDiagnostics,promptCacheKey} from '../electron/core/prompt-cache';
import {ModelClient,type ToolDefinition} from '../electron/core/model';
import {protocolRequest,nativeKey} from '../electron/core/model-protocol';
import {Store} from '../electron/core/store';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {ContextEngine} from '../electron/core/context-engine';
import {Harness} from '../electron/core/harness';
import {TaskScheduler} from '../electron/core/task-scheduler';
import {stableToolDefinitions,transportErrorCodes} from '../electron/core/request-snapshot';
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

test('diagnostics identify added, removed and changed tool definitions',()=>{
 const tracker=new PromptCacheDiagnostics(),body={model:'fixture',input:[]};
 tracker.record('one',{...body,tools:[{name:'read',description:'first'},{name:'chat_pin'}]});
 const changed=tracker.record('one',{...body,tools:[{name:'read',description:'second'},{name:'write'}]});
 assert.equal(changed.firstDifference,'tools');assert.deepEqual(changed.toolsAdded,['write']);assert.deepEqual(changed.toolsRemoved,['chat_pin']);assert.deepEqual(changed.toolsChanged,['read']);assert.equal(changed.toolCount,2);
 assert.ok(!JSON.stringify(changed).includes('description'));
});

test('creating a plan keeps tool schemas stable and rejects reactions before execution',async t=>{
 const store=fixture(t),serialized:string[]=[],bot=store.data.bots[0];let turn=0;
 const call=(name:string,args:unknown)=>({id:'call-'+name+'-'+turn,type:'function',function:{name,arguments:JSON.stringify(args)}});
 const plan=(revision=0,done=false)=>({revision,goal:'核对项目',steps:[{id:'check',title:'核对项目',acceptance:'命令成功返回核对结果',status:done?'done':'pending',evidenceIds:done?[store.data.runs[0].executions!.find(e=>e.tool==='computer_execute')!.id]:[]}]});
 const model={complete:async(messages:WireMessage[],tools:ToolDefinition[])=>{
  serialized.push(JSON.stringify(tools));turn++;
  if(turn===1)return {content:'先核对项目。',finishReason:'tool_calls',calls:[call('plan_update',plan()),call('chat_pin',{messageId:store.data.messages.find(m=>m.role==='user')!.id,emoji:'👍'})]};
  assert.ok(messages.some(m=>m.role==='system'&&m.content?.includes('当前工具执行限制')));
  if(turn===2)return {content:'',finishReason:'tool_calls',calls:[call('computer_execute',{command:'verify'})]};
  if(turn===3)return {content:'',finishReason:'tool_calls',calls:[call('plan_update',plan(1,true))]};
  return {content:'已核对项目。',finishReason:'stop',calls:[]};
 }} as unknown as ModelClient;
 await new Harness(store,{execute:async()=>({exitCode:0,stdout:'verified'})} as unknown as VmController,model,()=>{}).run(bot.id,'请核对项目');
 assert.equal(store.data.runs[0].status,'completed');assert.equal(turn,4);assert.equal(new Set(serialized).size,1);
 assert.ok(store.data.messages.every(message=>!message.pins?.length));
 const rejected=store.data.messages.find(message=>message.tool==='chat_pin')!;assert.equal(rejected.status,'cancelled');assert.match(rejected.content,/TOOL_TEMPORARILY_UNAVAILABLE/);assert.match(rejected.content,/"executed":false/);
});

test('large output does not add a new tool schema and read_result is available from the first request',async t=>{
 const store=fixture(t),schemas:string[]=[];let turn=0;
 const model={complete:async(_messages:WireMessage[],tools:ToolDefinition[])=>{
  schemas.push(JSON.stringify(tools));assert.ok(tools.some(tool=>tool.function.name==='read_result'));turn++;
  const name=turn===1?'computer_execute':'read_result',args=turn===1?{command:'read-large-output'}:{id:store.data.runs[0].executions![0].resultId,offset:0,maxChars:200};
  return turn<3?{content:'',finishReason:'tool_calls',calls:[{id:'large-'+turn,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{content:'已读取并核对输出。',finishReason:'stop',calls:[]};
 }} as unknown as ModelClient;
 await new Harness(store,{execute:async()=>({exitCode:0,stdout:'x'.repeat(10000)})} as unknown as VmController,model,()=>{}).run(store.data.bots[0].id,'读取输出');
 assert.equal(store.data.runs[0].status,'completed');assert.equal(turn,3);assert.equal(new Set(schemas).size,1);assert.equal(store.data.runs[0].executions?.[1].status,'succeeded');
});

test('real context assembly keeps changing task state after unchanged history',async t=>{
 let close=()=>{};const store=fixture(t,()=>close()),storage=new CognitiveStore(store);close=()=>storage.close();const bot=store.data.bots[0];
 const model={complete:async()=>{throw Error('No compaction expected');}} as unknown as ModelClient,engine=new ContextEngine(storage,model,()=>{});
 const system:WireMessage={role:'system',content:'Fixed rules'},reference:WireMessage={role:'system',content:'Current project and memory'},history:WireMessage[]=[{role:'user',content:'hi'}];
 const prepare=async(id:string,items:WireMessage[])=>{store.data.runs.push({id,botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0});store.message(bot.id,'user','hi',{runId:id});return engine.prepare({botId:bot.id,runId:id,system,prefixContext:[reference],dynamicContext:[{role:'system',content:'Current time: '+id}],history:items,tools:[],signal:signal()});};
 const first=await prepare('r1',history),nextHistory:WireMessage[]=[...history,{role:'assistant',content:'hello'},{role:'user',content:'hi'}],second=await prepare('r2',nextHistory);
 assert.deepEqual(first.messages,second.messages.slice(0,first.messages.length));assert.deepEqual(second.messages.slice(first.messages.length,first.messages.length+2),nextHistory.slice(1));
 assert.ok(second.messages.slice(first.messages.length+2).some(m=>m.content?.includes('r2')));assert.ok(!second.messages.slice(0,first.messages.length).some(m=>m.content?.includes('r2')));
 assert.deepEqual(history,[{role:'user',content:'hi'}]);
});

test('same-Bot runs keep the system prefix stable while current time and reaction targets stay fresh',async t=>{
 const store=fixture(t),captured:WireMessage[][]=[];const model={complete:async(messages:WireMessage[])=>{captured.push(structuredClone(messages));return {content:'hello',calls:[],finishReason:'stop'};}} as unknown as ModelClient;
 const harness=new Harness(store,{} as VmController,model,()=>{}),scheduler=new TaskScheduler(store,{ready:()=>false,send:()=>{}},()=>{});harness.setTaskScheduler(scheduler);t.after(()=>scheduler.dispose());
 await harness.run(store.data.bots[0].id,'hi');await harness.run(store.data.bots[0].id,'hi');
 assert.equal(captured.length,2);assert.deepEqual(captured[0].slice(0,2),captured[1].slice(0,2));
 assert.ok(!captured[0][0].content?.includes('当前时间：'));assert.ok(captured[1].at(-1)?.content?.includes('当前时间：'));
 assert.ok(captured[1].at(-1)?.content?.includes('Messages available for reactions: '));assert.notEqual(captured[0].at(-1)?.content,captured[1].at(-1)?.content);
});

test('Anthropic breakpoints cover stable sections and history without mutating replayed reasoning',()=>{
 const cfg={...config,protocol:'anthropic' as const},messages:WireMessage[]=[{role:'system',content:'stable'},{role:'system',content:'project'},{role:'user',content:'hi'},{role:'assistant',content:'hello',native:{protocol:'anthropic',key:nativeKey(cfg),data:[{type:'thinking',thinking:'opaque',signature:'signed'},{type:'text',text:'hello',cache_control:{type:'ephemeral'}}]}},{role:'system',content:'fresh runtime'}];
 const before=JSON.stringify(messages),body=protocolRequest(cfg,messages,[],1024,'',()=> '').body as any;
 assert.equal(JSON.stringify(messages),before);assert.equal(body.system.length,2);assert.equal(body.system[0].cache_control.type,'ephemeral');
 assert.equal((JSON.stringify(body).match(/cache_control/g)||[]).length,3);
 const assistant=body.messages.find((m:any)=>m.role==='assistant');assert.equal(assistant.content[0].signature,'signed');assert.equal(assistant.content[0].cache_control,undefined);
 assert.equal(body.messages.at(-1).content.at(-1).cache_control,undefined);
});

async function endpoint(t:test.TestContext,handler:(body:any)=>{status?:number;body:any}){
 const requests:any[]=[],headers:any[]=[];const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);headers.push({...req.headers});const response=handler(body);res.writeHead(response.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(response.body));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});return {requests,headers,url:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`};
}
const reply={id:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'hello'}]}],usage:{input_tokens:1200,output_tokens:1,input_tokens_details:{cached_tokens:1024}}};

test('equivalent tool registries serialize identically without changing schema arrays or source objects',()=>{
 const tools:ToolDefinition[]=[{type:'function',function:{name:'z',description:'last',parameters:{required:['b','a'],properties:{b:{type:'string'},a:{type:'number'}},type:'object'}}},{type:'function',function:{name:'a',description:'first',parameters:{type:'object'}}}];
 const before=JSON.stringify(tools),reordered:ToolDefinition[]=[tools[1],{type:'function',function:{parameters:{type:'object',properties:{a:{type:'number'},b:{type:'string'}},required:['b','a']},description:'last',name:'z'}}];
 const normalized=stableToolDefinitions(tools);assert.equal(JSON.stringify(normalized),JSON.stringify(stableToolDefinitions(reordered)));assert.deepEqual(normalized[1].function.parameters.required,['b','a']);assert.equal(JSON.stringify(tools),before);
 normalized[1].function.description='changed';assert.equal(tools[0].function.description,'last');
});

test('HTTP retries keep a private immutable snapshot of messages and tools',async t=>{
 const messages:WireMessage[]=[{role:'user',content:'original'}],tools:ToolDefinition[]=[{type:'function',function:{name:'read',description:'original tool',parameters:{type:'object',properties:{path:{type:'string'}}}}}];let calls=0;
 const api=await endpoint(t,()=>{if(calls++===0){messages[0].content='changed by caller';(tools[0].function.parameters.properties as any).path.type='number';return {status:503,body:{error:{message:'temporarily unavailable'}}};}return {body:reply};});
 const records:UsageRecord[]=[],model=new ModelClient(()=>({...config,baseUrl:api.url}),()=>'',undefined,undefined,record=>records.push(record));
 await model.complete(messages,tools,signal(),undefined,{botId:'bot',runId:'run',retries:1});assert.equal(calls,2);assert.deepEqual(api.requests[0],api.requests[1]);assert.equal(api.requests[1].input[0].content[0].text,'original');assert.equal(api.requests[1].tools[0].parameters.properties.path.type,'string');assert.equal(records[1].requestCache?.firstDifference,'none');
});

test('Chat requests use stable opaque affinity headers without adding unsupported cache body fields',async t=>{
 const api=await endpoint(t,()=>({body:{choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:1}}}));
 const records:UsageRecord[]=[],model=new ModelClient(()=>({...config,protocol:'chat',baseUrl:api.url}),()=>'',undefined,undefined,record=>records.push(record));
 for(const [cacheScope,runId] of [['main','first'],['main','second'],['private','third']])await model.complete([{role:'user',content:'hi'}],[],signal(),undefined,{botId:'bot',cacheScope,runId,retries:0});
 const keys=api.headers.map(header=>header['x-session-affinity']);assert.equal(keys[0],keys[1]);assert.notEqual(keys[0],keys[2]);assert.match(keys[0],/^aelion-[a-f0-9]{48}$/);assert.equal(api.headers[0]['x-session-id'],keys[0]);assert.ok(api.requests.every(body=>body.prompt_cache_key===undefined));assert.ok(records.every(record=>record.requestCache?.sessionAffinitySent));
});

test('Anthropic history breakpoints use complete parallel tool transactions',()=>{
 const cfg={...config,protocol:'anthropic' as const},calls=['a','b'].map(id=>({id,type:'function' as const,function:{name:'read',arguments:'{}'}}));
 const messages:WireMessage[]=[{role:'system',content:'rules'},{role:'system',content:'project'},{role:'assistant',content:'previous result'},{role:'user',content:'read two files'},{role:'assistant',content:null,tool_calls:calls,native:{protocol:'anthropic',key:nativeKey(cfg),data:[{type:'thinking',thinking:'opaque',signature:'signature'},...calls.map(call=>({type:'tool_use',id:call.id,name:'read',input:{}}))]}},{role:'tool',tool_call_id:'a',content:'one'},{role:'tool',tool_call_id:'b',content:'two'},{role:'system',content:'runtime'}];
 const before=JSON.stringify(messages),body=protocolRequest(cfg,messages,[],4096,'',()=> '').body as any,parts=body.messages.flatMap((message:any)=>message.content);
 assert.equal(parts.find((part:any)=>part.tool_use_id==='a').cache_control,undefined);assert.equal(parts.find((part:any)=>part.tool_use_id==='b').cache_control.type,'ephemeral');assert.equal(parts.find((part:any)=>part.text==='previous result').cache_control.type,'ephemeral');assert.equal(parts.find((part:any)=>part.type==='thinking').cache_control,undefined);assert.equal((JSON.stringify(body).match(/cache_control/g)||[]).length,4);assert.equal(JSON.stringify(messages),before);
 const partial=protocolRequest(cfg,messages.filter(message=>message.tool_call_id!=='b'),[],4096,'',()=> '').body as any;assert.ok(!partial.messages.flatMap((message:any)=>message.content).find((part:any)=>part.tool_use_id==='a').cache_control);
});

test('native Responses output objects are not shared with the request adapter',()=>{
 const cfg={...config,protocol:'responses' as const},message:WireMessage={role:'assistant',content:'answer',native:{protocol:'responses',key:nativeKey(cfg),data:[{id:'rs_1',type:'reasoning',summary:[],encrypted_content:'opaque'},{id:'fc_1',type:'function_call',call_id:'call_1',name:'read',arguments:'{}'}]}};
 const before=JSON.stringify(message),body=protocolRequest(cfg,[message],[],1000,'',()=> '').body as any;body.input[0].encrypted_content='mutation';body.input[1].arguments='mutated';assert.equal(JSON.stringify(message),before);
});

test('diagnostics never label changes beyond the bounded message scan as identical',()=>{
 const tracker=new PromptCacheDiagnostics(),input=Array.from({length:4100},(_,i)=>({role:'user',content:String(i)}));tracker.record('scope',{model:'test',input});input[4098].content='changed beyond scan';const result=tracker.record('scope',{model:'test',input});assert.equal(result.firstDifference,'input-beyond-scan');assert.equal(result.prefixScanTruncated,true);assert.equal(result.matchingPrefixMessages,4096);
 assert.equal(tracker.record('scope',{model:'test',input}).firstDifference,'none');
});

test('transport diagnostics retain bounded error codes without messages or endpoint secrets',()=>{
 const error=new TypeError('fetch failed',{cause:new AggregateError([{code:'ECONNRESET',message:'private-host-and-secret'},{code:'UND_ERR_CONNECT_TIMEOUT',cause:{code:'UNKNOWN_PRIVATE_VALUE'}}])});
 assert.deepEqual(transportErrorCodes(error),['ECONNRESET','UND_ERR_CONNECT_TIMEOUT']);const loop:any={code:'ENOTFOUND'};loop.cause=loop;assert.deepEqual(transportErrorCodes(loop),['ENOTFOUND']);assert.deepEqual(transportErrorCodes({message:'private-host-and-secret'}),[]);
});

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
