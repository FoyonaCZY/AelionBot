import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {RunPolicy,runtimeSettings} from '../electron/core/runtime-policy';
import {Harness} from '../electron/core/harness';
import type {ModelClient} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';
import {DEFAULT_RUNTIME} from '../src/runtime-types';

function fixture(t:test.TestContext,incremental=false){
 const parent=realpathSync.native(tmpdir()),dir=mkdtempSync(join(parent,'aelion-runtime-policy-')),stores:Store[]=[];
 const open=()=>{const store=new Store(dir,{incremental});stores.push(store);return store;};
 t.after(()=>{for(const store of stores)store.close();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});
 return {open,store:open()};
}

test('a task completes after exceeding the old token cap when no limit is configured',async t=>{
 const {store}=fixture(t);let steps=0;
 const model={complete:async(_messages:unknown,_tools:unknown,_signal:unknown,_onText:unknown,options:{runId:string})=>{
  (store.data.modelUsage||=[]).push({id:String(steps),botId:store.data.bots[0].id,runId:options.runId,purpose:'foreground',model:'fixture',time:new Date().toISOString(),usage:{inputTokens:600000,outputTokens:100,cachedTokens:0}});
  return steps++<2?{content:'',finishReason:'tool_calls',calls:[{id:String(steps),type:'function',function:{name:'computer_execute',arguments:'{"command":"verify"}'}}]}:{content:'已检查全部结果',finishReason:'stop',calls:[]};
 }} as unknown as ModelClient;
 await new Harness(store,{execute:async()=>({exitCode:0,stdout:'verified'})} as unknown as VmController,model,()=>{}).run(store.data.bots[0].id,'完成检查');
 assert.equal(new RunPolicy(store).settings().maxTokens,0);
 assert.equal(steps,3);assert.equal(store.data.runs[0].status,'completed');assert.equal(store.data.runs[0].toolCalls,2);
 assert.equal(store.data.modelUsage?.length,3);
});

test('an explicit cap counts reported or estimated usage for its own run and can be disabled',t=>{
 const {store}=fixture(t),botId=store.data.bots[0].id,run={id:'r',botId,status:'running' as const,startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};
 store.data.runs.push(run);store.data.runtime=runtimeSettings({...DEFAULT_RUNTIME,maxTokens:10000});
 const record={botId,purpose:'foreground',model:'fixture',time:run.startedAt};
 store.data.modelUsage=[{...record,id:'other',runId:'other',estimatedTokens:1000000},{...record,id:'reported',runId:run.id,estimatedTokens:900000,usage:{inputTokens:8000,outputTokens:1000,cachedTokens:7000}}];
 const policy=new RunPolicy(store);assert.doesNotThrow(()=>policy.check(botId,run.id,0));
 store.data.modelUsage.push({...record,id:'estimated',runId:run.id,estimatedTokens:1000});
 assert.throws(()=>policy.check(botId,run.id,1),/模型用量预算/);
 store.data.runtime=runtimeSettings({...store.data.runtime,maxTokens:0});
 assert.doesNotThrow(()=>policy.check(botId,run.id,1));
 store.data.runtime.maxTurns=1;assert.throws(()=>policy.check(botId,run.id,1),/轮执行预算/);
 store.data.runtime.maxTurns=0;store.data.runtime.maxMinutes=60;run.startedAt=new Date(Date.now()-61*60000).toISOString();assert.throws(()=>policy.check(botId,run.id,1),/执行时间预算/);
 store.data.runtime.maxMinutes=0;assert.doesNotThrow(()=>policy.check(botId,run.id,10001));
});

test('default task limits are unlimited and do not schedule an immediate abort',async t=>{
 const {store}=fixture(t);assert.equal(runtimeSettings({}).maxTurns,0);assert.equal(runtimeSettings({}).maxMinutes,0);
 const model={complete:async(_messages:unknown,_tools:unknown,signal:AbortSignal)=>{
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(signal.aborted,false);
  return {content:'已完成',finishReason:'stop',calls:[]};
 }} as unknown as ModelClient;
 await new Harness(store,{} as VmController,model,()=>{}).run(store.data.bots[0].id,'回答问题');
 assert.equal(store.data.runs[0].status,'completed');
 for(const maxMinutes of [0,1,60,1440])assert.equal(runtimeSettings({maxMinutes}).maxMinutes,maxMinutes);
 for(const maxMinutes of [-1,0.5,1441,'0',null])assert.throws(()=>runtimeSettings({maxMinutes}),/maxMinutes/);
});

test('runtime settings accept unlimited and positive token caps, and reject invalid values',()=>{
 assert.equal(runtimeSettings({}).maxTokens,0);
 for(const maxTokens of [0,1,500000,10000000])assert.equal(runtimeSettings({maxTokens}).maxTokens,maxTokens);
 for(const maxTokens of [-1,1.5,NaN,Infinity,10000001,'0',null])assert.throws(()=>runtimeSettings({maxTokens}),/maxTokens/);
});

for(const incremental of [false,true])test(`legacy token budgets migrate once and user caps persist (${incremental?'SQLite':'JSON'})`,t=>{
 const f=fixture(t,incremental),legacy={...DEFAULT_RUNTIME,maxTokens:500000,parallelReads:2};
 f.store.data.runtime=legacy;delete f.store.data.unlimitedTokenBudgetMigrated;f.store.save();f.store.close();
 const migrated=f.open();assert.deepEqual(new RunPolicy(migrated).settings(),{...legacy,maxTokens:0});
 migrated.data.runtime=runtimeSettings({...migrated.data.runtime,maxTokens:500000});migrated.save();migrated.close();
 const reopened=f.open();assert.equal(new RunPolicy(reopened).settings().maxTokens,500000);
 reopened.data.runtime=runtimeSettings({...reopened.data.runtime,maxTokens:750000});delete reopened.data.unlimitedTokenBudgetMigrated;reopened.save();reopened.close();
 const custom=f.open();assert.equal(new RunPolicy(custom).settings().maxTokens,750000);
 custom.data.runtime=runtimeSettings({...custom.data.runtime,maxTokens:0});custom.save();custom.close();
 assert.equal(new RunPolicy(f.open()).settings().maxTokens,0);
});
