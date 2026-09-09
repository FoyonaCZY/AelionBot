import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {TaskScheduler,validateTaskSchedule} from '../electron/core/task-scheduler';
import {ChatPinQueue} from '../electron/core/chat-pins';
import {GroupChats} from '../electron/core/group-chats';
import {Harness} from '../electron/core/harness';
import {Interactions} from '../electron/core/interactions';
import {HostComputer} from '../electron/core/host';
import {nextTaskTime,wallTimeToInstant,type TaskSchedule,type TaskTarget} from '../src/scheduled-types';
import {groupPending} from '../src/group-types';
import type {ModelClient,Completion,ToolDefinition} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';
import type {RunRecord,WireMessage} from '../src/shared';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean){for(let n=0;n<650;n++){if(predicate())return;await delay(10);}throw new Error('Scheduled task did not settle');}
const zone='Asia/Shanghai',iso=(value:string)=>Date.parse(value);
const daily:TaskSchedule={kind:'daily',time:'09:00',timeZone:zone};
const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'});
const call=(name:string,args:Record<string,unknown>):Completion=>({content:'',calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}],finishReason:'tool_calls'});
function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'aelion-schedule-')),store=new Store(dir),bot=store.data.bots[0],other=store.createBot('Other','test'),target:TaskTarget={kind:'bot',id:bot.id};
  store.data.model.model='fixture';store.data.model.contextTokens=64000;
  let clock=iso('2026-09-06T00:00:00Z'),ready=true;const cleanup:Array<()=>void|Promise<void>>=[];
  const send=(scope:TaskTarget,prompt:string,scheduled:any)=>{assert.equal(scope.kind,'bot');store.message(scope.id,'user',prompt,{scheduled,inputState:'queued'});};
  const scheduler=new TaskScheduler(store,{ready:()=>ready,send},()=>{},()=>clock);cleanup.push(()=>scheduler.dispose());
  const create=(schedule:TaskSchedule=daily,title='每日核对')=>scheduler.create({target,title,prompt:'核对待办并汇报',schedule});
  t.after(async()=>{for(const close of cleanup)await close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,bot,other,target,scheduler,create,send,cleanup,get now(){return clock;},set now(value:number){clock=value;},setReady:(value:boolean)=>{ready=value;}};
}

test('daily, workday and interval schedules calculate the next actual time in the saved time zone',()=>{
  assert.equal(nextTaskTime(daily,iso('2026-09-06T00:00:00Z')),'2026-09-06T01:00:00.000Z');
  assert.equal(nextTaskTime(daily,iso('2026-09-06T01:00:00Z')),'2026-09-07T01:00:00.000Z');
  assert.equal(nextTaskTime({kind:'weekly',time:'09:00',timeZone:zone,weekdays:[1,2,3,4,5]},iso('2026-09-04T03:00:00Z')),'2026-09-07T01:00:00.000Z');
  assert.equal(nextTaskTime({kind:'interval',minutes:60,timeZone:zone},iso('2026-09-06T05:35:00Z'),iso('2026-09-06T01:00:00Z')),'2026-09-06T06:00:00.000Z');
  assert.equal(nextTaskTime({kind:'once',at:'2026-09-06T01:00:00Z',timeZone:zone},iso('2026-09-06T01:00:00Z')),undefined);
});

test('DST skips nonexistent wall times and never triggers twice in the repeated hour',()=>{
  const timeZone='America/New_York';assert.equal(wallTimeToInstant('2026-03-08','02:30',timeZone),undefined);
  assert.equal(nextTaskTime({kind:'daily',time:'02:30',timeZone},iso('2026-03-07T08:00:00Z')),'2026-03-09T06:30:00.000Z');
  assert.equal(wallTimeToInstant('2026-11-01','01:30',timeZone),iso('2026-11-01T05:30:00Z'));
  assert.equal(nextTaskTime({kind:'daily',time:'01:30',timeZone},iso('2026-11-01T05:30:00Z')),'2026-11-02T06:30:00.000Z');
});

