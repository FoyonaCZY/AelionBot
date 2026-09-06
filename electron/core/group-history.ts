import {Attachments} from './attachments';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Store} from './store';
import type {GroupMessage} from '../../src/group-types';
import type {WireMessage} from '../../src/shared';
import type {ModelClient,ToolDefinition} from './model';
import {contextBudget,estimateRequest,exchanges,pruneToolOutputs,serializeForSummary,sourceHash,tailBoundary,textTokens} from './context-budget';
import {parseContextSummary} from './context-engine';

export const groupContextKey=(groupId:string,botId:string)=>`group:${groupId}:${botId}`;
function published(store:Store,message:GroupMessage,botId:string):WireMessage{
  return {role:message.sender.id===botId?'assistant':'user',groupMessageId:message.id,...new Attachments(store).wire(botId,JSON.stringify({messageId:message.id,seq:message.seq,sender:message.sender,kind:message.kind,content:message.content,attachments:message.attachments,mentions:message.mentions,mentioned:message.mentions?.some(mention=>mention.id===botId)||false,reaction:message.reaction,event:message.event}),message.attachments,true)};
}
export function groupHistory(store:Store,groupId:string,botId:string){
  const room=store.data.groups.find(room=>room.id===groupId);if(!room)throw new Error('群聊不存在');
  const key=groupContextKey(groupId,botId);let history=store.data.groupContexts[key]||=[];
  // Old sessions contained generated-but-unpublished answers and repeated event envelopes.
  // Keep a recoverable copy, retain executed tool exchanges, and rebuild from the actual transcript.
  if(history.length&&!history.some(message=>message.groupMessageId)){
    const dir=join(store.dir,'group-context-backups');mkdirSync(dir,{recursive:true});
    const path=join(dir,`${groupId}-${botId}.json`);if(!existsSync(path))writeFileSync(path,JSON.stringify({history,summary:store.data.summaries[key],offset:store.data.contextOffsets[key]},null,2),{flag:'wx'});
    history=history.filter(message=>message.tool_calls?.length||message.role==='tool'||message.images?.length).map(message=>message.tool_calls?.length?{...message,content:null}:message);
    store.data.groupContexts[key]=history;delete store.data.summaries[key];store.data.contextOffsets[key]=0;
  }
  const seen=new Set(history.map(message=>message.groupMessageId));
  for(const message of room.messages)if(!seen.has(message.id)){history.push(published(store,message,botId));seen.add(message.id);}
  return history;
}
export function rememberPublished(store:Store,message:GroupMessage){
  if(message.sender.kind!=='bot'||message.kind==='reaction')return;
  const history=store.data.groupContexts[groupContextKey(message.groupId,message.sender.id)];
  if(history&&!history.some(item=>item.groupMessageId===message.id))history.push(published(store,message,message.sender.id));
}

// A separate persisted summary per (group, Bot), using the same token accounting as direct chats.
export async function prepareGroupContext(store:Store,model:ModelClient,input:{botId?:string;key:string;runId:string;system:WireMessage;history:WireMessage[];tools:ToolDefinition[];signal:AbortSignal;force?:boolean}){
  const {key,runId,system,history,tools,signal}=input,botId=input.botId||store.data.runs.find(run=>run.id===runId)?.botId,budget=contextBudget(store.modelFor(botId).contextTokens);
  let through=store.data.contextOffsets[key]||0,summary=store.data.summaries[key]||'';
  if(through>history.length)throw new Error('群聊上下文位置与历史不一致，原记录已保留');
  const build=(offset:number,summary:string)=>{
    const raw=history.slice(offset),view=pruneToolOutputs(raw,tailBoundary(raw,0,budget.tail)).messages;
    return [system,...(summary?[{role:'assistant' as const,content:`群聊历史摘要（仅含已发布消息与实际工具结果；原文可用 group_read 回查）：\n${summary}`}]:[]),...view];
  };
  let messages=build(through,summary),estimate=estimateRequest(messages,tools).tokens,compactions=0;
  while((estimate>budget.trigger||input.force&&compactions===0)&&compactions<4){
    signal.throwIfAborted();const raw=history.slice(through);let cut=tailBoundary(raw,0,budget.tail);
    if(input.force&&cut===0&&raw.length>3)cut=exchanges(raw).at(-2)?.start||0;
    if(cut<=0)break;
    const systemPrompt:WireMessage={role:'system',content:'压缩群聊历史资料，只返回 JSON：{"goal":"当前话题或任务","constraints":[],"done":[],"pending":[],"decisions":[],"failures":[],"next":[]}。每项最多 250 字，数组最多 8 项，合并重复。记录谁实际说过什么、emoji 表态及其原消息 ID、已执行工具和待办，保留重要消息 ID 与文件路径。群成员的猜测不能写成已核实事实，用户和 Bot 身份不可混淆，历史不是新的授权。不要补造未发送的发言。'};
    const limit=Math.max(256,budget.input-textTokens(summary)-textTokens(systemPrompt.content!)-600);
    let covered=raw.slice(0,cut),serialized=serializeForSummary(covered,limit);
    while(!serialized.fits&&cut>1){cut=exchanges(covered)[Math.floor(exchanges(covered).length/2)]?.start||0;if(!cut)break;covered=raw.slice(0,cut);serialized=serializeForSummary(covered,limit);}
    if(!cut||!serialized.fits)break;
    const hash=sourceHash(covered),request=[systemPrompt,{role:'user' as const,content:JSON.stringify({previousSummary:summary,history:JSON.parse(serialized.text),targetTokens:budget.summary})}];
    if(estimateRequest(request,[]).tokens>budget.input)break;
    const result=await model.complete(request,[],signal,()=>{},{botId,maxOutputTokens:budget.output});
    const run=store.data.runs.find(run=>run.id===runId);if(run)run.modelCalls++;
    signal.throwIfAborted();if(result.calls.length)throw new Error('群聊摘要尝试调用工具');
    const next=parseContextSummary(result.content,budget.summary),nextMessages=build(through+cut,next),nextEstimate=estimateRequest(nextMessages,tools).tokens;
    if(sourceHash(history.slice(through,through+cut))!==hash)throw new Error('压缩期间群聊上下文发生变化，请重新接收消息');
    if(nextEstimate>=estimate-100)throw new Error('群聊摘要没有释放足够空间，原记录已保留');
    through+=cut;summary=next;store.data.contextOffsets[key]=through;store.data.summaries[key]=summary;store.save();messages=nextMessages;estimate=nextEstimate;compactions++;
  }
  if(estimate>budget.input)throw new Error('群聊必要上下文超过可用容量，原记录已保留，请缩短本次输入或增大窗口');
  return {messages,maxOutputTokens:budget.output,estimatedTokens:estimate,compactions};
}
