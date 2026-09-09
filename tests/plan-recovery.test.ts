import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {RunPolicy} from '../electron/core/runtime-policy';
import {ExecutionLedger} from '../electron/core/execution-ledger';
import {WorkItems} from '../electron/core/work-items';
import {Harness} from '../electron/core/harness';
import {toolFailure} from '../electron/core/file-text';
import type {ModelClient} from '../electron/core/model';
import type {RunRecord,ToolCall} from '../src/shared';
import type {VmController} from '../electron/core/vm';

function fixture(t:test.TestContext){const parent=realpathSync.native(tmpdir()),dir=mkdtempSync(join(parent,'aelion-plan-recovery-')),store=new Store(dir);store.data.model.model='fixture';t.after(()=>{store.close();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});return store;}
const plan=(revision=0,status='pending',evidenceIds:string[]=[])=>({revision,goal:'核对项目',steps:[{id:'check',title:'核对项目',acceptance:'读取并检查实际文件',status,evidenceIds}]});
const call=(name:string,args:unknown,id=name):ToolCall=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('stale plan writes return current state and identical retries do not increment revision',t=>{
 const store=fixture(t),botId=store.data.bots[0].id,run:RunRecord={id:'run',botId,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};store.data.runs.push(run);const policy=new RunPolicy(store),first=policy.update(botId,run.id,plan());
 assert.equal(first.revision,1);assert.equal(policy.update(botId,run.id,plan()).revision,1);
 let failure:ReturnType<typeof toolFailure>|undefined;try{policy.update(botId,run.id,{...plan(),goal:'different update'});}catch(error){failure=toolFailure(error);}
 assert.equal(failure?.errorCode,'PLAN_REVISION_CONFLICT');assert.deepEqual(failure?.details?.currentPlan,first);assert.equal(run.plan?.goal,'核对项目');
 assert.equal(policy.update(botId,run.id,{...plan(1),goal:'corrected update'}).revision,2);
});

test('plan and goal control failures cannot deadlock a completed verified task',async t=>{
 const store=fixture(t),botId=store.data.bots[0].id;let turn=0;
 const model={complete:async()=>{
  turn++;const run=store.data.runs[0],evidence=run?.executions?.find(entry=>entry.tool==='file_read')?.id;
  let calls:ToolCall[]=[];
  if(turn===1)calls=[call('goal_set',{objective:'核对项目'}),call('goal_update',{status:'completed',summary:'过早完成',evidenceIds:['missing']})];
  else if(turn===2)calls=[call('plan_update',plan())];
  else if(turn===3)calls=[call('file_read',{path:'README.md'})];
  else if(turn===4)calls=[call('task_update',plan(1,'done',[evidence!])),call('plan_update',{...plan(1,'done',[evidence!]),goal:'过期的另一份提交'}),call('goal_update',{status:'completed',summary:'已经实际读取并核对项目文件',evidenceIds:[evidence]})];
  else assert.equal(turn,5,'must not spend extra turns resolving historical control errors');
  return {content:calls.length?'':'项目已核对。',calls,finishReason:calls.length?'tool_calls':'stop'};
 }} as unknown as ModelClient;
 const vm={execute:async()=>({exitCode:0,stdout:JSON.stringify({path:'/work/'+botId+'/README.md',data:Buffer.from('verified').toString('base64')})})} as unknown as VmController;
 await new Harness(store,vm,model,()=>{}).run(botId,'核对这个项目');const run=store.data.runs[0],ledger=new ExecutionLedger(store);
 assert.equal(turn,5);assert.equal(run.status,'completed');assert.equal(store.data.workItems?.[0].status,'completed');assert.equal(ledger.blocking(botId,run.id).length,0);assert.ok(ledger.pending(botId,run.id).some(entry=>entry.tool==='plan_update'));
 assert.ok(run.executions?.every(entry=>!['execution_resolve','execution_list'].includes(entry.tool)));
});

