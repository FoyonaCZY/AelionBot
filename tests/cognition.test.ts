import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {Store} from '../electron/core/store';
import {CognitiveStore} from '../electron/core/cognitive-store';
import {MemoryService} from '../electron/core/memory-service';
import {ContextEngine} from '../electron/core/context-engine';
import {LearningWorker,shouldReview} from '../electron/core/learning-worker';
import {SkillLibrary} from '../electron/core/skill-library';
import {contextBudget,estimateRequest,exchanges,tailBoundary,textTokens} from '../electron/core/context-budget';
import {ModelClient,type Completion} from '../electron/core/model';
import {TOOLS} from '../electron/core/harness';
import type {WireMessage} from '../src/shared';

const summary=JSON.stringify({goal:'继续处理当前任务',constraints:['以最后一条用户要求为准'],done:['较早的资料已经读取'],pending:['完成当前工作'],decisions:[],failures:[],next:['核对最新请求']});
const done=(content='完成'):Completion=>({content,calls:[],finishReason:'stop'});
const call=(name:string,args:unknown):Completion=>({content:'',calls:[{id:`call-${name}-${Math.random()}`,type:'function',function:{name,arguments:JSON.stringify(args)}}],finishReason:'tool_calls'});
function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'aelion-cognition-')),store=new Store(dir),storage=new CognitiveStore(store),bot=store.data.bots[0];
  const skills=new SkillLibrary(store,{homeDir:join(dir,'home'),projectDir:dir,dataDir:dir,configDir:join(dir,'config'),env:{}});
  let worker:LearningWorker|undefined;
  t.after(async()=>{await worker?.close();storage.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('aelion-cognition-'));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,storage,bot,skills,memory:new MemoryService(storage),setWorker:(value:LearningWorker)=>worker=value};
}

