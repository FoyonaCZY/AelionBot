import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {ContextEngine} from '../electron/core/context-engine';
import {ContextPruning} from '../electron/core/context-pruning';
import {readCalibration,observeCalibration} from '../electron/core/token-calibration';
import type {ModelClient} from '../electron/core/model';
import type {WireMessage} from '../src/shared';

function fixture(t:test.TestContext){
 const parent=realpathSync.native(tmpdir()),dir=mkdtempSync(join(parent,'aelion-context-cache-')),store=new Store(dir),storages:CognitiveStore[]=[];store.data.model.model='fixture';store.data.model.contextTokens=16000;
 const open=()=>{const storage=new CognitiveStore(store);storages.push(storage);return storage;},storage=open(),bot=store.data.bots[0];store.data.runs.push({id:'run',botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0});
 t.after(()=>{for(const storage of storages)storage.close();store.close();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});return {store,storage,bot,open};
}
const tool=(id:string,content:string):WireMessage=>({role:'tool',tool_call_id:id,content:JSON.stringify({resultId:id,result:{stdout:content,exitCode:0}})});

test('uncalibrated background observations do not compound an existing multiplier',()=>{
 let state=readCalibration();for(let i=0;i<30;i++)state=observeCalibration(state,15000,10000,1);assert.equal(state.factor,1.62);
 for(let i=0;i<30;i++)state=observeCalibration(state,15000,10000*state.factor,state.factor);assert.ok(Math.abs(state.factor-1.62)<.000001);
});

test('calibration recovers from overestimation while raising immediately for underestimation',()=>{
 let state={...readCalibration(),factor:4};for(let i=0;i<40;i++)state=observeCalibration(state,227075,209224*state.factor,state.factor);
 assert.ok(state.factor>=1&&state.factor<1.3);assert.ok(209224*state.factor<280000);
 const raised=observeCalibration(readCalibration(),20000,10000,1);assert.equal(raised.factor,2.16);
 for(const value of [0,-1,NaN,Infinity])assert.deepEqual(observeCalibration(state,value,10000,1),state);
 assert.equal(readCalibration('4').factor,1,'legacy compounded values are not reused by v2');
});

test('context engine observes the multiplier actually applied to each request',async t=>{
 const f=fixture(t),engine=new ContextEngine(f.storage,{complete:async()=>{throw Error('unexpected compaction');}} as unknown as ModelClient,()=>{});
 for(let i=0;i<12;i++)engine.observe(f.bot.id,'run','background_review',{content:'ok',calls:[],finishReason:'stop',usage:{inputTokens:15000,outputTokens:1}},10000,1);
 const result=await engine.prepare({botId:f.bot.id,runId:'run',system:{role:'system',content:'rules'},history:[{role:'user',content:'hi'}],tools:[],signal:new AbortController().signal});assert.equal(result.stats.calibration,1.62);
 engine.observe(f.bot.id,'run','foreground',{content:'ok',calls:[],finishReason:'stop',usage:{inputTokens:15000,outputTokens:1}},16200,result.stats.calibration);
 const next=await engine.prepare({botId:f.bot.id,runId:'run',system:{role:'system',content:'rules'},history:[{role:'user',content:'hi'}],tools:[],signal:new AbortController().signal});assert.equal(next.stats.calibration,1.62);
});

test('pruned output remains stable below the trigger and after reopening the context engine',async t=>{
 const f=fixture(t);let summaries=0;const model={complete:async()=>{summaries++;throw Error('no summary expected');}} as unknown as ModelClient;
 const original:WireMessage[]=[{role:'user',content:'检查文件'},{role:'assistant',content:null,tool_calls:[{id:'read',type:'function',function:{name:'file_read',arguments:'{}'}}]},tool('read','historical output '.repeat(18000)),{role:'assistant',content:'读取完毕'},{role:'user',content:'继续'}];const snapshot=JSON.stringify(original);
 const input={botId:f.bot.id,runId:'run',system:{role:'system' as const,content:'rules'},history:original,tools:[],signal:new AbortController().signal};
 const first=await new ContextEngine(f.storage,model,()=>{}).prepare(input),firstTool=first.messages.find(message=>message.role==='tool')!;assert.ok(first.stats.prunedOutputs>0);assert.ok(firstTool.content!.length<original[2].content!.length);assert.equal(first.head.revision,0);
 f.store.data.model.contextTokens=1000000;
 const reopened=new ContextEngine(f.open(),model,()=>{}),second=await reopened.prepare(input);assert.equal(second.messages.find(message=>message.role==='tool')!.content,firstTool.content);assert.equal(second.stats.compactions,0);
 original.push({role:'assistant',content:'追加回复'},{role:'user',content:'再继续'});const third=await reopened.prepare(input);assert.equal(third.messages.find(message=>message.role==='tool')!.content,firstTool.content);assert.equal(JSON.stringify(original.slice(0,5)),snapshot);assert.equal(summaries,0);
});

test('pruning snapshots are scoped, reject changed sources and are removed when a Bot is cleared',t=>{
 const f=fixture(t),history=[tool('call','reusable output '.repeat(2000))],pruning=new ContextPruning(f.storage,f.bot.id,'main'),reduced=pruning.prune(history,history,1,true);pruning.persist(history,reduced.messages);
 assert.notEqual(new ContextPruning(f.storage,f.bot.id,'main').apply(history)[0].content,history[0].content);
 assert.equal(new ContextPruning(f.storage,f.bot.id,'group:other').apply(history)[0].content,history[0].content);
 const other=f.store.createBot('other','other');assert.equal(new ContextPruning(f.storage,other.id,'main').apply(history)[0].content,history[0].content);
 const changed=[tool('call','different output')];assert.equal(new ContextPruning(f.storage,f.bot.id,'main').apply(changed)[0].content,changed[0].content);
 f.storage.clearBot(f.bot.id);assert.equal(f.storage.readContextPruning(f.bot.id,'main').size,0);
});
