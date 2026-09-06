import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {PeerChats} from '../electron/core/peer-chats';
import {Interactions} from '../electron/core/interactions';
import {HostComputer} from '../electron/core/host';
import type {ModelClient,Completion,ToolDefinition} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';
import type {WireMessage} from '../src/shared';
import {peerPending} from '../src/peer-types';

const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'});
const tool=(name:string,args:Record<string,unknown>):Completion=>({content:'正在联络。',finishReason:'tool_calls',calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean){for(let i=0;i<400;i++){if(predicate())return;await delay(10);}throw new Error('私聊测试等待超时');}
function fixture(t:test.TestContext,complete:(botId:string,messages:WireMessage[],tools:ToolDefinition[],signal:AbortSignal)=>Promise<Completion>|Completion){
  const dir=mkdtempSync(join(tmpdir(),'aelion-peer-test-')),store=new Store(dir),a=store.data.bots[0],b=store.createBot('数据伙伴','分析数据'),c=store.createBot('检查伙伴','核对结果'),busy=new Set<string>();let peers:PeerChats|undefined;
  const interactions=new Interactions(()=>peers?.wake()),host=new HostComputer({dataDir:dir,homeDir:dir,projectDir:dir},interactions);
  const model={complete:async(messages:WireMessage[],tools:ToolDefinition[],signal:AbortSignal)=>{const system=messages[0].content||'',id=/\/work\/([a-f0-9-]+)/.exec(system)?.[1];assert.ok(id);return complete(id,messages,tools,signal);}} as unknown as ModelClient;
  const harness=new Harness(store,{} as VmController,model,()=>peers?.wake(),undefined,undefined,undefined,host,interactions);
  peers=new PeerChats(store,{isRunning:id=>busy.has(id)||harness.isRunning(id),run:(id,input,options)=>harness.run(id,input,options),cancel:id=>harness.cancel(id)},()=>{});harness.setPeerGateway(peers);peers.start();
  t.after(async()=>{peers!.dispose();for(const bot of store.data.bots)harness.cancel(bot.id);await until(()=>!harness.busy);host.dispose();interactions.dispose();await delay(20);assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('aelion-peer-test-'));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,a,b,c,busy,harness,peers,interactions};
}

test('private dialogue stays isolated and only the sender final summary is published for the user',async t=>{
  let rootCalls=0,recipientCalls=0,relayCalls=0;const fx=fixture(t,(id,messages,tools)=>{
    const context=messages[0].content||'';
    if(id===fx.b.id){recipientCalls++;assert.ok(!context.includes('另一项任务的秘密'));assert.ok(!tools.some(tool=>tool.function.name==='memory'));return answer('目前空闲，上一项是数据核对。');}
    if(context.includes('这是先前联络的实际回信')){relayCalls++;assert.equal(tools.length,0);assert.match(messages.at(-1)!.content||'',/目前空闲/);return answer('数据伙伴目前空闲，上一项是数据核对。');}
    return rootCalls++===0?tool('bot_send_message',{botId:fx.b.id,message:'你现在在忙什么？'}):answer('已联系数据伙伴，正在等回复。');
  });
  fx.store.data.conversations[fx.a.id].push({role:'user',content:'另一项任务的秘密'});fx.busy.add(fx.b.id);
  await fx.harness.run(fx.a.id,'问问数据伙伴在做什么');assert.equal(fx.harness.isRunning(fx.a.id),false);assert.equal(recipientCalls,0);assert.equal(fx.store.data.peerExchanges[0].status,'queued');
  fx.busy.add(fx.a.id);fx.busy.delete(fx.b.id);fx.peers.wake();await until(()=>fx.store.data.peerExchanges[0].status==='reply_queued');assert.equal(relayCalls,0);
  fx.busy.delete(fx.a.id);fx.peers.wake();await until(()=>fx.store.data.peerExchanges[0].status==='completed');assert.equal(recipientCalls,1);assert.equal(relayCalls,1);
  assert.equal(fx.store.data.messages.filter(message=>message.role==='user').length,1);assert.ok(fx.store.data.messages.some(message=>message.peer?.direction==='received'&&message.botId===fx.a.id));
  assert.equal(fx.store.data.messages.filter(message=>message.botId===fx.b.id&&message.role!=='event').length,0);
  assert.deepEqual(fx.store.data.messages.filter(message=>message.botId===fx.b.id).map(message=>message.peer?.direction),['received','sent']);
  assert.ok(fx.store.data.peerMessages.some(message=>message.botId===fx.b.id&&message.content.includes('目前空闲')));
  const final=fx.store.data.messages.find(message=>message.audience==='user');assert.equal(final?.content,'数据伙伴目前空闲，上一项是数据核对。');assert.equal(final?.botId,fx.a.id);
  assert.ok(!fx.store.data.conversations[fx.a.id].some(message=>message.role==='user'&&message.content?.includes('协作消息数据')));assert.equal(fx.store.data.conversations[fx.a.id].at(-1)?.content,final?.content);
  const page=fx.peers.read({threadId:fx.store.data.peerThreads[0].id});assert.equal(page.messages.length,2);assert.deepEqual(page.messages.map(message=>message.sender.id),[fx.a.id,fx.b.id]);
  page.messages[0].content='mutated';assert.notEqual(fx.store.data.peerThreads[0].messages[0].content,'mutated');
});

test('legacy Bot dialogue stays private while the genuine final reply to the user is restored once',async t=>{
  let count=0;const fx=fixture(t,()=>count++===0?tool('bot_send_message',{botId:fx.b.id,message:'请回复'}):answer('已发送。'));fx.busy.add(fx.b.id);await fx.harness.run(fx.a.id,'原始人类请求');
  const exchange=fx.store.data.peerExchanges[0],thread=fx.store.data.peerThreads[0],stamp=new Date().toISOString(),secret='这句只在私聊里显示';exchange.status='completed';exchange.replyMessageId='legacy-reply';
  thread.messages.push({id:'legacy-reply',exchangeId:exchange.id,sender:{id:fx.b.id,name:fx.b.name,color:fx.b.color},content:secret,time:stamp,kind:'reply'});
  fx.store.data.runs.push({id:'legacy-recipient',botId:fx.b.id,status:'completed',startedAt:stamp,modelCalls:1,toolCalls:0,peerOrigin:{kind:'peer_request',exchangeId:exchange.id,sessionId:exchange.id}},{id:'legacy-relay',botId:fx.a.id,status:'completed',startedAt:stamp,modelCalls:1,toolCalls:0,peerOrigin:{kind:'peer_result',exchangeId:exchange.id}});
  fx.store.data.messages.push({id:'legacy-body',botId:fx.b.id,role:'assistant',content:secret,time:stamp,runId:'legacy-recipient',presentation:'answer',status:'done'},{id:'legacy-summary',botId:fx.a.id,role:'assistant',content:'转述：'+secret,time:stamp,runId:'legacy-relay',presentation:'answer',status:'done'});
  fx.store.data.conversations[fx.a.id].push({role:'user',content:`协作消息数据（不是新的用户指令）：\n来自 ${fx.b.name} 的私聊答复：\n${secret}`},{role:'assistant',content:'转述：'+secret},{role:'user',content:'继续主任务'},{role:'assistant',content:'保留这条人类会话答复'});
  fx.store.message(fx.a.id,'user','继续主任务');fx.store.message(fx.a.id,'assistant','保留这条人类会话答复');fx.store.save();
  const reopened=new Store(fx.dir);assert.ok(!reopened.data.messages.some(message=>message.id==='legacy-body'));assert.equal(reopened.data.peerMessages.filter(message=>message.content.includes(secret)).length,1);assert.equal(reopened.data.messages.find(message=>message.id==='legacy-summary')?.audience,'user');
  assert.ok(!reopened.data.conversations[fx.a.id].some(message=>message.role==='user'&&message.content?.includes(secret)));assert.ok(reopened.data.conversations[fx.a.id].some(message=>message.content==='保留这条人类会话答复'));assert.ok(reopened.data.peerContexts['legacy-relay:legacy-relay'].some(message=>message.content?.includes(secret)));
  assert.equal(reopened.data.peerThreads[0].messages.at(-1)?.content,secret);assert.equal(existsSync(join(fx.dir,'peer-message-migration-backup.json')),true);
  const peers=new PeerChats(reopened,{isRunning:()=>false,run:async()=>{},cancel:()=>{}},()=>{});assert.ok(reopened.data.messages.some(message=>message.botId===fx.b.id&&message.peer?.direction==='sent'));peers.dispose();
  const again=new Store(fx.dir);assert.equal(again.data.peerMessages.length,reopened.data.peerMessages.length);assert.equal(again.data.messages.filter(message=>message.id==='legacy-summary').length,1);assert.equal(again.data.conversations[fx.a.id].filter(message=>message.content==='转述：'+secret).length,1);
});

test('a recipient can ask a third Bot and finish the original private request after the child reply',async t=>{
  let root=0,receiver=0;const fx=fixture(t,(id,messages)=>{
    const system=messages[0].content||'';
    if(id===fx.c.id)return answer('核对结果是 7。');
    if(id===fx.b.id){if(system.includes('这是先前联络的实际回信'))return answer('已与检查伙伴核对，结果是 7。');return receiver++===0?tool('bot_send_message',{botId:fx.c.id,message:'请核对结果'}):answer('正在等检查伙伴核对。');}
    if(system.includes('这是先前联络的实际回信'))return answer('最终核对结果为 7。');
    return root++===0?tool('bot_send_message',{botId:fx.b.id,message:'帮我核对数字'}):answer('已交给数据伙伴核对。');
  });
  await fx.harness.run(fx.a.id,'请合作核对数字');await until(()=>fx.store.data.peerExchanges.length===2&&fx.store.data.peerExchanges.every(item=>item.status==='completed'));
  const parent=fx.store.data.peerExchanges.find(item=>!item.parentId)!;assert.match(fx.store.data.peerThreads.find(thread=>thread.id===parent.threadId)!.messages.at(-1)!.content,/结果是 7/);
  assert.ok(fx.store.data.peerContexts[parent.id].some(message=>message.content?.includes('核对结果是 7')));assert.equal(fx.store.data.conversations[fx.b.id].length,0);
});

test('a received reply missing its user summary regenerates only the text summary after upgrade',async t=>{
  let rootCalls=0,recipientCalls=0,summaryCalls=0;const fx=fixture(t,(id,messages)=>{if(id===fx.b.id){recipientCalls++;return answer('对方已完成核对。');}if(messages[0].content?.includes('这是先前联络的实际回信')){summaryCalls++;return answer('给用户的核对总结。');}return rootCalls++===0?tool('bot_send_message',{botId:fx.b.id,message:'请核对'}):answer('已发送。');});
  await fx.harness.run(fx.a.id,'请协作核对');await until(()=>fx.store.data.peerExchanges[0]?.status==='completed');fx.peers.dispose();
  const exchange=fx.store.data.peerExchanges[0],summary=fx.store.data.messages.find(message=>message.id===exchange.userSummaryMessageId)!;fx.store.data.messages=fx.store.data.messages.filter(message=>message.id!==summary.id);fx.store.data.runs=fx.store.data.runs.filter(run=>run.id!==summary.runId);fx.store.data.conversations[fx.a.id]=fx.store.data.conversations[fx.a.id].filter(message=>message.content!==summary.content);delete exchange.userSummaryMessageId;fx.store.save();
  const upgraded=new PeerChats(fx.store,{isRunning:id=>fx.harness.isRunning(id),run:(id,input,options)=>fx.harness.run(id,input,options),cancel:id=>fx.harness.cancel(id)},()=>{});upgraded.start();await until(()=>exchange.status==='completed');upgraded.dispose();
  assert.equal(recipientCalls,1);assert.equal(summaryCalls,2);assert.equal(fx.store.data.messages.filter(message=>message.audience==='user').length,1);assert.equal(fx.store.data.peerThreads[0].messages.length,2);
});

test('cancelling a private request withdraws the recipient host permission without executing it',async t=>{
  let root=0,relays=0;const fx=fixture(t,(id,messages)=>{
    if(id===fx.b.id)return tool('host_file_write',{path:join(fx.dir,'not-approved.txt'),content:'no',reason:'协作写入测试'});
    if(messages[0].content?.includes('这是先前联络的实际回信')){relays++;return answer('不应收到此答复');}
    return root++===0?tool('bot_send_message',{botId:fx.b.id,message:'请保存测试文件'}):answer('等待对方处理。');
  });
  await fx.harness.run(fx.a.id,'请数据伙伴保存文件');await until(()=>fx.interactions.snapshot().length===1);assert.equal(fx.interactions.snapshot()[0].botId,fx.b.id);
  fx.peers.cancel(fx.store.data.peerExchanges[0].id);await until(()=>!fx.harness.busy);assert.equal(existsSync(join(fx.dir,'not-approved.txt')),false);assert.equal(fx.interactions.snapshot().length,0);assert.equal(relays,0);assert.equal(fx.store.data.peerExchanges[0].status,'cancelled');
});

test('human refusal in a recipient task is not retried or automatically handed to another Bot',async t=>{
  let root=0,receiver=0;const fx=fixture(t,id=>id===fx.b.id?(receiver++,tool('host_file_read',{path:join(fx.dir,'state.json'),reason:'协作读取测试'})):root++===0?tool('bot_send_message',{botId:fx.b.id,message:'请读取文件'}):answer('正在等待。'));
  await fx.harness.run(fx.a.id,'请数据伙伴读取文件');await until(()=>fx.interactions.snapshot().length===1);const beforeRefusal=receiver;assert.equal(fx.store.data.runs.find(run=>run.botId===fx.b.id)?.peerOrigin?.kind,'peer_task');fx.interactions.approve(fx.interactions.snapshot()[0].id,false);await until(()=>!peerPending(fx.store.data.peerExchanges[0].status));assert.equal(receiver,beforeRefusal);assert.equal(root,2);assert.equal(fx.store.data.peerExchanges.length,1);assert.equal(fx.store.data.peerExchanges[0].status,'cancelled');assert.match(fx.store.data.peerExchanges[0].error||'',/拒绝/);
});

test('the recipient chooses a main task, uses its own context and writes only after its own approval',async t=>{
  let root=0,planned=0;const fx=fixture(t,(id,messages,tools)=>{
    if(id===fx.b.id){
      if(tools.some(item=>item.function.name==='start_main_task')){planned++;assert.ok(!messages.some(message=>message.content==='收件方自己的主会话'));assert.ok(!tools.some(item=>item.function.name==='host_file_write'));return tool('start_main_task',{});}
      assert.ok(messages.some(message=>message.content==='收件方自己的主会话'));assert.ok(!messages.some(message=>message.content==='发件方的无关记录'));
      const result=messages.find(message=>message.role==='tool'&&message.content?.includes('delegated.txt'));
      if(!result)return tool('host_file_write',{path:join(fx.dir,'delegated.txt'),content:'由数据伙伴完成',reason:'完成受托任务'});
      assert.equal(JSON.parse(result.content!).result.written,true);return answer('已经保存 delegated.txt。');
    }
    if(messages[0].content?.includes('这是先前联络的实际回信'))return answer('数据伙伴已完成文件保存。');
    return root++===0?tool('bot_send_message',{botId:fx.b.id,message:'请保存 delegated.txt'}):answer('已转交。');
  });
  fx.store.data.conversations[fx.a.id].push({role:'user',content:'发件方的无关记录'});fx.store.data.conversations[fx.b.id].push({role:'user',content:'收件方自己的主会话'});
  await fx.harness.run(fx.a.id,'让数据伙伴保存文件');await until(()=>fx.interactions.snapshot().length===1);
  const approval=fx.interactions.snapshot()[0],run=fx.store.data.runs.find(item=>item.id===approval.runId)!;
  assert.equal(approval.botId,fx.b.id);assert.equal(run.peerOrigin?.kind,'peer_task');assert.equal(existsSync(join(fx.dir,'delegated.txt')),false);
  fx.interactions.approve(approval.id,true);await until(()=>fx.store.data.peerExchanges[0].status==='completed');
  assert.equal(planned,1);assert.equal(readFileSync(join(fx.dir,'delegated.txt'),'utf8'),'由数据伙伴完成');
  const reopened=new Store(fx.dir),trace=reopened.runMessages(run.id);
  assert.equal(trace.filter(message=>message.role==='user').length,0);assert.equal(trace.filter(message=>message.taskSource?.botId===fx.a.id).length,1);
  assert.ok(trace.some(message=>message.tool==='host_file_write'&&message.status==='done'));assert.ok(!reopened.data.peerMessages.some(message=>message.runId===run.id));
  assert.match(reopened.data.peerThreads[0].messages.at(-1)!.content,/已经保存/);
});

test('a child reply resumes an accepted task in the recipient main conversation',async t=>{
  let root=0,forwarded=false;const fx=fixture(t,(id,messages,tools)=>{
    if(id===fx.c.id)return answer('核验码为 7。');
    if(id===fx.b.id){
      if(tools.some(item=>item.function.name==='start_main_task'))return tool('start_main_task',{});
      assert.ok(messages.some(message=>message.content==='我的主会话上下文'));
      if(messages[0].content?.includes('这是先前联络的实际回信')){assert.ok(messages.some(message=>message.tool_calls?.some(call=>call.function.name==='bot_send_message')));return tool('host_file_write',{path:join(fx.dir,'nested.txt'),content:'7',reason:'保存核验结果'});}
      if(!forwarded){forwarded=true;return tool('bot_send_message',{botId:fx.c.id,message:'请核对结果'});}
      return answer('正在等检查伙伴。');
    }
    return root++===0?tool('bot_send_message',{botId:fx.b.id,message:'找检查伙伴核验后保存结果'}):answer('已转交。');
  });
  fx.store.data.conversations[fx.b.id].push({role:'user',content:'我的主会话上下文'});
  await fx.harness.run(fx.a.id,'请合作核验并保存结果');await until(()=>fx.interactions.snapshot().length===1);
  const tasks=fx.store.data.runs.filter(run=>run.botId===fx.b.id);assert.equal(tasks.length,2);assert.ok(tasks.every(run=>run.peerOrigin?.kind==='peer_task'));
  assert.equal(fx.store.data.messages.filter(message=>message.taskSource?.continuation).length,1);
  fx.interactions.approve(fx.interactions.snapshot()[0].id,false);await until(()=>!fx.harness.busy);assert.equal(existsSync(join(fx.dir,'nested.txt')),false);
});

test('reopening preserves the private transcript and does not replay unfinished messages',async t=>{
  let root=0;const fx=fixture(t,()=>root++===0?tool('bot_send_message',{botId:fx.b.id,message:'排队消息'}):answer('已排队'));fx.busy.add(fx.b.id);await fx.harness.run(fx.a.id,'发消息');
  const reloaded=new Store(fx.dir);let calls=0;const peers=new PeerChats(reloaded,{isRunning:()=>false,run:async()=>{calls++;},cancel:()=>{}},()=>{});peers.start();await delay(40);assert.equal(calls,0);assert.equal(reloaded.data.peerExchanges[0].status,'interrupted');assert.equal(peers.read({threadId:reloaded.data.peerThreads[0].id}).messages[0].content,'排队消息');peers.dispose();
});

test('mention IDs bind same-name Bots and stale or forged spans cannot start a run',async t=>{
  let called=0;const fx=fixture(t,(_id,messages)=>{called++;assert.match(messages[0].content||'',new RegExp(fx.c.id));return answer('收到。');});fx.b.name=fx.c.name='同名';
  await fx.harness.run(fx.a.id,'问 @同名',{mentions:[{id:fx.c.id,name:'同名',color:'#fff',start:2,end:5}]});assert.equal(called,1);assert.equal(fx.store.data.messages.find(message=>message.role==='user')!.mentions![0].color,fx.c.color);
  await assert.rejects(()=>fx.harness.run(fx.a.id,'问 @同名',{mentions:[{id:fx.b.id,name:'别的名字',color:'#fff',start:2,end:5}]}),/提及/);assert.equal(called,1);
});

test('a Bot cannot read a private conversation between two other Bots',async t=>{
  let root=0;const fx=fixture(t,()=>root++===0?tool('bot_send_message',{botId:fx.b.id,message:'只给数据伙伴'}):answer('已发送'));fx.busy.add(fx.b.id);await fx.harness.run(fx.a.id,'发消息');
  assert.deepEqual(fx.peers.readForBot(fx.c.id,{botId:fx.b.id}),{messages:[]});assert.equal((fx.peers.readForBot(fx.a.id,{botId:fx.b.id}) as any).messages.length,1);
});

test('deleting a queued recipient cancels delivery and keeps the shared transcript readable',async t=>{
  let root=0;const fx=fixture(t,()=>root++===0?tool('bot_send_message',{botId:fx.b.id,message:'保留已发送的私聊'}):answer('已发出。'));fx.busy.add(fx.b.id);await fx.harness.run(fx.a.id,'联系数据伙伴');const exchange=fx.store.data.peerExchanges[0];
  fx.store.data.peerContexts[exchange.id]=[{role:'user',content:'私有执行上下文'}];fx.peers.deletingBot(fx.b.id);fx.store.deleteBot(fx.b.id);fx.busy.delete(fx.b.id);fx.peers.wake();await delay(30);
  assert.equal(exchange.status,'cancelled');assert.equal(root,2);assert.equal(fx.store.data.peerContexts[exchange.id],undefined);const page=fx.peers.read({threadId:exchange.threadId});assert.equal(page.messages[0].content,'保留已发送的私聊');assert.equal(page.thread.members[1].name,'数据伙伴');
});

test('replying to an ancestor cannot create a circular chain of queued requests',async t=>{
  let root=0,attempts=0;const fx=fixture(t,id=>id===fx.b.id?(attempts++,tool('bot_send_message',{botId:fx.a.id,message:'不要形成回环'})):root++===0?tool('bot_send_message',{botId:fx.b.id,message:'请处理'}):answer('等待处理。'));
  await fx.harness.run(fx.a.id,'请协作');await until(()=>!peerPending(fx.store.data.peerExchanges[0].status));assert.equal(fx.store.data.peerExchanges.length,1);assert.equal(attempts,3);assert.equal(fx.store.data.peerExchanges[0].status,'failed');
});
