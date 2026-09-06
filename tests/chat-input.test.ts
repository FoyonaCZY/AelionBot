import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {ChatPinQueue} from '../electron/core/chat-pins';
import {Interactions} from '../electron/core/interactions';
import {HostComputer} from '../electron/core/host';
import {ComputerController} from '../electron/core/computer';
import type {ModelClient,Completion,ToolDefinition} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';
import type {WireMessage} from '../src/shared';
import {conversationTimeline} from '../src/activity';
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean){for(let i=0;i<500;i++){if(predicate())return;await delay(10);}throw Error('输入测试等待超时');}
const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'});
const tool=(name:string,args:object):Completion=>({content:'',calls:[{id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}],finishReason:'tool_calls'});
function fixture(t:test.TestContext,complete:(messages:WireMessage[],tools:ToolDefinition[],signal:AbortSignal)=>Promise<Completion>|Completion,vm?:VmController){
  const dir=mkdtempSync(join(tmpdir(),'aelion-input-')),store=new Store(dir),bot=store.data.bots[0];store.data.model.model='fixture';store.data.model.contextTokens=64000;
  let queue:ChatPinQueue;const interactions=new Interactions(()=>queue?.wake()),host=new HostComputer({dataDir:dir,homeDir:dir,projectDir:dir},interactions);
  const harness=new Harness(store,vm||{} as VmController,{complete} as ModelClient,()=>queue?.wake(),undefined,undefined,undefined,host,interactions);
  queue=new ChatPinQueue(store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args),refresh:id=>harness.refreshInput(id)},()=>{});
  t.after(async()=>{queue.dispose();harness.cancel(bot.id);await until(()=>!harness.busy&&!queue.hasPending(bot.id));host.dispose();interactions.dispose();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,bot,harness,queue,interactions,idle:()=>!harness.busy&&!queue.hasPending(bot.id)};
}

test('stopping cancels queued input and restarting never replays it',async t=>{
  let calls=0;const fx=fixture(t,()=>{calls++;return answer('不应调用');});
  fx.queue.send({botId:fx.bot.id,message:'尚未处理'});fx.queue.cancel(fx.bot.id);await delay(120);assert.equal(calls,0);
  fx.queue.send({botId:fx.bot.id,message:'重启前的输入'});const restored=new Store(fx.dir);assert.equal(restored.data.messages.at(-1)?.inputState,'interrupted');
  fx.queue.dispose();const replay=new ChatPinQueue(restored,{isRunning:()=>false,run:async()=>{calls++;}},()=>{});replay.wake();await delay(120);assert.equal(calls,0);assert.equal(replay.hasPending(fx.bot.id),false);replay.dispose();
});

test('a new message cancels a pending VM takeover without taking control back from the user',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-input-takeover-')),store=new Store(dir),bot=store.data.bots[0];store.data.model.model='fixture';store.data.model.contextTokens=64000;
  let queue:ChatPinQueue;const interactions=new Interactions(()=>queue?.wake()),vm={state:{status:'ready'}} as unknown as VmController,computer=new ComputerController(vm,dir,()=>{});
  const model={complete:async(messages:WireMessage[])=>messages.at(-1)?.content==='先回答我的问题'?answer('收到新的问题。'):tool('request_user_control',{reason:'登录账号'})} as unknown as ModelClient;
  const harness=new Harness(store,vm,model,()=>queue?.wake(),computer,undefined,undefined,undefined,interactions);
  queue=new ChatPinQueue(store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args),refresh:id=>harness.refreshInput(id)},()=>{});
  t.after(async()=>{queue.dispose();harness.cancel(bot.id);await until(()=>!harness.busy&&!queue.hasPending(bot.id));interactions.dispose();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  queue.send({botId:bot.id,message:'需要登录后工作'});await until(()=>interactions.snapshot().length===1);computer.setManual(bot.id,true);interactions.startTakeover(interactions.snapshot()[0].id);
  queue.send({botId:bot.id,message:'先回答我的问题'});await until(()=>!harness.busy&&!queue.hasPending(bot.id));assert.equal(interactions.snapshot().length,0);assert.equal(computer.stateFor(bot.id).manualControl,true);assert.ok(store.data.messages.some(m=>m.content==='收到新的问题。'));
});

