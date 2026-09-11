import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {createServer} from 'node:http';
import {Store} from '../electron/core/store';
import {ModelClient,type Completion} from '../electron/core/model';
import {BotGreetings} from '../electron/core/bot-greetings';

const answer=(content:string):Completion=>({content,calls:[],finishReason:'stop'});
function fixture(t:test.TestContext,complete:ModelClient['complete'],configured=true,isRunning=()=>false){
  const dir=mkdtempSync(join(tmpdir(),'aelion-greeting-test-')),store=new Store(dir);
  if(configured)store.data.model.model='selected-model';
  const changes:string[][]=[];
  const greetings=new BotGreetings(store,{complete},()=>changes.push(greetings.botIds),isRunning);
  t.after(()=>{greetings.dispose();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('aelion-greeting-test-'));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,greetings,bot:store.data.bots[0],changes};
}
function deferred(){let resolve!:(value:Completion)=>void;const promise=new Promise<Completion>(done=>resolve=done);return{promise,resolve};}

test('greetings impose no reply language despite legacy stored preferences',async t=>{
  const f=fixture(t,async messages=>{const prompt=messages[0].content!;assert.doesNotMatch(prompt,/Response language policy|interface language/);assert.doesNotMatch(prompt,/用自然的中文/);return answer('Hello!');});f.store.data.language='en';await f.greetings.greet(f.bot.id);assert.equal(f.store.data.messages[0].content,'Hello!');
});

test('changing interface language does not discard a pending greeting',async t=>{
  const pending=deferred(),f=fixture(t,async()=>pending.promise);f.store.data.language='zh-CN';const work=f.greetings.greet(f.bot.id);f.store.data.language='en';pending.resolve(answer('Hello!'));await work;assert.equal(f.store.data.messages[0].content,'Hello!');
});

test('creating a Bot persists its data without inventing an assistant message',t=>{
  const f=fixture(t,async()=>answer('unused'),false),bot=f.store.createBot('代码达人','编写代码与测试');
  const reopened=new Store(f.dir);
  assert.equal(reopened.bot(bot.id).role,'编写代码与测试');
  assert.equal(reopened.data.messages.length,0);
  assert.deepEqual(reopened.data.conversations[bot.id],[]);
});

test('greeting usage has its own purpose and retains native reasoning for later requests',async t=>{
 const native={protocol:'chat' as const,key:'provider:model',data:{reasoning_content:'opaque reasoning'}};
 const f=fixture(t,async(_messages,_tools,_signal,_onText,options)=>{assert.equal(options?.purpose,'greeting');return {...answer('你好。'),native};});
 await f.greetings.greet(f.bot.id);assert.deepEqual(f.store.data.conversations[f.bot.id][0].native,native);assert.equal(f.store.data.messages[0].content,'你好。');assert.ok(!f.store.data.messages[0].content.includes('opaque'));
});

test('the configured ModelClient generates the first message from Bot identity without tools or a VM',async t=>{
  let requests=0,body:any;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw);requests++;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const content of ['我是代码达人，','把你想实现的功能告诉我吧。'])res.write(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\n`);
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  t.after(()=>new Promise<void>((ok,fail)=>server.close(error=>error?fail(error):ok())));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const client=new ModelClient(()=>({baseUrl:`http://127.0.0.1:${address.port}/v1`,model:'selected-model',hasKey:false,contextTokens:32000}),()=> '');
  const f=fixture(t,client.complete.bind(client));f.bot.name='代码达人';f.bot.role='编写代码与测试';
  await f.greetings.greet(f.bot.id);
  assert.equal(requests,1);assert.equal(body.model,'selected-model');assert.equal(body.tools,undefined);
  assert.deepEqual(JSON.parse(body.messages[1].content),{name:'代码达人',role:'编写代码与测试'});
  assert.equal(f.store.data.messages[0].content,'我是代码达人，把你想实现的功能告诉我吧。');
  assert.equal(f.store.data.messages[0].role,'assistant');
  assert.deepEqual(f.store.data.conversations[f.bot.id].map(({role,content})=>({role,content})),[{role:'assistant',content:f.store.data.messages[0].content}]);
  assert.equal(f.store.data.runs.length,0);assert.deepEqual(f.greetings.botIds,[]);
  assert.equal(new Store(f.dir).data.messages[0].content,f.store.data.messages[0].content);
});