test('context budget accounts for text, tool definitions and actual image observations',()=>{
  const messages:WireMessage[]=[{role:'user',content:'请核对中文报表与 API identifiers。'}];const plain=estimateRequest(messages,[]),withTools=estimateRequest(messages,TOOLS),withImage=estimateRequest([{...messages[0],images:[{id:'screen',width:1280,height:720}]}],TOOLS);
  assert.ok(textTokens('中文报表')>0);assert.ok(withTools.tokens>plain.tokens);assert.ok(withImage.tokens>withTools.tokens);assert.ok(withImage.imageTokens>=1024);const budget=contextBudget(32000);assert.equal(budget.input+budget.output+budget.safety,32000);
});
test('tail retention never splits a tool call/result pair or compresses an incomplete exchange',()=>{
  const messages:WireMessage[]=[{role:'user',content:'开始'}];for(let i=0;i<10;i++)messages.push({role:'assistant',content:null,tool_calls:[{id:`id-${i}`,type:'function',function:{name:'file_read',arguments:'{}'}}]},{role:'tool',tool_call_id:`id-${i}`,content:'result '.repeat(120)});
  const cut=tailBoundary(messages,0,300);assert.equal(messages[cut].role,'assistant');assert.ok(exchanges(messages).every(group=>group.complete));
  messages[1].tool_calls![0].id='missing';assert.equal(tailBoundary(messages,0,300),0);
});
test('structured compaction keeps the latest request and original transcript, with durable source coverage',async t=>{
  const f=fixture(t);f.store.data.model.contextTokens=8000;
  const history:WireMessage[]=Array.from({length:35},(_,i)=>({role:'user',content:`历史讨论 ${i}，记录路径 reports/item-${i}.json。`+'过去的实现细节与讨论。'.repeat(100)}));history.push({role:'user',content:'最终要求：只做本地，不需要服务器。'});
  const runId='context-test';f.store.data.runs.push({id:runId,botId:f.bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0});f.store.message(f.bot.id,'user','最终要求：只做本地，不需要服务器。',{runId});const original=JSON.stringify(history);
  let calls=0;const model={complete:async()=>{calls++;return done(summary);}} as unknown as ModelClient;
  const context=new ContextEngine(f.storage,model,()=>{}),result=await context.prepare({botId:f.bot.id,runId,system:{role:'system',content:'遵循用户最新要求。'},history,tools:[],signal:new AbortController().signal});
  assert.ok(calls>0);assert.ok(f.storage.head(f.bot.id).through>0);assert.ok(result.stats.estimatedTokens<=result.stats.inputBudget);assert.ok(result.messages.some(message=>message.role==='system'&&message.content?.includes('只做本地')));assert.equal(JSON.stringify(history),original);
  assert.equal((f.storage.db.prepare('SELECT count(*) AS n FROM context_epochs').get() as any).n,calls);
});
test('bad or cancelled summaries cannot replace a usable context and retries enter cooldown',async t=>{
  const f=fixture(t);f.store.data.model.contextTokens=8000;const history:WireMessage[]=Array.from({length:12},(_,i)=>({role:'user',content:`旧记录 ${i} `+'数据。'.repeat(120)}));
  let calls=0;const model={complete:async()=>{calls++;return done('not JSON');}} as unknown as ModelClient,engine=new ContextEngine(f.storage,model,()=>{});
  const input={botId:f.bot.id,runId:'failure',system:{role:'system' as const,content:'系统'},history,tools:[],signal:new AbortController().signal,force:true};
  await engine.prepare(input);await engine.prepare(input);assert.equal(calls,2);assert.equal(f.storage.head(f.bot.id).revision,0);
  const controller=new AbortController(),cancelModel={complete:async()=>{controller.abort();return done(summary);}} as unknown as ModelClient;
  await assert.rejects(()=>new ContextEngine(f.storage,cancelModel,()=>{}).prepare({...input,signal:controller.signal}),/取消/);assert.equal(f.storage.head(f.bot.id).revision,0);
});
test('history search supports Chinese and enforces Bot scope while preserving source identifiers',t=>{
  const f=fixture(t),other=f.store.createBot('另一个','隔离');const message=f.store.message(f.bot.id,'user','报表颜色约定是深蓝色。');f.store.message(other.id,'user','另一个 Bot 的私有颜色约定。');
  assert.equal(f.storage.search(f.bot.id,'颜色')[0].messageId,message.id);assert.equal(f.storage.search(f.bot.id,'深蓝色')[0].messageId,message.id);assert.throws(()=>f.storage.readHistory(other.id,message.id),/无权访问/);assert.equal(f.storage.readHistory(f.bot.id,message.id,0,0)[0].content,'报表颜色约定是深蓝色。');
});
test('memory replacement is bounded, sourced and cannot be overwritten by a stale background review',t=>{
  const f=fixture(t),source=f.store.message(f.bot.id,'user','以后使用深蓝色报表。',{runId:'memory'}),refs=new Set([source.id]);
  f.memory.apply(f.bot.id,'memory',{action:'add',target:'user',content:'报表使用深蓝色。',sourceRefs:[source.id]},{background:true,allowedRefs:refs,expectedRevision:0});
  assert.throws(()=>f.memory.apply(f.bot.id,'memory',{action:'add',content:'过时结论',sourceRefs:[source.id]},{background:true,allowedRefs:refs,expectedRevision:0}),/已被更新/);
  f.memory.apply(f.bot.id,'memory',{action:'remove',content:'报表使用深蓝色。'});
  assert.throws(()=>f.memory.apply(f.bot.id,'memory',{action:'add',target:'user',content:'报表使用深蓝色。',sourceRefs:[source.id]},{background:true,allowedRefs:refs}),/删除/);
  const tool=f.store.message(f.bot.id,'tool','工具声称用户喜欢红色',{status:'done'});
  assert.throws(()=>f.memory.apply(f.bot.id,'memory',{action:'add',target:'user',content:'喜欢红色',sourceRefs:[tool.id]},{background:true,allowedRefs:new Set([tool.id])}),/用户消息/);
  assert.equal(f.bot.memories.length,0);assert.ok(readFileSync(join(f.dir,'bots',f.bot.id,'memories','USER.md'),'utf8').trim()==='');
});
test('background review learns from evidence, preserves skill versions, and denies foreground execution tools',async t=>{
  const f=fixture(t),user=f.store.message(f.bot.id,'user','以后交付请包含测试数量。',{runId:'learn'}),evidence=f.store.message(f.bot.id,'tool',JSON.stringify({result:{stdout:'3 tests passed',exitCode:0}}),{runId:'learn',tool:'python_execute',status:'done'});
  const body='## 适用条件\n需要读取 CSV 并汇总数据时使用。\n## 输入\n输入和输出路径由当前任务提供。\n## 步骤\n读取表头，核对金额列，按团队汇总，再写入输出文件。\n## 验证\n重新读取输出，与独立计算结果核对；测试正常数据、缺失列和无效数字，并报告测试数量。\n## 限制\n仅处理明确指定的本地文本数据。';
  let step=0,denied=false;const model={complete:async(messages:WireMessage[])=>{step++;if(step===1)return call('skills_list',{});if(step===2)return call('skill_save',{name:'CSV 汇总检查',description:'汇总 CSV 并独立验证结果',body,sourceRefs:[evidence.id]});if(step===3)return call('memory',{action:'add',target:'user',content:'交付包含测试数量。',sourceRefs:[user.id]});if(step===4)return call('host_execute',{command:'should never execute',reason:'forbidden'});denied=messages.some(message=>message.role==='tool'&&message.content?.includes('后台复盘禁止'));return done();}} as unknown as ModelClient;
  const engine=new ContextEngine(f.storage,model,()=>{}),worker=new LearningWorker(f.storage,f.memory,f.skills,model,engine,()=>{},()=>false,()=>[],100000);f.setWorker(worker);
  const id=f.storage.enqueue(f.bot.id,'learn',{messages:[{role:'user',content:user.content}],tools:TOOLS,sourceRefs:[user.id,evidence.id],revision:0,model:f.store.data.model.model});await worker.drain();
  assert.equal(f.storage.jobs(f.bot.id).find(job=>job.id===id)?.status,'completed');assert.equal(denied,true);assert.ok(f.memory.snapshot(f.bot.id).user.some(fact=>fact.content==='交付包含测试数量。'));
  const skill=f.skills.list(f.bot.id).find(skill=>skill.name==='CSV 汇总检查')!;assert.ok(skill);assert.equal(f.skills.autoManaged(f.bot.id,skill.id),true);assert.equal(f.skills.revisions(f.bot.id,skill.id).length,1);assert.match(f.skills.read(f.bot.id,skill.id).body,/独立计算/);
});
test('user-owned skills stay protected from automatic maintenance and explicit learning opt-outs are honored',async t=>{
  const f=fixture(t),saved=f.skills.save(f.bot.id,'用户流程','用户创建的流程','用户保留的正文。'),before=f.skills.fingerprint(f.bot.id,saved.id),source=f.store.message(f.bot.id,'tool','success',{tool:'python_execute',status:'done'});
  let step=0,protectedWrite=false;const model={complete:async(messages:WireMessage[])=>{step++;if(step===1)return call('skills_list',{});if(step===2)return call('skill_read',{id:saved.id});if(step===3)return call('skill_save',{name:'用户流程',description:'覆盖',body:'新的自动内容。'.repeat(25),sourceRefs:[source.id]});protectedWrite=messages.some(message=>message.content?.includes('用户维护的技能'));return done();}} as unknown as ModelClient;
  const worker=new LearningWorker(f.storage,f.memory,f.skills,model,new ContextEngine(f.storage,model,()=>{}),()=>{},()=>false,()=>[],100000);f.setWorker(worker);
  f.storage.enqueue(f.bot.id,'protected',{messages:[],tools:TOOLS,sourceRefs:[source.id],revision:0,model:f.store.data.model.model});await worker.drain();assert.equal(protectedWrite,true);assert.equal(f.skills.fingerprint(f.bot.id,saved.id),before);
  assert.equal(shouldReview('只做这次验证，不新增记忆或技能。',20),false);assert.equal(shouldReview('以后请报告测试数量。',0),true);assert.equal(shouldReview('你好',0),false);
});

