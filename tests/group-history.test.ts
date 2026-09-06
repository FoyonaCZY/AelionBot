import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../electron/core/store';
import {groupHistory,groupContextKey,prepareGroupContext} from '../electron/core/group-history';
import {contextBudget,estimateRequest} from '../electron/core/context-budget';
import {imageContext,type ModelClient} from '../electron/core/model';
import type {GroupRoom} from '../src/group-types';
import type {WireMessage} from '../src/shared';

function fixture(t:test.TestContext){
  const dir=mkdtempSync(join(tmpdir(),'aelion-group-context-')),store=new Store(dir),bot=store.data.bots[0];
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  const room:GroupRoom={id:randomUUID(),name:'群历史',members:[{...bot,joinedAt:new Date().toISOString()}],createdBy:{kind:'user',id:'user',name:'你'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[],lastReadSeq:0};
  store.data.groups.push(room);return {dir,store,bot,room,key:groupContextKey(room.id,bot.id)};
}
const summary=JSON.stringify({goal:'完成报告',constraints:['保留用户最新要求'],done:['文件已生成：/work/proof.csv；消息 source-1 中的用户表态为 👍'],pending:['核对结果'],decisions:[],failures:[],next:['回查原始群消息']});
function longHistory():WireMessage[]{return Array.from({length:75},(_,i)=>({role:i%3?'assistant':'user',groupMessageId:`source-${i}`,content:`消息 ${i}，${'讨论数据口径、来源、计算过程和文件验证。'.repeat(55)}`}));}

test('legacy group context drops unsent text, archives it, and preserves tool evidence and published message identities',t=>{
  const {dir,store,bot,room,key}=fixture(t),id=randomUUID();
  room.messages.push({id,seq:1,groupId:room.id,kind:'message',sender:{kind:'user',id:'user',name:'你'},content:'真正发出的消息',time:new Date().toISOString()});
  store.data.groupContexts[key]=[{role:'user',content:'旧的重复事件'},{role:'assistant',content:'我已经打过招呼了，但实际没有发出去'},{role:'assistant',content:'未发送的工具过程草稿',tool_calls:[{id:'call-1',type:'function',function:{name:'file_write',arguments:'{}'}}]},{role:'tool',tool_call_id:'call-1',content:'{"saved":true,"path":"/work/proof.csv"}'}];
  store.data.summaries[key]='旧摘要包含未发出的问候';store.data.contextOffsets[key]=2;
  const history=groupHistory(store,room.id,bot.id),text=JSON.stringify(history);
  assert.ok(!text.includes('草稿')&&!text.includes('没有发出去')&&!text.includes('重复事件'));assert.ok(text.includes('/work/proof.csv'));
  assert.equal(history[0].content,null);assert.equal(history[1].tool_call_id,'call-1');assert.equal(history.at(-1)?.groupMessageId,id);
  assert.equal(groupHistory(store,room.id,bot.id).length,3);assert.equal(store.data.contextOffsets[key],0);assert.equal(store.data.summaries[key],undefined);
  const backup=join(dir,'group-context-backups',`${room.id}-${bot.id}.json`);assert.ok(existsSync(backup));assert.ok(readFileSync(backup,'utf8').includes('实际没有发出去'));
  const wire=imageContext(history,()=>{throw new Error('no images');});assert.ok(wire.every(message=>!('groupMessageId' in message)));
});

test('long group histories compact within the input budget including tool schemas, retain originals and persist independently',async t=>{
  const {store,dir,key}=fixture(t);store.data.model.contextTokens=8000;
  const history=store.data.groupContexts[key]=longHistory(),original=JSON.stringify(history);store.data.summaries['another-session']='不可改动';
  const system:WireMessage={role:'system',content:'群聊当前任务：核对报告'},tools=[{type:'function' as const,function:{name:'group_read',description:'读取原记录',parameters:{type:'object',properties:{groupId:{type:'string'}}}}}];
  let calls=0;const model={complete:async(messages:WireMessage[])=>{calls++;assert.ok(estimateRequest(messages,[]).tokens<=contextBudget(8000).input);return {content:summary,calls:[],finishReason:'stop'};}} as unknown as ModelClient;
  const result=await prepareGroupContext(store,model,{key,runId:'compression-test',system,history,tools,signal:new AbortController().signal});
  assert.ok(calls>0&&result.compactions>0);assert.ok(result.estimatedTokens<=contextBudget(8000).input);assert.ok(store.data.contextOffsets[key]>0);
  assert.equal(JSON.stringify(history),original);assert.equal(store.data.summaries['another-session'],'不可改动');assert.ok(result.messages.some(m=>m.content?.includes('/work/proof.csv')));
  const restored=new Store(dir);assert.equal(restored.data.contextOffsets[key],store.data.contextOffsets[key]);assert.equal(restored.data.summaries[key],summary);
});

test('interrupted and invalid group summaries never advance the persisted boundary',async t=>{
  const {store,key}=fixture(t);store.data.model.contextTokens=8000;const history=store.data.groupContexts[key]=longHistory(),controller=new AbortController();
  const input={key,runId:'interrupted',system:{role:'system' as const,content:'群聊'},history,tools:[],signal:controller.signal};
  const cancelled={complete:async()=>{controller.abort(new Error('新群消息'));return {content:summary,calls:[],finishReason:'stop'};}} as unknown as ModelClient;
  await assert.rejects(prepareGroupContext(store,cancelled,input),/新群消息/);assert.equal(store.data.contextOffsets[key],undefined);assert.equal(store.data.summaries[key],undefined);
  const invalid={complete:async()=>({content:'这不是结构化摘要',calls:[],finishReason:'stop'})} as unknown as ModelClient;
  await assert.rejects(prepareGroupContext(store,invalid,{...input,signal:new AbortController().signal}),/不是有效/);assert.equal(store.data.contextOffsets[key],undefined);
});
