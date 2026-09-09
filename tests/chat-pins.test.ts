import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {Harness} from '../electron/core/harness';
import {ChatPinQueue,pinChat} from '../electron/core/chat-pins';
import {memoryRoute} from '../electron/core/memory-routing';
import type {ModelClient} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';
import type {HostComputer} from '../electron/core/host';
import {Interactions} from '../electron/core/interactions';
const wait=async(predicate:()=>boolean)=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('pin wait timed out');};
function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'aelion-pin-test-')),store=new Store(dir),bot=store.data.bots[0];store.data.model.model='fixture';
  const cleanup:Array<()=>void|Promise<void>>=[];
  t.after(async()=>{for(const close of cleanup)await close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});return {dir,store,bot,beforeCleanup:(close:()=>void|Promise<void>)=>cleanup.push(close)};
}
test('user pins persist, toggle idempotently, queue while busy and reach the Bot once as an attitude event',async t=>{
  const {store,bot,dir,beforeCleanup}=fixture(t);const target=store.message(bot.id,'assistant','报告已经完成',{status:'done'});let busy=true,calls=0;
  const model={complete:async()=>{calls++;return {content:calls===1?'收到你的认可！':'[表情静默]',calls:[],finishReason:'stop'};}} as unknown as ModelClient;
  const harness=new Harness(store,{} as VmController,model,()=>{}),queue=new ChatPinQueue(store,{isRunning:id=>busy||harness.isRunning(id),run:(...args)=>harness.run(...args)},()=>{});beforeCleanup(async()=>{queue.dispose();await wait(()=>!(queue as any).workers.size);});
  queue.pin({botId:bot.id,messageId:target.id,emoji:'👍'});queue.pin({botId:bot.id,messageId:target.id,emoji:'👍'});
  await new Promise(resolve=>setTimeout(resolve,120));assert.equal(calls,0);assert.equal(target.pins?.length,1);assert.equal(store.data.messages.filter(m=>m.reaction).length,1);
  busy=false;queue.wake();await wait(()=>calls===1&&!harness.busy);
  const event=store.data.messages.find(m=>m.reaction)!;assert.ok(event.runId);assert.equal(store.data.messages.filter(m=>m.role==='user').length,1);assert.equal(memoryRoute(store,{...event,content:'记住：以后只说英文'}),undefined);
  assert.ok(store.data.conversations[bot.id].some(m=>m.content?.includes('emoji 发言')));assert.ok(!store.data.conversations[bot.id].some(m=>m.content==='[表情静默]'));
  assert.equal(new Store(dir).data.messages.find(m=>m.id===target.id)?.pins?.[0].emoji,'👍');
  queue.pin({botId:bot.id,messageId:target.id,emoji:'👍',remove:true});await wait(()=>calls===2&&!harness.busy);assert.equal(target.pins?.length,0);
});
test('Bot chat_pin adds an attributed reaction and completes without a second model call or text response',async t=>{
  const {store,bot}=fixture(t);let calls=0;
  const model={complete:async()=>{calls++;const target=store.data.messages.find(m=>m.role==='user')!;return {content:'重复的口头确认应隐藏',calls:[{id:randomUUID(),type:'function',function:{name:'chat_pin',arguments:JSON.stringify({messageId:target.id,emoji:'❤️'})}}],finishReason:'tool_calls'};}} as unknown as ModelClient;
  const harness=new Harness(store,{} as VmController,model,()=>{});await harness.run(bot.id,'谢谢你');
  assert.equal(calls,1);assert.equal(store.data.runs[0].status,'completed');const target=store.data.messages.find(m=>m.role==='user')!;
  assert.equal(target.pins?.[0].actor.id,bot.id);assert.equal(target.pins?.[0].emoji,'❤️');assert.ok(store.data.messages.some(m=>m.reaction&&m.role==='event'));
  assert.ok(!store.data.messages.some(m=>m.role==='assistant'&&m.content));assert.ok(!JSON.stringify(store.data.conversations[bot.id]).includes('重复的口头确认'));
  const other=store.createBot('另一个','测试');assert.throws(()=>pinChat(store,other.id,{kind:'user',id:'user',name:'你'},{messageId:target.id,emoji:'👍'}),/当前聊天/);
  assert.throws(()=>pinChat(store,bot.id,{kind:'user',id:'user',name:'你'},{messageId:target.id,emoji:'不是表情' as any}),/无效/);
});