test('invalid schedules and edits never partially update a saved task',t=>{
  const f=fixture(t),task=f.create(),before=readFileSync(f.store.file,'utf8');
  for(const schedule of [{...daily,time:'25:00'},{...daily,timeZone:'not-a-zone'},{kind:'weekly',time:'10:00',weekdays:[],timeZone:zone},{kind:'interval',minutes:0,timeZone:zone},{kind:'once',at:'2026-09-06T10:00',timeZone:zone}])assert.throws(()=>f.scheduler.update({id:task.id,title:'must not save',schedule:schedule as TaskSchedule}));
  assert.throws(()=>f.create({kind:'once',at:'2026-09-05T00:00:00Z',timeZone:zone}),/晚于/);
  assert.equal(readFileSync(f.store.file,'utf8'),before);assert.equal(f.scheduler.list()[0].title,task.title);
  assert.deepEqual(validateTaskSchedule({kind:'weekly',time:'09:00',weekdays:[2,1,2],timeZone:zone}),{kind:'weekly',time:'09:00',weekdays:[1,2],timeZone:zone});
});

test('busy conversations wait and missed recurring slots coalesce into one durable occurrence',t=>{
  const f=fixture(t);f.create();f.setReady(false);f.now=iso('2026-09-09T03:00:00Z');f.scheduler.tick();assert.equal(f.store.data.messages.length,0);
  f.setReady(true);f.scheduler.tick();f.scheduler.tick();const task=f.scheduler.list()[0];assert.equal(f.store.data.messages.length,1);assert.equal(task.lastRun?.status,'queued');assert.equal(task.lastRun?.scheduledFor,'2026-09-06T01:00:00.000Z');assert.equal(task.nextRunAt,'2026-09-10T01:00:00.000Z');
  assert.equal(new Store(f.dir).data.scheduledTasks[0].lastRun?.id,task.lastRun!.id);
});

test('pause and resume persist, expired one-shot tasks require a new time, and manual runs do not re-enable a paused plan',t=>{
  const f=fixture(t),task=f.create();f.scheduler.update({id:task.id,status:'paused'});f.now+=86400000;f.scheduler.tick();assert.equal(f.store.data.messages.length,0);
  f.scheduler.runNow(task.id);assert.equal(f.scheduler.list()[0].status,'paused');assert.equal(f.scheduler.list()[0].nextRunAt,undefined);assert.equal(f.store.data.messages.length,1);
  f.store.data.messages[0].inputState='cancelled';f.scheduler.tick();f.scheduler.update({id:task.id,status:'enabled'});assert.ok(Date.parse(f.scheduler.list()[0].nextRunAt!)>f.now);
  const once=f.create({kind:'once',at:new Date(f.now+60000).toISOString(),timeZone:zone},'一次任务');f.scheduler.update({id:once.id,status:'paused'});f.now+=120000;assert.throws(()=>f.scheduler.update({id:once.id,status:'enabled'}),/未来/);
  f.scheduler.remove(task.id);assert.equal(f.scheduler.list().length,1);assert.equal(new Store(f.dir).data.scheduledTasks.length,1);
});

test('restart does not replay a claimed occurrence but delivers an overdue unstarted task once',t=>{
  const f=fixture(t),once=f.create({kind:'once',at:new Date(f.now+1000).toISOString(),timeZone:zone});f.now+=2000;f.scheduler.tick();f.scheduler.dispose();
  const reopened=new Store(f.dir),scheduler=new TaskScheduler(reopened,{ready:()=>true,send:(target,prompt,scheduled)=>reopened.message(target.id,'user',prompt,{scheduled,inputState:'queued'})},()=>{},()=>f.now);f.cleanup.push(()=>scheduler.dispose());scheduler.tick();
  assert.equal(reopened.data.messages.length,1);assert.equal(scheduler.list()[0].id,once.id);assert.equal(scheduler.list()[0].status,'paused');assert.equal(scheduler.list()[0].lastRun?.status,'interrupted');
  scheduler.create({target:f.target,title:'离线到期任务',prompt:'执行一次',schedule:{kind:'once',at:new Date(f.now+1000).toISOString(),timeZone:zone}});scheduler.dispose();f.now+=120000;
  const again=new Store(f.dir),restored=new TaskScheduler(again,{ready:()=>true,send:(target,prompt,scheduled)=>again.message(target.id,'user',prompt,{scheduled,inputState:'queued'})},()=>{},()=>f.now);f.cleanup.push(()=>restored.dispose());restored.tick();restored.tick();assert.equal(again.data.messages.length,2);
});

