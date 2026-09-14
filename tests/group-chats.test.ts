import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {GroupChats} from '../electron/core/group-chats';
import {groupMainContext,groupWorkContext} from '../electron/core/group-context';
import {repeatedGroupResponse} from '../electron/core/group-response';
import {Interactions} from '../electron/core/interactions';
import {HostComputer} from '../electron/core/host';
import type {ModelClient,Completion,ToolDefinition} from '../electron/core/model';
import type {WireMessage,RunRecord} from '../src/shared';
import type {VmController} from '../electron/core/vm';
import {groupPending} from '../src/group-types';
import {conversationTimeline} from '../src/activity';
import {groupParaphrases} from './fixtures/group-paraphrases';
const publishedMessages=(messages:WireMessage[])=>messages.filter(message=>message.groupMessageId).map(message=>JSON.parse(message.content!));
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean){for(let i=0;i<650;i++){if(predicate())return;await delay(10);}throw new Error('群聊测试等待超时');}
const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'}),silent=()=>answer('[群聊静默]');
const call=(name:string,args:Record<string,unknown>):Completion=>({content:'',calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}],finishReason:'tool_calls'});
const waitAbort=(signal:AbortSignal)=>new Promise<Completion>((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});

test('a group reaction alongside file work preserves the final reply and its delivery record',async t=>{
  let requests=0;
  const fx=fixture(t,(run)=>{
    if(run.botId!==fx.a.id)return silent();
    const room=fx.store.data.groups.find(room=>room.id===run.groupOrigin!.groupId)!,user=room.messages.find(message=>message.sender.kind==='user'&&message.kind==='message');
    if(!user)return silent();
    requests++;if(requests===1)return {content:'先看文件内容，再把结论发到群里。',calls:[...call('group_pin',{groupId:room.id,messageId:user.id,emoji:'👀'}).calls,...call('file_read',{path:'README.md'}).calls],finishReason:'tool_calls'};
    return answer('README 已核对，项目说明完整。');
  },{execute:async(_command:string,botId:string)=>({stdout:JSON.stringify({path:`/work/${botId}/README.md`,data:Buffer.from('项目说明').toString('base64')}),stderr:'',exitCode:0,durationMs:1})} as unknown as VmController);
  const room=fx.groups.create({name:'项目核对',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'请读取 README 并说明结果'});await until(fx.settled);
  const messages=fx.groups.read({id:room.id}).messages,user=messages.find(message=>message.sender.kind==='user'&&message.kind==='message')!,reply=messages.find(message=>message.sender.id===fx.a.id&&message.kind==='message'&&message.content==='README 已核对，项目说明完整。');
  assert.equal(requests,2);assert.ok(reply);assert.ok(user.pins?.some(pin=>pin.actor.id===fx.a.id));
  assert.equal(fx.store.data.groupDeliveries.find(delivery=>delivery.messageId===user.id&&delivery.recipientId===fx.a.id)?.replyMessageId,reply.id);
  assert.ok(fx.store.data.messages.some(message=>message.botId===fx.a.id&&message.presentation==='progress'&&message.content==='先看文件内容，再把结论发到群里。'));
});
function fixture(t:test.TestContext,complete:(run:RunRecord,messages:WireMessage[],tools:ToolDefinition[],signal:AbortSignal)=>Completion|Promise<Completion>=()=>silent(),vm?:VmController){
  const dir=mkdtempSync(join(tmpdir(),'aelion-group-test-')),store=new Store(dir),a=store.data.bots[0],b=store.createBot('数据伙伴','分析'),c=store.createBot('核对伙伴','核对'),busy=new Set<string>();let groups:GroupChats;
  store.data.model.contextTokens=64000;
  const interactions=new Interactions(()=>groups?.wake()),host=new HostComputer({dataDir:dir,homeDir:dir,projectDir:dir},interactions);
  const model={complete:async(messages:WireMessage[],tools:ToolDefinition[],signal:AbortSignal)=>{const id=/\/work\/([a-f0-9-]+)/.exec(messages[0].content||'')?.[1]||store.data.bots.find(bot=>messages[0].content?.startsWith(`你是 ${bot.name}，职责：`))?.id;const run=store.data.runs.find(r=>r.botId===id&&r.status==='running')!;assert.ok(run);return complete(run,messages,tools,signal);}} as unknown as ModelClient;
  const harness=new Harness(store,vm||{} as VmController,model,()=>groups?.wake(),undefined,undefined,undefined,host,interactions);
  groups=new GroupChats(store,{isRunning:id=>busy.has(id)||harness.isRunning(id),run:(id,input,options)=>harness.run(id,input,options),cancel:id=>harness.cancel(id),refresh:id=>harness.refreshGroup(id)},()=>{});harness.setGroupGateway(groups);groups.start();
  t.after(async()=>{groups.dispose();for(const bot of store.data.bots)harness.cancel(bot.id);await until(()=>!groups.busy&&!harness.busy);host.dispose();interactions.dispose();await delay(10);assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  const settled=()=>!groups.busy&&!harness.busy&&!store.data.groupDeliveries.some(d=>groupPending(d.status));
  return {store,groups,harness,a,b,c,busy,dir,interactions,settled};
}

test('ordinary group dispatch runs only the coordinator without language rules',async t=>{
 const captured:Array<{text:string;botEvent:boolean}>=[];let replied=false;
 const fx=fixture(t,(run,messages)=>{const context=messages.filter(m=>m.role==='system').map(m=>m.content||'').join('\n');if(!context.includes('Build an awesome project.'))return silent();const history=publishedMessages(messages);captured.push({text:context,botEvent:history.some(m=>m.sender.kind==='bot'&&m.content==='我建议做音乐项目。')});if(run.botId===fx.a.id&&!replied){replied=true;return answer('我建议做音乐项目。');}return silent();});
 fx.store.data.language='en';const room=fx.groups.create({name:'Team',botIds:[fx.a.id,fx.b.id]});await until(fx.settled);fx.groups.send({id:room.id,message:'Build an awesome project.'});await until(fx.settled);
 assert.equal(captured.length,1);assert.ok(!captured[0].botEvent);for(const item of captured){assert.doesNotMatch(item.text,/Response language policy|current interface language|latestHumanMessage/);assert.doesNotMatch(item.text,/这是群聊|群聊发言规则|系统发布的 event/);}
});

test('work progress is visible in the group and own main chat without waking uninvolved members',async t=>{
  let actions=0;const recipients=new Set<string>(),vm={execute:async()=>({stdout:`完成步骤 ${++actions}`,stderr:'',exitCode:0,durationMs:1})} as unknown as VmController;
  const fx=fixture(t,(run,messages,tools)=>{
    assert.ok(!JSON.stringify(messages).includes('现在只向用户简短汇报'));
    if(run.botId!==fx.a.id){if(publishedMessages(messages).some(m=>m.kind==='progress'))recipients.add(run.botId);return silent();}
    return actions<4?{...call('computer_execute',{command:'verify-step'}),content:actions===3?'已核对三处配置，接下来检查运行结果。':''}:answer('已完成核对。');
  },vm);
  const room=fx.groups.create({name:'工作进度',botIds:[fx.a.id,fx.b.id,fx.c.id]});fx.groups.send({id:room.id,message:'请核对配置和运行结果'});await until(fx.settled);
  const progress=fx.groups.read({id:room.id}).messages.filter(message=>message.kind==='progress');assert.equal(progress.length,1);assert.equal(actions,4);assert.deepEqual(recipients,new Set());
  assert.ok(fx.store.data.messages.some(message=>message.botId===fx.a.id&&message.content===progress[0].content&&message.audience==='user'));
  assert.equal(fx.store.data.runs.filter(run=>run.botId===fx.a.id).length,1);assert.equal(fx.store.data.runs.find(run=>run.botId===fx.a.id)?.status,'completed');
});
test('ordinary messages go to the configured coordinator and replies are not rebroadcast',async t=>{
  const started:string[]=[];
  const fx=fixture(t,(run,messages,tools)=>{started.push(run.botId);assert.ok(tools.some(tool=>tool.function.name==='group_read'));assert.ok(!messages[0].content?.includes('只返回 JSON'));return answer('第一份实际结果');});
  const room=fx.groups.create({name:'协调',botIds:[fx.a.id,fx.b.id,fx.c.id],coordinatorBotId:fx.b.id});fx.groups.send({id:room.id,message:'并行处理'});await until(fx.settled);
  const page=fx.groups.read({id:room.id}),user=page.messages.find(message=>message.sender.kind==='user')!,reply=page.messages.find(message=>message.sender.id===fx.b.id)!;
  assert.deepEqual(started,[fx.b.id]);assert.deepEqual(page.deliveries.filter(d=>d.messageId===user.id).map(d=>d.recipientId),[fx.b.id]);assert.deepEqual(page.deliveries.filter(d=>d.messageId===reply.id).map(d=>d.recipientId),['user']);
});
test('an explicit user @ overrides the coordinator for that request',async t=>{
  const started:string[]=[];
  const fx=fixture(t,run=>{started.push(run.botId);return silent();});
  const room=fx.groups.create({name:'点名优先',botIds:[fx.a.id,fx.b.id,fx.c.id],coordinatorBotId:fx.a.id}),message=`@${fx.c.name} 请直接核对`;
  fx.groups.send({id:room.id,message,mentions:[{id:fx.c.id,name:fx.c.name,color:fx.c.color,start:0,end:fx.c.name.length+1}]});await until(fx.settled);
  assert.deepEqual(started,[fx.c.id]);
});
test('the coordinator delegates with group_wake and receives the worker result without waking bystanders',async t=>{
  let coordinatorTurns=0,workerTurns=0;
  const fx=fixture(t,(run,messages,tools)=>{
    if(run.botId===fx.a.id){coordinatorTurns++;if(coordinatorTurns===1){assert.ok(tools.some(tool=>tool.function.name==='group_wake'));return call('group_wake',{botIds:[fx.b.id],task:'核对数据口径',mode:'assist'});}return silent();}
    if(run.botId===fx.b.id){workerTurns++;const delegation=publishedMessages(messages).find(event=>event.delegation);assert.deepEqual(delegation?.delegation,{fromBotId:fx.a.id,mode:'assist',task:'核对数据口径'});return answer('数据口径已核对。');}
    throw new Error('旁观成员不应被唤醒');
  });
  const room=fx.groups.create({name:'按需委托',botIds:[fx.a.id,fx.b.id,fx.c.id],coordinatorBotId:fx.a.id});fx.groups.send({id:room.id,message:'请完成数据核对'});await until(fx.settled);
  const page=fx.groups.read({id:room.id}),delegation=page.messages.find(message=>message.delegation),reply=page.messages.find(message=>message.content==='数据口径已核对。')!;
  assert.equal(delegation?.delegation?.fromBotId,fx.a.id);assert.equal(workerTurns,1);assert.ok(coordinatorTurns>=2);assert.equal(page.deliveries.find(delivery=>delivery.messageId===delegation?.id&&delivery.recipientId===fx.b.id)?.delegatedByBotId,fx.a.id);assert.deepEqual(page.deliveries.filter(delivery=>delivery.messageId===reply.id).map(delivery=>delivery.recipientId).sort(),['user',fx.a.id].sort());
});
test('a silent ordinary notification reaches only the coordinator',async t=>{
  let calls=0;const fx=fixture(t,()=>{calls++;return silent();});const room=fx.groups.create({name:'安静',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'谢谢，不用回复'});await until(fx.settled);assert.equal(calls,1);assert.ok(fx.store.data.groupDeliveries.filter(d=>d.recipientId!=='user').every(d=>d.status==='ignored'));assert.equal(fx.store.data.groups[0].messages.filter(m=>m.kind==='message').length,1);
});
test('a busy coordinator queues its task and group models retain their own private history',async t=>{
  const seen=new Set<string>();const fx=fixture(t,(run,messages,tools)=>{seen.add(run.botId);const text=JSON.stringify(messages);assert.ok(text.includes(run.botId===fx.a.id?'项目路径 A:/alpha':'项目路径 B:/beta'));assert.ok(!text.includes(run.botId===fx.a.id?'仅B可见':'仅A可见'));assert.ok(!tools.some(t=>t.function.name==='bot_send_message'));return silent();});
  fx.store.message(fx.a.id,'user','项目路径 A:/alpha，仅A可见');fx.store.message(fx.b.id,'user','项目路径 B:/beta，仅B可见');fx.busy.add(fx.a.id);
  const room=fx.groups.create({name:'交接',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'交接主会话之前的工作'});await delay(160);assert.ok(!seen.has(fx.a.id)&&!seen.has(fx.b.id));fx.busy.clear();fx.groups.wake();await until(fx.settled);assert.deepEqual(seen,new Set([fx.a.id]));assert.equal(fx.store.data.messages.length,2);
});
test('an ordinary request produces one coordinator response instead of an autonomous discussion loop',async t=>{
  const points=['数据库事务可以保证订单与库存同时落库','但外部支付无法参与数据库事务，应使用状态机','状态机仍要处理回调乱序，建议记录支付事件序号','回调事件也需要幂等键，防止重复发货','发货前校验库存预占是否过期','预占过期后不要直接扣款，先撤销支付授权','撤销失败应进入人工对账队列','对账队列要记录上游交易号与重试次数','重试次数不能作为唯一失败判断，还要检查错误类型','不可重试错误应该告警并冻结自动结算','告警需要附带订单状态与交易流水，方便定位','最后用故障注入验证乱序、重放和超时场景'];
  const fx=fixture(t,()=>answer(points[0]));const room=fx.groups.create({name:'深入讨论',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'深入讨论支付方案'});await until(fx.settled);assert.equal(fx.store.data.groupRounds.at(-1)!.botMessages,1);assert.equal(fx.store.data.groups[0].messages.filter(m=>m.sender.kind==='bot').length,1);assert.equal(fx.store.data.groupRounds.at(-1)!.status,'active');
});
test('repeating the same conclusion naturally goes quiet instead of an infinite loop',async t=>{
  const fx=fixture(t,()=>answer('我们已确认采用消息队列进行订单通知。'));const room=fx.groups.create({name:'去重',botIds:[fx.a.id,fx.b.id,fx.c.id]});fx.groups.send({id:room.id,message:'讨论通知机制'});await until(fx.settled);assert.equal(fx.store.data.groupRounds.at(-1)!.botMessages,1);assert.equal(fx.store.data.runs.length,1);
  assert.ok(repeatedGroupResponse(fx.store.data.groups[0],fx.store.data.groupRounds.at(-1)!.id,'我们已确认采用消息队列进行订单通知！'));assert.ok(!repeatedGroupResponse(fx.store.data.groups[0],fx.store.data.groupRounds.at(-1)!.id,'我反对，目前无需引入队列，直接事务发件箱即可。'));
});

test('a six-Bot group publishes one coordinator answer without waking the other five',async t=>{
  let calls=0;const fx=fixture(t,(run)=>{calls++;const index=fx.store.data.bots.findIndex(bot=>bot.id===run.botId);return answer(groupParaphrases[index]);});
  for(let n=3;n<6;n++)fx.store.createBot('伙伴'+n,'协作');const bots=fx.store.data.bots;
  const group=fx.groups.create({name:'复述回归',botIds:bots.map(bot=>bot.id)});fx.groups.send({id:group.id,message:'这是什么'});await until(fx.settled);
  const page=fx.groups.read({id:group.id});assert.equal(page.messages.filter(message=>message.sender.kind==='bot').length,1);assert.equal(page.messages.find(message=>message.sender.kind==='bot')!.content,groupParaphrases[0]);
  assert.equal(calls,1);assert.equal(fx.store.data.groupRounds.at(-1)!.status,'active');
  assert.equal(page.deliveries.filter(delivery=>delivery.recipientId!=='user'&&delivery.status==='replied').length,1);assert.equal(page.deliveries.filter(delivery=>delivery.recipientId===fx.a.id).length,1);
});

test('a selected coordinator can be changed without waking unrelated members',async t=>{
  const started:string[]=[];
  const fx=fixture(t,run=>{started.push(run.botId);return answer('由指定协调者处理。');});
  for(let n=3;n<6;n++)fx.store.createBot('伙伴'+n,'协作');const group=fx.groups.create({name:'指定负责人',botIds:fx.store.data.bots.map(bot=>bot.id),coordinatorBotId:fx.c.id});fx.groups.send({id:group.id,message:'这是什么'});await until(fx.settled);
  assert.deepEqual(started,[fx.c.id]);assert.equal(fx.groups.snapshot().rooms.find(room=>room.id===group.id)?.coordinatorBotId,fx.c.id);
});

test('an explicit vote can receive the same requested answer from each member only once',async t=>{
  const fx=fixture(t,()=>answer('同意'));const group=fx.groups.create({name:'投票',botIds:[fx.a.id,fx.b.id,fx.c.id]});fx.groups.send({id:group.id,message:'请每个人投票表态'});await until(fx.settled);
  const replies=fx.groups.read({id:group.id}).messages.filter(message=>message.sender.kind==='bot');assert.equal(replies.length,3);assert.equal(new Set(replies.map(message=>message.sender.id)).size,3);
});
test('new user events abort the active coordinator generation and do not publish stale drafts',async t=>{
  let calls=0;const signals:AbortSignal[]=[];const fx=fixture(t,(_run,messages,_tools,signal)=>{calls++;if(calls===1){signals.push(signal);return waitAbort(signal);}assert.ok(messages.at(-1)?.content?.includes('新的群发事件'));return silent();});
  const room=fx.groups.create({name:'实时消息',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'旧问题'});await until(()=>signals.length===1);fx.groups.send({id:room.id,message:'新的群发事件'});assert.ok(signals.every(signal=>signal.aborted));await until(fx.settled);assert.equal(calls,2);assert.equal(fx.store.data.groups[0].messages.filter(m=>m.sender.kind==='bot').length,0);
});
test('a running command finishes once; its result survives interruption and supports handoff',async t=>{
  let finish:(value:unknown)=>void=()=>{},executions=0,toolSignal:AbortSignal|undefined,resumed=false;const vm={execute:async(_command:string,signal?:AbortSignal)=>{executions++;toolSignal=signal;return new Promise(resolve=>{finish=resolve;});}} as unknown as VmController;
  const fx=fixture(t,(run,messages)=>{if(run.botId!==fx.a.id)return silent();if(!JSON.stringify(messages).includes('/work/completed-report.csv'))return call('computer_execute',{command:'create-report-once'});assert.ok(JSON.stringify(messages).includes('改为向大家交接'));resumed=true;return answer('报告已完成，文件是 /work/completed-report.csv，接下来核对汇总。');},vm);
  const room=fx.groups.create({name:'不中断副作用',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'生成报告'});await until(()=>executions===1);fx.groups.send({id:room.id,message:'改为向大家交接报告路径'});assert.ok(!toolSignal?.aborted);finish({stdout:'/work/completed-report.csv',stderr:'',exitCode:0,durationMs:30});await until(fx.settled);assert.equal(executions,1);assert.ok(resumed);assert.ok(groupWorkContext(fx.store,fx.a.id).includes('/work/completed-report.csv'));assert.ok(fx.store.data.groups[0].messages.some(m=>m.content.includes('报告已完成')));assert.equal(fx.store.data.messages.filter(m=>m.role==='user').length,0);assert.ok(fx.store.data.messages.some(m=>m.groupTaskSource));assert.ok(fx.store.data.messages.some(m=>m.tool==='computer_execute'));
});
test('superseded permission is withdrawn without executing an obsolete file write',async t=>{
  const fx=fixture(t,(run,messages)=>run.botId===fx.a.id&&!messages.at(-1)?.content?.includes('不用写了')?call('host_file_write',{path:join(fx.dir,'obsolete.txt'),content:'测试',reason:'群任务'}):silent());
  const room=fx.groups.create({name:'过期许可',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'写文件'});await until(()=>fx.interactions.snapshot().length===1);fx.groups.send({id:room.id,message:'不用写了，收到即可'});await until(fx.settled);assert.equal(fx.interactions.snapshot().length,0);assert.equal(existsSync(join(fx.dir,'obsolete.txt')),false);
});
test('membership changes, user stop and resume, unread state and restart remain durable',async t=>{
  const fx=fixture(t);fx.busy.add(fx.a.id);fx.busy.add(fx.b.id);const room=fx.groups.create({name:'管理',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'待处理'});assert.throws(()=>fx.groups.invoke(fx.c.id,'none','group_read',{groupId:room.id},new AbortController().signal,{}),/自己加入/);
  fx.groups.update({id:room.id,name:'管理更新',botIds:[fx.a.id,fx.c.id]});assert.ok(fx.store.data.groupDeliveries.filter(d=>d.recipientId===fx.b.id).every(d=>d.status==='cancelled'));assert.equal(fx.store.data.groupDeliveries.filter(d=>d.recipientId===fx.c.id).length,0);fx.groups.stop(room.id);assert.equal(fx.groups.snapshot().rooms[0].round?.status,'stopped');fx.groups.continue(room.id);fx.busy.clear();fx.groups.wake();await until(fx.settled);fx.groups.markRead({id:room.id,seq:fx.groups.read({id:room.id}).group.lastSeq});assert.equal(fx.groups.snapshot().rooms[0].unread,0);
  const restored=new Store(fx.dir),service=new GroupChats(restored,{isRunning:()=>false,run:async()=>{throw Error('不能重放');},cancel:()=>{}},()=>{});assert.equal(service.snapshot().rooms[0].round?.status,'stopped');service.dispose();
});
test('bot-created groups inherit the real user task and cannot turn broadcast into a private side channel',async t=>{
  const fx=fixture(t);const root:RunRecord={id:randomUUID(),botId:fx.a.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};fx.store.data.runs.push(root);fx.store.message(fx.a.id,'user','组织协作',{runId:root.id});
  const created=fx.groups.invoke(fx.a.id,root.id,'group_create',{name:'自主建群',botIds:[fx.b.id],message:'请交接项目'},new AbortController().signal,{}) as {groupId:string};root.status='completed';await until(fx.settled);assert.equal(fx.store.data.groupRounds[0].request,'组织协作');assert.ok(fx.store.data.messages.some(m=>m.groupLink?.groupId===created.groupId));assert.ok(groupMainContext(fx.store,fx.a.id).includes('组织协作'));
});
test('bursts preserve every coordinator event even when processing in batches',async t=>{
  const seen=new Set<string>();const fx=fixture(t,(_run,messages)=>{for(const event of publishedMessages(messages).filter(event=>event.kind==='message'))seen.add(`${_run.botId}:${event.messageId}`);return silent();});
  fx.busy.add(fx.a.id);fx.busy.add(fx.b.id);const room=fx.groups.create({name:'突发消息',botIds:[fx.a.id,fx.b.id]});for(let i=0;i<22;i++)fx.groups.send({id:room.id,message:`广播事件 ${i}`});fx.busy.clear();fx.groups.wake();await until(fx.settled);assert.equal(seen.size,22);const deliveries=fx.store.data.groupDeliveries.filter(d=>d.recipientId!=='user'&&fx.store.data.groups[0].messages.find(m=>m.id===d.messageId)?.kind==='message');assert.ok(deliveries.every(delivery=>delivery.recipientId===fx.a.id&&seen.has(`${delivery.recipientId}:${delivery.messageId}`)));
});
test('a Bot @ is persisted as a real member identity and included in every broadcast event',async t=>{
  let received=false;const fx=fixture(t,(run,messages)=>{
    const payload={events:publishedMessages(messages).slice(-1)};
    if(run.botId===fx.a.id&&payload.events.some((event:any)=>event.sender.kind==='user'))return answer(`@{${fx.b.id}} 请复核报告，@${fx.c.name} 请补充意见。`);
    const direct=payload.events.find((event:any)=>event.sender.id===fx.a.id);if(run.botId===fx.b.id&&direct){assert.ok(direct.mentions.some((mention:any)=>mention.id===fx.b.id));received=true;}return silent();
  });
  const room=fx.groups.create({name:'点名协作',botIds:[fx.a.id,fx.b.id,fx.c.id]});fx.groups.send({id:room.id,message:'分派复核任务'});await until(fx.settled);
  const reply=fx.groups.read({id:room.id}).messages.find(message=>message.sender.id===fx.a.id)!;assert.deepEqual(reply.mentions?.map(mention=>mention.id),[fx.b.id,fx.c.id]);assert.ok(!reply.content.includes('@{'));assert.ok(received);assert.equal(fx.store.data.groupDeliveries.filter(d=>d.messageId===reply.id).length,3);
  const reopened=new Store(fx.dir);assert.deepEqual(reopened.data.groups[0].messages.find(m=>m.id===reply.id)?.mentions,reply.mentions);
});
test('invalid Bot mention formatting is repaired without repeating successful work',async t=>{
  let writes=0,answers=0;const vm={execute:async()=>{writes++;return {stdout:'report ready',stderr:'',exitCode:0,durationMs:1};}} as unknown as VmController;
  const fx=fixture(t,(run,messages)=>{if(run.botId!==fx.a.id)return silent();if(!run.toolCalls)return call('computer_execute',{command:'create-once'});if(answers++===0)return answer('@{not-a-member} 请检查');assert.ok(JSON.stringify(messages).includes('身份检查未通过'));return answer(`@{${fx.b.id}} 文件已生成，请检查。`);},vm);
  const room=fx.groups.create({name:'身份核对',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'生成一次并交接'});await until(fx.settled);assert.equal(writes,1);assert.equal(fx.groups.read({id:room.id}).messages.find(m=>m.sender.id===fx.a.id)?.mentions?.[0].id,fx.b.id);
});
test('group tool messages can address different same-name Bots without being deduplicated',async t=>{
  const fx=fixture(t);fx.c.name=fx.b.name;const room=fx.groups.create({name:'同名点名',botIds:[fx.a.id,fx.b.id,fx.c.id]});
  const root:RunRecord={id:randomUUID(),botId:fx.a.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};fx.store.data.runs.push(root);fx.store.message(fx.a.id,'user','请分别点名两位成员',{runId:root.id});
  for(const target of [fx.b,fx.c])fx.groups.invoke(fx.a.id,root.id,'group_send_message',{groupId:room.id,message:`@{${target.id}} 请检查`},new AbortController().signal,{});root.status='completed';await until(fx.settled);
  const messages=fx.groups.read({id:room.id}).messages.filter(message=>message.sender.id===fx.a.id);assert.equal(messages.length,2);assert.deepEqual(messages.map(m=>m.mentions?.[0].id),[fx.b.id,fx.c.id]);
});
test('group work appears live in the Bot main conversation with a source card and final result',async t=>{
  let finish:(value:unknown)=>void=()=>{};const vm={execute:async()=>new Promise(resolve=>{finish=resolve;})} as unknown as VmController;
  const fx=fixture(t,(run)=>run.botId!==fx.a.id?silent():run.toolCalls?answer('任务完成，已生成报告。'):call('computer_execute',{command:'generate-report'}),vm);
  const room=fx.groups.create({name:'项目组',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'请生成报告'});
  await until(()=>fx.store.data.messages.some(m=>m.role==='tool'&&m.status==='running'));const run=fx.store.data.runs.find(r=>r.botId===fx.a.id&&r.status==='running')!;assert.equal(run.groupTask,true);
  const source=fx.store.data.messages.find(m=>m.runId===run.id&&m.groupTaskSource)!;assert.equal(source.groupTaskSource?.groupId,room.id);assert.equal(source.content,'请生成报告');assert.equal(source.role,'event');assert.equal(conversationTimeline(fx.store.data.messages)[0].kind,'message');
  finish({stdout:'report ready',stderr:'',exitCode:0,durationMs:1});await until(fx.settled);assert.ok(fx.store.data.messages.some(m=>m.runId===run.id&&m.presentation==='answer'&&m.content==='任务完成，已生成报告。'));assert.ok(fx.groups.read({id:room.id}).messages.some(m=>m.content==='任务完成，已生成报告。'));assert.equal(fx.store.data.messages.filter(m=>m.botId===fx.b.id).length,0);assert.equal(fx.store.data.messages.filter(m=>m.role==='user').length,0);
});
test('a group task continues in its coordinator main conversation after tool work',async t=>{
  let executions=0,finish:(value:unknown)=>void=()=>{};const vm={execute:async()=>{executions++;return new Promise(resolve=>{finish=resolve;});}} as unknown as VmController;
  const fx=fixture(t,(run,messages)=>run.botId!==fx.a.id?silent():messages.some(message=>message.role==='tool')?answer('已完成报告，并保留总计。'):call('computer_execute',{command:'run-once'}),vm);
  const room=fx.groups.create({name:'续接',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'生成报告'});await until(()=>executions===1);finish({stdout:'done',stderr:'',exitCode:0,durationMs:1});await until(fx.settled);
  assert.equal(executions,1);assert.ok(fx.store.data.messages.some(message=>message.botId===fx.a.id&&message.content==='已完成报告，并保留总计。'));assert.ok(fx.store.data.runs.some(run=>run.botId===fx.a.id&&run.groupTask));
});
test('historical group work is restored once without replaying tools or exposing ordinary chatter',async t=>{
  const fx=fixture(t);fx.busy.add(fx.a.id);fx.busy.add(fx.b.id);const room=fx.groups.create({name:'旧群任务',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'旧任务：创建表格'});
  const delivery=fx.store.data.groupDeliveries.find(d=>d.recipientId===fx.a.id&&fx.store.data.groups[0].messages.find(m=>m.id===d.messageId)?.kind==='message')!;
  const work:RunRecord={id:randomUUID(),botId:fx.a.id,status:'completed',startedAt:new Date().toISOString(),toolCalls:1,modelCalls:2,groupOrigin:{groupId:room.id,rootId:delivery.rootId,deliveryId:delivery.id}};fx.store.data.runs.push(work);
  const tool=fx.store.message(fx.a.id,'tool','{"result":{"stdout":"old report"}}',{runId:work.id,tool:'computer_execute',status:'done'});fx.store.message(fx.a.id,'assistant','旧表格已完成',{runId:work.id,presentation:'answer',status:'done'});
  const chat:RunRecord={...work,id:randomUUID(),toolCalls:0};fx.store.data.runs.push(chat);const chatter=fx.store.message(fx.a.id,'assistant','普通群聊发言',{runId:chat.id,presentation:'answer',status:'done'});fx.store.save();
  const restored=new Store(fx.dir);assert.ok(restored.data.messages.some(m=>m.id===tool.id));assert.equal(restored.data.messages.filter(m=>m.groupTaskSource).length,1);assert.ok(!restored.data.messages.some(m=>m.id===chatter.id));assert.ok(restored.data.groupRunMessages.some(m=>m.id===chatter.id));assert.ok(existsSync(join(fx.dir,'group-task-migration-backup.json')));
  const again=new Store(fx.dir);assert.equal(again.data.messages.filter(m=>m.id===tool.id).length,1);assert.equal(again.data.messages.filter(m=>m.groupTaskSource).length,1);assert.deepEqual(again.data.groups,restored.data.groups);
});


test('a completed reply superseded before publication never enters either Bot context',async t=>{
  let first=true,held=false,release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const fx=fixture(t,(run,messages)=>{assert.ok(!JSON.stringify(messages).includes('这条旧回复不能成为历史'));if(run.botId!==fx.a.id)return silent();if(first){first=false;return answer('这条旧回复不能成为历史');}return silent();});
  const runner=(fx.groups as any).runner,original=runner.run;runner.run=async(id:string,input:string,options:any)=>{await original(id,input,options);if(id===fx.a.id&&!held){held=true;await gate;}};
  const room=fx.groups.create({name:'发布前被抢话',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'旧问题'});await until(()=>held);
  fx.groups.send({id:room.id,message:'新问题，旧回复作废'});release();await until(fx.settled);
  assert.ok(!JSON.stringify(fx.store.data.groupContexts).includes('这条旧回复不能成为历史'));
  assert.ok(!fx.groups.read({id:room.id}).messages.some(m=>m.content==='这条旧回复不能成为历史'));
  for(const history of Object.values(fx.store.data.groupContexts)){const ids=history.filter(m=>m.groupMessageId).map(m=>m.groupMessageId);assert.equal(ids.length,new Set(ids).size);}
});

test('a Bot pin is one published utterance and does not expose private tool pairing',async t=>{
  const fx=fixture(t,(run,messages)=>{
    const events=publishedMessages(messages),latest=events.at(-1);
    if(latest?.kind==='reaction'){assert.equal(latest.reaction.emoji,'👍');return silent();}
    if(run.botId===fx.a.id)return call('group_pin',{groupId:run.groupOrigin!.groupId,messageId:latest.messageId,emoji:'👍'});
    return silent();
  });
  const room=fx.groups.create({name:'表态',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'这个方案我觉得可以'});await until(fx.settled);
  const page=fx.groups.read({id:room.id}),reaction=page.messages.find(m=>m.kind==='reaction')!,target=page.messages.find(m=>m.kind==='message')!;
  assert.equal(target.pins?.[0].actor.id,fx.a.id);assert.equal(reaction.reaction?.messageId,target.id);assert.equal(page.messages.filter(m=>m.sender.kind==='bot').length,1);
  assert.deepEqual(page.deliveries.filter(d=>d.messageId===reaction.id).map(d=>d.recipientId),['user']);
  const history=fx.store.data.groupContexts['group:'+room.id];assert.ok(history.every(message=>!message.tool_calls&&message.role==='user'));
  assert.ok(!fx.store.data.runs.some(r=>r.botId===fx.a.id&&r.groupTask));
});

test('user group pins add and remove once, refresh old message badges and cannot target reactions or foreign groups',async t=>{
  let reactionsSeen=0;const fx=fixture(t,(_run,messages)=>{if(publishedMessages(messages).at(-1)?.kind==='reaction')reactionsSeen++;return silent();});
  const room=fx.groups.create({name:'用户表态',botIds:[fx.a.id,fx.b.id]});fx.groups.send({id:room.id,message:'先讨论一下'});await until(fx.settled);const target=fx.groups.read({id:room.id}).messages.find(m=>m.kind==='message')!;
  fx.groups.pinUser({groupId:room.id,messageId:target.id,emoji:'👀'});fx.groups.pinUser({groupId:room.id,messageId:target.id,emoji:'👀'});await until(fx.settled);
  let page=fx.groups.read({id:room.id});assert.equal(page.messages.filter(m=>m.kind==='reaction').length,1);assert.equal(reactionsSeen,1);assert.equal(page.pins?.[target.id][0].actor.id,'user');
  const reopened=new Store(fx.dir);assert.equal(reopened.data.groups[0].messages.find(m=>m.id===target.id)?.pins?.[0].emoji,'👀');
  assert.throws(()=>fx.groups.pinUser({groupId:room.id,messageId:page.messages.at(-1)!.id,emoji:'👍'}),/文字消息/);
  const other=fx.groups.create({name:'另一个群',botIds:[fx.a.id,fx.b.id]});assert.throws(()=>fx.groups.pinUser({groupId:other.id,messageId:target.id,emoji:'👍'}),/文字消息/);
  fx.groups.pinUser({groupId:room.id,messageId:target.id,emoji:'👀',remove:true});await until(fx.settled);page=fx.groups.read({id:room.id});assert.equal(page.messages.filter(m=>m.kind==='reaction').length,2);assert.equal(page.pins?.[target.id],undefined);assert.equal(reactionsSeen,2);
});

test('creating a group persists one lifecycle event without waking members',async t=>{
  const seen:string[]=[];const fx=fixture(t,(run,messages)=>{const event=publishedMessages(messages).at(-1);assert.equal(event.kind,'system');assert.equal(event.event.type,'created');assert.equal(event.event.actor.kind,'user');assert.deepEqual(event.event.members.map((member:any)=>member.id),[fx.a.id,fx.b.id]);seen.push(run.botId);return silent();});
  const group=fx.groups.create({name:'创建事件',botIds:[fx.a.id,fx.b.id]});await until(fx.settled);
  const page=fx.groups.read({id:group.id}),events=page.messages.filter(message=>message.event);assert.equal(events.length,1);assert.equal(events[0].event!.left.length,0);
  assert.deepEqual(page.deliveries.map(delivery=>delivery.recipientId),['user']);assert.deepEqual(seen,[]);
  fx.groups.wake();fx.groups.read({id:group.id});await delay(150);assert.equal(seen.length,0);assert.equal(fx.groups.read({id:group.id}).messages.length,1);
  const restored=new Store(fx.dir),before=restored.data.groupDeliveries.length;const service=new GroupChats(restored,{isRunning:()=>false,run:async()=>{throw Error('不能重播创建事件');},cancel:()=>{}},()=>{});service.start();await delay(150);assert.equal(restored.data.groupDeliveries.length,before);assert.equal(restored.data.groups[0].messages.filter(message=>message.event).length,1);service.dispose();
});

test('one membership save combines joins and removals without waking members',async t=>{
  const seen:Array<{botId:string;event:any}>=[];const fx=fixture(t,(run,messages)=>{seen.push({botId:run.botId,event:publishedMessages(messages).at(-1)?.event});return silent();});
  const d=fx.store.createBot('新成员','协作'),group=fx.groups.create({name:'成员事件',botIds:[fx.a.id,fx.b.id]});await until(fx.settled);seen.length=0;
  fx.groups.update({id:group.id,name:group.name,botIds:[fx.a.id,fx.c.id,d.id]});await until(fx.settled);
  const page=fx.groups.read({id:group.id}),event=page.messages.find(message=>message.event?.type==='members_changed')!;assert.ok(event);assert.equal(page.messages.filter(message=>message.event?.type==='members_changed').length,1);
  assert.deepEqual(event.event!.joined.map(bot=>bot.id),[fx.c.id,d.id]);assert.deepEqual(event.event!.left.map(bot=>bot.id),[fx.b.id]);assert.deepEqual(event.event!.members.map(bot=>bot.id),[fx.a.id,fx.c.id,d.id]);
  assert.deepEqual(page.deliveries.filter(delivery=>delivery.messageId===event.id).map(delivery=>delivery.recipientId),['user']);assert.deepEqual(seen,[]);
  const count=fx.store.data.groupDeliveries.length;fx.groups.update({id:group.id,name:group.name,botIds:[d.id,fx.a.id,fx.c.id]});fx.groups.update({id:group.id,name:'仅改群名',botIds:[fx.a.id,fx.c.id,d.id]});await delay(150);assert.equal(fx.store.data.groupDeliveries.length,count);
  fx.groups.update({id:group.id,name:'仅改群名',botIds:[fx.a.id,fx.b.id,fx.c.id,d.id]});await until(fx.settled);assert.deepEqual(fx.groups.read({id:group.id}).messages.at(-1)!.event!.joined.map(bot=>bot.id),[fx.b.id]);
});

test('membership changes refresh the coordinator work and cancel the removed recipient',async t=>{
  const aborted=new Set<string>();const fx=fixture(t,async(run,messages,_tools,signal)=>{const latest=publishedMessages(messages).at(-1);if(latest.kind==='message'){try{return await waitAbort(signal);}finally{aborted.add(run.botId);}}return silent();});
  const group=fx.groups.create({name:'进行中的成员变动',botIds:[fx.a.id,fx.b.id]});await until(fx.settled);fx.groups.send({id:group.id,message:'等待新的分工信息'});await until(()=>fx.groups.snapshot().rooms[0].activities?.length===1);
  const rootId=fx.store.data.groups[0].activeRootId;fx.groups.update({id:group.id,name:group.name,botIds:[fx.a.id,fx.c.id]});await until(fx.settled);
  assert.ok(aborted.has(fx.a.id));assert.equal(fx.store.data.groups[0].activeRootId,rootId);
  const page=fx.groups.read({id:group.id}),event=page.messages.at(-1)!;assert.equal(event.event?.type,'members_changed');assert.deepEqual(page.deliveries.filter(delivery=>delivery.messageId===event.id).map(delivery=>delivery.recipientId),['user']);assert.ok(page.deliveries.filter(delivery=>delivery.recipientId===fx.b.id&&delivery.rootId===rootId).every(delivery=>delivery.status==='cancelled'));
});

test('Bot creation and invitations broadcast once with the true actor and deletion notifies remaining members',async t=>{
  const fx=fixture(t),run:RunRecord={id:randomUUID(),botId:fx.a.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};fx.store.data.runs.push(run);fx.store.message(fx.a.id,'user','创建群聊并邀请伙伴',{runId:run.id});
  const {groupId}=fx.groups.invoke(fx.a.id,run.id,'group_create',{name:'Bot 建群',botIds:[fx.b.id],message:'一起协作'},new AbortController().signal,{}) as {groupId:string};
  let page=fx.groups.read({id:groupId});const created=page.messages.find(message=>message.event?.type==='created')!;assert.equal(created.event!.actor.id,fx.a.id);assert.equal(created.event!.actor.kind,'bot');assert.deepEqual(page.deliveries.filter(delivery=>delivery.messageId===created.id).map(delivery=>delivery.recipientId),['user']);assert.equal(fx.store.data.groupRounds.find(round=>round.id===created.rootId)?.request,'创建群聊并邀请伙伴');
  fx.groups.invoke(fx.a.id,run.id,'group_invite',{groupId,botIds:[fx.c.id]},new AbortController().signal,{});const count=fx.store.data.groupDeliveries.length;fx.groups.invoke(fx.a.id,run.id,'group_invite',{groupId,botIds:[fx.c.id]},new AbortController().signal,{});assert.equal(fx.store.data.groupDeliveries.length,count);run.status='completed';await until(fx.settled);
  page=fx.groups.read({id:groupId});const invite=page.messages.find(message=>message.event?.type==='members_changed')!;assert.equal(invite.event!.actor.id,fx.a.id);assert.deepEqual(invite.event!.joined.map(bot=>bot.id),[fx.c.id]);
  fx.groups.deletingBot(fx.b.id);fx.store.deleteBot(fx.b.id);await until(fx.settled);page=fx.groups.read({id:groupId});const removed=page.messages.at(-1)!;assert.deepEqual(removed.event!.left.map(bot=>bot.id),[fx.b.id]);assert.deepEqual(page.deliveries.filter(delivery=>delivery.messageId===removed.id).map(delivery=>delivery.recipientId),['user']);
});
