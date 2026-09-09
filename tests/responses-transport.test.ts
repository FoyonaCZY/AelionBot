import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import type {AddressInfo} from 'node:net';
import {ModelClient,assistantMessage} from '../electron/core/model';
import {ResponsesTransport,websocketEnabled} from '../electron/core/responses-transport';
import {DEFAULT_RUNTIME,type UsageRecord} from '../src/runtime-types';
import type {ModelConfig,WireMessage} from '../src/shared';
import {modelParameters} from '../electron/core/model-providers';

const output=(text:string)=>[{type:'message',id:'msg_'+text,role:'assistant',content:[{type:'output_text',text}]}];
async function fixture(t:test.TestContext,receive:(payload:any,socket:any,index:number)=>void){
 let http=0,connections=0;const requests:any[]=[],records:UsageRecord[]=[];
 const server=createServer((_request,response)=>{http++;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({id:'resp_http',status:'completed',output:output('http'),usage:{input_tokens:30,output_tokens:1}}));});
 const ws=new WebSocketServer({server});ws.on('connection',socket=>{connections++;socket.on('message',data=>{const payload=JSON.parse(data.toString());requests.push(payload);receive(payload,socket,requests.length);});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const config:ModelConfig={baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,model:'fixture',protocol:'responses',responsesTransport:'websocket',contextTokens:128000,hasKey:false};
 const client=new ModelClient(()=>config,()=>'',undefined,()=>({...DEFAULT_RUNTIME,modelRetries:1,requestTimeoutMs:3000}),record=>records.push(record));
 t.after(async()=>{client.dispose();for(const socket of ws.clients)socket.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));});
 return {client,config,requests,records,http:()=>http,connections:()=>connections};
}
function completed(socket:any,id:string,text:string){socket.send(JSON.stringify({type:'response.completed',response:{id,status:'completed',output:output(text),usage:{input_tokens:30,output_tokens:1}}}));}

test('Responses sends only strict extensions on a reused connection, with full logical diagnostics',async t=>{
 const f=await fixture(t,(_payload,socket,index)=>completed(socket,'resp_'+index,'answer'+index)),messages:WireMessage[]=[{role:'system',content:'rules'},{role:'user',content:'hi'}];
 const first=await f.client.complete(messages,[],new AbortController().signal,undefined,{botId:'a'});
 messages.push(assistantMessage(first),{role:'user',content:'continue'});await f.client.complete(messages,[],new AbortController().signal,undefined,{botId:'a'});
 assert.equal(f.connections(),1);assert.equal(f.http(),0);assert.equal(f.requests[1].previous_response_id,'resp_1');assert.equal(f.requests[1].input.length,1);assert.equal(f.requests[1].store,false);assert.equal(f.requests[1].stream,undefined);
 assert.equal(f.records[1].requestCache?.transport,'websocket');assert.equal(f.records[1].requestCache?.incremental,true);assert.equal(f.records[1].requestCache?.strictContinuation,true);assert.equal(f.records[1].requestCache?.inputMessages,4);
});
test('missing previous response recovers once with full context without changing store=false',async t=>{
 const f=await fixture(t,(payload,socket,index)=>{if(payload.previous_response_id){socket.send(JSON.stringify({type:'response.created',response:{id:'pending'}}));socket.send(JSON.stringify({type:'error',error:{code:'previous_response_not_found'}}));}else completed(socket,'resp_'+index,'answer'+index);}),messages:WireMessage[]=[{role:'user',content:'hi'}];
 const first=await f.client.complete(messages,[],new AbortController().signal,undefined,{botId:'a'});messages.push(assistantMessage(first),{role:'user',content:'next'});await f.client.complete(messages,[],new AbortController().signal,undefined,{botId:'a'});
 assert.equal(f.requests.length,3);assert.equal(f.requests[2].previous_response_id,undefined);assert.equal(f.requests[2].input.length,3);assert.equal(f.requests[2].store,false);assert.equal(f.http(),0);
 assert.equal(f.records.at(-1)?.requestCache?.incremental,false);assert.equal(f.records.at(-1)?.requestCache?.sentInputItems,3);
});
test('rewritten prefixes and different Bot scopes cannot continue another request chain',async t=>{
 const f=await fixture(t,(_payload,socket,index)=>completed(socket,'resp_'+index,'answer'+index));
 await f.client.complete([{role:'user',content:'old'}],[],new AbortController().signal,undefined,{botId:'a'});
 await f.client.complete([{role:'user',content:'changed'}],[],new AbortController().signal,undefined,{botId:'a'});
 await f.client.complete([{role:'user',content:'changed'}],[],new AbortController().signal,undefined,{botId:'b'});
 assert.equal(f.requests[1].previous_response_id,undefined);assert.equal(f.requests[2].previous_response_id,undefined);assert.equal(f.connections(),2);
});
test('unsupported websocket requests fall back to HTTP and do not probe on every model step',async t=>{
 const f=await fixture(t,(_payload,socket)=>socket.send(JSON.stringify({type:'error',error:{code:'unsupported_transport'}})));
 for(let i=0;i<2;i++)assert.equal((await f.client.complete([{role:'user',content:'hi'}],[],new AbortController().signal,undefined,{botId:'a'})).content,'http');
 assert.equal(f.requests.length,1);assert.equal(f.http(),2);assert.equal(f.records[0].requestCache?.transport,'http');
});
test('a dropped streaming connection resets partial UI text before complete HTTP recovery',async t=>{
 const f=await fixture(t,(_payload,socket)=>{socket.send(JSON.stringify({type:'response.output_text.delta',delta:'partial'}));setTimeout(()=>socket.terminate(),10);});let resets=0,text='';
 const result=await f.client.complete([{role:'user',content:'hi'}],[],new AbortController().signal,delta=>text+=delta,{botId:'a',onReset:()=>{resets++;text='';}});
 assert.equal(result.content,'http');assert.equal(text,'http');assert.equal(resets,1);assert.equal(f.http(),1);
});
test('aborting an incremental connection does not fall back and releases the busy lane',async t=>{
 let sent!:()=>void;const started=new Promise<void>(resolve=>sent=resolve);const f=await fixture(t,()=>sent()),controller=new AbortController();
 const pending=f.client.complete([{role:'user',content:'hi'}],[],controller.signal,undefined,{botId:'a'});await started;controller.abort();await assert.rejects(pending);assert.equal(f.http(),0);f.client.dispose();
});
test('transport configuration is validated; compatible endpoints are not assumed to support websockets',()=>{
 assert.equal(websocketEnabled({baseUrl:'https://example.com/v1',protocol:'responses'} as ModelConfig),false);
 assert.equal(websocketEnabled({baseUrl:'https://example.com/v1',protocol:'responses',responsesTransport:'websocket'} as ModelConfig),true);
 assert.equal(modelParameters({responsesTransport:'http'}).responsesTransport,'http');assert.throws(()=>modelParameters({responsesTransport:'invalid'} as any));
 const transport=new ResponsesTransport();transport.dispose();
});
