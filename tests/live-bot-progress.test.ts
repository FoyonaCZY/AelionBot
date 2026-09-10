import test from 'node:test';
import assert from 'node:assert/strict';
import type {RunRecord} from '../src/shared';
import type {ToolExecution} from '../src/execution-types';
import {liveBotProgress,waitingExplanation} from '../src/live-bot-progress';

const at='2026-09-11T10:00:00Z';
const run=(patch:Partial<RunRecord>={}):RunRecord=>({id:'run',botId:'bot',status:'running',startedAt:at,modelCalls:0,toolCalls:0,...patch});
const execution=(id:string,status:ToolExecution['status'],tool='host_file_read',time=at):ToolExecution=>({id,callId:id,botId:'bot',runId:'run',tool,target:'private-command-and-path',targetKey:'secret',status,startedAt:at,endedAt:status==='running'?undefined:time});
test('progress uses only confirmed current-run operations, excluding wrappers and private arguments',()=>{
  const r=run({executions:[execution('1','succeeded'),execution('2','failed'),execution('batch','succeeded','code_exec'),{...execution('foreign','succeeded'),runId:'other'},execution('3','succeeded','host_file_write','2026-09-11T10:01:00Z'),execution('4','running','host_file_read')]});
  const p=liveBotProgress([],r)!;
  assert.equal(p.label,'正在读取本机文件');assert.equal(p.recent?.length,2);assert.match(p.receipt!,/写入本机文件/);
  assert.equal(p.since,at);assert.doesNotMatch(JSON.stringify(p),/private|secret|foreign|batch/);
});
test('long wait starts only from observed request or tool timestamps, never from run age',()=>{
  const r=run(),now=Date.parse(at)+80000;
  assert.equal(waitingExplanation(liveBotProgress([],r)!,now),undefined);
  r.modelRequest={phase:'waiting',startedAt:at,updatedAt:at,attempt:0,maxRetries:2};
  const p=liveBotProgress([],r)!;assert.match(waitingExplanation(p,now)!,/还没有返回结果/);
  assert.equal(waitingExplanation(p,Date.parse(at)+59000),undefined);
  assert.equal(waitingExplanation({...p,since:'invalid'},now),undefined);
});
test('streaming refreshes its wait timestamp and transport retry stays factual',()=>{
  const r=run({modelRequest:{phase:'retrying',startedAt:at,updatedAt:at,attempt:1,maxRetries:2,reason:'rate_limit'}});
  assert.equal(liveBotProgress([],r)?.label,'服务繁忙，正在重试');assert.match(liveBotProgress([],r)!.description!,/第 1 次重试/);
  r.modelRequest={...r.modelRequest!,phase:'streaming',updatedAt:'2026-09-11T10:01:10Z'};
  const p=liveBotProgress([],r)!;assert.equal(p.label,'正在生成回复');assert.equal(waitingExplanation(p,Date.parse(at)+80000),undefined);
});
test('user action overrides work and terminal runs remove the whole status',()=>{
  const r=run({executions:[execution('current','running')]});
  const p=liveBotProgress([],r,'host_permission')!;assert.equal(p.needsInput,true);assert.match(p.description!,/尚未执行/);assert.equal(waitingExplanation(p,Date.parse(at)+900000),undefined);
  assert.equal(liveBotProgress([],r,'host_permission',true)?.needsInput,undefined);
  for(const status of ['completed','failed','cancelled','interrupted'] as const)assert.equal(liveBotProgress([],run({status})),undefined);
});

