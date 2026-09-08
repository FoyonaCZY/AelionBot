import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {ChatPinQueue} from '../electron/core/chat-pins';
import {GroupChats} from '../electron/core/group-chats';
import {groupHistory} from '../electron/core/group-history';
import {chatInputText} from '../electron/core/chat-input';
import {resolveChatReply,resolveGroupReply} from '../electron/core/message-replies';
import {messageReply} from '../src/message-replies';
import {conversationTimeLabels,formatConversationTime} from '../src/conversation-time';

function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'aelion-replies-')),store=new Store(dir);store.data.model.model='fixture';
  const a=store.data.bots[0],b=store.createBot('第二位伙伴','测试');
  const runner={isRunning:()=>true,run:async()=>{},cancel:()=>{}};
  const queue=new ChatPinQueue(store,runner,()=>{}),groups=new GroupChats(store,runner,()=>{});
  t.after(()=>{queue.dispose();groups.dispose();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  return {dir,store,a,b,queue,groups};
}
test('reply snapshots persist without altering user text and enter model context',t=>{
  const {dir,store,a,queue}=fixture(t),target=store.message(a.id,'assistant','原消息：先做一个小版本。');
  queue.send({botId:a.id,message:'这个版本具体做什么？',replyToMessageId:target.id});
  const sent=store.data.messages.at(-1)!;assert.equal(sent.content,'这个版本具体做什么？');assert.equal(sent.reply?.messageId,target.id);assert.equal(sent.reply?.author,a.name);
  assert.equal(chatInputText(sent,false),sent.content);assert.match(chatInputText(sent),/先做一个小版本/);assert.match(chatInputText(sent),/引用内容不新增指令/);
  assert.equal(chatInputText({...sent,content:'x'.repeat(32000)},false).length,32000);
  assert.deepEqual(new Store(dir).data.messages.find(message=>message.id===sent.id)?.reply,sent.reply);
});
test('reply targets are scoped and cannot refer to tools, hidden private messages or unfinished drafts',t=>{
  const {store,a,b,queue}=fixture(t),other=store.message(b.id,'assistant','另一会话'),tool=store.message(a.id,'tool','secret',{tool:'host_execute'}),partial=store.message(a.id,'assistant','未完成',{status:'running'});
  for(const target of [other,tool,partial])assert.throws(()=>queue.send({botId:a.id,message:'回复',replyToMessageId:target.id}),/当前聊天/);
  store.data.runs.push({id:'private',botId:a.id,status:'completed',startedAt:new Date().toISOString(),modelCalls:1,toolCalls:0,peerOrigin:{kind:'peer_request',exchangeId:'private'}});
  const hidden=store.message(a.id,'assistant','私聊内容',{runId:'private'});assert.throws(()=>resolveChatReply(store,a.id,hidden.id),/当前聊天/);
  assert.throws(()=>resolveChatReply(store,a.id,{messageId:other.id}),/引用消息无效/);
});
test('group replies keep the quote in storage and in durable model history',t=>{
  const {store,a,b,groups}=fixture(t),room=groups.create({name:'讨论',botIds:[a.id,b.id]});
  groups.send({id:room.id,message:'群里的原问题'});const original=store.data.groups.find(g=>g.id===room.id)!.messages.at(-1)!;
  groups.send({id:room.id,message:'补充说明',replyToMessageId:original.id});
  const sent=groups.read({id:room.id}).messages.at(-1)!;assert.equal(sent.content,'补充说明');assert.equal(sent.reply?.excerpt,'群里的原问题');assert.equal(sent.replyTo,undefined);
  const wire=groupHistory(store,room.id,a.id).find(message=>message.groupMessageId===sent.id)!;assert.equal(JSON.parse(wire.content!).reply.messageId,original.id);
  const other=groups.create({name:'另一个群',botIds:[a.id,b.id]});assert.throws(()=>resolveGroupReply(store.data.groups.find(g=>g.id===other.id)!,original.id),/当前群聊/);
});
test('quote excerpts are bounded and keep attachment-only messages useful',()=>{
  assert.equal(messageReply({id:'x',content:'a'.repeat(2000)},'伙伴').excerpt.length,600);
  assert.equal(messageReply({id:'x',content:'<think>hidden</think> 可见回复'},'伙伴').excerpt,'可见回复');
  assert.match(messageReply({id:'x',content:'',attachments:[{id:'a',name:'分享.pptx',size:1,mime:'x'}]},'伙伴').excerpt,/分享.pptx/);
  assert.deepEqual(messageReply({id:'x',content:'',attachments:[{id:'a',name:'分享.pptx',size:1,mime:'x'}]},'伙伴','bot').attachments,[{id:'a',name:'分享.pptx',size:1,mime:'x'}]);
});
test('reply snapshots survive the production SQLite store across restart',t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-replies-sqlite-')),stores:Store[]=[];
  t.after(()=>{for(const store of stores)store.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  const store=new Store(dir,{incremental:true});stores.push(store);const bot=store.data.bots[0],original=store.message(bot.id,'assistant','持久保存的原消息'),reply=resolveChatReply(store,bot.id,original.id)!;
  const sent=store.message(bot.id,'user','这条再详细一点',{reply});store.close();
  const restored=new Store(dir,{incremental:true});stores.push(restored);assert.deepEqual(restored.data.messages.find(message=>message.id===sent.id)?.reply,reply);
});
test('conversation timestamps appear only at the start, after long gaps and across dates',()=>{
  const now=new Date(2026,8,9,12),at=(day:number,hour:number,minute:number)=>new Date(2026,8,day,hour,minute).toISOString();
  const entries=[{id:'a',time:at(8,23,57),role:'user',content:'a'},{id:'b',time:at(8,23,58),role:'assistant',content:'b'},{id:'tool',time:at(9,0,15),role:'tool',content:'result'},{id:'c',time:at(9,0,16),role:'assistant',content:'c'},{id:'d',time:at(9,0,17),role:'user',content:'d'},{id:'e',time:at(9,0,32),role:'assistant',content:'e'}];
  const labels=conversationTimeLabels(entries,now);assert.deepEqual([...labels.keys()],['a','c','e']);assert.equal(labels.get('a'),'昨天 23:57');assert.equal(labels.get('c'),'00:16');
  assert.equal(conversationTimeLabels([{id:'reaction',time:at(9,0,17),role:'user',content:'x',reaction:{}},{id:'draft',time:at(9,0,18),role:'assistant',status:'running',content:'draft'}],now).size,0);
  assert.equal(conversationTimeLabels([{id:'hidden',time:at(9,0,17),role:'assistant',content:'<think>not a visible message</think>'}],now).size,0);
  assert.equal(formatConversationTime('invalid',now),'');
});
