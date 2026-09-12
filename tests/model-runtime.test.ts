import type {ModelRequestStatus} from '../src/model-request-status';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type RequestListener} from 'node:http';
import {ModelClient,assistantMessage} from '../electron/core/model';
import {protocolRequest,StreamAccumulator,nativeKey} from '../electron/core/model-protocol';
import {DEFAULT_RUNTIME} from '../src/runtime-types';
import type {ModelConfig} from '../src/shared';
async function server(t:test.TestContext,handler:RequestListener){const s=createServer(handler);await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));t.after(()=>{s.closeAllConnections();s.close();});return `http://127.0.0.1:${(s.address() as any).port}/v1`;}
const cfg:ModelConfig={baseUrl:'http://localhost:1/v1',model:'test',hasKey:false,contextTokens:32000};

test('requests use the full configured output allowance immediately and honor explicit smaller limits',async t=>{
 const limits:number[]=[];const baseUrl=await server(t,async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;limits.push(JSON.parse(body).max_tokens);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));});
 const model=new ModelClient(()=>({...cfg,baseUrl,contextTokens:128000}),()=> '');t.after(()=>model.dispose());
 await model.complete([{role:'user',content:'long document'}],[],new AbortController().signal);
 await model.complete([],[],new AbortController().signal,undefined,{maxOutputTokens:1024});
 const configured=new ModelClient(()=>({...cfg,baseUrl,contextTokens:128000}),()=> '',undefined,()=>({...DEFAULT_RUNTIME,maxOutputTokens:8192}));t.after(()=>configured.dispose());await configured.complete([],[],new AbortController().signal);
 assert.deepEqual(limits,[65536,1024,8192]);
});
test('429 retries are bounded; failed partial previews reset before retry and only complete calls escape',async t=>{
 let count=0,resets=0,visible='';const statuses:ModelRequestStatus[]=[];const baseUrl=await server(t,async(req,res)=>{for await(const _ of req){}count++;if(count===1){res.writeHead(429,{'retry-after':'0.001'});res.end('busy');return;}res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:count===2?'partial':'finished'}}]})+'\n\n');if(count===3)res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');res.end();});
 const model=new ModelClient(()=>({...cfg,baseUrl}),()=> '');const result=await model.complete([{role:'user',content:'test'}],[],new AbortController().signal,t=>visible+=t,{onStatus:status=>statuses.push(status),onReset:()=>{resets++;visible='';}});
 assert.equal(count,3);assert.equal(resets,1);assert.equal(visible,'finished');assert.equal(result.content,'finished');assert.deepEqual(statuses.map(s=>s.phase),['waiting','retrying','waiting','retrying','waiting']);assert.equal(statuses[1].reason,'rate_limit');assert.equal(statuses[1].attempt,1);assert.doesNotMatch(JSON.stringify(statuses),/busy|partial|finished/);
});
test('authentication failures are not retried and cancellation interrupts backoff',async t=>{
 let count=0;const baseUrl=await server(t,async(req,res)=>{for await(const _ of req){}count++;res.writeHead(count===1?401:429,{'retry-after':'30'});res.end('denied');});
 const model=new ModelClient(()=>({...cfg,baseUrl}),()=> '');await assert.rejects(model.complete([],[],new AbortController().signal),/401/);assert.equal(count,1);
 const controller=new AbortController();setTimeout(()=>controller.abort(Error('cancelled by test')),100);await assert.rejects(model.complete([],[],controller.signal),/cancelled by test/);assert.equal(count,2);
});
test('Responses reasoning and call IDs survive the next tool turn but never cross model boundaries',()=>{
 const config={...cfg,protocol:'responses' as const},parser=new StreamAccumulator('responses',nativeKey(config),()=>{});
 const reasoning={type:'reasoning',id:'rs_1',summary:[],encrypted_content:'opaque-signature'};
 parser.consume({type:'response.completed',response:{output:[reasoning,{type:'function_call',id:'fc_1',call_id:'call_1',name:'file_read',arguments:'{"path":"a"}'}],usage:{input_tokens:30,output_tokens:20,input_tokens_details:{cached_tokens:10},output_tokens_details:{reasoning_tokens:5}}}});
 const result=parser.result();assert.equal(result.calls[0].id,'call_1');assert.equal(result.usage?.cachedTokens,10);
 const history=[assistantMessage(result),{role:'tool' as const,tool_call_id:'call_1',content:'a'}];
 const body=protocolRequest(config,history,[],4096,'',()=> '') .body as any;assert.deepEqual(body.input[0],reasoning);assert.equal(body.input[2].type,'function_call_output');assert.equal(body.store,false);
 const other=protocolRequest({...config,model:'different'},history,[],4096,'',()=> '').body as any;assert.ok(!JSON.stringify(other).includes('opaque-signature'));
});
test('Claude thinking signatures and fragmented JSON remain opaque and are returned unchanged',()=>{
 const config={...cfg,protocol:'anthropic' as const},parser=new StreamAccumulator('anthropic',nativeKey(config),()=>{});
 for(const event of [{type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:5}}},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'private reasoning'}},{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'signature'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'t',name:'read',input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"path":"a"}'}},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:30}},{type:'message_stop'}])parser.consume(event);
 const result=parser.result();assert.equal(result.content,'');assert.equal(result.calls[0].function.arguments,'{"path":"a"}');
 const body=protocolRequest(config,[assistantMessage(result),{role:'tool',tool_call_id:'t',content:'ok'}],[],4096,'',()=> '').body as any;assert.equal(body.messages[0].content[0].signature,'signature');assert.equal(body.messages[1].content[0].tool_use_id,'t');
});
test('Gemini preserves thoughtSignature with the exact function-call part',()=>{
 const config={...cfg,protocol:'gemini' as const},parser=new StreamAccumulator('gemini',nativeKey(config),()=>{});
 parser.consume({candidates:[{content:{parts:[{functionCall:{name:'read',args:{path:'a'},id:'g1'},thoughtSignature:'opaque'}]},finishReason:'STOP'}]});
 const result=parser.result(),body=protocolRequest(config,[assistantMessage(result),{role:'tool',tool_call_id:'g1',content:'ok'}],[],4096,'',()=> '').body as any;
 assert.equal(body.contents[0].parts[0].thoughtSignature,'opaque');assert.equal(body.contents[1].parts[0].functionResponse.name,'read');
});


test('request context telemetry arrives before the response and cannot break inference',async t=>{
 let reported=false;let observed:import("../src/context-overview").ContextOverview|undefined;
 const baseUrl=await server(t,async(req,res)=>{for await(const _ of req){}assert.ok(reported);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));});
 const model=new ModelClient(()=>({...cfg,baseUrl}),()=> '');t.after(()=>model.dispose());
 const result=await model.complete([{role:'user',content:'Current request'}],[],new AbortController().signal,undefined,{onContext:overview=>{reported=true;observed=overview;throw Error('UI observer failure');}});
 assert.equal(result.content,'ok');assert.equal(observed?.capacity,32000);assert.ok(observed!.parts.conversation>0);
});