test('a failed progress summary does not stop the actual work',async t=>{
  let actions=0;const vm={execute:async()=>({stdout:`step ${++actions}`,stderr:'',exitCode:0,durationMs:1})} as unknown as VmController;
  const fx=fixture(t,messages=>{if(messages[0].content?.includes('简短汇报工作进度'))throw Error('fixture summary unavailable');return actions<4?tool('computer_execute',{command:'next-step'}):answer('已执行完毕');},vm);
  fx.queue.send({botId:fx.bot.id,message:'执行四个操作'});await until(fx.idle);assert.equal(actions,4);assert.equal(fx.store.data.runs[0].status,'completed');assert.ok(fx.store.data.messages.some(m=>m.content==='已执行完毕'));
});
test('a new user message aborts the old request immediately and stale completion cannot publish',async t=>{
  let calls=0,oldSignal:AbortSignal|undefined,late:(value:Completion)=>void=()=>{};
  const fx=fixture(t,(messages,_tools,signal)=>{calls++;if(calls===1){oldSignal=signal;return new Promise(resolve=>{late=resolve;});}assert.ok(messages.some(m=>m.role==='user'&&m.content==='旧问题'));assert.ok(messages.some(m=>m.role==='user'&&m.content==='改成新问题'));return answer('这是新问题的回答');});
  fx.queue.send({botId:fx.bot.id,message:'旧问题'});await until(()=>calls===1);fx.queue.send({botId:fx.bot.id,message:'改成新问题'});assert.equal(oldSignal?.aborted,true);await until(fx.idle);
  late(answer('过时的回答'));await delay(30);assert.equal(calls,2);assert.equal(fx.store.data.messages.filter(m=>m.role==='user'&&!m.reaction).length,2);assert.ok(!fx.store.data.messages.some(m=>m.content.includes('过时的回答')));assert.ok(fx.store.data.runs[0].inputUpdated);assert.ok(fx.store.data.messages.some(m=>m.content==='这是新问题的回答'));
});
test('new pins replace pending text and pin replies, retaining the actual latest attitude',async t=>{
  let calls=0;const signals:AbortSignal[]=[];const fx=fixture(t,(messages,_tools,signal)=>{calls++;if(calls<3){signals.push(signal);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}assert.ok(messages.at(-1)?.content?.includes('👎'));return answer('看到你不赞同，我重新说明。');});
  const greeting=fx.store.message(fx.bot.id,'assistant','原消息',{status:'done'});fx.queue.send({botId:fx.bot.id,message:'解释一下'});await until(()=>calls===1);fx.queue.pin({botId:fx.bot.id,messageId:greeting.id,emoji:'👍'});assert.equal(signals[0].aborted,true);await until(()=>calls===2);fx.queue.pin({botId:fx.bot.id,messageId:greeting.id,emoji:'👎'});assert.equal(signals[1].aborted,true);await until(fx.idle);assert.equal(calls,3);assert.equal(fx.store.data.messages.filter(m=>m.reaction&&m.role==='user').length,2);assert.equal(fx.store.humanRunMessage(fx.store.data.runs.at(-1)!.id)?.content,'解释一下');
});
test('bursts are combined into a fresh request without losing or duplicating user messages',async t=>{
  let calls=0;const fx=fixture(t,messages=>{calls++;const text=messages.filter(m=>m.role==='user').map(m=>m.content||'');assert.ok(text.indexOf('第一条')<text.indexOf('以第二条为准'));assert.ok(text.at(-1)?.includes('emoji 发言'));return answer('按最新输入处理。');});const greeting=fx.store.message(fx.bot.id,'assistant','可回应的消息',{status:'done'});
  fx.queue.send({botId:fx.bot.id,message:'第一条'});fx.queue.send({botId:fx.bot.id,message:'以第二条为准'});fx.queue.pin({botId:fx.bot.id,messageId:greeting.id,emoji:'👍'});await until(fx.idle);assert.equal(calls,1);assert.equal(fx.store.humanRunMessage(fx.store.data.runs[0].id)?.content,'以第二条为准');assert.equal(fx.store.data.messages.filter(m=>m.role==='user').length,3);
});
test('invalid replacement input cannot cancel a valid request',async t=>{
  let signal:AbortSignal|undefined;const fx=fixture(t,(_messages,_tools,current)=>{signal=current;return new Promise((_resolve,reject)=>current.addEventListener('abort',()=>reject(current.reason),{once:true}));});
  fx.queue.send({botId:fx.bot.id,message:'有效请求'});await until(()=>Boolean(signal));assert.throws(()=>fx.queue.send({botId:fx.bot.id,message:' '}));assert.equal(signal?.aborted,false);assert.throws(()=>fx.queue.pin({botId:fx.bot.id,messageId:'missing',emoji:'👍'}));assert.equal(signal?.aborted,false);
});
test('an in-flight operation completes once and the new request sees its recorded result',async t=>{
  let actions=0,finish:(value:unknown)=>void=()=>{};const vm={execute:async()=>{actions++;return new Promise(resolve=>{finish=resolve;});}} as unknown as VmController;
  const fx=fixture(t,messages=>{if(!messages.some(m=>m.role==='tool'))return tool('computer_execute',{command:'create-once'});assert.ok(JSON.stringify(messages).includes('created-once'));assert.ok(messages.some(m=>m.content==='只汇报结果'));return answer('已核对执行结果。');},vm);
  fx.queue.send({botId:fx.bot.id,message:'创建一次'});await until(()=>actions===1);fx.queue.send({botId:fx.bot.id,message:'只汇报结果'});assert.equal(actions,1);finish({stdout:'created-once',stderr:'',exitCode:0,durationMs:1});await until(fx.idle);assert.equal(actions,1);assert.ok(fx.store.data.messages.some(m=>m.content==='已核对执行结果。'));
});
test('a new input withdraws an obsolete permission instead of executing it',async t=>{
  const fx=fixture(t,messages=>messages.at(-1)?.content==='不用写了'?answer('收到，不再写入。'):tool('host_file_write',{path:join(fx.dir,'obsolete.txt'),content:'旧内容',reason:'旧请求'}));
  fx.queue.send({botId:fx.bot.id,message:'写入文件'});await until(()=>fx.interactions.snapshot().length===1);fx.queue.send({botId:fx.bot.id,message:'不用写了'});await until(fx.idle);assert.equal(fx.interactions.snapshot().length,0);assert.equal(existsSync(join(fx.dir,'obsolete.txt')),false);
});
test('every three work steps produce a visible concise progress message without ending the task',async t=>{
  let summaries=0,actions=0;const vm={execute:async()=>({stdout:`已执行 ${++actions}`,stderr:'',exitCode:0,durationMs:1})} as unknown as VmController;
  const fx=fixture(t,(messages,tools)=>{if(messages[0].content?.includes('简短汇报工作进度')){summaries++;assert.equal(tools.length,0);assert.ok(messages[1].content?.includes('done'));return answer(`已完成第 ${actions} 个操作，接下来继续核对。`);}return actions<7?tool('computer_execute',{command:'next-step'}):answer('所有工作已完成。');},vm);
  fx.queue.send({botId:fx.bot.id,message:'完成七个操作并核对'});await until(fx.idle);const updates=fx.store.data.messages.filter(m=>m.audience==='user'&&m.presentation==='progress');assert.equal(summaries,2);assert.equal(updates.length,2);assert.ok(conversationTimeline(fx.store.data.messages).filter(item=>item.kind==='message').some(item=>item.id===updates[0].id));assert.equal(fx.store.data.runs[0].status,'completed');
});
test('superseding a pending progress generation prevents that old update from being published',async t=>{
  let actions=0,summarySignal:AbortSignal|undefined,late:(value:Completion)=>void=()=>{};const vm={execute:async()=>({stdout:`step ${++actions}`,stderr:'',exitCode:0,durationMs:1})} as unknown as VmController;
  const fx=fixture(t,(messages,_tools,signal)=>{if(messages[0].content?.includes('简短汇报工作进度')){summarySignal=signal;return new Promise(resolve=>{late=resolve;});}if(messages.some(m=>m.role==='user'&&m.content==='回答新的问题'))return answer('新问题的答案');return tool('computer_execute',{command:'work'});},vm);
  fx.queue.send({botId:fx.bot.id,message:'先做工作'});await until(()=>Boolean(summarySignal));fx.queue.send({botId:fx.bot.id,message:'回答新的问题'});assert.equal(summarySignal?.aborted,true);await until(fx.idle);late(answer('过时进度'));await delay(30);assert.ok(!fx.store.data.messages.some(m=>m.content==='过时进度'));assert.equal(actions,3);
});

