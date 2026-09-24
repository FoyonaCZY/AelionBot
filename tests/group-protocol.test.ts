import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {GroupChats} from '../electron/core/group-chats';
import {groupHistory,groupContextKey} from '../electron/core/group-history';
import {CognitiveStore} from '../electron/core/cognitive-store';
import type {RunRecord} from '../src/shared';

function fixture(t:test.TestContext,incremental=false){
 const dir=mkdtempSync(join(tmpdir(),'aelion-group-protocol-')),store=new Store(dir,{incremental}),a=store.data.bots[0],b=store.createBot('B',''),c=store.createBot('C','');
 const groups=new GroupChats(store,{isRunning:()=>false,run:async()=>{},cancel:()=>{}},()=>{});
 const id=groups.create({name:'协作',botIds:[a.id,b.id]}).id;groups.send({id,message:'核对报告，保存结果文档。'});const room=store.data.groups[0],source=room.messages.at(-1)!;
 function run(botId:string){const delivery=store.data.groupDeliveries.find(d=>d.recipientId===botId&&d.messageId===source.id)!;const run:RunRecord={id:randomUUID(),botId,status:'running',modelCalls:0,toolCalls:0,startedAt:new Date().toISOString(),groupOrigin:{groupId:id,rootId:source.rootId!,deliveryId:delivery.id}};store.data.runs.push(run);return run;}
 function deliver(run:RunRecord){const delivery=store.data.groupDeliveries.find(d=>d.id===run.groupOrigin?.deliveryId)!;delivery.status='running';delivery.runId=run.id;}
 const ra=run(a.id),rb=run(b.id);
 const invoke=(run:RunRecord,name:string,args:Record<string,unknown>={})=>groups.invoke(run.botId,run.id,name,{groupId:id,...args},new AbortController().signal,{groupOrigin:run.groupOrigin}) as any;
 t.after(()=>{groups.dispose();store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store,groups,room,a,b,c,ra,rb,run,deliver,invoke,source};
}

test('outbox commit failure publishes nothing; retry and reopen preserve exactly one message and its deliveries',t=>{
 const f=fixture(t,true),args={message:'已核对第一部分。',clientMessageId:'milestone-1',kind:'progress'};
 const before={messages:f.room.messages.length,deliveries:f.store.data.groupDeliveries.length},save=f.store.save.bind(f.store);let writes=0;
 f.store.save=()=>{if(++writes===2)throw Error('disk unavailable');save();};
 assert.throws(()=>f.invoke(f.ra,'group_send_message',args),/disk unavailable/);f.store.save=save;
 assert.equal(f.room.messages.length,before.messages);assert.equal(f.store.data.groupDeliveries.length,before.deliveries);assert.equal(f.store.data.groupOutbox?.[0].status,'pending');
 assert.equal(f.invoke(f.rb,'group_outbox').length,0);
 const first=f.invoke(f.ra,'group_send_message',args),second=f.invoke(f.ra,'group_send_message',args);assert.equal(first.messageId,second.messageId);
 assert.equal(f.room.messages.length,before.messages+1);assert.equal(f.store.data.groupDeliveries.length,before.deliveries+2);assert.equal(f.store.data.groupOutbox?.[0].status,'sent');
 assert.throws(()=>f.invoke(f.ra,'group_send_message',{...args,message:'同一个 ID 的不同内容'}),/不同内容/);
 f.store.close();const restored=new Store(f.dir,{incremental:true});assert.equal(restored.data.groupOutbox?.[0].messageId,first.messageId);assert.equal(restored.data.groups[0].messages.filter(m=>m.id===first.messageId).length,1);restored.close();
});

test('group outbox rejects internal silence markers',t=>{
 const f=fixture(t);assert.throws(()=>f.invoke(f.ra,'group_send_message',{message:'没有新内容。[群聊静默]'}),/内部控制文本/);
 assert.ok(!f.room.messages.some(message=>message.content.includes('[群聊静默]')));
});

test('task claims are exclusive, survive runs, reject foreign updates and allow explicit handoff',async t=>{
 const f=fixture(t),args={key:'report-validation',title:'核对报告',sourceMessageId:f.source.id};
 f.deliver(f.ra);f.deliver(f.rb);
 const [first,second]=await Promise.all([Promise.resolve().then(()=>f.invoke(f.ra,'group_task_claim',args)),Promise.resolve().then(()=>f.invoke(f.rb,'group_task_claim',args))]);
 assert.equal(first.claimed,true);assert.equal(second.claimed,false);assert.equal(first.task.id,second.task.id);assert.equal(f.room.tasks?.length,1);
 assert.equal(f.groups.unfinished(f.a.id,f.ra.id),true);assert.equal(f.groups.unfinished(f.b.id,f.rb.id),false);
 assert.throws(()=>f.invoke(f.rb,'group_task_update',{taskId:first.task.id,revision:first.task.revision,status:'completed',summary:'抢先标记完成'}),/自己认领/);
 const conflict=f.invoke(f.ra,'group_task_update',{taskId:first.task.id,revision:0,status:'completed',summary:'过时状态'});assert.equal(conflict.conflict,true);assert.equal(f.room.tasks![0].status,'working');
 const blocked=f.invoke(f.ra,'group_task_update',{taskId:first.task.id,revision:first.task.revision,status:'blocked',summary:'等待数据文档'});assert.equal(f.groups.unfinished(f.a.id,f.ra.id),false);
 f.ra.status='completed';const next=f.run(f.a.id),resumed=f.invoke(next,'group_task_claim',{taskId:first.task.id});assert.equal(resumed.claimed,true);assert.deepEqual(f.room.tasks![0].runIds,[f.ra.id,next.id]);
 const released=f.invoke(next,'group_task_update',{taskId:first.task.id,revision:resumed.task.revision,status:'open',summary:'请 B 接手，先核对现有文档'});assert.equal(released.task.ownerId,undefined);
 const taken=f.invoke(f.rb,'group_task_claim',{taskId:first.task.id});assert.equal(taken.claimed,true);assert.equal(taken.task.ownerId,f.b.id);
 assert.ok(!('runIds' in f.invoke(f.rb,'group_tasks').tasks[0]));assert.ok(f.groups.read({id:f.room.id}).tasks?.length);assert.equal(blocked.updated,true);
});

test('removing an owner releases unfinished tasks and prevents further reads or publication',t=>{
 const f=fixture(t);f.deliver(f.ra);const claimed=f.invoke(f.ra,'group_task_claim',{key:'report',title:'报告',sourceMessageId:f.source.id});
 f.groups.update({id:f.room.id,name:f.room.name,botIds:[f.b.id,f.c.id]});assert.equal(f.room.tasks![0].status,'open');assert.equal(f.room.tasks![0].ownerId,undefined);
 for(const name of ['group_read','group_tasks','group_outbox','group_send_message'])assert.throws(()=>f.invoke(f.ra,name,{message:'旧进展'}),/自己加入/);
 assert.equal(f.invoke(f.rb,'group_task_claim',{taskId:claimed.task.id}).claimed,true);
});

test('context starts with a bounded public window, expands on demand, and private lookup stays bot scoped',t=>{
 const f=fixture(t);for(let i=0;i<30;i++)f.groups.send({id:f.room.id,message:`公共消息 ${i} `+'长文'.repeat(3500)});
 const privateA=f.store.message(f.a.id,'user','ALPHA_PRIVATE_CONTEXT'),privateB=f.store.message(f.b.id,'user','BETA_PRIVATE_CONTEXT');f.store.data.conversations[f.a.id]=[{role:'user',content:privateA.content}];
 const main=JSON.stringify(f.store.data.conversations),context=groupHistory(f.store,f.room.id,f.a.id),text=JSON.stringify(context);
 assert.equal(context.filter(m=>m.groupMessageId).length,4);assert.doesNotMatch(text,/公共消息 0 |ALPHA_PRIVATE_CONTEXT|BETA_PRIVATE_CONTEXT/);assert.ok(text.length<10000);
 const target=f.room.messages.find(m=>m.content.startsWith('公共消息 0 '))!,first=f.invoke(f.ra,'group_read',{messageId:target.id}),second=f.invoke(f.ra,'group_read',{messageId:target.id,offset:first.nextOffset});assert.equal(first.content+second.content,target.content);
 const storage=new CognitiveStore(f.store);try{assert.equal(storage.search(f.a.id,'ALPHA_PRIVATE_CONTEXT')[0].messageId,privateA.id);assert.equal(storage.search(f.a.id,'BETA_PRIVATE_CONTEXT').length,0);assert.throws(()=>storage.readHistory(f.a.id,privateB.id),/无权/);}finally{storage.close();}
 assert.equal(JSON.stringify(f.store.data.conversations),main);assert.ok(!JSON.stringify(f.room.messages).includes('ALPHA_PRIVATE_CONTEXT'));assert.equal(f.store.data.groupContexts[groupContextKey(f.room.id,f.a.id)],context);
});

test('new tasks require an actual group user request and restart pauses work without replaying actions',t=>{
 const f=fixture(t);f.deliver(f.ra);assert.throws(()=>f.invoke(f.ra,'group_task_claim',{key:'invented',title:'新增操作',sourceMessageId:f.room.messages[0].id}),/原始用户/);
 const claimed=f.invoke(f.ra,'group_task_claim',{key:'report',title:'核对报告',sourceMessageId:f.source.id});f.store.message(f.a.id,'tool','PRIVATE_CHECKPOINT_FROM_A',{runId:f.ra.id,tool:'computer_execute',status:'done'});f.invoke(f.ra,'group_task_update',{taskId:claimed.task.id,revision:claimed.task.revision,status:'working',summary:'已保存 /work/report.md，剩余第二部分。'});f.store.save();
 const ownFrame=f.groups.taskFrame(f.a.id,f.ra.id),otherFrame=f.groups.taskFrame(f.b.id,f.rb.id);assert.match(ownFrame,/PRIVATE_CHECKPOINT_FROM_A/);assert.doesNotMatch(otherFrame,/PRIVATE_CHECKPOINT_FROM_A/);
 const restored=new Store(f.dir);assert.equal(restored.data.groups[0].tasks?.find(t=>t.id===claimed.task.id)?.status,'paused');assert.equal(restored.data.groups[0].tasks?.[0].summary,'已保存 /work/report.md，剩余第二部分。');assert.match(restored.data.groups[0].tasks?.[0].reason||'',/应用中断/);assert.equal(restored.data.groups[0].messages.length,f.room.messages.length);restored.close();
});

test('new tasks cannot borrow authorization from an unrelated earlier group message',t=>{
 const f=fixture(t);f.groups.send({id:f.room.id,message:'讨论一下周五的会议安排。'});const current=f.room.messages.at(-1)!;
 const delivery=f.store.data.groupDeliveries.find(d=>d.messageId===current.id&&d.recipientId===f.a.id)!;
 const run:RunRecord={id:randomUUID(),botId:f.a.id,status:'running',modelCalls:0,toolCalls:0,startedAt:new Date().toISOString(),groupOrigin:{groupId:f.room.id,rootId:current.rootId!,deliveryId:delivery.id}};delivery.status='running';delivery.runId=run.id;f.store.data.runs.push(run);
 assert.throws(()=>f.invoke(run,'group_task_claim',{key:'delete-project',title:'删除整个项目目录',sourceMessageId:f.source.id}),/当前收件批次/);
 const earlierDelivery=f.store.data.groupDeliveries.find(d=>d.messageId===f.source.id&&d.recipientId===f.a.id)!;earlierDelivery.status='running';earlierDelivery.runId=run.id;
 const received=f.invoke(run,'group_task_claim',{key:'report',title:'核对季度报告',sourceMessageId:f.source.id});assert.equal(received.claimed,true);
 const valid=f.invoke(run,'group_task_claim',{key:'meeting-notes',title:'整理周五会议议题',sourceMessageId:current.id});assert.equal(valid.claimed,true);assert.equal(valid.task.sourceMessageId,current.id);
});

test('restart reconciles a committed reply before marking the remaining inbox interrupted',t=>{
 const f=fixture(t),delivery=f.store.data.groupDeliveries.find(d=>d.id===f.ra.groupOrigin!.deliveryId)!;delivery.status='running';delivery.runId=f.ra.id;
 const sent=f.invoke(f.ra,'group_send_message',{message:'已经完成',clientMessageId:'completed'});f.ra.status='completed';f.store.save();
 const restored=new Store(f.dir),groups=new GroupChats(restored,{isRunning:()=>false,run:async()=>{throw Error('must not replay');},cancel:()=>{}},()=>{});
 assert.equal(restored.data.groupDeliveries.find(d=>d.id===delivery.id)?.status,'replied');assert.equal(restored.data.groupDeliveries.find(d=>d.id===delivery.id)?.replyMessageId,sent.messageId);assert.equal(restored.data.runs.find(r=>r.id===f.ra.id)?.groupReplyMessageId,sent.messageId);groups.dispose();restored.close();
});
