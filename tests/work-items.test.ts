import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {HostComputer} from '../electron/core/host';
import {Interactions,InteractionDenied} from '../electron/core/interactions';
import {WorkItems} from '../electron/core/work-items';
import {ExecutionLedger} from '../electron/core/execution-ledger';
import {ChatPinQueue} from '../electron/core/chat-pins';
import {GroupChats} from '../electron/core/group-chats';
import {conversationWorkspace,setConversationWorkspace} from '../electron/core/workspaces';
import {workCommand} from '../src/work-types';
import type {RunRecord} from '../src/shared';
import type {ModelClient,Completion,ToolDefinition} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';

function fixture(t:test.TestContext){
  const parent=realpathSync.native(tmpdir()),dir=realpathSync.native(mkdtempSync(join(parent,'aelion-work-items-'))),store=new Store(dir),bot=store.data.bots[0];
  store.data.model.model='test';store.data.runtime={maxTurns:12,maxMinutes:10,maxTokens:20000,modelRetries:0,requestTimeoutMs:1000,maxOutputTokens:1000,parallelReads:1,fileCheckpoints:false};
  const interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:dir,projectDir:dir,homeDir:dir},interactions);
  const cleanup:Array<()=>void>=[];
  t.after(()=>{for(const dispose of cleanup)dispose();host.dispose();interactions.dispose();assert.equal(dirname(resolve(dir)),parent);assert.ok(basename(dir).startsWith('aelion-work-items-'));rmSync(dir,{recursive:true,force:true});});
  return {store,bot,dir,host,interactions,cleanup,work:new WorkItems(store)};
}
const call=(name:string,args:Record<string,unknown>={})=>({id:Math.random().toString(36),type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
const response=(calls:Completion['calls']=[],content='已按要求处理。'):Completion=>({content,calls,finishReason:'stop'});
const plan=(revision=0,status='pending',evidenceIds:string[]=[])=>({revision,goal:'修复项目并验证',steps:[{id:'fix',title:'修复项目',acceptance:'文件包含预期结果',status,evidenceIds}]});
const record=(botId:string,id:string):RunRecord=>({id,botId,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0});

test('slash commands match only complete leading commands, including multiline prompts',()=>{
  assert.deepEqual(workCommand('/plan 修复项目\n加上验证'),{kind:'plan',objective:'修复项目\n加上验证'});
  assert.deepEqual(workCommand('/GOAL 发布报告'),{kind:'goal',objective:'发布报告'});
  for(const text of ['/planning nope','解释 /plan','/goalkeeper','src/plan.ts'])assert.equal(workCommand(text),undefined);
  assert.equal(workCommand('/plan')?.objective,'');
});

test('conversation folders persist independently, reset to default, and require existing directories',t=>{
  const {store,host,dir,bot,interactions}=fixture(t),other=store.createBot('其他','测试'),a=join(dir,'project A'),b=join(dir,'project B');mkdirSync(a);mkdirSync(b);
  setConversationWorkspace(store,host,{kind:'bot',id:bot.id},a);setConversationWorkspace(store,host,{kind:'bot',id:other.id},b);
  assert.equal(conversationWorkspace(new Store(dir),{kind:'bot',id:bot.id}),a);assert.equal(host.workspace(bot.id),host.workspaceSettings().defaultWorkspaceDir);
  assert.equal(interactions.snapshot().length,0);assert.throws(()=>setConversationWorkspace(store,host,{kind:'bot',id:bot.id},join(dir,'absent')),/不存在/);
  setConversationWorkspace(store,host,{kind:'bot',id:bot.id},null);assert.equal(conversationWorkspace(store,{kind:'bot',id:bot.id}),undefined);assert.equal(conversationWorkspace(store,{kind:'bot',id:other.id}),b);
  assert.throws(()=>setConversationWorkspace(store,host,{kind:'group',id:'missing'},a),/不存在/);
});

test('relative host reads and writes show exact project paths and retain single-use permission',async t=>{
  const {dir,host,interactions}=fixture(t),project=join(dir,'project 空格');mkdirSync(project);writeFileSync(join(project,'readme.md'),'original');
  const reading=host.readFile('bot','r',{path:'readme.md',reason:'查看项目说明'},new AbortController().signal,project),request=interactions.snapshot()[0];
  assert.equal(request.kind,'host_permission');if(request.kind==='host_permission')assert.equal(request.details.path,join(project,'readme.md'));interactions.approve(request.id,true);assert.equal((await reading).content,'original');
  const writing=host.writeFile('bot','r',{path:'readme.md',reason:'更新文件',content:'new',overwrite:true},new AbortController().signal,project),rejected=assert.rejects(writing,InteractionDenied);assert.equal(interactions.snapshot().length,1);interactions.approve(interactions.snapshot()[0].id,false);await rejected;assert.equal(readFileSync(join(project,'readme.md'),'utf8'),'original');
  const listing=host.listDirectory('bot','r',{reason:'查看目录'},new AbortController().signal,project);interactions.approve(interactions.snapshot()[0].id,true);assert.equal((await listing).items[0].name,'readme.md');
});

test('selected cwd is immutable while a host command awaits permission',{skip:process.platform!=='win32'},async t=>{
  const {host,interactions,dir,store,bot}=fixture(t),first=join(dir,'first'),second=join(dir,'second');mkdirSync(first);mkdirSync(second);
  setConversationWorkspace(store,host,{kind:'bot',id:bot.id},first);
  const running=host.execute(bot.id,'r',{command:'(Get-Location).Path',reason:'核对目录'},new AbortController().signal,first);
  setConversationWorkspace(store,host,{kind:'bot',id:bot.id},second);interactions.approve(interactions.snapshot()[0].id,true);
  const result=await running;assert.equal(result.exitCode,0);assert.equal(result.stdout.trim(),first);
});

test('/plan persists a pending checklist, exposes only read tools, and executes only after confirmation',async t=>{
  const {store,bot,work}=fixture(t);let turn=0,writes=0;
  const model={complete:async(_messages:unknown,tools:ToolDefinition[])=>{
    if(turn++===0){assert.ok(tools.some(t=>t.function.name==='plan_update'));assert.ok(!tools.some(t=>['host_execute','file_write','goal_set','bot_send_message','scheduled_task_create','mcp_call'].includes(t.function.name)));return response([call('plan_update',plan())]);}
    return response([],'计划已生成，请确认。');
  }} as unknown as ModelClient;
  const vm={execute:async()=>{writes++;return {exitCode:0,stdout:'verified'};}} as unknown as VmController;
  await new Harness(store,vm,model,()=>{}).run(bot.id,'/plan 修复项目并验证');
  const item=store.data.workItems![0];assert.equal(item.status,'ready');assert.equal(writes,0);assert.equal(item.plan?.steps[0].status,'pending');
  const userMessages=store.data.messages.filter(m=>m.role==='user').length;work.action({id:item.id,action:'start'});
  let executeTurn=0;const executeModel={complete:async()=>{
    executeTurn++;
    if(executeTurn===1)return response([call('file_write',{path:'result.txt',content:'ok'})]);
    if(executeTurn===2){const evidence=store.data.runs.at(-1)!.executions!.find(e=>e.tool==='file_write')!.id;return response([call('plan_update',plan(1,'done',[evidence]))]);}
    return response([],'已完成并核对文件。');
  }} as unknown as ModelClient;
  await new Harness(store,vm,executeModel,()=>{}).run(bot.id,'执行已确认计划',{workItemId:item.id});
  assert.equal(writes,1);assert.equal(item.status,'completed');assert.equal(item.runIds.length,2);assert.equal(store.data.messages.filter(m=>m.role==='user').length,userMessages);assert.equal(store.humanRunMessage(item.runIds[1])?.id,item.sourceMessageId);
});

test('goal keeps working after premature final text and needs real verification to complete',async t=>{
  const {store,bot}=fixture(t);let turn=0;
  const model={complete:async()=>{
    turn++;if(turn===1)return response([],'我会继续处理。');
    if(turn===2)return response([call('plan_update',plan())]);
    if(turn===3)return response([call('file_read',{path:'result.txt'})]);
    const evidence=store.data.runs.at(-1)?.executions?.find(e=>e.tool==='file_read')?.id;
    if(turn===4)return response([call('plan_update',plan(1,'done',[evidence!]))]);
    if(turn===5)return response([call('goal_update',{status:'completed',summary:'实际读取并核对了文件内容',evidenceIds:[evidence]})]);
    return response([],'目标已完成。');
  }} as unknown as ModelClient;
  await new Harness(store,{execute:async(_command:string,botId:string)=>({exitCode:0,stdout:JSON.stringify({path:`/work/${botId}/result.txt`,data:Buffer.from('ok').toString('base64')})})} as unknown as VmController,model,()=>{}).run(bot.id,'/goal 修复项目并验证');
  assert.equal(turn,6);const item=store.data.workItems![0];assert.equal(item.status,'completed');assert.match(item.summary!,/实际读取/);assert.equal(store.data.runs[0].status,'completed');
});

test('bot can establish its own goal and report a concrete blocker without looping',async t=>{
  const {store,bot}=fixture(t);let turn=0;
  const model={complete:async()=>++turn===1?response([call('goal_set',{objective:'完成用户的项目修改'})]):turn===2?response([call('goal_update',{status:'blocked',reason:'缺少待修改的项目文件，请选择对应的工作目录。'})]):response([],'请先选择项目目录。')} as unknown as ModelClient;
  await new Harness(store,{} as VmController,model,()=>{}).run(bot.id,'请处理项目修改');
  assert.equal(turn,3);assert.equal(store.data.workItems![0].createdBy,'bot');assert.equal(store.data.workItems![0].status,'blocked');
});

test('stopping planning or restarting the app never approves a pending plan',t=>{
  const {store,bot,work}=fixture(t),run=record(bot.id,'r1');store.data.runs.push(run);work.create(run,'plan','修改项目','user');work.updatePlan(run,plan());run.status='cancelled';work.finish(run);
  const next=record(bot.id,'r2');store.data.runs.push(next);work.begin(next,{supersedesRunId:run.id});assert.equal(work.forRun(next)?.status,'planning');
  const restored=new Store(store.dir),item=restored.data.workItems![0];assert.equal(item.status,'paused');assert.equal(item.approvedAt,undefined);assert.equal(item.activeRunId,undefined);
});

test('evidence survives goal continuation, unknown operations must be checked, other tasks cannot provide evidence',t=>{
  const {store,bot,work}=fixture(t),first=record(bot.id,'first');store.data.runs.push(first);const item=work.create(first,'goal','验证项目','user'),ledger=new ExecutionLedger(store);
  work.updatePlan(first,plan());const original=ledger.begin(bot.id,first.id,call('file_write',{path:'a'}),{path:'a'});ledger.finish(original,'unknown',{},'unknown');first.status='interrupted';work.finish(first);
  const next=record(bot.id,'next');store.data.runs.push(next);work.action({id:item.id,action:'start'});work.begin(next,{workItemId:item.id});
  const checked=ledger.begin(bot.id,next.id,call('file_read',{path:'a'}),{path:'a'});ledger.finish(checked,'succeeded',{content:'ok'},'checked');
  work.updatePlan(next,plan(1,'done',[checked.id]));assert.throws(()=>work.invoke(next,'goal_update',{status:'completed',summary:'已核对原文件结果',evidenceIds:[checked.id]}),/未解决/);
  ledger.resolve(bot.id,next.id,{executionId:original.id,kind:'resolved',reason:'重新读取原文件确认写入结果正确',evidenceIds:[checked.id]});
  const other=record(bot.id,'unrelated');store.data.runs.push(other);const foreign=ledger.begin(bot.id,other.id,call('file_read',{path:'b'}),{path:'b'});ledger.finish(foreign,'succeeded',{},'foreign');
  assert.throws(()=>work.invoke(next,'goal_update',{status:'completed',summary:'完成',evidenceIds:[foreign.id]}),/本目标/);
  work.invoke(next,'goal_update',{status:'completed',summary:'通过重新读取完成验证',evidenceIds:[checked.id]});assert.equal(item.status,'completed');
});

test('queued messages retain selected workspace and bare slash commands do not send',t=>{
  const {store,bot,host,dir,cleanup}=fixture(t),project=join(dir,'project');mkdirSync(project);setConversationWorkspace(store,host,{kind:'bot',id:bot.id},project);
  const queue=new ChatPinQueue(store,{isRunning:()=>true,run:async()=>{}},()=>{});cleanup.push(()=>queue.dispose());
  assert.throws(()=>queue.send({botId:bot.id,message:'/plan'}),/任务内容/);queue.send({botId:bot.id,message:'/goal 修复项目'});setConversationWorkspace(store,host,{kind:'bot',id:bot.id},null);
  assert.equal(store.data.messages.at(-1)?.workspaceDir,project);
});

test('group plan confirmation broadcasts a human event with a stable task id and explicit recipient',t=>{
  const {store,bot,work,cleanup}=fixture(t),other=store.createBot('协作者','测试'),groups=new GroupChats(store,{isRunning:()=>true,run:async()=>{},cancel:()=>{}},()=>{});cleanup.push(()=>groups.dispose());
  const room=groups.create({name:'项目协作',botIds:[bot.id,other.id]}),run=record(bot.id,'group-run');run.groupOrigin={groupId:room.id,rootId:'root',deliveryId:'d'};store.data.runs.push(run);
  const item=work.create(run,'plan','修改群内项目','user');work.updatePlan(run,plan());run.status='completed';work.finish(run);work.action({id:item.id,action:'start'});groups.startWork(item);
  const message=store.data.groups[0].messages.at(-1)!;assert.equal(message.workItemId,item.id);assert.equal(message.mentions?.[0].id,bot.id);assert.equal(message.sender.kind,'user');assert.equal(store.data.groupDeliveries.filter(d=>d.messageId===message.id).length,2);
});

test('a follow-up edits the pending plan without silently approving execution',async t=>{
  const {store,bot,work}=fixture(t),first=record(bot.id,'first');store.data.runs.push(first);const source=store.message(bot.id,'user','/plan 修改项目',{runId:first.id});work.create(first,'plan','修改项目','user',source.id);work.updatePlan(first,plan());first.status='completed';work.finish(first);
  let turn=0;const model={complete:async(_messages:unknown,tools:ToolDefinition[])=>{assert.ok(!tools.some(t=>t.function.name==='file_write'||t.function.name==='host_execute'));return ++turn===1?response([call('plan_update',{...plan(1),steps:[{...plan().steps[0],title:'先完成读取和检查'}]})]):response([],'已经调整计划。');}} as unknown as ModelClient;
  await new Harness(store,{} as VmController,model,()=>{}).run(bot.id,'第二步改成先检查再修改');
  assert.equal(store.data.workItems?.length,1);assert.equal(store.data.workItems![0].status,'ready');assert.equal(store.data.workItems![0].approvedAt,undefined);assert.equal(store.data.workItems![0].plan?.revision,2);
});

test('a new project input does not redirect or inherit an unfinished goal in another directory',t=>{
  const {store,bot,work}=fixture(t),first=record(bot.id,'first');first.workspaceDir='C:\\ProjectA';store.data.runs.push(first);const item=work.create(first,'goal','修改 A','user');first.status='cancelled';work.finish(first);
  const next=record(bot.id,'next');next.workspaceDir='C:\\ProjectB';store.data.runs.push(next);work.begin(next,{supersedesRunId:first.id},{id:'message',content:'修改 B'});
  assert.equal(next.workItemId,undefined);assert.equal(item.workspaceDir,'C:\\ProjectA');assert.equal(item.status,'paused');
});

test('completed checklist and unrelated evidence cannot hide unfinished background work',t=>{
  const {store,bot,work}=fixture(t),run=record(bot.id,'r');store.data.runs.push(run);const item=work.create(run,'goal','完成构建','user'),ledger=new ExecutionLedger(store),entry=ledger.begin(bot.id,run.id,call('file_read',{path:'a'}),{path:'a'});ledger.finish(entry,'succeeded',{},'result');work.updatePlan(run,plan(0,'done',[entry.id]));
  store.data.processes=[{id:'background',botId:bot.id,runId:run.id,location:'host',purpose:'task',command:'build',cwd:'C:\\project',createdAt:run.startedAt,status:'unknown'}];
  assert.throws(()=>work.invoke(run,'goal_update',{status:'completed',summary:'文件验证完成',evidenceIds:[entry.id]}),/后台任务/);assert.equal(item.status,'running');
});

test('deleting a Bot removes its saved folder and managed goals',t=>{
  const {store,bot,host,dir,work}=fixture(t),run=record(bot.id,'r');store.data.runs.push(run);work.create(run,'goal','处理项目','user');run.status='cancelled';work.finish(run);setConversationWorkspace(store,host,{kind:'bot',id:bot.id},dir);
  store.deleteBot(bot.id);assert.equal(store.data.workItems?.length,0);assert.equal(conversationWorkspace(store,{kind:'bot',id:bot.id}),undefined);
});

test('a group plan runs through broadcast, confirmation, execution and final group reply',async t=>{
  const {store,bot,work,cleanup}=fixture(t),other=store.createBot('旁观成员','没有分工时不需要回复');store.data.model.contextTokens=128000;
  let harness:Harness;
  const groups=new GroupChats(store,{isRunning:id=>id!==bot.id||harness?.isRunning(id)||false,run:(id,input,options)=>harness.run(id,input,options),cancel:id=>harness.cancel(id),refresh:id=>harness.refreshGroup(id)},()=>{});cleanup.push(()=>groups.dispose());
  const model={complete:async()=>{
    const run=store.data.runs.find(r=>r.botId===bot.id&&r.status==='running')!,item=work.forRun(run);
    if(!item)return response([],'[群聊静默]');
    if(!run.plan)return response([call('plan_update',plan())]);
    if(item.status==='planning')return response([],'计划已准备，请确认。');
    const evidence=run.executions?.find(e=>e.tool==='file_read');
    if(!evidence)return response([call('file_read',{path:'proof.txt'})]);
    if(run.plan.steps[0].status!=='done')return response([call('plan_update',plan(run.plan.revision,'done',[evidence.id]))]);
    return response([],'已经核对完成，结果已验证。');
  }} as unknown as ModelClient;
  harness=new Harness(store,{execute:async(_command:string,botId:string)=>({exitCode:0,stdout:JSON.stringify({path:`/work/${botId}/proof.txt`,data:Buffer.from('verified').toString('base64')})})} as unknown as VmController,model,()=>{});harness.setGroupGateway(groups);
  const room=groups.create({name:'项目群',botIds:[bot.id,other.id]}),text='/plan @'+bot.name+' 核对文件';
  groups.send({id:room.id,message:text,mentions:[{id:bot.id,name:bot.name,color:bot.color,start:6,end:7+bot.name.length}]});groups.start();
  const until=async(check:()=>boolean)=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Group workflow did not settle: '+JSON.stringify(store.data.runs.map(r=>({status:r.status,error:r.error}))));};
  await until(()=>store.data.workItems?.[0]?.status==='ready');const item=store.data.workItems![0];work.action({id:item.id,action:'start'});groups.startWork(item);
  await until(()=>item.status==='completed'&&store.data.groups[0].messages.some(m=>m.sender.id===bot.id&&m.content.includes('结果已验证')));
  assert.equal(item.runIds.length,2);assert.ok(store.data.messages.some(m=>m.botId===bot.id&&m.role==='tool'&&m.tool==='file_read'));assert.equal(store.data.workItems?.length,1);
});

test('production SQLite storage restores the selected folder and pauses an unfinished goal after restart',t=>{
  const {dir,host,cleanup}=fixture(t),store=new Store(dir,{incremental:true});cleanup.push(()=>store.close());const bot=store.data.bots[0],run=record(bot.id,'durable-goal');store.data.runs.push(run);
  setConversationWorkspace(store,host,{kind:'bot',id:bot.id},dir);const work=new WorkItems(store),item=work.create(run,'goal','完成项目检查','user');work.updatePlan(run,plan());store.close();
  // An older JSON export must not replace the latest committed database state.
  writeFileSync(join(dir,'state.json'),JSON.stringify({version:1}));
  const restored=new Store(dir,{incremental:true});cleanup.push(()=>restored.close());
  assert.equal(conversationWorkspace(restored,{kind:'bot',id:bot.id}),dir);assert.equal(restored.data.workItems![0].id,item.id);assert.equal(restored.data.workItems![0].status,'paused');assert.equal(restored.data.workItems![0].activeRunId,undefined);assert.equal(restored.data.workItems![0].plan?.steps.length,1);assert.equal(restored.data.runs[0].status,'interrupted');
});