test('a new input preserves progress already spoken before an in-flight operation',async t=>{
  let started=false,finish:(value:unknown)=>void=()=>{};
  const vm={execute:async()=>{started=true;return new Promise(resolve=>{finish=resolve;});}} as unknown as VmController;
  const fx=fixture(t,messages=>messages.some(message=>message.role==='user'&&message.content==='只说明结果')?answer('这是已执行的结果。'):{...tool('computer_execute',{command:'run-once'}),content:'我先核对现有文件，再继续处理。'},vm);
  fx.queue.send({botId:fx.bot.id,message:'核对文件'});await until(()=>started);const progress=fx.store.data.messages.find(message=>message.presentation==='progress'&&message.content)!;const id=progress.id;
  fx.queue.send({botId:fx.bot.id,message:'只说明结果'});finish({stdout:'checked',stderr:'',exitCode:0,durationMs:1});await until(fx.idle);
  assert.equal(progress.status,'done');assert.equal(progress.content,'我先核对现有文件，再继续处理。');assert.ok(conversationTimeline(fx.store.data.messages).some(item=>item.kind==='message'&&item.id===id));assert.ok(fx.store.data.runs[0].inputUpdated);
});

test('a later execution error cannot overwrite completed progress with the failure notice',async t=>{
  let calls=0;const vm={execute:async()=>({stdout:'',stderr:'fixture failure',exitCode:1,durationMs:1})} as unknown as VmController;
  const fx=fixture(t,()=>({...tool('computer_execute',{command:'same-failing-check'}),content:`正在做第 ${++calls} 次检查。`}),vm);
  fx.queue.send({botId:fx.bot.id,message:'核对文件'});await until(fx.idle);assert.equal(fx.store.data.runs[0].status,'failed');
  const progress=fx.store.data.messages.filter(message=>message.presentation==='progress'&&message.status==='done');assert.equal(progress.length,3);assert.equal(progress[2].content,'正在做第 3 次检查。');assert.equal(fx.store.data.messages.filter(message=>message.presentation==='error').length,1);
});
