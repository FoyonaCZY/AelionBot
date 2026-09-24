import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LayaShadow} from '../electron/core/laya-shadow';
import {Store} from '../electron/core/store';
import {GroupChats} from '../electron/core/group-chats';

async function ready(shadow:LayaShadow){
 shadow.warmup();
 for(let i=0;i<100&&!shadow.isReady;i++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(shadow.isReady,true);
}

test('cold start and excess requests fall back; a stuck worker is stopped',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-laya-budget-')),script=join(dir,'fake.py');
 writeFileSync(script,'import json,sys,time\ntime.sleep(0.3)\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n time.sleep(30)\n');
 const previous={runtime:process.env.AELION_LAYA_RUNTIME,python:process.env.AELION_LAYA_PYTHON};
 process.env.AELION_LAYA_RUNTIME='mlx';process.env.AELION_LAYA_PYTHON='python3';
 const shadow=new LayaShadow(dir,script);
 try{
  assert.equal(shadow.isReady,false);
  assert.equal(await shadow.group('cold','bot',{}),undefined);
  assert.equal(shadow.isReady,false);
  await ready(shadow);
  const pending=[1,2,3].map(id=>shadow.group(String(id),'bot',{}));
  assert.equal(await shadow.group('excess','bot',{}),undefined);
  assert.equal(shadow.enabled,true);
  assert.deepEqual(await Promise.all(pending),[undefined,undefined,undefined]);
  assert.equal(shadow.enabled,false);
  assert.equal(shadow.isReady,false);
 }finally{
  shadow.dispose();
  if(previous.runtime===undefined)delete process.env.AELION_LAYA_RUNTIME;else process.env.AELION_LAYA_RUNTIME=previous.runtime;
  if(previous.python===undefined)delete process.env.AELION_LAYA_PYTHON;else process.env.AELION_LAYA_PYTHON=previous.python;
  rmSync(dir,{recursive:true,force:true});
 }
});

test('local Laya records a two-way group decision',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-laya-'));
 const script=join(dir,'fake.py');
 writeFileSync(script,'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":"participate","confidence":0.73,"probabilities":{"observe":0.3,"participate":0.7}}}}}),flush=True)\n');
 const previous={runtime:process.env.AELION_LAYA_RUNTIME,python:process.env.AELION_LAYA_PYTHON};
 process.env.AELION_LAYA_RUNTIME='mlx';process.env.AELION_LAYA_PYTHON='python3';
 const shadow=new LayaShadow(dir,script);
 try{
  await ready(shadow);
  assert.equal(await shadow.group('delivery-1','bot-1',{message:'PRIVATE_GROUP_CONTENT'}),'participate');
  const line=readFileSync(join(dir,'laya-decisions.jsonl'),'utf8');
  const result=JSON.parse(line);
  assert.equal(result.scope,'group');assert.equal(result.choice,'participate');assert.equal(result.confidence,0.73);
  assert.equal(result.probabilities.participate,0.7);assert.equal(result.criteria.participate,'这个 Bot 可以回应当前问题、补充有用信息，或开展及继续用户授权的工作');
  assert.deepEqual(result.features,{events:0,recent:0,mentioned:false,ownTask:false});
  assert.equal(typeof result.elapsedMs,'number');
  assert(line.includes('PRIVATE_GROUP_CONTENT'));
  assert.equal(await shadow.group('delivery-2','bot-1',{message:'不要执行，请安静处理'},true),'observe');
  const adjusted=shadow.groupDecisions(new Set(['delivery-2']))[0];
  assert.equal(adjusted.choice,'participate');assert.equal(adjusted.appliedChoice,'observe');
  assert.equal(adjusted.adjustment,'用户明确要求本轮静默');
 }finally{
  shadow.dispose();
  if(previous.runtime===undefined)delete process.env.AELION_LAYA_RUNTIME;else process.env.AELION_LAYA_RUNTIME=previous.runtime;
  if(previous.python===undefined)delete process.env.AELION_LAYA_PYTHON;else process.env.AELION_LAYA_PYTHON=previous.python;
  rmSync(dir,{recursive:true,force:true});
 }
});