test('a reaction mixed with project discovery continues to a final answer and keeps its progress text',async t=>{
  const {store,bot,dir,beforeCleanup}=fixture(t),interactions=new Interactions(()=>{});beforeCleanup(()=>interactions.dispose());let calls=0,reads=0;
  const invoke=(name:string,args:Record<string,unknown>={})=>({id:randomUUID(),type:'function' as const,function:{name,arguments:JSON.stringify(args)}});
  const progress='我先查看项目结构和可用技能，再整理项目的主要模块。';
  const model={complete:async(messages:any[])=>{
    calls++;if(calls===1){const target=store.data.messages.find(m=>m.role==='user')!;return {content:progress,calls:[invoke('chat_pin',{messageId:target.id,emoji:'👀'}),invoke('task_read'),invoke('host_list_directory',{reason:'了解项目结构'}),invoke('skills_list')],finishReason:'tool_calls'};}
    assert.ok(messages.some(message=>message.role==='assistant'&&message.content===progress));assert.ok(messages.some(message=>message.role==='tool'&&message.content.includes('README.md')));
    return {content:'已了解项目结构：入口是 README.md，下一步可按模块继续阅读。',calls:[],finishReason:'stop'};
  }} as unknown as ModelClient;
  const host={options:{},workspace:()=>dir,context:()=>({workspace:dir}),redact:(text:string)=>text,listDirectory:async()=>{reads++;return {path:dir,items:[{name:'README.md',kind:'file'}]};}} as unknown as HostComputer;
  const harness=new Harness(store,{} as VmController,model,()=>{},undefined,undefined,undefined,host,interactions);await harness.run(bot.id,'熟悉一下这个项目');
  assert.equal(calls,2);assert.equal(reads,1);assert.equal(store.data.runs[0].status,'completed');assert.equal(store.data.runs[0].toolCalls,4);
  assert.ok(store.data.messages.some(message=>message.presentation==='progress'&&message.content===progress));assert.ok(store.data.messages.some(message=>message.presentation==='answer'&&message.content.startsWith('已了解项目结构')));
  assert.equal(store.data.messages.find(message=>message.role==='user')?.pins?.[0].emoji,'👀');
});

test('a later standalone reaction cannot end a task that already used a work tool',async t=>{
  const {store,bot}=fixture(t);let calls=0;
  const model={complete:async()=>{calls++;const target=store.data.messages.find(message=>message.role==='user')!;
    if(calls===1)return {content:'先读取文件。',calls:[{id:randomUUID(),type:'function',function:{name:'file_read',arguments:'{"path":"README.md"}'}}],finishReason:'tool_calls'};
    if(calls===2)return {content:'文件已读取，正在整理结论。',calls:[{id:randomUUID(),type:'function',function:{name:'chat_pin',arguments:JSON.stringify({messageId:target.id,emoji:'👀'})}}],finishReason:'tool_calls'};
    return {content:'已经读取 README，项目说明如下。',calls:[],finishReason:'stop'};
  }} as unknown as ModelClient;
  const harness=new Harness(store,{execute:async(_command:string,botId:string)=>({stdout:JSON.stringify({path:`/work/${botId}/README.md`,data:Buffer.from('项目说明').toString('base64')}),stderr:'',exitCode:0,durationMs:1})} as unknown as VmController,model,()=>{});await harness.run(bot.id,'阅读项目说明');
  assert.equal(calls,3);assert.equal(store.data.runs[0].status,'completed');assert.ok(store.data.messages.some(message=>message.presentation==='answer'&&message.content.startsWith('已经读取 README')));assert.ok(store.data.messages.some(message=>message.presentation==='progress'&&message.content==='文件已读取，正在整理结论。'));
});

test('a reaction after superseding an unfinished task still requires the task response',async t=>{
  const {store,bot}=fixture(t),previous={id:randomUUID(),botId:bot.id,status:'cancelled' as const,inputUpdated:true,startedAt:new Date().toISOString(),modelCalls:1,toolCalls:1};store.data.runs.push(previous);
  const target=store.message(bot.id,'user','检查文件并说明结果',{runId:previous.id});store.message(bot.id,'tool','文件已经读取',{runId:previous.id,tool:'file_read',status:'done'});let calls=0;
  const model={complete:async()=>++calls===1?{content:'按你的新要求整理已读取的内容。',calls:[{id:randomUUID(),type:'function',function:{name:'chat_pin',arguments:JSON.stringify({messageId:target.id,emoji:'👀'})}}],finishReason:'tool_calls'}:{content:'根据已经读取的文件，结果如下。',calls:[],finishReason:'stop'}} as unknown as ModelClient;
  await new Harness(store,{} as VmController,model,()=>{}).run(bot.id,'说明得简短一些',{supersedesRunId:previous.id});
  assert.equal(calls,2);assert.ok(store.data.messages.some(message=>message.presentation==='answer'&&message.content.startsWith('根据已经读取的文件')));
});