test('foreground work preempts a background model request and keeps the job queued without writes',async t=>{
  const f=fixture(t);let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);
  const model={complete:async(_messages:WireMessage[],_tools:unknown,signal:AbortSignal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}} as unknown as ModelClient;
  const worker=new LearningWorker(f.storage,f.memory,f.skills,model,new ContextEngine(f.storage,model,()=>{}),()=>{},()=>false,()=>[],100000);f.setWorker(worker);
  const id=f.storage.enqueue(f.bot.id,'preempt',{messages:[],tools:TOOLS,sourceRefs:[],revision:0,model:f.store.data.model.model});const pending=worker.drain();await ready;worker.preempt();await pending;
  const job=f.storage.jobs(f.bot.id).find(job=>job.id===id)!;assert.equal(job.status,'queued');assert.equal(job.attempts,0);assert.equal(f.storage.revision(f.bot.id),0);
});

test('a knowledge change during inference rejects stale skill writes',async t=>{
  const f=fixture(t),evidence=f.store.message(f.bot.id,'tool','verified',{status:'done',tool:'python_execute'});let step=0;
  const model={complete:async()=>{if(++step===1)return call('skills_list',{});f.memory.apply(f.bot.id,'newer',{action:'add',content:'较新的用户纠正'});return call('skill_save',{name:'过时技能',description:'不能保存',body:'这是基于过时上下文的内容。'.repeat(20),sourceRefs:[evidence.id]});}} as unknown as ModelClient;
  const worker=new LearningWorker(f.storage,f.memory,f.skills,model,new ContextEngine(f.storage,model,()=>{}),()=>{},()=>false,()=>[],100000);f.setWorker(worker);
  f.storage.enqueue(f.bot.id,'stale',{messages:[],tools:TOOLS,sourceRefs:[evidence.id],revision:0,model:f.store.data.model.model});await worker.drain();assert.ok(!f.skills.list(f.bot.id).some(skill=>skill.name==='过时技能'));assert.equal(f.storage.jobs(f.bot.id)[0].status,'failed');
});

