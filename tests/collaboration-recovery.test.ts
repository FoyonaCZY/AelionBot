import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {GroupChats} from '../electron/core/group-chats';
import {PeerChats} from '../electron/core/peer-chats';
import {ContextCapacityError} from '../electron/core/context-error';
import {contextModelKey} from '../src/context-issue';
import {groupPending} from '../src/group-types';
import {peerPending} from '../src/peer-types';
import type {ModelClient,Completion} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';
import type {RunRecord,WireMessage} from '../src/shared';
const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'}),call=(name:string,args:unknown={}):Completion=>({content:'',calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}],finishReason:'tool_calls'});
const until=async(check:()=>boolean)=>{for(let i=0;i<800;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('协作恢复未完成');};
function fixture(t:test.TestContext,complete:(run:RunRecord,messages:WireMessage[])=>Completion){
  const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-co-recovery-')),store=new Store(root),a=store.data.bots[0],b=store.createBot('协作伙伴','实际执行任务');store.data.model.model='fixture';store.data.model.contextTokens=64000;let operations=0;
  const vm={state:{status:'ready'},execute:async()=>{operations++;return {exitCode:0,stdout:'operation completed',stderr:'',durationMs:1};}} as unknown as VmController;
  const model={complete:async(messages:WireMessage[],_tools:unknown,_signal:unknown,_text:unknown,options:any)=>complete(store.data.runs.find(run=>run.id===options.runId)!,messages)} as unknown as ModelClient;
  const harness=new Harness(store,vm,model,()=>{}),runner={isRunning:(id:string)=>harness.isRunning(id),run:(...args:Parameters<Harness['run']>)=>harness.run(...args),cancel:(id:string)=>harness.cancel(id),refresh:(id:string)=>harness.refreshGroup(id)},groups=new GroupChats(store,runner,()=>{}),peers=new PeerChats(store,runner,()=>{});harness.setGroupGateway(groups);harness.setPeerGateway(peers);
  t.after(async()=>{groups.dispose();peers.dispose();for(const bot of store.data.bots)harness.cancel(bot.id);await until(()=>!harness.busy);store.close();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});
  return {store,a,b,harness,groups,peers,operations:()=>operations,error:(botId:string)=>new ContextCapacityError({capacity:64000,estimatedTokens:70000,inputBudget:54800,modelKey:contextModelKey(store.modelFor(botId))})};
}
test('a failed group task resumes for its original member and posts one final group reply',async t=>{
  let resumed=false;const f=fixture(t,(run,messages)=>{if(run.botId!==f.a.id)return answer('[群聊静默]');if(!messages.some(message=>message.role==='tool'))return call('computer_execute',{command:'write once'});if(!resumed)throw f.error(run.botId);if(!messages.some(message=>message.tool_calls?.some(call=>call.function.name==='execution_list')))return call('execution_list');assert.ok(JSON.stringify(messages).includes('succeeded'));return answer('群任务已恢复完成。');});
  const group=f.groups.create({name:'恢复群',botIds:[f.a.id,f.b.id]});f.groups.send({id:group.id,message:'执行任务并交付结果'});f.groups.start();await until(()=>!f.harness.busy&&!f.store.data.groupDeliveries.some(delivery=>groupPending(delivery.status)));
  const failed=f.store.data.runs.find(run=>run.botId===f.a.id&&run.status==='failed')!;assert.ok(failed?.groupTask);assert.equal(f.operations(),1);f.store.data.model.contextTokens=128000;resumed=true;f.groups.retryRun(failed);
  await until(()=>!f.harness.busy&&!f.store.data.groupDeliveries.some(delivery=>groupPending(delivery.status)));const replies=f.groups.read({id:group.id}).messages.filter(message=>message.content==='群任务已恢复完成。');assert.equal(replies.length,1);assert.equal(f.operations(),1);assert.ok(f.store.data.runs.some(run=>run.resumedFromRunId===failed.id&&run.status==='completed'));assert.equal(f.store.data.messages.filter(message=>message.role==='user').length,0);
});
test('a failed delegated private task resumes its exchange and returns a real summary to the human',async t=>{
  let resumed=false;const f=fixture(t,(run,messages)=>{
    if(run.botId===f.a.id){if(run.peerOrigin?.kind==='peer_summary')return answer('协作伙伴已经完成任务。');return messages.some(message=>message.role==='tool')?answer('已发出任务。'):call('bot_send_message',{botId:f.b.id,message:'执行任务并返回结果'});}
    if(run.peerOrigin?.kind==='peer_request')return call('start_main_task');
    if(!messages.some(message=>message.tool_calls?.some(call=>call.function.name==='computer_execute')))return call('computer_execute',{command:'write once'});
    if(!resumed)throw f.error(run.botId);if(!messages.some(message=>message.tool_calls?.some(call=>call.function.name==='execution_list')))return call('execution_list');return answer('私聊任务已恢复完成。');
  });
  await f.harness.run(f.a.id,'请协作伙伴完成任务');f.peers.start();await until(()=>!f.harness.busy&&!f.store.data.peerExchanges.some(exchange=>peerPending(exchange.status)));
  const failed=f.store.data.runs.find(run=>run.botId===f.b.id&&run.status==='failed')!;assert.equal(failed.peerOrigin?.kind,'peer_task');assert.equal(f.operations(),1);f.store.data.model.contextTokens=128000;resumed=true;f.peers.retryRun(failed);
  await until(()=>!f.harness.busy&&!f.store.data.peerExchanges.some(exchange=>peerPending(exchange.status)));assert.equal(f.store.data.peerExchanges[0].status,'completed');assert.equal(f.store.data.peerThreads[0].messages.filter(message=>message.kind==='reply').length,1);assert.equal(f.operations(),1);assert.ok(f.store.data.messages.some(message=>message.content==='协作伙伴已经完成任务。'));assert.equal(f.store.data.messages.filter(message=>message.role==='user').length,1);
});
