import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {ContextEngine} from '../electron/core/context-engine';
import {ContextView,type ViewInput} from '../electron/core/context-view';
import {ContextMeter} from '../electron/core/context-meter';
import {estimateRequest,contextBudget} from '../electron/core/context-budget';
import {ContextPruning} from '../electron/core/context-pruning';
import {protocolRequest} from '../electron/core/model-protocol';
import type {WireMessage} from '../src/shared';
function fixture(t:test.TestContext){
 const parent=realpathSync(tmpdir()),dir=mkdtempSync(join(parent,'aelion-view-')),store=new Store(dir),storage=new CognitiveStore(store),bot=store.data.bots[0];store.data.model.model='fixture';store.data.model.contextTokens=128000;
 store.data.runs.push({id:'run',botId:bot.id,status:'running',startedAt:'2026-09-10T00:00:00Z',modelCalls:0,toolCalls:0});
 t.after(()=>{storage.close();store.close();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});
 const input:ViewInput={epoch:0,through:0,system:{role:'system',content:'rules'},reference:[{role:'system',content:'memory v1'}],history:[{role:'user',content:'task'}],controls:[{role:'system',content:'status v1'}]};return {store,storage,bot,input};
}
test('sent controls stay before generated output, and reference changes append across reloads',t=>{
 const f=fixture(t),first=new ContextView(f.storage,f.bot.id,'main'),original=JSON.stringify(f.input.history),a=first.compose(f.input,f.input.history);first.persist();
 f.input.history.push({role:'assistant',content:'working',tool_calls:[{id:'c',type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:'c',content:'contents'});f.input.controls=[{role:'system',content:'status v2'}];f.input.reference=[{role:'system',content:'memory v2'}];
 const second=new ContextView(f.storage,f.bot.id,'main'),b=second.compose(f.input,f.input.history);second.persist();
 assert.deepEqual(b.slice(0,a.length),a);assert.equal(b[a.length].role,'assistant');assert.equal(b[a.length+1].role,'tool');assert.ok(b.slice(a.length+2).some(message=>message.content==='memory v2'));assert.equal(JSON.stringify(f.input.history.slice(0,1)),original);
 const c=new ContextView(f.storage,f.bot.id,'main').compose(f.input,f.input.history);assert.deepEqual(c,b,'unchanged controls do not accumulate');
 f.input.reference=[{role:'system',content:'memory v1'}];const d=new ContextView(f.storage,f.bot.id,'main').compose(f.input,f.input.history);assert.deepEqual(d.slice(0,b.length),b);assert.equal(d.at(-1)?.content,'memory v1','reverting a preference appends its current value');
});
test('views reset at compaction, isolate scopes, and Bot removal clears persisted context',t=>{
 const f=fixture(t),view=new ContextView(f.storage,f.bot.id,'main');view.compose(f.input,f.input.history);view.persist();
 const other=new ContextView(f.storage,f.bot.id,'peer:other').compose({...f.input,controls:[],reference:[]},f.input.history);assert.ok(!JSON.stringify(other).includes('status v1'));
 f.input.history.push({role:'assistant',content:'done'},{role:'user',content:'next'});const reset=new ContextView(f.storage,f.bot.id,'main').compose({...f.input,epoch:1,through:2,controls:[{role:'system',content:'current'}],reference:[{role:'assistant',content:'summary'}]},f.input.history.slice(2));assert.ok(!JSON.stringify(reset).includes('status v1'));assert.equal(reset[1].content,'summary');
 f.storage.clearBot(f.bot.id);assert.equal(f.storage.contextState(f.bot.id,'main','view'),undefined);
});
test('new screenshots keep old wire input stable; batch archival persists with original images intact',t=>{
 const f=fixture(t),view=new ContextView(f.storage,f.bot.id,'main'),screen=(id:number):WireMessage=>({role:'user',content:'screen '+id,images:[{id:String(id),width:100,height:100}]});
 f.input.history=[screen(1),{role:'assistant',content:'observed'},screen(2)];f.input.controls=[];const a=view.compose(f.input,f.input.history);
 f.input.history.push({role:'assistant',content:'observed again'},screen(3));const b=view.compose(f.input,f.input.history);assert.equal(view.archiveImages(b),0);
 const wire=(messages:WireMessage[])=>(protocolRequest(f.store.modelFor(f.bot.id),messages,[],4096,'',id=>'data:image/png;base64,'+id).body as any).messages;
 assert.deepEqual(wire(b).slice(0,a.length),wire(a));
 f.input.history.push(...Array.from({length:30},(_,n)=>screen(n+4)));let c=view.compose(f.input,f.input.history);assert.equal(view.archiveImages(c),25);c=view.compose(f.input,f.input.history);view.persist();assert.equal(c.flatMap(message=>message.images||[]).length,8);assert.equal(f.input.history.flatMap(message=>message.images||[]).length,33);
 f.input.history.push(screen(34));const d=new ContextView(f.storage,f.bot.id,'main').compose(f.input,f.input.history);assert.deepEqual(d.slice(0,c.length),c);assert.equal(d.flatMap(message=>message.images||[]).length,9);assert.match(d.find(message=>message.content?.includes('screen 1'))!.content!,/已归档/);
});
test('real usage anchors estimate only new content and invalidate on rewrite, model, or tool change',t=>{
 const f=fixture(t),config=f.store.modelFor(f.bot.id),messages:WireMessage[]=[{role:'system',content:'rules'},{role:'user',content:'input '.repeat(10000)}],meter=new ContextMeter(f.storage,f.bot.id,'main',config,[]);
 meter.record(messages,[],{content:'ok',calls:[],finishReason:'stop',usage:{inputTokens:7000,outputTokens:10}});
 const next=[...messages,{role:'assistant' as const,content:'done'},{role:'user' as const,content:'continue'}],result=new ContextMeter(f.storage,f.bot.id,'main',config,[]).estimate(next,[],2);
 assert.equal(result.estimateSource,'usage-anchor');assert.equal(result.tokens,7000+2*(estimateRequest(next,[]).tokens-estimateRequest(messages,[]).tokens));
 assert.equal(meter.estimate([{role:'system',content:'changed'},...messages.slice(1)],[],2).estimateSource,'tokenizer');
 assert.equal(new ContextMeter(f.storage,f.bot.id,'main',{...config,model:'other'},[]).estimate(next,[],2).estimateSource,'tokenizer');
 assert.equal(new ContextMeter(f.storage,f.bot.id,'other',config,[]).estimate(next,[],2).estimateSource,'tokenizer');
 assert.equal(new ContextMeter(f.storage,f.bot.id,'main',config,[{type:'function',function:{name:'new',description:'new',parameters:{}}}]).estimate(next,[],2).estimateSource,'tokenizer');
 f.storage.close();meter.record(messages,[],{content:'ok',calls:[],finishReason:'stop',usage:{inputTokens:7100,outputTokens:10}});assert.equal(meter.estimate(messages,[],1).tokens,7100,'completed requests can save usage after an owned context reader closes');
});
test('context engine uses actual usage without corrupting tokenizer calibration and does not persist aborted views',async t=>{
 const f=fixture(t),engine=new ContextEngine(f.storage,{complete:async()=>{throw Error('unexpected summary');}} as any,()=>{}),input={botId:f.bot.id,runId:'run',system:f.input.system,prefixContext:f.input.reference,history:f.input.history,tools:[],signal:new AbortController().signal};
 const a=await engine.prepare(input);a.recordUsage({content:'ok',calls:[],finishReason:'stop',usage:{inputTokens:500,outputTokens:10}});
 input.history.push({role:'assistant',content:'reply'});const b=await engine.prepare(input);assert.equal(b.stats.estimateSource,'usage-anchor');assert.equal(b.calibrationEstimate,estimateRequest(b.messages,[],b.stats.calibration).tokens);
 const before=f.storage.contextState(f.bot.id,f.bot.id,'view');await assert.rejects(engine.prepare({...input,dynamicContext:[{role:'system',content:'not sent'}],signal:AbortSignal.abort()}));assert.equal(f.storage.contextState(f.bot.id,f.bot.id,'view'),before);
 assert.ok(contextBudget(128000).trigger/128000>.87);
});
test('small pruning does not repeatedly invalidate history and remains available for emergency recovery',t=>{
 const f=fixture(t),history:WireMessage[]=[{role:'tool',tool_call_id:'read',content:JSON.stringify({resultId:'r',result:{stdout:'word '.repeat(1500)}})}],pruning=new ContextPruning(f.storage,f.bot.id,'main');
 assert.equal(pruning.prune(history,history,1,true,10000).pruned,0);assert.equal(pruning.prune(history,history,1,true).pruned,1);
});
test('re-reading an archived attachment displays the new occurrence without restoring old images',t=>{
 const f=fixture(t),view=new ContextView(f.storage,f.bot.id,'main'),image={id:'same-image',attachmentId:'attachment',width:100,height:100};f.input.controls=[];
 f.input.history=Array.from({length:33},(_,index)=>({role:'user' as const,content:'image '+index,images:[{...image,id:'image-'+index}]}));
 let a=view.compose(f.input,f.input.history);assert.equal(view.archiveImages(a),23);a=view.compose(f.input,f.input.history);view.persist();
 f.input.history.push({role:'user',content:'read again',images:[{...image,id:'image-0'}]});const b=new ContextView(f.storage,f.bot.id,'main').compose(f.input,f.input.history);assert.deepEqual(b.slice(0,a.length),a);assert.equal(b.at(-1)?.images?.[0].id,'image-0');assert.equal(b.flatMap(message=>message.images||[]).length,11);
});