test('a changed source prefix invalidates compaction instead of committing or sending a stale view',async t=>{
  const f=fixture(t);f.store.data.model.contextTokens=8000;const history:WireMessage[]=Array.from({length:16},(_,i)=>({role:'user',content:`记录 ${i} `+'资料。'.repeat(140)}));
  const model={complete:async()=>{history[0].content='用户已更新这个来源';return done(summary);}} as unknown as ModelClient;
  await assert.rejects(()=>new ContextEngine(f.storage,model,()=>{}).prepare({botId:f.bot.id,runId:'change',system:{role:'system',content:'规则'},history,tools:[],signal:new AbortController().signal,force:true}),/原始历史发生变化/);assert.equal(f.storage.head(f.bot.id).revision,0);
});

test('review limits allow correcting its own writes instead of trapping a bad memory at the cap',async t=>{
  const f=fixture(t),source=f.store.message(f.bot.id,'user','长期偏好：清晰、简短、包含验证。');let step=0;
  const model={complete:async()=>{step++;if(step<=3)return call('memory',{action:'add',target:'user',content:`长期偏好 ${step}`,sourceRefs:[source.id]});if(step===4)return call('memory',{action:'remove',content:'长期偏好 3',sourceRefs:[source.id]});return done();}} as unknown as ModelClient;
  const worker=new LearningWorker(f.storage,f.memory,f.skills,model,new ContextEngine(f.storage,model,()=>{}),()=>{},()=>false,()=>[],100000);f.setWorker(worker);
  f.storage.enqueue(f.bot.id,'correction',{messages:[],tools:TOOLS,sourceRefs:[source.id],revision:0,model:f.store.data.model.model});await worker.drain();assert.equal(f.storage.jobs(f.bot.id)[0].status,'completed');assert.equal(f.storage.memories(f.bot.id).length,2);assert.ok(!f.storage.memories(f.bot.id).some(fact=>fact.content==='长期偏好 3'));
});

test('skill lookup handles multiple query terms and transient test results do not become memory',t=>{
  const f=fixture(t);f.skills.save(f.bot.id,'货币 CSV 汇总','金额与整数分处理','可复用流程');assert.ok(f.skills.search(f.bot.id,'货币 CSV 整数分').some(skill=>skill.name==='货币 CSV 汇总'));
  const source=f.store.message(f.bot.id,'tool','4 tests passed',{tool:'python_execute',status:'done'});assert.throws(()=>f.memory.apply(f.bot.id,'transient',{action:'add',content:'本次受控样例运行 4 项测试通过。',sourceRefs:[source.id]},{background:true,allowedRefs:new Set([source.id])}),/一次性执行记录/);
});

test('background review cannot bypass external-file permission by directly reading a new skill',async t=>{
  const f=fixture(t),path=join(f.dir,'home','.agents','skills','external','SKILL.md');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'---\nname: external\ndescription: External source\n---\nPRIVATE EXTERNAL BODY');f.skills.refresh();const external=f.skills.list(f.bot.id).find(skill=>skill.name==='external')!;
  let step=0,denied=false;const model={complete:async(messages:WireMessage[])=>{if(++step===1)return call('skill_read',{id:external.id});denied=messages.some(message=>message.content?.includes('后台不读取新的本机外部文件'));assert.ok(!JSON.stringify(messages).includes('PRIVATE EXTERNAL BODY'));return done();}} as unknown as ModelClient;
  const worker=new LearningWorker(f.storage,f.memory,f.skills,model,new ContextEngine(f.storage,model,()=>{}),()=>{},()=>false,()=>[],100000);f.setWorker(worker);f.storage.enqueue(f.bot.id,'external',{messages:[],tools:TOOLS,sourceRefs:[],revision:0,model:f.store.data.model.model});await worker.drain();assert.equal(denied,true);
});