test('an unconfigured Bot waits for model setup and repeated requests generate only one greeting',async t=>{
  let calls=0;const pending=deferred();
  const f=fixture(t,async()=>{calls++;return pending.promise;},false);
  await f.greetings.greetEmpty();assert.equal(calls,0);assert.equal(f.store.data.messages.length,0);
  f.store.data.model.model='configured';const first=f.greetings.greetEmpty(),second=f.greetings.greet(f.bot.id);
  assert.equal(calls,1);assert.deepEqual(f.greetings.botIds,[f.bot.id]);
  pending.resolve(answer('你想从哪件事开始？'));await Promise.all([first,second]);
  await f.greetings.greetEmpty();assert.equal(calls,1);assert.equal(f.store.data.messages.length,1);
});

test('existing conversations and historical welcome messages are left alone',async t=>{
  let calls=0;const f=fixture(t,async()=>{calls++;return answer('new');});
  f.store.message(f.bot.id,'assistant','以前保存的欢迎消息');
  const other=f.store.createBot('已开始的 Bot','工作');f.store.data.conversations[other.id].push({role:'user',content:'已有请求'});
  await f.greetings.greetEmpty();assert.equal(calls,0);assert.equal(f.store.data.messages[0].content,'以前保存的欢迎消息');
});

test('a user message supersedes a pending greeting without injecting a late reply',async t=>{
  const pending=deferred();const f=fixture(t,async()=>pending.promise);
  const greeting=f.greetings.greet(f.bot.id);
  f.greetings.cancel(f.bot.id);f.store.message(f.bot.id,'user','先帮我看代码');
  pending.resolve(answer('late welcome'));await greeting;
  assert.equal(f.store.data.messages.length,1);assert.equal(f.store.data.messages[0].role,'user');assert.deepEqual(f.greetings.botIds,[]);
});

test('deleted, renamed, or newly busy Bots never receive a stale greeting',async t=>{
  for(const change of ['delete','rename','busy'] as const){
    await t.test(change,async t=>{
      const pending=deferred();let busy=false;const f=fixture(t,async()=>pending.promise,true,()=>busy);
      const greeting=f.greetings.greet(f.bot.id);
      if(change==='delete')f.store.deleteBot(f.bot.id);else if(change==='rename')f.bot.name='新名字';else busy=true;
      pending.resolve(answer('stale welcome'));await greeting;
      assert.equal(f.store.data.messages.length,0);
    });
  }
});

test('a cancelled attempt cannot clear or replace a newer model request',async t=>{
  const old=deferred(),current=deferred();let calls=0;const signals:AbortSignal[]=[];
  const f=fixture(t,async(_messages,_tools,signal)=>{signals.push(signal);return ++calls===1?old.promise:current.promise;});
  const first=f.greetings.greet(f.bot.id);f.greetings.cancelAll();const second=f.greetings.greet(f.bot.id);
  assert.equal(signals[0].aborted,true);old.resolve(answer('old model'));await first;
  assert.deepEqual(f.greetings.botIds,[f.bot.id]);assert.equal(f.store.data.messages.length,0);
  current.resolve(answer('current model'));await second;
  assert.equal(f.store.data.messages[0].content,'current model');assert.deepEqual(f.greetings.botIds,[]);
});

test('model failures stay system errors and a later attempt can return a real greeting',async t=>{
  let calls=0;const f=fixture(t,async()=>{if(++calls===1)throw new Error('service unavailable');return answer('模型生成的开场白');});
  await f.greetings.greet(f.bot.id);assert.equal(f.store.data.messages[0].role,'event');assert.match(f.store.data.messages[0].content,/service unavailable/);
  assert.deepEqual(f.store.data.conversations[f.bot.id],[]);
  await f.greetings.greet(f.bot.id);assert.equal(f.store.data.messages[1].content,'模型生成的开场白');
});

test('empty output or attempted tool calls are never substituted with a canned greeting',async t=>{
  let calls=0;const f=fixture(t,async()=>++calls===1?answer('  '):{...answer('will run a tool'),calls:[{id:'call',type:'function',function:{name:'shell',arguments:'{}'}}]});
  await f.greetings.greet(f.bot.id);await f.greetings.greet(f.bot.id);
  assert.equal(f.store.data.messages.filter(message=>message.role==='assistant').length,0);
  assert.deepEqual(f.store.data.conversations[f.bot.id],[]);
});

test('shutdown aborts pending generation and prevents later writes or new calls',async t=>{
  const pending=deferred();let calls=0;const f=fixture(t,async()=>{calls++;return pending.promise;});
  const greeting=f.greetings.greet(f.bot.id);f.greetings.dispose();pending.resolve(answer('late'));
  await greeting;await f.greetings.greetEmpty();assert.equal(calls,1);assert.equal(f.store.data.messages.length,0);
});
