import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {ReplyStreams} from '../electron/core/reply-streams';
import {streamingReplyText} from '../src/streaming';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {ModelClient,type Completion} from '../electron/core/model';
import {BotGreetings} from '../electron/core/bot-greetings';
import {GroupChats} from '../electron/core/group-chats';
import {PeerChats} from '../electron/core/peer-chats';
import {groupPending} from '../src/group-types';
import type {VmController} from '../electron/core/vm';
import type {WireMessage} from '../src/shared';

const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'});
const tool=(name:string,args:unknown):Completion=>({content:'',calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}],finishReason:'tool_calls'});
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function until(check:()=>boolean){for(let n=0;n<500;n++){if(check())return;await pause(10);}throw new Error('Streaming test did not settle');}
function fixture(t:test.TestContext,complete:ModelClient['complete'],vm={} as VmController){
  const dir=mkdtempSync(join(tmpdir(),'aelion-stream-')),store=new Store(dir);store.data.model.model='fixture';store.data.model.contextTokens=64000;
  const cleanup:Array<()=>void|Promise<void>>=[],model={complete} as ModelClient;let changed=()=>{};
  const harness=new Harness(store,vm,model,()=>changed()),bot=store.data.bots[0];
  t.after(async()=>{for(const bot of store.data.bots)harness.cancel(bot.id);for(const close of cleanup)await close();await until(()=>!harness.busy);harness.streams.dispose();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,model,harness,bot,cleanup,onChange:(callback:()=>void)=>{changed=callback;}};
}

test('stream previews hide fragmented control tokens and reasoning, resolve mentions and flush the trailing chunk',async t=>{
  const seen:string[]=[];const streams=new ReplyStreams(()=>seen.push(streams.snapshot()[0]?.content||''),30);t.after(()=>streams.dispose());
  const target={id:'message',botId:'a',runId:'run',time:new Date().toISOString(),main:true};
  const current=streams.begin(target,()=>[{id:'b',name:'伙伴',color:'#268bfa'}]);
  let raw='';for(const letter of '<think>hidden reasoning</think>你好'){raw+=letter;assert.ok(!streamingReplyText(raw).includes('hidden'));}
  for(const marker of ['[群聊静默]','[表情静默]'])for(let n=1;n<=marker.length;n++)assert.equal(streamingReplyText(marker.slice(0,n)),'');
  assert.equal(streamingReplyText('正文[群聊静'),'正文');
  current.update('<thi');assert.equal(streams.snapshot().length,0);current.update('nk>hidden reasoning</think>你好');current.update('，@{b');assert.equal(streams.snapshot()[0].content,'你好，');current.update('} 请核对');
  await until(()=>seen.at(-1)==='你好，@伙伴 请核对');assert.equal(streams.snapshot()[0].mentions?.[0].id,'b');assert.ok(seen.every(text=>!text.includes('hidden')));
  const snapshot=streams.snapshot();snapshot[0].content='mutated';assert.notEqual(streams.snapshot()[0].content,'mutated');
  streams.dropRun('run');current.update('late');assert.equal(streams.snapshot().length,0);
  const replacement=streams.begin(target);replacement.update('新内容');current.update('旧尾巴');assert.equal(streams.snapshot()[0].content,'新内容');replacement.close();assert.equal(streams.snapshot().length,0);
});

test('a real SSE reply is visible before the server finishes and commits only once',async t=>{
  const finish=deferred<void>(),first=deferred<void>();let requests=0;
  const server=createServer(async(req,res)=>{for await(const _part of req){}requests++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'第一段'}}]})+'\n\n');first.resolve();await finish.promise;if(res.destroyed)return;res.end('data: '+JSON.stringify({choices:[{delta:{content:'，第二段'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as any).port;
  const client=new ModelClient(()=>({baseUrl:`http://127.0.0.1:${port}/v1`,model:'fixture',contextTokens:64000,hasKey:false}),()=>''),f=fixture(t,client.complete.bind(client));f.cleanup.push(async()=>{finish.resolve();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});
  const pending=f.harness.run(f.bot.id,'请逐段回复');await first.promise;await until(()=>f.harness.streams.snapshot()[0]?.content==='第一段');
  assert.equal(f.store.data.runs[0].status,'running');assert.ok(!f.store.data.conversations[f.bot.id].some(message=>message.role==='assistant'));assert.equal(f.harness.streams.snapshot()[0].main,true);
  finish.resolve();await pending;assert.equal(requests,1);assert.equal(f.harness.streams.snapshot().length,0);assert.equal(f.store.data.messages.filter(message=>message.presentation==='answer'&&message.content==='第一段，第二段').length,1);
});

test('a cancelled or superseded stream cannot append late fragments into the next reply',async t=>{
  const old=deferred<Completion>(),next=deferred<Completion>();let oldText:(text:string)=>void=()=>{},nextText:(text:string)=>void=()=>{},calls=0;
  const f=fixture(t,async(_messages,_tools,_signal,onText)=>{if(++calls===1){oldText=onText!;onText?.('旧回复');return old.promise;}nextText=onText!;onText?.('新回复');return next.promise;});
  const previous=f.harness.run(f.bot.id,'旧请求');await until(()=>f.harness.streams.snapshot().length===1);f.harness.refreshInput(f.bot.id);await previous;oldText('过期尾巴');assert.equal(f.harness.streams.snapshot().length,0);
  const current=f.harness.run(f.bot.id,'新请求');await until(()=>f.harness.streams.snapshot()[0]?.content==='新回复');oldText('不得污染');assert.equal(f.harness.streams.snapshot()[0].content,'新回复');nextText('进行中');f.harness.cancel(f.bot.id);await current;nextText('取消后的片段');assert.equal(f.harness.streams.snapshot().length,0);assert.ok(f.store.data.runs.every(run=>run.status==='cancelled'));old.resolve(answer('旧最终'));next.resolve(answer('新最终'));await pause(10);assert.ok(!f.store.data.messages.some(message=>message.presentation==='answer'));
});

test('streamed tool arguments never execute before the complete tool call and are not preview text',async t=>{
  const finish=deferred<void>();let executions=0,requests=0;
  const server=createServer(async(req,res)=>{for await(const _part of req){}res.writeHead(200,{'Content-Type':'text/event-stream'});if(++requests===1){res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'tool-call',type:'function',function:{name:'computer_execute',arguments:'{"command":"run'}}]}}]})+'\n\n');await finish.promise;if(res.destroyed)return;res.end('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'-once"}'}}]},finish_reason:'tool_calls'}]})+'\n\n');}else res.end('data: '+JSON.stringify({choices:[{delta:{content:'完成'},finish_reason:'stop'}]})+'\n\n');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const client=new ModelClient(()=>({baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture',contextTokens:64000,hasKey:false}),()=>''),vm={execute:async()=>{executions++;return {stdout:'done',stderr:'',exitCode:0,durationMs:1};}} as unknown as VmController;
  const f=fixture(t,client.complete.bind(client),vm);f.cleanup.push(async()=>{finish.resolve();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));});const pending=f.harness.run(f.bot.id,'执行一次');await until(()=>requests===1);await pause(60);assert.equal(executions,0);assert.equal(f.harness.streams.snapshot().length,0);finish.resolve();await pending;assert.equal(executions,1);assert.equal(f.store.data.runs[0].status,'completed');
});