test('valid tool-result references resolve to their source messages without accepting another Bot',t=>{
  const f=fixture(t),resultId='a2fa026d-4c16-4120-8ee2-3bb9d453025c',message=f.store.message(f.bot.id,'tool',JSON.stringify({resultId,result:{exitCode:0}}),{status:'done',tool:'python_execute'}),other=f.store.createBot('另一位','隔离');assert.equal(f.storage.sourceMessage(f.bot.id,resultId)?.id,message.id);assert.equal(f.storage.sourceMessage(other.id,resultId),undefined);
  f.memory.apply(f.bot.id,'references',{action:'add',content:'CLI 返回成功状态。',sourceRefs:[resultId]},{background:true,allowedRefs:new Set([message.id])});assert.deepEqual(f.storage.memories(f.bot.id)[0].sourceRefs,[message.id]);
  f.memory.apply(f.bot.id,'case',{action:'add',content:'路径 /Reports 是区分大小写的目录。'});f.memory.apply(f.bot.id,'case',{action:'add',content:'路径 /reports 是区分大小写的目录。'});assert.equal(f.storage.memories(f.bot.id).length,3);
});

test('background review reuses an archived external skill without reopening its changed source',async t=>{
  const f=fixture(t),path=join(f.dir,'home','.agents','skills','cached','SKILL.md');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'---\nname: cached\ndescription: Cached source\n---\nOriginal permitted body');f.skills.refresh();const skill=f.skills.list(f.bot.id).find(skill=>skill.name==='cached')!;
  f.store.message(f.bot.id,'tool',JSON.stringify({result:{...skill,body:'Original permitted body'}}),{tool:'skill_read',status:'done'});writeFileSync(path,'---\nname: cached\ndescription: Changed\n---\nNEW UNAPPROVED BODY');
  let step=0;const model={complete:async(messages:WireMessage[])=>{if(++step===1)return call('skill_read',{id:skill.id});assert.ok(JSON.stringify(messages).includes('Original permitted body'));assert.ok(!JSON.stringify(messages).includes('NEW UNAPPROVED BODY'));return done();}} as unknown as ModelClient;
  const worker=new LearningWorker(f.storage,f.memory,f.skills,model,new ContextEngine(f.storage,model,()=>{}),()=>{},()=>false,()=>[],100000);f.setWorker(worker);f.storage.enqueue(f.bot.id,'cached',{messages:[],tools:TOOLS,sourceRefs:[],revision:0,model:f.store.data.model.model});await worker.drain();assert.equal(f.storage.jobs(f.bot.id)[0].status,'completed');
});

test('successive compactions retain contiguous coverage and reopen from the persisted head',async t=>{
  const f=fixture(t);f.store.data.model.contextTokens=8000;const history:WireMessage[]=[];f.store.data.conversations[f.bot.id]=history;
  const engine=new ContextEngine(f.storage,{complete:async()=>done(summary)} as unknown as ModelClient,()=>{});
  for(let round=0;round<3;round++){
    for(let i=0;i<16;i++)history.push({role:'assistant',content:`第 ${round} 段记录 ${i} `+'工作内容与检查结果。'.repeat(90)});
    const runId=`round-${round}`,request=`当前要求 ${round}：保留最近结果并继续。`;history.push({role:'user',content:request});f.store.message(f.bot.id,'user',request,{runId});
    const result=await engine.prepare({botId:f.bot.id,runId,system:{role:'system',content:'遵循最新要求。'},history,tools:[],signal:new AbortController().signal,force:true});assert.ok(result.messages.some(message=>message.role==='system'&&message.content?.includes(request)));assert.ok(result.stats.estimatedTokens<=result.stats.inputBudget);
  }
  const epochs=f.storage.db.prepare('SELECT from_seq,through_seq FROM context_epochs ORDER BY created_at,rowid').all() as any[];assert.ok(epochs.length>=3);for(let i=1;i<epochs.length;i++)assert.equal(epochs[i].from_seq,epochs[i-1].through_seq);
  const before=f.storage.head(f.bot.id);f.storage.close();const reopened=new CognitiveStore(f.store);try{assert.deepEqual(reopened.head(f.bot.id),before);assert.equal(f.store.data.conversations[f.bot.id],history);}finally{reopened.close();}
});