test('a Bot can manage only its current conversation tasks and identical group creation is deduplicated',t=>{
  const f=fixture(t),groupId=randomUUID(),stamp=new Date(f.now).toISOString();f.store.data.groups.push({id:groupId,name:'Tasks',createdBy:{kind:'user',id:'user',name:'你'},createdAt:stamp,updatedAt:stamp,members:[f.bot,f.other].map(bot=>({id:bot.id,name:bot.name,color:bot.color,joinedAt:stamp})),messages:[],lastReadSeq:0});
  const run=(botId:string,group=false)=>{const value:RunRecord={id:randomUUID(),botId,status:'running',startedAt:stamp,modelCalls:1,toolCalls:0,...(group?{groupOrigin:{groupId,rootId:'round',deliveryId:'delivery'}}:{})};f.store.data.runs.push(value);return value;};
  const direct=run(f.bot.id),peer=run(f.other.id),args={title:'周报',prompt:'整理本周进度',schedule:daily},signal=new AbortController().signal;
  const task=f.scheduler.invoke(f.bot.id,direct.id,'scheduled_task_create',args,signal,{}) as any;
  assert.deepEqual(f.scheduler.invoke(f.other.id,peer.id,'scheduled_tasks_list',{},signal,{}),[]);assert.throws(()=>f.scheduler.invoke(f.other.id,peer.id,'scheduled_task_delete',{id:task.id},signal,{}),/当前会话/);
  const a=run(f.bot.id,true),b=run(f.other.id,true);const first=f.scheduler.invoke(f.bot.id,a.id,'scheduled_task_create',args,signal,{}) as any,second=f.scheduler.invoke(f.other.id,b.id,'scheduled_task_create',args,signal,{}) as any;assert.equal(first.id,second.id);assert.equal(first.target.kind,'group');
  assert.throws(()=>f.scheduler.invoke(f.bot.id,a.id,'scheduled_task_create',args,AbortSignal.abort(),{}),/已结束/);
  assert.equal(f.scheduler.list().length,2);
});

test('a scheduled direct task goes through the real chat queue and tools, replies once, and completes its one-shot plan',async t=>{
  const f=fixture(t);let executions=0;
  const model={complete:async(messages:WireMessage[],tools:ToolDefinition[])=>{assert.ok(tools.some(tool=>tool.function.name==='scheduled_task_create'));assert.match(messages.filter(message=>message.role==='system').map(message=>message.content||'').join('\n'),/不要重新创建同一计划/);return executions?answer('定时核对已完成'):call('computer_execute',{command:'check-work'});}} as unknown as ModelClient;
  const vm={execute:async()=>{executions++;return {stdout:'verified',stderr:'',exitCode:0,durationMs:1};}} as unknown as VmController;
  const harness=new Harness(f.store,vm,model,()=>{}),queue=new ChatPinQueue(f.store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args)},()=>{}),scheduler=new TaskScheduler(f.store,{ready:()=>!harness.busy&&!queue.hasPending(f.bot.id),send:(target,prompt,trigger)=>queue.schedule(target.id,prompt,trigger)},()=>{},()=>f.now);harness.setTaskScheduler(scheduler);
  f.cleanup.push(async()=>{scheduler.dispose();queue.dispose();harness.cancel(f.bot.id);await until(()=>!harness.busy);await delay(20);});
  const task=scheduler.create({target:f.target,title:'核对',prompt:'核对工作并回复',schedule:{kind:'once',at:new Date(f.now+1000).toISOString(),timeZone:zone}});f.now+=2000;scheduler.tick();await until(()=>f.store.data.runs.length>0&&!harness.busy&&!queue.hasPending(f.bot.id));scheduler.tick();
  assert.equal(executions,1);assert.equal(scheduler.list()[0].status,'completed');assert.equal(scheduler.list()[0].lastRun?.status,'completed');scheduler.tick();assert.equal(f.store.data.messages.filter(message=>message.scheduled).length,1);
  assert.equal(f.store.data.messages.filter(message=>message.content==='定时核对已完成').length,1);assert.equal(new Store(f.dir).data.scheduledTasks.find(item=>item.id===task.id)?.status,'completed');
});