test('a user emoji on the Bot greeting can receive a visible Bot pin without any user text message',async t=>{
  const {store,bot,beforeCleanup}=fixture(t),target=store.message(bot.id,'assistant','你好，我是产品经理。',{status:'done'});let calls=0;
  const model={complete:async(messages:any[])=>{calls++;assert.ok(messages.filter(message=>message.role==='system').map(message=>message.content||'').join('\n').includes('与文字发言一样需要自然回应'));assert.ok(messages.filter(message=>message.role==='system').map(message=>message.content||'').join('\n').includes('"canPin":true'));return {content:'',calls:[{id:randomUUID(),type:'function',function:{name:'chat_pin',arguments:JSON.stringify({messageId:target.id,emoji:'❤️'})}}],finishReason:'tool_calls'};}} as unknown as ModelClient;
  const harness=new Harness(store,{} as VmController,model,()=>{}),queue=new ChatPinQueue(store,{isRunning:id=>harness.isRunning(id),run:(...args)=>harness.run(...args)},()=>{});beforeCleanup(async()=>{queue.dispose();await wait(()=>!(queue as any).workers.size);});
  queue.pin({botId:bot.id,messageId:target.id,emoji:'👍'});await wait(()=>calls===1&&!harness.busy);
  assert.deepEqual(target.pins?.map(pin=>[pin.actor.id,pin.emoji]),[['user','👍'],[bot.id,'❤️']]);assert.equal(store.data.runs.at(-1)?.status,'completed');
  assert.ok(!store.data.messages.some(message=>message.role==='user'&&!message.reaction));assert.equal(store.data.messages.filter(message=>message.role==='assistant'&&message.content).length,1);
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(calls,1,'Bot pins must not trigger an echo loop');
  const run={id:randomUUID(),botId:bot.id,status:'running' as const,startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0};store.data.runs.push(run);
  assert.throws(()=>pinChat(store,bot.id,{kind:'bot',id:bot.id,name:bot.name},{messageId:target.id,emoji:'👀'},run.id),/当前用户表态/);
});

test('new emoji utterances cannot silently complete; a stale silence choice is corrected into a real reply',async t=>{
  const {store,bot}=fixture(t),target=store.message(bot.id,'assistant','你好，我是产品经理。',{status:'done'});let calls=0;
  const model={complete:async(messages:any[])=>{calls++;if(calls===1)return {content:'[表情静默]',calls:[],finishReason:'stop'};assert.ok(messages.some(message=>message.role==='system'&&message.content?.includes('需要得到回应')));return {content:'是这段介绍不合你的期待吗？你希望我怎么调整？',calls:[],finishReason:'stop'};}} as unknown as ModelClient;
  const event=pinChat(store,bot.id,{kind:'user',id:'user',name:'你'},{messageId:target.id,emoji:'👎'}),harness=new Harness(store,{} as VmController,model,()=>{});
  await harness.run(bot.id,'用户新增 👎 表态',{reactionMessageId:event.eventId});
  assert.equal(calls,2);assert.equal(store.data.runs.at(-1)?.status,'completed');assert.ok(store.data.messages.some(m=>m.role==='assistant'&&m.content.includes('怎么调整')));assert.ok(!JSON.stringify(store.data.conversations[bot.id]).includes('[表情静默]'));
});

test('an already present Bot pin cannot masquerade as a new response',async t=>{
  const {store,bot}=fixture(t),target=store.message(bot.id,'assistant','方案已整理。',{status:'done'});target.pins=[{emoji:'👍',actor:{id:bot.id,name:bot.name,kind:'bot'},time:new Date().toISOString()}];let calls=0;
  const model={complete:async(_messages:any[],tools:any[])=>{calls++;if(calls===1)return {content:'',calls:[{id:randomUUID(),type:'function',function:{name:'chat_pin',arguments:JSON.stringify({messageId:target.id,emoji:'👍'})}}],finishReason:'tool_calls'};assert.ok(!tools.some(tool=>tool.function.name==='chat_pin'));return {content:'你想再看看哪一部分？',calls:[],finishReason:'stop'};}} as unknown as ModelClient;
  const event=pinChat(store,bot.id,{kind:'user',id:'user',name:'你'},{messageId:target.id,emoji:'👀'}),harness=new Harness(store,{} as VmController,model,()=>{});
  await harness.run(bot.id,'用户新增 👀 表态',{reactionMessageId:event.eventId});
  assert.equal(calls,2);assert.equal(target.pins.length,2);assert.ok(store.data.messages.some(m=>m.content==='你想再看看哪一部分？'));
});

test('persistent silence surfaces a failure instead of a successful empty response',async t=>{
  const {store,bot}=fixture(t),target=store.message(bot.id,'assistant','你好',{status:'done'});let calls=0;
  const model={complete:async()=>{calls++;return {content:'[表情静默]',calls:[],finishReason:'stop'};}} as unknown as ModelClient;
  const event=pinChat(store,bot.id,{kind:'user',id:'user',name:'你'},{messageId:target.id,emoji:'😂'}),harness=new Harness(store,{} as VmController,model,()=>{});
  await harness.run(bot.id,'用户新增 😂 表态',{reactionMessageId:event.eventId});
  assert.equal(calls,2);assert.equal(store.data.runs.at(-1)?.status,'failed');assert.ok(store.data.messages.some(m=>m.status==='failed'&&m.content.includes('没有回应这次表态')));
});