test('stopping a group decision releases its slot and ignores the late answer',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-laya-abort-')),script=join(dir,'fake.py');
 writeFileSync(script,'import json,sys,time\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n time.sleep(0.2)\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":"participate"}}}}),flush=True)\n');
 const shadow=new LayaShadow(dir,script,()=>{},{runtime:'mlx',python:'python3'});
 try{
  await ready(shadow);
  const controller=new AbortController();
  const prediction=shadow.group('stopped','bot',{},false,controller.signal);
  controller.abort();
  assert.equal(await prediction,undefined);
  assert.equal(await shadow.group('after-stop','bot',{}),'participate');
  assert.deepEqual(shadow.groupDecisions(new Set(['stopped'])),[]);
 }finally{shadow.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('group broadcast sends each Bot a separate shadow decision',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-laya-group-'));
 const script=join(dir,'fake.py');
 writeFileSync(script,'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":"observe"}}}}),flush=True)\n');
 const previous={runtime:process.env.AELION_LAYA_RUNTIME,python:process.env.AELION_LAYA_PYTHON};
 process.env.AELION_LAYA_RUNTIME='mlx';process.env.AELION_LAYA_PYTHON='python3';
 const store=new Store(dir),first=store.data.bots[0],second=store.createBot('第二个 Bot','');
 const shadow=new LayaShadow(dir,script);
 let runs=0;
 const groups=new GroupChats(store,{isRunning:()=>false,run:async()=>{runs++;},cancel:()=>{}},()=>{},undefined,undefined,shadow);
 try{
  await ready(shadow);
  const group=groups.create({name:'测试群',botIds:[first.id,second.id]});
  groups.send({id:group.id,message:'请看这条群消息'});groups.start();
  let events:Record<string,string>[]=[];
  for(let attempt=0;attempt<50;attempt++){
   try{events=readFileSync(join(dir,'laya-decisions.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{}
   if(events.length>=2)break;
   await new Promise(resolve=>setTimeout(resolve,40));
  }
  assert.deepEqual(new Set(events.map(event=>event.actorId)),new Set([first.id,second.id]));
  assert(events.every(event=>event.scope==='group'&&event.choice==='observe'));
  assert.equal(runs,0);
  const page=groups.read({id:group.id});
  assert.equal(page.laya?.decisions.length,2);
  assert(page.laya?.decisions.every(decision=>page.messages.some(message=>message.id===decision.messageId)));
  const sourceId=page.laya!.decisions[0].sourceId,sourceDelivery=store.data.groupDeliveries.find(item=>item.id===sourceId)!;
  const originalMessage=store.data.groups[0].messages.find(message=>message.id===sourceDelivery.messageId)!;
  const laterMessage={...originalMessage,id:randomUUID(),seq:originalMessage.seq+1,sender:{kind:'bot' as const,id:first.id,name:first.name,color:first.color},content:'Bot 后续发言'};
  store.data.groups[0].messages.push(laterMessage);
  store.data.groupDeliveries.push({...sourceDelivery,id:randomUUID(),layaDecisionId:sourceId});
  sourceDelivery.messageId=laterMessage.id;
  const earlierPage=groups.read({id:group.id,before:laterMessage.id});
  assert(earlierPage.laya?.decisions.some(decision=>decision.sourceId===sourceId),'用户消息关联的 Bot 决策应在触发消息位于下一页时仍可读取');
 }finally{
  groups.dispose();shadow.dispose();store.close();
  if(previous.runtime===undefined)delete process.env.AELION_LAYA_RUNTIME;else process.env.AELION_LAYA_RUNTIME=previous.runtime;
  if(previous.python===undefined)delete process.env.AELION_LAYA_PYTHON;else process.env.AELION_LAYA_PYTHON=previous.python;
  rmSync(dir,{recursive:true,force:true});
 }
});

test('Laya participation reaches each Bot for questions and work',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-laya-route-')),script=join(dir,'fake.py');
 writeFileSync(script,'import json,sys\nprint(json.dumps({"ready":True}),flush=True)\nfor line in sys.stdin:\n request=json.loads(line)\n event=request["state"]["events"][-1]\n choice="participate" if event["from"]["kind"]=="user" else "observe"\n print(json.dumps({"id":request["id"],"result":{"answers":{"decision":{"choice":choice,"probabilities":{"observe":0.1,"participate":0.9}}}}}),flush=True)\n');
 const previous={runtime:process.env.AELION_LAYA_RUNTIME,python:process.env.AELION_LAYA_PYTHON};
 process.env.AELION_LAYA_RUNTIME='mlx';process.env.AELION_LAYA_PYTHON='python3';
 const store=new Store(dir),first=store.data.bots[0],second=store.createBot('第二个 Bot','');
 const shadow=new LayaShadow(dir,script);
 const calls:Array<{botId:string;choice:string}>=[];
 const groups=new GroupChats(store,{isRunning:()=>false,run:async(botId,input,options)=>{
   calls.push({botId,choice:(JSON.parse(input) as {layaDecision:{choice:string}}).layaDecision.choice});
   const id=randomUUID();store.data.runs.push({id,botId,status:'completed',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0,groupOrigin:options.groupOrigin});options.onStarted?.(id);
  },cancel:()=>{}},()=>{},undefined,undefined,shadow);
 try{
  await ready(shadow);
  const room=groups.create({name:'路由测试',botIds:[first.id,second.id]});groups.start();
  const wait=async()=>{for(let i=0;i<100;i++){if(!groups.busy&&!store.data.groupDeliveries.some(item=>['queued','deciding','running'].includes(item.status)))return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('路由测试超时');};
  await wait();
  groups.send({id:room.id,message:'请回复这条消息。'});await wait();
  assert.equal(calls.filter(item=>item.choice==='participate').length,2);
  groups.send({id:room.id,message:'请执行本轮测试任务。'});await wait();
  assert.equal(calls.filter(item=>item.choice==='participate').length,4);
  assert.deepEqual(new Set(calls.map(item=>item.botId)),new Set([first.id,second.id]));
 }finally{
  groups.dispose();shadow.dispose();store.close();
  if(previous.runtime===undefined)delete process.env.AELION_LAYA_RUNTIME;else process.env.AELION_LAYA_RUNTIME=previous.runtime;
  if(previous.python===undefined)delete process.env.AELION_LAYA_PYTHON;else process.env.AELION_LAYA_PYTHON=previous.python;
  rmSync(dir,{recursive:true,force:true});
 }
});
