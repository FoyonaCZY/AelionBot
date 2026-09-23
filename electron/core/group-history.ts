import {CognitiveStore} from './cognitive-store';
import {ContextEngine} from './context-engine';
import {Attachments} from './attachments';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Store} from './store';
import type {GroupMessage} from '../../src/group-types';
import type {WireMessage} from '../../src/shared';
import type {ModelClient,ToolDefinition} from './model';
import {contextBudget,estimateRequest,exchanges,pruneToolOutputs,serializeForSummary,sourceHash,tailBoundary,textTokens} from './context-budget';
import {parseContextSummary} from './context-engine';
import {groupReplyContent} from '../../src/message-envelope';
import {hasPendingHistoryCalls} from './tool-history';

export const groupContextKey=(groupId:string,botId:string)=>`group:${groupId}:${botId}`;
export function groupMessageWire(store:Store,message:GroupMessage,botId:string):WireMessage{
  const content=groupReplyContent(message.content,message.sender.kind==='bot'?message.sender.id:undefined);
  return {role:message.sender.id===botId?'assistant':'user',groupMessageId:message.id,...new Attachments(store).wire(botId,JSON.stringify({messageId:message.id,seq:message.seq,sender:message.sender,kind:message.kind,reply:message.reply,content:content.slice(0,1800),...(content.length>1800?{truncated:true,readWith:'group_read',offset:1800}:{}),attachments:message.attachments,mentions:message.mentions,mentioned:message.mentions?.some(mention=>mention.id===botId)||false,reaction:message.reaction,event:message.event}),message.attachments,true)};
}
export function groupHistory(store:Store,groupId:string,botId:string,messageIds?:string[]){
  const room=store.data.groups.find(room=>room.id===groupId);if(!room)throw new Error('群聊不存在');
  const key=groupContextKey(groupId,botId);let history=store.data.groupContexts[key]||=[];
  // Migrate only this member's group workspace. Main/peer histories are never copied or reset.
  const versions=store.data.groupContextVersions||={};
  if(versions[key]!==2){
   if(history.length){
    const dir=join(store.dir,'group-context-backups');mkdirSync(dir,{recursive:true});
    const path=join(dir,`${groupId}-${botId}.json`);if(!existsSync(path))writeFileSync(path,JSON.stringify({history,summary:store.data.summaries[key],offset:store.data.contextOffsets[key]},null,2),{flag:'wx'});
    const retained=history.filter(message=>message.tool_calls?.length||message.role==='tool'||message.images?.length).map(message=>message.tool_calls?.length?{...message,content:null}:message);
    history.splice(0,history.length,...retained);
   }
   store.data.groupContexts[key]=history;delete store.data.summaries[key];store.data.contextOffsets[key]=0;versions[key]=2;
  }
  if(hasPendingHistoryCalls(history))return history;
  const resetAt=store.bot(botId).contextResetAt;
  const deliveries=store.data.groupDeliveries.filter(d=>d.groupId===groupId&&d.recipientId===botId);
  const selected=new Set(messageIds||deliveries.filter(d=>d.status==='running').map(d=>d.messageId));
  // A new member gets a small public window; older material stays behind group_read.
  if(!history.length)for(const message of room.messages.filter(m=>!resetAt||m.time>=resetAt).slice(-4))selected.add(message.id);
  if(!deliveries.length&&messageIds===undefined)for(const message of room.messages.slice(-4))selected.add(message.id);
  for(const message of room.messages.filter(m=>m.sender.id===botId).slice(-4))selected.add(message.id);
  const seen=new Set(history.map(message=>message.groupMessageId));
  for(const message of room.messages){if(resetAt&&message.time<resetAt)continue;if(!selected.has(message.id))continue;if(!seen.has(message.id)){history.push(groupMessageWire(store,message,botId));seen.add(message.id);}}
  if(!resetAt)return history;
  const allowed=new Set(room.messages.filter(message=>message.time>=resetAt).map(message=>message.id));
  const filtered=history.filter(item=>!item.groupMessageId||allowed.has(item.groupMessageId));if(filtered.length!==history.length)history.splice(0,history.length,...filtered);return history;

}
export function rememberPublished(store:Store,message:GroupMessage){
  if(message.sender.kind!=='bot'||message.kind==='reaction')return;
  const history=store.data.groupContexts[groupContextKey(message.groupId,message.sender.id)];
  if(history&&!hasPendingHistoryCalls(history)&&!history.some(item=>item.groupMessageId===message.id))history.push(groupMessageWire(store,message,message.sender.id));
}

// All scopes share token calibration, atomic epochs, summary repair and tool-pair protection.
export async function prepareGroupContext(store:Store,model:ModelClient,input:{botId?:string;key:string;runId:string;system:WireMessage;prefixContext?:WireMessage[];dynamicContext?:WireMessage[];history:WireMessage[];tools:ToolDefinition[];signal:AbortSignal;force?:boolean;pendingFailures?:Map<string,string>;taskFrame?:string},engine?:ContextEngine){
 const botId=input.botId||store.data.runs.find(run=>run.id===input.runId)?.botId||store.data.bots.find(bot=>input.key.endsWith(':'+bot.id))?.id;if(!botId)throw Error('群任务不存在');
 const owned=engine?undefined:new CognitiveStore(store),context=engine||new ContextEngine(owned!,model,()=>{});
 try{
  const prepared=await context.prepare({...input,botId,scopeKey:input.key,legacyHead:{through:store.data.contextOffsets[input.key]||0,summary:store.data.summaries[input.key]||''}});
  store.data.contextOffsets[input.key]=prepared.head.through;store.data.summaries[input.key]=prepared.head.summary;store.save();
  return {...prepared,estimatedTokens:prepared.stats.estimatedTokens,compactions:prepared.stats.compactions};
 }finally{owned?.close();}
}
