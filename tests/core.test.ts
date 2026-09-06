import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {createServer,type Server} from 'node:http';
import {Store} from '../electron/core/store';
import {ModelClient,validateModelEndpoint} from '../electron/core/model';
import {Harness,safeRelativePath,workspacePath,compactBoundary} from '../electron/core/harness';
import type {VmController} from '../electron/core/vm';
import type {WireMessage} from '../src/shared';

function temporary(t:test.TestContext){const dir=mkdtempSync(join(tmpdir(),'aelion-core-test-'));t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('aelion-core-test-'));rmSync(dir,{recursive:true,force:true});});return dir;}
async function server(t:test.TestContext,handler:Parameters<typeof createServer>[1]){const instance=createServer(handler);await new Promise<void>(ok=>instance.listen(0,'127.0.0.1',ok));t.after(()=>new Promise<void>((ok,fail)=>instance.close(error=>error?fail(error):ok())));const address=instance.address();assert.ok(address&&typeof address==='object');return `http://127.0.0.1:${address.port}/v1`;}

test('endpoint rejects credentials and remote plaintext while supporting local models',()=>{
  assert.equal(validateModelEndpoint('http://127.0.0.1:8080/v1/'),'http://127.0.0.1:8080/v1');
  assert.equal(validateModelEndpoint('https://api.example.com/v1'),'https://api.example.com/v1');
  for(const url of ['http://example.com/v1','https://user:secret@example.com/v1','https://example.com/v1?key=secret','file:///etc/passwd'])assert.throws(()=>validateModelEndpoint(url));
});
test('file tools reject traversal and host paths',()=>{
  assert.equal(safeRelativePath('reports/proof.txt'),'reports/proof.txt');
  for(const path of ['../secret','reports/../../secret','/etc/passwd','C:\\Users\\Example\\file.txt','foo\\bar','x\0y'])assert.throws(()=>safeRelativePath(path));
});
test('file tool accepts its own returned absolute path without permitting another workspace',()=>{
  assert.equal(workspacePath('/work/bot-a/reports/result.json','bot-a'),'reports/result.json');
  assert.equal(workspacePath('result.json','bot-a'),'result.json');
  assert.throws(()=>workspacePath('/work/bot-b/result.json','bot-a'));
  assert.throws(()=>workspacePath('/work/bot-a/../bot-b/result.json','bot-a'));
});
test('state persists Bot data and repairs interrupted tool protocol without replay',t=>{
  const dir=temporary(t);const first=new Store(dir);const bot=first.data.bots[0];bot.memories.push('优先使用中文');
  first.data.runs.push({id:'run-1',botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:1,toolCalls:0});
  first.data.conversations[bot.id]=[
    {role:'user',content:'旧任务'},
    {role:'assistant',content:null,tool_calls:[{id:'reused-id',type:'function',function:{name:'file_write',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'reused-id',content:'done'},
    {role:'user',content:'新任务'},
    {role:'assistant',content:null,tool_calls:[{id:'reused-id',type:'function',function:{name:'file_write',arguments:'{}'}}]}
  ];first.save();
  const reopened=new Store(dir);assert.equal(reopened.data.runs[0].status,'interrupted');assert.deepEqual(reopened.bot(bot.id).memories,['优先使用中文']);
  const last=reopened.data.conversations[bot.id].at(-1)!;assert.equal(last.role,'tool');assert.equal(last.tool_call_id,'reused-id');assert.match(last.content!,/unknown/);
  assert.equal(JSON.parse(readFileSync(join(dir,'state.json'),'utf8')).version,1);
});
test('compression tail never begins with an orphan tool response',()=>{
  const messages:WireMessage[]=[{role:'user',content:'task'}];
  for(let i=0;i<8;i++)messages.push({role:'assistant',content:null,tool_calls:[{id:`c${i}`,type:'function',function:{name:'read',arguments:'{}'}}]},{role:'tool',tool_call_id:`c${i}`,content:'result'});
  const tail=messages.slice(compactBoundary(messages));assert.notEqual(tail[0].role,'tool');const ids=new Set(tail.flatMap(m=>m.tool_calls?.map(c=>c.id)||[]));for(const m of tail)if(m.role==='tool')assert.ok(ids.has(m.tool_call_id!));
});

test('deleting a Bot removes only its records and preserves other Bot references and model settings',t=>{
  const dir=temporary(t),store=new Store(dir),removed=store.data.bots[0],kept=store.createBot('保留的 Bot','仍在工作');
  removed.memories.push('私有记忆');kept.memories.push('保留记忆');
  store.data.conversations[removed.id]=[{role:'user',content:'删除的对话'}];store.data.summaries[removed.id]='删除的摘要';store.data.contextOffsets[removed.id]=1;
  const keptHistory=store.data.conversations[kept.id];keptHistory.push({role:'user',content:'保留的对话'});
  const keptRun={id:'kept-run',botId:kept.id,status:'running' as const,startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};
  store.data.runs.push({id:'removed-run',botId:removed.id,status:'completed',startedAt:new Date().toISOString(),modelCalls:1,toolCalls:0},keptRun);
  store.data.artifacts.push({id:'removed-file',botId:removed.id,runId:'removed-run',name:'report.txt',path:'report.txt',size:10,modifiedAt:new Date().toISOString()},{id:'kept-file',botId:kept.id,runId:'kept-run',name:'keep.txt',path:'keep.txt',size:10,modifiedAt:new Date().toISOString()});
  store.data.skills.push({id:'removed-skill',botId:removed.id,name:'私有流程',description:'删除',body:'private'},{id:'kept-skill',botId:kept.id,name:'保留流程',description:'保留',body:'keep'});
  const model=store.data.model;store.save();store.deleteBot(removed.id);
  assert.deepEqual(store.data.bots,[kept]);assert.equal(store.data.model,model);assert.equal(store.data.conversations[kept.id],keptHistory);assert.equal(store.data.runs[0],keptRun);
  for(const items of [store.data.messages,store.data.runs,store.data.artifacts,store.data.skills])assert.ok(items.every(item=>item.botId!==removed.id));
  for(const record of [store.data.conversations,store.data.summaries,store.data.contextOffsets])assert.equal(Object.hasOwn(record,removed.id),false);
  const saved=JSON.parse(readFileSync(store.file,'utf8'));assert.deepEqual(saved.bots.map((bot:any)=>bot.id),[kept.id]);assert.equal(saved.runs[0].status,'running');
  assert.ok(saved.skills.some((skill:any)=>skill.id==='verified-files'));assert.ok(saved.skills.some((skill:any)=>skill.id==='kept-skill'));assert.equal(saved.artifacts[0].id,'kept-file');
});

test('deleting the final Bot stays empty after reopening and still allows creating a new Bot',t=>{
  const dir=temporary(t),store=new Store(dir),id=store.data.bots[0].id;
  store.deleteBot(id);const reopened=new Store(dir);
  assert.equal(reopened.data.bots.length,0);assert.equal(reopened.data.messages.length,0);assert.deepEqual(reopened.data.conversations,{});
  const created=reopened.createBot('新伙伴','新工作');assert.notEqual(created.id,id);assert.equal(reopened.data.bots.length,1);assert.equal(new Store(dir).data.bots[0].id,created.id);
});

test('a running or unknown Bot cannot be deleted and failed deletion leaves persisted state untouched',t=>{
  const store=new Store(temporary(t)),bot=store.data.bots[0];
  store.data.runs.push({id:'active',botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0});store.save();
  const before=readFileSync(store.file,'utf8');
  assert.throws(()=>store.deleteBot(bot.id),/先停止/);assert.throws(()=>store.deleteBot('missing'),/不存在/);
  assert.equal(readFileSync(store.file,'utf8'),before);assert.equal(store.bot(bot.id),bot);
});

test('Harness reports a Bot busy until its final artifact collection has finished',async t=>{
  const store=new Store(temporary(t));let release!:()=>void,collecting!:()=>void;
  const started=new Promise<void>(resolve=>collecting=resolve),finished=new Promise<void>(resolve=>release=resolve);
  const model={complete:async()=>({content:'完成',finishReason:'stop',calls:[]})} as unknown as ModelClient;
  const harness=new Harness(store,{} as VmController,model,()=>{},undefined,async()=>{collecting();await finished;});
  const bot=store.data.bots[0],run=harness.run(bot.id,'结束测试');await started;
  assert.equal(store.data.runs[0].status,'completed');assert.equal(harness.isRunning(bot.id),true);
  release();await run;assert.equal(harness.isRunning(bot.id),false);
});
test('model parser reconstructs fragmented SSE tool calls and rejects incomplete streams',async t=>{
  let attempt=0;const base=await server(t,async(req,res)=>{
    for await(const _ of req){}attempt++;res.writeHead(200,{'Content-Type':'text/event-stream'});
    const rows=[{choices:[{delta:{tool_calls:[{index:0,id:'call-1',function:{name:'file_write',arguments:'{"path":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"proof.txt","content":"ok"}'}}]}}]}];
    for(const row of rows){const text=`data: ${JSON.stringify(row)}\n\n`;res.write(text.slice(0,11));res.write(text.slice(11));}
    if(attempt===1)res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');res.end('data: [DONE]\n\n');
  });
  const client=new ModelClient(()=>({baseUrl:base,model:'test',contextTokens:32000,hasKey:false}),()=> '');
  const result=await client.complete([{role:'user',content:'go'}],[],new AbortController().signal);
  assert.equal(result.calls[0].function.name,'file_write');assert.deepEqual(JSON.parse(result.calls[0].function.arguments),{path:'proof.txt',content:'ok'});
  await assert.rejects(()=>client.complete([{role:'user',content:'go'}],[],new AbortController().signal),/完整响应之前断开/);
});
test('model HTTP error redacts a provided key',async t=>{
  const base=await server(t,(_req,res)=>{res.writeHead(401);res.end('key secret-unit-value rejected');});
  const client=new ModelClient(()=>({baseUrl:base,model:'test',contextTokens:32000,hasKey:true}),()=> 'secret-unit-value');
  await assert.rejects(()=>client.complete([{role:'user',content:'go'}],[],new AbortController().signal),(error:Error)=>error.message.includes('[redacted]')&&!error.message.includes('secret-unit-value'));
});
test('Harness denies another Bot private skill and never dispatches an unknown tool',async t=>{
  const store=new Store(temporary(t));const first=store.data.bots[0],second=store.createBot('另一个 Bot','测试隔离');
  store.data.skills.push({id:'private-skill',name:'私有流程',description:'private',body:'private content',botId:first.id});
  let step=0,executed=0;
  const fakeModel={complete:async()=>++step===1?{content:'',finishReason:'tool_calls',calls:[{id:'one',type:'function',function:{name:'skill_read',arguments:'{"id":"private-skill"}'}},{id:'two',type:'function',function:{name:'host_delete_all',arguments:'{}'}}]}:{content:'已核对错误',finishReason:'stop',calls:[]}} as unknown as ModelClient;
  const fakeVm={execute:async()=>{executed++;return {stdout:'',stderr:'',exitCode:0,durationMs:0};}} as unknown as VmController;
  await new Harness(store,fakeVm,fakeModel,()=>{}).run(second.id,'测试权限');
  assert.equal(executed,0);const results=store.data.conversations[second.id].filter(m=>m.role==='tool').map(m=>m.content).join('\n');
  assert.match(results,/无权访问/);assert.match(results,/未注册工具/);assert.equal(store.bot(first.id).memories.length,0);
});
test('nonzero guest exit is visibly failed and cannot be confirmed as completed',async t=>{
  const store=new Store(temporary(t));const bot=store.data.bots[0];let step=0;
  const fakeModel={complete:async()=>++step===1?{content:'',finishReason:'tool_calls',calls:[{id:'failed-command',type:'function',function:{name:'python_execute',arguments:'{"code":"raise ValueError()"}'}}]}:{content:'已经完成',finishReason:'stop',calls:[]}} as unknown as ModelClient;
  const fakeVm={execute:async()=>({stdout:'',stderr:'ValueError',exitCode:1,durationMs:1})} as unknown as VmController;
  await new Harness(store,fakeVm,fakeModel,()=>{}).run(bot.id,'执行并验证');
  assert.equal(store.data.messages.find(m=>m.role==='tool')?.status,'failed');
  assert.equal(store.data.runs.at(-1)?.status,'failed');
  assert.match(store.data.runs.at(-1)?.error||'',/不能确认完成/);
});

test('skill names resolve only within the Bot scope and ambiguous names require an ID',async t=>{
  const store=new Store(temporary(t));const bot=store.data.bots[0];
  store.data.skills.push(
    {id:'own',name:'汇总',description:'own',body:'own procedure',botId:bot.id},
    {id:'other',name:'汇总',description:'other',body:'private procedure',botId:'another-bot'},
    {id:'hidden',name:'隐藏流程',description:'hidden',body:'hidden',botId:'another-bot'},
    {id:'shared',name:'重复名称',description:'shared',body:'shared'},
    {id:'duplicate',name:'重复名称',description:'own',body:'own',botId:bot.id}
  );
  let step=0;
  const fakeModel={complete:async()=>++step===1?{content:'',finishReason:'tool_calls',calls:['汇总','隐藏流程','重复名称','own'].map((id,index)=>({id:`read-${index}`,type:'function',function:{name:'skill_read',arguments:JSON.stringify({id})}}))}:{content:'检查结束',finishReason:'stop',calls:[]}} as unknown as ModelClient;
  await new Harness(store,{} as VmController,fakeModel,()=>{}).run(bot.id,'测试技能名称解析');
  const results=store.data.conversations[bot.id].filter(m=>m.role==='tool').map(m=>JSON.parse(m.content!).result);
  assert.equal(results[0].id,'own');assert.match(results[1].error,/无权访问/);assert.match(results[2].error,/多个同名技能/);assert.equal(results[3].id,'own');
});
