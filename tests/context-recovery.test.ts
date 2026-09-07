import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {ContextEngine} from '../electron/core/context-engine';
import {ContextCapacityError} from '../electron/core/context-error';
import {contextModelKey} from '../src/context-issue';
import {Harness} from '../electron/core/harness';
import {HostComputer} from '../electron/core/host';
import {Interactions} from '../electron/core/interactions';
import type {VmController} from '../electron/core/vm';
import type {ModelClient,Completion} from '../electron/core/model';
import type {WireMessage} from '../src/shared';
const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'}),call=(name:string,args:unknown):Completion=>({content:'',calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}],finishReason:'tool_calls'});
const summary=JSON.stringify({goal:'完成原任务',constraints:['仅修改所选项目'],done:['文件写入完成，已记录工具结果'],pending:['核对结果并答复用户'],decisions:[],failures:[],next:['查阅已保存的执行记录']});
function fixture(t:test.TestContext){const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-recovery-')),store=new Store(join(root,'data')),storage=new CognitiveStore(store),bot=store.data.bots[0],project=join(root,'project');mkdirSync(project);store.data.model.model='fixture';store.data.model.contextTokens=8000;const run={id:randomUUID(),botId:bot.id,status:'running' as const,startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};store.data.runs.push(run);store.message(bot.id,'user','仅修改所选项目，核对结果后答复。',{runId:run.id});t.after(()=>{storage.close();store.close();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});return {root,store,storage,bot,project,run};}
test('a single recent large archived output fits without losing the tool pair or calling a summarizer',async t=>{
  const f=fixture(t),id=randomUUID(),history:WireMessage[]=[{role:'user',content:'仅修改所选项目'},{role:'assistant',content:null,tool_calls:[{id:'read',type:'function',function:{name:'file_read',arguments:'{"path":"data.txt"}'}}]},{role:'tool',tool_call_id:'read',content:JSON.stringify({resultId:id,result:{stdout:'资料和完整记录。'.repeat(12000)}})}],original=JSON.stringify(history);
  let calls=0;const model={complete:async()=>{calls++;return answer(summary);}} as unknown as ModelClient;
  const result=await new ContextEngine(f.storage,model,()=>{}).prepare({botId:f.bot.id,runId:f.run.id,system:{role:'system',content:'按原任务继续'},history,tools:[],signal:new AbortController().signal});
  assert.ok(result.stats.estimatedTokens<=result.stats.inputBudget);assert.equal(calls,0);assert.equal(JSON.stringify(history),original);const output=JSON.parse(result.messages.find(item=>item.role==='tool')!.content!);assert.equal(output.resultId,id);assert.equal(output.readWith,'read_result');assert.ok(result.messages.some(item=>item.tool_calls?.[0].id==='read'));
});
test('a recent completed exchange with large write arguments can be summarized even with few history items',async t=>{
  const f=fixture(t),history:WireMessage[]=[{role:'user',content:'仅修改所选项目'},{role:'assistant',content:null,tool_calls:[{id:'write',type:'function',function:{name:'file_write',arguments:JSON.stringify({path:'done.txt',content:'代码内容。'.repeat(12000)})}}]},{role:'tool',tool_call_id:'write',content:'{"resultId":"saved","result":{"saved":true}}'}],original=JSON.stringify(history);
  const engine=new ContextEngine(f.storage,{complete:async()=>answer(summary)} as unknown as ModelClient,()=>{}),result=await engine.prepare({botId:f.bot.id,runId:f.run.id,system:{role:'system',content:'保持约束'},history,tools:[],signal:new AbortController().signal});
  assert.ok(result.stats.compactions>0);assert.ok(result.stats.estimatedTokens<=result.stats.inputBudget);assert.equal(JSON.stringify(history),original);assert.ok(result.messages.some(item=>item.content?.includes('仅修改所选项目')));assert.equal(result.messages.some(item=>item.role==='tool'),false);
});
test('an oversized required task yields an actionable capacity error without erasing requirements',async t=>{
  const f=fixture(t),source=f.store.humanRunMessage(f.run.id)!;source.content='不可删除的用户要求。'.repeat(15000);let calls=0;
  const engine=new ContextEngine(f.storage,{complete:async()=>{calls++;return answer(summary);}} as unknown as ModelClient,()=>{});
  await assert.rejects(engine.prepare({botId:f.bot.id,runId:f.run.id,system:{role:'system',content:'遵守要求'},history:[{role:'user',content:source.content}],tools:[],signal:new AbortController().signal}),error=>error instanceof ContextCapacityError&&error.issue.capacity===8000&&error.issue.estimatedTokens!>error.issue.inputBudget!);
  assert.equal(calls,0);assert.equal(f.storage.head(f.bot.id).revision,0);assert.ok(source.content.length>50000);
});
test('resume keeps the original human request and execution evidence and does not write a file twice',async t=>{
  const f=fixture(t);f.store.data.runs=[];f.store.data.messages=[];f.store.data.model.contextTokens=32000;
  const interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:f.store.dir,homeDir:f.root,projectDir:f.project,env:{}},interactions);t.after(()=>{host.dispose();interactions.dispose();});
  let resumed=false,seenEvidence=false;const target=join(f.project,'done.txt');
  const model={complete:async(messages:WireMessage[])=>{if(!messages.some(item=>item.role==='tool'))return call('host_file_write',{path:target,content:'written once',reason:'完成用户文件任务'});if(!resumed)throw new ContextCapacityError({capacity:32000,estimatedTokens:40000,inputBudget:25344,modelKey:contextModelKey(f.store.modelFor(f.bot.id))});if(!messages.some(item=>item.tool_calls?.some(call=>call.function.name==='execution_list')))return call('execution_list',{});seenEvidence=messages.some(item=>item.role==='tool'&&item.content?.includes('host_file_write')&&item.content.includes('succeeded'));return answer('文件已写入并核对。');}} as unknown as ModelClient;
  const harness=new Harness(f.store,{state:{status:'ready'}} as unknown as VmController,model,()=>{},undefined,undefined,undefined,host,interactions);
  const pending=harness.run(f.bot.id,'在当前项目写入 done.txt，然后核对');for(let i=0;i<100&&!interactions.snapshot().length;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(interactions.snapshot().length,1);interactions.approve(interactions.snapshot()[0].id,true);await pending;
  const first=f.store.data.runs[0];assert.equal(first.status,'failed');assert.throws(()=>harness.resume(f.bot.id,first.id),/容量仍不足/);assert.equal(f.store.data.runs.length,1);
  f.store.data.model.contextTokens=64000;resumed=true;await harness.resume(f.bot.id,first.id);const second=f.store.data.runs.at(-1)!;
  assert.equal(second.status,'completed');assert.equal(second.resumedFromRunId,first.id);assert.equal(f.store.data.messages.filter(message=>message.role==='user').length,1);assert.equal(f.store.data.conversations[f.bot.id].filter(message=>message.role==='user').length,1);assert.equal(f.store.humanRunMessage(second.id)?.runId,first.id);assert.equal(f.store.data.runs.flatMap(run=>run.executions||[]).filter(entry=>entry.tool==='host_file_write').length,1);assert.equal(readFileSync(target,'utf8'),'written once');assert.equal(seenEvidence,true);
});