test('model-created schedules in a group broadcast to its members and publish their actual tool results in that group',async t=>{
  const f=fixture(t),executed=new Set<string>();let creating=true;let scheduler:TaskScheduler;
  const model={complete:async(messages:WireMessage[],tools:ToolDefinition[])=>{
    const id=/\/work\/([a-f0-9-]+)/.exec(messages.filter(message=>message.role==='system').map(message=>message.content||'').join('\n'))?.[1]!,run=f.store.data.runs.find(run=>run.botId===id&&run.status==='running')!;
    if(creating){if(id!==f.bot.id)return answer('[群聊静默]');if(!f.store.data.scheduledTasks.length)return call('scheduled_task_create',{title:'群定时核对',prompt:'请各自核对工作成果',schedule:{kind:'once',at:new Date(f.now+1000).toISOString(),timeZone:zone}});return answer('群定时任务已创建');}
    if(!executed.has(id)){assert.ok(tools.some(tool=>tool.function.name==='computer_execute'));executed.add(id);return call('computer_execute',{command:'verify-'+id});}
    return answer(run.toolCalls?'已核对 '+id:'[群聊静默]');
  }} as unknown as ModelClient;
  const commands:string[]=[],vm={execute:async(command:string)=>{commands.push(command);return {stdout:'verified',stderr:'',exitCode:0,durationMs:1};}} as unknown as VmController;
  let groups:GroupChats;const harness=new Harness(f.store,vm,model,()=>groups?.wake());groups=new GroupChats(f.store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args),cancel:id=>harness.cancel(id),refresh:id=>harness.refreshGroup(id)},()=>{});harness.setGroupGateway(groups);groups.start();
  const settled=()=>!groups.busy&&!harness.busy&&!f.store.data.groupDeliveries.some(delivery=>groupPending(delivery.status));
  scheduler=new TaskScheduler(f.store,{ready:()=>settled(),send:(target,prompt,trigger)=>groups.schedule(target.id,prompt,trigger)},()=>{},()=>f.now);harness.setTaskScheduler(scheduler);
  f.cleanup.push(async()=>{scheduler.dispose();groups.dispose();for(const bot of f.store.data.bots)harness.cancel(bot.id);await until(()=>!groups.busy&&!harness.busy);});
  const room=groups.create({name:'定时任务协作',botIds:[f.bot.id,f.other.id]});groups.send({id:room.id,message:'请创建一个定时核对任务'});await until(settled);assert.equal(scheduler.list().length,1);assert.deepEqual(scheduler.list()[0].target,{kind:'group',id:room.id});
  creating=false;f.now+=2000;scheduler.tick();await until(settled);scheduler.tick();
  assert.equal(commands.length,2);assert.equal(scheduler.list()[0].status,'completed');assert.equal(room.id,f.store.data.groups.find(room=>room.messages.some(message=>message.scheduled))?.id);
  const page=groups.read({id:room.id});assert.equal(page.messages.filter(message=>message.scheduled).length,1);assert.ok(page.messages.some(message=>message.sender.kind==='bot'&&message.content.startsWith('已核对')));
});

