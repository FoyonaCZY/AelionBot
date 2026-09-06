import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import type {RunRecord} from '../src/shared';
import {isGroupWorkTool} from '../src/group-types';

function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'aelion-group-visibility-')),store=new Store(dir),bot=store.data.bots[0],groupId=randomUUID(),rootId=randomUUID(),time=new Date().toISOString();
  store.data.groups.push({id:groupId,name:'大家庭',members:[{id:bot.id,name:bot.name,color:bot.color,joinedAt:time}],createdBy:{kind:'user',id:'user',name:'你'},createdAt:time,updatedAt:time,messages:[{id:randomUUID(),seq:1,groupId,sender:{kind:'user',id:'user',name:'你'},kind:'message',content:'这是什么',time,rootId}],lastReadSeq:0});
  store.data.groupRounds.push({id:rootId,groupId,request:'这是什么',status:'stopped',createdAt:time,botMessages:0,botCounts:{},decisions:0,createdGroups:0});
  function add(tool?:string,updated=false,root=rootId){
    const run:RunRecord={id:randomUUID(),botId:bot.id,groupOrigin:{groupId,rootId:root,deliveryId:randomUUID()},groupTask:true,groupUpdated:updated||undefined,status:updated?'cancelled':'completed',startedAt:time,endedAt:time,toolCalls:tool?1:0,modelCalls:1};store.data.runs.push(run);
    store.message(bot.id,'event','这是什么',{runId:run.id,groupTaskSource:{groupId,name:'大家庭',continuation:store.data.runs.length>1}});
    if(tool)store.message(bot.id,'tool','必须完整保留的原始工具输出',{runId:run.id,tool,status:'done'});
    store.message(bot.id,'assistant',updated?'':'原始回答',{runId:run.id,status:updated?'cancelled':'done',presentation:updated?'progress':'answer'});return run;
  }
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});return {dir,store,bot,groupId,rootId,add};
}
const records=(store:Store)=>[...store.data.messages,...store.data.groupRunMessages].map(({id,content,role,tool,status})=>({id,content,role,tool,status})).sort((a,b)=>a.id.localeCompare(b.id));

test('reading an attachment or expanding its result is conversational; saving or producing work still promotes a task',()=>{
  assert.equal(isGroupWorkTool('attachment_read'),false);assert.equal(isGroupWorkTool('read_result'),false);
  for(const name of ['attachment_save','message_attach','computer_execute','python_execute','host_execute','file_write'])assert.equal(isGroupWorkTool(name),true);
});

test('legacy read-only tasks and all their empty continuations leave the main chat without losing records',t=>{
  const f=fixture(t),first=f.add('attachment_read',true),second=f.add('read_result',true),third=f.add(undefined,true),fourth=f.add();
  const legitimate=f.add('computer_execute',false,randomUUID());f.store.message(f.bot.id,'user','保留我的单聊消息');f.store.save();const before=records(f.store),group=JSON.stringify(f.store.data.groups);
  const restored=new Store(f.dir),hidden=new Set([first.id,second.id,third.id,fourth.id]);
  assert.ok(!restored.data.messages.some(message=>message.runId&&hidden.has(message.runId)));assert.ok(restored.data.runs.filter(run=>hidden.has(run.id)).every(run=>!run.groupTask));
  assert.equal(restored.data.messages.filter(message=>message.groupTaskSource).length,1);assert.ok(restored.data.messages.some(message=>message.runId===legitimate.id&&message.tool==='computer_execute'));assert.ok(restored.data.messages.some(message=>message.content==='保留我的单聊消息'));
  assert.deepEqual(records(restored),before);assert.equal(JSON.stringify(restored.data.groups),group);const backup=join(f.dir,'group-task-visibility-backup.json');assert.ok(existsSync(backup));const backupText=readFileSync(backup,'utf8');
  const once=JSON.stringify(restored.data),again=new Store(f.dir);assert.equal(JSON.stringify(again.data),once);assert.equal(readFileSync(backup,'utf8'),backupText);
});

test('actual work following read-only discussion remains visible and starts a fresh work continuation chain',t=>{
  const f=fixture(t),reader=f.add('attachment_read',true),writer=f.add('file_write',true),follow=f.add();f.store.save();
  const restored=new Store(f.dir);assert.ok(!restored.data.messages.some(message=>message.runId===reader.id));
  const sources=restored.data.messages.filter(message=>message.groupTaskSource);assert.equal(sources.length,2);assert.equal(sources.find(message=>message.runId===writer.id)?.groupTaskSource?.continuation,false);assert.equal(sources.find(message=>message.runId===follow.id)?.groupTaskSource?.continuation,true);
  assert.ok(restored.data.runs.find(run=>run.id===writer.id)?.groupTask);assert.ok(restored.data.runs.find(run=>run.id===follow.id)?.groupTask);
});

test('a preserved source marker is reused when the same record later contains actual work',t=>{
  const f=fixture(t),reader=f.add('attachment_read');f.store.save();const marker=f.store.data.messages.find(message=>message.groupTaskSource)!.id;
  const restored=new Store(f.dir);restored.message(f.bot.id,'tool','实际写入记录',{runId:reader.id,tool:'file_write',status:'done'});
  const repaired=new Store(f.dir);assert.equal(repaired.data.messages.filter(message=>message.runId===reader.id&&message.groupTaskSource).length,1);assert.equal(repaired.data.messages.find(message=>message.runId===reader.id&&message.groupTaskSource)!.id,marker);
});