test('the SSE completion marker finishes the reply even if the server keeps the connection open',async t=>{
  let closed=false;
  const server=createServer(async(req,res)=>{for await(const _part of req){}res.on('close',()=>{closed=true;});res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"完整答复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>{server.closeAllConnections();server.close();});
  const client=new ModelClient(()=>({baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture',contextTokens:32000,hasKey:false}),()=>''),result=await client.complete([{role:'user',content:'回复'}],[],AbortSignal.timeout(2000));assert.equal(result.content,'完整答复');await until(()=>closed);
});

test('group drafts stay hidden and only completed replies enter the group after superseded generation is discarded',async t=>{
  const first=deferred<Completion>(),second=deferred<Completion>();let late:(text:string)=>void=()=>{},began=0,secondCalls=0;
  const f=fixture(t,async(messages,_tools,_signal,onText)=>{const id=/\/work\/([a-f0-9-]+)/.exec(messages[0].content||'')![1];began++;if(id===f.bot.id){onText?.('甲的半句');return first.promise;}if(++secondCalls===1){late=onText!;onText?.('乙的半句');return second.promise;}return answer('[群聊静默]');});const other=f.store.createBot('乙','协作');
  const groups=new GroupChats(f.store,{isRunning:id=>f.harness.isRunning(id),run:(...args)=>f.harness.run(...args),cancel:id=>f.harness.cancel(id),refresh:id=>f.harness.refreshGroup(id)},()=>{});f.harness.setGroupGateway(groups);f.onChange(()=>groups.wake());groups.start();f.cleanup.push(()=>groups.dispose());
  const room=groups.create({name:'完整回复群',botIds:[f.bot.id,other.id]});groups.send({id:room.id,message:'分别发表观点'});await until(()=>began===2);const revision=groups.snapshot().revision;
  assert.equal(f.harness.streams.snapshot().length,0);assert.equal(groups.read({id:room.id}).messages.filter(message=>message.sender.kind==='bot').length,0);assert.ok(!JSON.stringify(f.store.data.groupContexts).includes('半句'));
  late('后半段');await pause(130);assert.equal(groups.snapshot().revision,revision);assert.equal(began,2);assert.equal(f.harness.streams.snapshot().length,0);
  first.resolve(answer('甲已完整发表'));await until(()=>secondCalls===2);late('过期文字');second.resolve(answer('乙的旧内容'));await until(()=>!groups.busy&&!f.harness.busy&&!f.store.data.groupDeliveries.some(delivery=>groupPending(delivery.status)));
  assert.equal(f.harness.streams.snapshot().length,0);assert.deepEqual(groups.read({id:room.id}).messages.filter(message=>message.sender.kind==='bot').map(message=>message.content),['甲已完整发表']);assert.ok(!JSON.stringify(f.store.data.groupContexts).includes('过期文字'));
});

test('private reply previews stay in their thread and the sender summary streams in the user conversation',async t=>{
  const received=deferred<Completion>(),summary=deferred<Completion>();let sent=false;
  const f=fixture(t,async(messages,_tools,_signal,onText)=>{const system=messages.filter(message=>message.role==='system').map(message=>message.content||'').join('\n');if(system.includes(`/work/${other.id}`)){onText?.('私聊回复片段');return received.promise;}if(system.includes('这是先前联络的实际回信')){onText?.('给用户的总结片段');return summary.promise;}if(!sent){sent=true;return tool('bot_send_message',{botId:other.id,message:'当前状态如何？'});}return answer('已联络');});const other=f.store.createBot('乙','协作');
  const peers=new PeerChats(f.store,{isRunning:id=>f.harness.isRunning(id),run:(...args)=>f.harness.run(...args),cancel:id=>f.harness.cancel(id)},()=>{});f.harness.setPeerGateway(peers);f.onChange(()=>peers.wake());peers.start();f.cleanup.push(()=>peers.dispose());
  await f.harness.run(f.bot.id,'问问乙当前状态');await until(()=>f.harness.streams.snapshot().some(reply=>reply.botId===other.id));const preview=f.harness.streams.snapshot()[0],exchange=f.store.data.peerExchanges[0];assert.equal(preview.peerThreadId,exchange.threadId);assert.equal(preview.main,false);assert.equal(peers.read({threadId:exchange.threadId}).messages.length,1);
  received.resolve(answer('私聊完整回复'));await until(()=>f.harness.streams.snapshot().some(reply=>reply.botId===f.bot.id));const outgoing=f.harness.streams.snapshot()[0];assert.equal(outgoing.main,true);assert.equal(outgoing.peerThreadId,undefined);assert.equal(peers.read({threadId:exchange.threadId}).messages.length,2);
  summary.resolve(answer('给用户的完整总结'));await until(()=>exchange.status==='completed');assert.equal(f.harness.streams.snapshot().length,0);assert.equal(f.store.data.messages.filter(message=>message.audience==='user'&&message.content==='给用户的完整总结').length,1);
});

test('the first greeting streams without persisting a partial welcome and keeps one final message',async t=>{
  const finish=deferred<Completion>();let text:(value:string)=>void=()=>{};
  const f=fixture(t,async()=>answer('unused')),greetings=new BotGreetings(f.store,{complete:async(_m,_t,_s,onText)=>{text=onText!;onText?.('你好，');return finish.promise;}},()=>{});f.cleanup.push(()=>greetings.dispose());
  const pending=greetings.greet(f.bot.id);await until(()=>greetings.streams.snapshot().length===1);assert.equal(f.store.data.messages.length,0);assert.deepEqual(f.store.data.conversations[f.bot.id],[]);const id=greetings.streams.snapshot()[0].id;
  text('我是你的伙伴。');finish.resolve(answer('你好，我是你的伙伴。'));await pending;assert.equal(greetings.streams.snapshot().length,0);assert.equal(f.store.data.messages.length,1);assert.equal(f.store.data.messages[0].id,id);text('迟到片段');assert.equal(greetings.streams.snapshot().length,0);
});

test('model-authored intermediate messages stream and persist without helper requests',async t=>{
  const finish=deferred<Completion>();let requests=0;
  const f=fixture(t,async(_messages,_tools,_signal,onText)=>{requests++;if(requests===4){onText?.('三步检查已完成');return finish.promise;}return requests<4?tool('computer_execute',{command:'check'}):answer('任务完成');},{execute:async()=>({stdout:'ok',stderr:'',exitCode:0,durationMs:1})} as unknown as VmController);
  const pending=f.harness.run(f.bot.id,'完成检查');await until(()=>f.harness.streams.snapshot().some(reply=>reply.content.includes('三步检查已完成')));const preview=f.harness.streams.snapshot()[0];assert.equal(preview.main,true);assert.ok(!f.store.data.messages.some(message=>message.status==='done'&&message.content==='三步检查已完成'));
  finish.resolve({...tool('computer_execute',{command:'final-check'}),content:'三步检查已完成，继续核对最后一项。'});await pending;assert.equal(requests,5);assert.equal(f.harness.streams.snapshot().length,0);assert.equal(f.store.data.messages.filter(message=>message.id===preview.id&&message.presentation==='progress').length,1);
});