test('scheduled host operations still wait for approval, and a refusal pauses a one-shot task without writing or retrying',async t=>{
  const f=fixture(t),path=join(f.dir,'must-not-write.txt'),interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:f.dir,homeDir:f.dir,projectDir:f.dir},interactions);let calls=0;
  const model={complete:async()=>{calls++;return call('host_file_write',{path,content:'not authorized',reason:'定时保存'});}} as unknown as ModelClient;
  const harness=new Harness(f.store,{} as VmController,model,()=>{},undefined,undefined,undefined,host,interactions),queue=new ChatPinQueue(f.store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args)},()=>{}),scheduler=new TaskScheduler(f.store,{ready:()=>!harness.busy,send:(target,prompt,trigger)=>queue.schedule(target.id,prompt,trigger)},()=>{},()=>f.now);harness.setTaskScheduler(scheduler);
  f.cleanup.push(async()=>{scheduler.dispose();queue.dispose();harness.cancel(f.bot.id);await until(()=>!harness.busy);host.dispose();interactions.dispose();await delay(20);});
  scheduler.create({target:f.target,title:'定时保存',prompt:'保存文件',schedule:{kind:'once',at:new Date(f.now+1000).toISOString(),timeZone:zone}});f.now+=2000;scheduler.tick();await until(()=>interactions.snapshot().length===1);assert.equal(existsSync(path),false);
  scheduler.tick();assert.equal(scheduler.list()[0].lastRun?.status,'running');interactions.approve(interactions.snapshot()[0].id,false);await until(()=>!harness.busy&&!queue.hasPending(f.bot.id));scheduler.tick();scheduler.tick();
  assert.equal(existsSync(path),false);assert.equal(calls,1);assert.equal(scheduler.list()[0].status,'paused');assert.equal(scheduler.list()[0].lastRun?.status,'cancelled');
});

test('human input takes priority while scheduled tasks remain separate queued runs',async t=>{
  const f=fixture(t),requests:string[]=[];
  const model={complete:async(messages:WireMessage[])=>{requests.push(messages.filter(message=>message.role==='user').at(-1)!.content!);return answer('已处理');}} as unknown as ModelClient;
  const harness=new Harness(f.store,{} as VmController,model,()=>{}),queue=new ChatPinQueue(f.store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args)},()=>{});
  f.cleanup.push(async()=>{queue.dispose();await until(()=>!queue.hasPending(f.bot.id)&&!harness.busy);await delay(20);});
  queue.schedule(f.bot.id,'定时核对',{taskId:'task',occurrenceId:'occurrence',title:'核对',scheduledFor:new Date(f.now).toISOString()});queue.send({botId:f.bot.id,message:'先回答我的新问题'});
  await until(()=>requests.length===2&&!harness.busy&&!queue.hasPending(f.bot.id));assert.equal(requests[0],'先回答我的新问题');assert.match(requests[1],/定时任务触发/);
  const inputs=f.store.data.messages.filter(message=>message.role==='user');assert.notEqual(inputs[0].runId,inputs[1].runId);
});

test('running a one-shot task early consumes its scheduled occurrence instead of firing again at the original time',t=>{
  const f=fixture(t),task=f.create({kind:'once',at:new Date(f.now+60000).toISOString(),timeZone:zone});f.scheduler.runNow(task.id);assert.equal(f.scheduler.list()[0].nextRunAt,undefined);
  const message=f.store.data.messages[0],run:RunRecord={id:randomUUID(),botId:f.bot.id,status:'completed',startedAt:new Date(f.now).toISOString(),endedAt:new Date(f.now).toISOString(),modelCalls:1,toolCalls:0};f.store.data.runs.push(run);message.runId=run.id;message.inputState='handled';f.scheduler.tick();assert.equal(f.scheduler.list()[0].status,'completed');f.now+=120000;f.scheduler.tick();assert.equal(f.store.data.messages.length,1);
});
