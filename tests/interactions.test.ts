import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {HostComputer} from '../electron/core/host';
import {Interactions} from '../electron/core/interactions';
import {ComputerController} from '../electron/core/computer';
import type {ModelClient} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';
import type {Integrations} from '../electron/core/integrations';
import type {ToolCall,WireMessage} from '../src/shared';

function fixture(t:test.TestContext){const root=mkdtempSync(join(tmpdir(),'aelion-human-test-')),store=new Store(root),interactions=new Interactions(()=>{});t.after(()=>{interactions.dispose();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('aelion-human-test-'));rmSync(root,{recursive:true,force:true});});return {root,store,interactions};}
async function until(condition:()=>boolean){for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out waiting for interaction');}

test('refusing a host operation stops the run, skips later calls and keeps tool-call history complete',async t=>{
  const {root,store,interactions}=fixture(t),bot=store.data.bots[0],host=new HostComputer({dataDir:root,homeDir:root,projectDir:root},interactions);
  const files=[join(root,'one.txt'),join(root,'two.txt')];let modelCalls=0;
  const calls:ToolCall[]=files.map((path,index)=>({id:`call-${index}`,type:'function',function:{name:'host_file_write',arguments:JSON.stringify({path,content:'must not be written',reason:'测试'})}}));
  const model={complete:async()=>{modelCalls++;return {content:'准备保存',finishReason:'tool_calls',calls};}} as unknown as ModelClient;
  const run=new Harness(store,{} as VmController,model,()=>{},undefined,undefined,undefined,host,interactions).run(bot.id,'保存文件');
  await until(()=>interactions.snapshot().length===1);assert.ok(files.every(file=>!existsSync(file)));interactions.approve(interactions.snapshot()[0].id,false);await run;
  assert.equal(modelCalls,1);assert.ok(files.every(file=>!existsSync(file)));assert.equal(store.data.runs[0].status,'cancelled');assert.match(store.data.runs[0].error||'',/拒绝/);
  const answered=store.data.conversations[bot.id].filter(message=>message.role==='tool').map(message=>message.tool_call_id);assert.deepEqual(answered,['call-0','call-1']);assert.equal(interactions.snapshot().length,0);
});

test('local MCP tools cannot start before their per-call permission is approved',async t=>{
  const {root,store,interactions}=fixture(t);let dispatched=0,modelCalls=0;
  const mcp={hostPermission:()=>({server:'local',command:'node fixture.mjs',cwd:root}),listTools:async()=>{dispatched++;return {tools:[]};}};
  const model={complete:async()=>++modelCalls===1?{content:'检查工具',finishReason:'tool_calls',calls:[{id:'list',type:'function',function:{name:'mcp_list_tools',arguments:'{"server":"local"}'}}]}:{content:'已完成',finishReason:'stop',calls:[]}} as unknown as ModelClient;
  const run=new Harness(store,{} as VmController,model,()=>{},undefined,undefined,{mcp} as unknown as Integrations,undefined,interactions).run(store.data.bots[0].id,'检查本机 MCP');
  await until(()=>interactions.snapshot().length===1);assert.equal(dispatched,0);interactions.approve(interactions.snapshot()[0].id,true);await run;assert.equal(dispatched,1);assert.equal(store.data.runs[0].status,'completed');
});

test('external skill reads need fresh permission while application-owned skills remain internal',async t=>{
  const {root,store,interactions}=fixture(t);let modelCalls=0;const reads:string[]=[];
  const skills={externalPath:(_botId:string,id:string)=>id==='external'?join(root,'external','SKILL.md'):undefined,read:(_botId:string,id:string)=>{reads.push(id);return {name:id,body:'fixture skill'};}};
  const ids=['private','external','external'];
  const model={complete:async()=>{const index=modelCalls++;return index<ids.length?{content:'读取技能',finishReason:'tool_calls',calls:[{id:`read-${index}`,type:'function',function:{name:'skill_read',arguments:JSON.stringify({id:ids[index]})}}]}:{content:'已完成',finishReason:'stop',calls:[]};}} as unknown as ModelClient;
  const run=new Harness(store,{} as VmController,model,()=>{},undefined,undefined,{skills} as unknown as Integrations,undefined,interactions).run(store.data.bots[0].id,'读取技能');
  await until(()=>interactions.snapshot().length===1);assert.deepEqual(reads,['private']);const first=interactions.snapshot()[0];assert.equal(first.kind,'host_permission');
  interactions.approve(first.id,true);await until(()=>interactions.snapshot().length===1&&interactions.snapshot()[0].id!==first.id);assert.deepEqual(reads,['private','external']);
  interactions.approve(interactions.snapshot()[0].id,false);await run;assert.deepEqual(reads,['private','external']);assert.equal(store.data.runs[0].status,'cancelled');
});

test('VM assistance pauses through takeover and resumes only with a fresh observed screenshot',async t=>{
  const {store,interactions}=fixture(t);let calls=0,screenshots=0,held=false;const state={manualControl:false};const image={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',width:1280,height:800};
  const computer={stateFor:()=>state,reserveForHuman:()=>{held=true;},clearHumanHold:()=>{held=false;},release:()=>{held=false;},execute:async()=>{assert.equal(state.manualControl,false);screenshots++;return {action:'screenshot',message:'fresh',screenshot:image};}} as unknown as ComputerController;
  const model={complete:async(messages:WireMessage[])=>{calls++;if(calls===1)return {content:'这里需要你登录',finishReason:'tool_calls',calls:[{id:'human',type:'function',function:{name:'request_user_control',arguments:'{"reason":"请完成网页登录，然后交还控制"}'}}]};assert.ok(messages.some(message=>message.images?.[0].id===image.id));return {content:'已看到交还后的画面',finishReason:'stop',calls:[]};}} as unknown as ModelClient;
  const run=new Harness(store,{} as VmController,model,()=>{},computer,undefined,undefined,undefined,interactions).run(store.data.bots[0].id,'处理需要登录的网站');
  await until(()=>interactions.snapshot().length===1);const request=interactions.snapshot()[0];assert.equal(held,true);assert.equal(calls,1);assert.equal(screenshots,0);assert.throws(()=>interactions.completeTakeover(request.id),/先接管/);
  state.manualControl=true;interactions.startTakeover(request.id);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,1);assert.equal(screenshots,0);
  state.manualControl=false;interactions.completeTakeover(request.id);await run;assert.equal(calls,2);assert.equal(screenshots,1);assert.equal(held,false);assert.equal(store.data.runs[0].status,'completed');
});

test('human reservations and takeover requests remain independent for each Bot',async t=>{
  const {root}=fixture(t);const computer=new ComputerController({state:{status:'ready'}} as VmController,root,()=>{});
  computer.reserveForHuman('first');computer.setManual('first',true);computer.reserveForHuman('other');assert.equal(computer.stateFor('other').ownerBotId,'other');
  computer.setManual('first',false);assert.equal(computer.stateFor('first').ownerBotId,'first');computer.clearHumanHold('first');computer.release('first');assert.equal(computer.stateFor('other').ownerBotId,'other');
  const interactions=new Interactions(()=>{}),signal=new AbortController().signal;
  const requests=[interactions.requestTakeover('first','r1','登录',false,signal),interactions.requestTakeover('other','r2','确认',false,signal)];
  assert.equal(interactions.snapshot().length,2);for(const request of interactions.snapshot()){interactions.startTakeover(request.id);interactions.completeTakeover(request.id);}await Promise.all(requests);
});

test('cancelling a paused run withdraws its request and never resumes the model',async t=>{
  const {root,store,interactions}=fixture(t),host=new HostComputer({dataDir:root,homeDir:root,projectDir:root},interactions);let calls=0;
  const model={complete:async()=>{calls++;return {content:'保存',finishReason:'tool_calls',calls:[{id:'write',type:'function',function:{name:'host_file_write',arguments:JSON.stringify({path:join(root,'cancelled.txt'),content:'no',reason:'测试'})}}]};}} as unknown as ModelClient;
  const harness=new Harness(store,{} as VmController,model,()=>{},undefined,undefined,undefined,host,interactions),bot=store.data.bots[0];const run=harness.run(bot.id,'保存');
  await until(()=>interactions.snapshot().length===1);harness.cancel(bot.id);await run;assert.equal(calls,1);assert.equal(interactions.snapshot().length,0);assert.equal(existsSync(join(root,'cancelled.txt')),false);assert.equal(store.data.runs[0].status,'cancelled');
});
