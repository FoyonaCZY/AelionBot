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

export const groupContextKey=(groupId:string,botId:string)=>`group:${groupId}:${botId}`;
function published(store:Store,message:GroupMessage,botId:string):WireMessage{
  const content=groupReplyContent(message.content,message.sender.kind==='bot'?message.sender.id:undefined);
  return {role:message.sender.id===botId?'assistant':'user',groupMessageId:message.id,...new Attachments(store).wire(botId,JSON.stringify({messageId:message.id,seq:message.seq,sender:message.sender,kind:message.kind,content,attachments:message.attachments,mentions:message.mentions,mentioned:message.mentions?.some(mention=>mention.id===botId)||false,reaction:message.reaction,event:message.event}),message.attachments,true)};
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
  for(const message of room.messages){if(!seen.has(message.id)){history.push(published(store,message,botId));seen.add(message.id);}else if(groupReplyContent(message.content,message.sender.kind==='bot'?message.sender.id:undefined)!==message.content){const index=history.findIndex(item=>item.groupMessageId===message.id);if(index>=0)history[index]=published(store,message,botId);}}
  return history;
}
export function rememberPublished(store:Store,message:GroupMessage){
  if(message.sender.kind!=='bot'||message.kind==='reaction')return;
  const history=store.data.groupContexts[groupContextKey(message.groupId,message.sender.id)];
  if(history&&!history.some(item=>item.groupMessageId===message.id))history.push(published(store,message,message.sender.id));
}

// All scopes share token calibration, atomic epochs, summary repair and tool-pair protection.
export async function prepareGroupContext(store:Store,model:ModelClient,input:{botId?:string;key:string;runId:string;system:WireMessage;history:WireMessage[];tools:ToolDefinition[];signal:AbortSignal;force?:boolean;pendingFailures?:Map<string,string>;taskFrame?:string},engine?:ContextEngine){
 const botId=input.botId||store.data.runs.find(run=>run.id===input.runId)?.botId||store.data.bots.find(bot=>input.key.endsWith(':'+bot.id))?.id;if(!botId)throw Error('群任务不存在');
 const owned=engine?undefined:new CognitiveStore(store),context=engine||new ContextEngine(owned!,model,()=>{});
 try{
  const prepared=await context.prepare({...input,botId,scopeKey:input.key,legacyHead:{through:store.data.contextOffsets[input.key]||0,summary:store.data.summaries[input.key]||''}});
  store.data.contextOffsets[input.key]=prepared.head.through;store.data.summaries[input.key]=prepared.head.summary;store.save();
  return {...prepared,estimatedTokens:prepared.stats.estimatedTokens,compactions:prepared.stats.compactions};
 }finally{owned?.close();}
}