test('goal completion still blocks unresolved writes and unknown operations',t=>{
 const store=fixture(t),botId=store.data.bots[0].id,run:RunRecord={id:'run',botId,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};store.data.runs.push(run);const work=new WorkItems(store),ledger=new ExecutionLedger(store);work.invoke(run,'goal_set',{objective:'实际完成文件任务'});
 const evidence=ledger.begin(botId,run.id,call('file_read',{path:'README'}),{path:'README'});ledger.finish(evidence,'succeeded',{},'result');work.updatePlan(run,plan(0,'done',[evidence.id]));
 const failed=ledger.begin(botId,run.id,call('file_write',{path:'output'}),{path:'output'});ledger.finish(failed,'failed',{error:'write failed'},'failed');const complete={status:'completed',summary:'已核对实际结果',evidenceIds:[evidence.id]};
 assert.throws(()=>work.invoke(run,'goal_update',complete),/未解决/);
 const retry=ledger.begin(botId,run.id,call('file_write',{path:'output'},'retry'),{path:'output'});ledger.finish(retry,'succeeded',{},'retry-result');
 const unknown=ledger.begin(botId,run.id,call('host_execute',{command:'do work'}),{command:'do work'});ledger.finish(unknown,'unknown',{error:'connection lost'},'unknown');assert.throws(()=>work.invoke(run,'goal_update',complete),/未解决/);
 assert.throws(()=>work.updatePlan(run,plan(1,'done',[retry.id,'not-real'])),/实际成功执行证据/);
});

test('new plan state supersedes legacy failed submissions without clearing unrelated failures',t=>{
 const store=fixture(t),botId=store.data.bots[0].id,run:RunRecord={id:'run',botId,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};store.data.runs.push(run);const ledger=new ExecutionLedger(store);
 const stale=ledger.begin(botId,run.id,call('plan_update',{revision:0}),{revision:0});ledger.finish(stale,'failed',{error:'stale'},'stale');const write=ledger.begin(botId,run.id,call('file_write',{path:'output'}),{path:'output'});ledger.finish(write,'failed',{error:'failed'},'write');
 const updated=ledger.begin(botId,run.id,call('task_update',{revision:1}),{revision:1});ledger.finish(updated,'succeeded',{},'new-plan');assert.equal(stale.resolution?.kind,'unnecessary');assert.equal(write.resolution,undefined);
 assert.equal(ledger.resolve(botId,run.id,{executionId:stale.id}).alreadyResolved,true);
 const control=ledger.begin(botId,run.id,call('goal_update',{}),{});ledger.finish(control,'failed',{error:'not ready'},'control');assert.equal(ledger.resolve(botId,run.id,{executionId:control.id}).required,false);
 assert.deepEqual(ledger.blocking(botId,run.id).map(entry=>entry.id),[write.id]);
});

test('execution queries are bounded and cursors stay stable as diagnostic calls accumulate',t=>{
 const store=fixture(t),botId=store.data.bots[0].id,run:RunRecord={id:'run',botId,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0,executions:[]};store.data.runs.push(run);const ledger=new ExecutionLedger(store);
 for(let i=0;i<170;i++)run.executions!.push({id:'entry-'+i,callId:'call-'+i,botId,runId:run.id,tool:i%3?'host_file_read':'host_file_write',target:'target/'.repeat(60),targetKey:String(i),status:i%3?'succeeded':'failed',startedAt:new Date(1700000000000+i).toISOString(),resultId:'result-'+i,error:i%3?undefined:'failure'.repeat(200)});
 const seen=new Set<string>();let before:string|undefined;
 do{const page=ledger.query(botId,run.id,{before,limit:50});assert.ok('items' in page);assert.ok(JSON.stringify(page).length<6500);for(const item of page.items!){assert.equal(seen.has(item.id as string),false);seen.add(item.id as string);assert.equal(item.executionId,item.id);}before=page.nextBefore as string|undefined;
  const diagnostic=ledger.begin(botId,run.id,call('execution_list',{},'list-'+seen.size),{});ledger.finish(diagnostic,'succeeded',{},'diagnostic-result');
 }while(before);
 assert.equal(seen.size,170);const blocked=ledger.query(botId,run.id,{filter:'blocking'}),evidence=ledger.query(botId,run.id,{filter:'evidence'});assert.ok('items' in blocked&&'items' in evidence);assert.ok(blocked.items.every(item=>item.blocksCompletion));assert.ok(evidence.items.every(item=>item.evidenceEligible));
 assert.throws(()=>ledger.query(botId,run.id,{executionId:'other-bot-entry'}),/没有这个 executionId/);
 const detail=ledger.query(botId,run.id,{executionId:'entry-0'});detail.entry!.target='changed copy';assert.notEqual(run.executions![0].target,'changed copy');
});
