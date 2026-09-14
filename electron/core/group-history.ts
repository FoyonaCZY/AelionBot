import {CognitiveStore} from './cognitive-store';
import {ContextEngine} from './context-engine';
import {Attachments} from './attachments';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Store} from './store';
import type {GroupMessage} from '../../src/group-types';
import type {WireMessage} from '../../src/shared';
import type {ModelClient,ToolDefinition} from './model';
import {groupReplyContent} from '../../src/message-envelope';

export const groupContextKey=(groupId:string,botId?:string)=>botId?`group:${groupId}:${botId}`:`group:${groupId}`;
function published(store:Store,message:GroupMessage,botId:string):WireMessage{
  const content=groupReplyContent(message.content,message.sender.kind==='bot'?message.sender.id:undefined);
  return {role:'user',groupMessageId:message.id,...new Attachments(store).wire(botId,JSON.stringify({messageId:message.id,seq:message.seq,sender:message.sender,kind:message.kind,reply:message.reply,content,attachments:message.attachments,mentions:message.mentions,reaction:message.reaction,event:message.event,delegation:message.delegation}),message.attachments,true)};
}
export function groupHistory(store:Store,groupId:string,botId:string){
  const room=store.data.groups.find(room=>room.id===groupId);if(!room)throw new Error('群聊不存在');
  const key=groupContextKey(groupId);let history=store.data.groupContexts[key];
  // Legacy group histories were bot-specific mutable prompts. The transcript is
  // authoritative, so retain a recovery copy then rebuild one shared projection.
  if(!history){
    const legacy=Object.entries(store.data.groupContexts).filter(([candidate])=>candidate.startsWith(`group:${groupId}:`));
    if(legacy.length){
    const dir=join(store.dir,'group-context-backups');mkdirSync(dir,{recursive:true});
    const path=join(dir,`${groupId}-shared-migration.json`);if(!existsSync(path))writeFileSync(path,JSON.stringify({legacy},null,2),{flag:'wx'});
    delete store.data.summaries[key];store.data.contextOffsets[key]=0;
  }
  }
  history=room.messages.map(message=>published(store,message,botId));store.data.groupContexts[key]=history;
  return history;
}
export function rememberPublished(store:Store,message:GroupMessage){
  if(message.sender.kind==='bot'&&message.kind!=='reaction')groupHistory(store,message.groupId,message.sender.id);
}

// All scopes share token calibration, atomic epochs, summary repair and tool-pair protection.
const groupPreparation=new Map<string,Promise<unknown>>();
export async function prepareGroupContext(store:Store,model:ModelClient,input:{botId:string;key:string;runId:string;system:WireMessage;prefixContext?:WireMessage[];dynamicContext?:WireMessage[];history:WireMessage[];tools:ToolDefinition[];signal:AbortSignal;force?:boolean;pendingFailures?:Map<string,string>;taskFrame?:string},engine?:ContextEngine){
  const previous=groupPreparation.get(input.key)||Promise.resolve();let release!:()=>void;const mine=new Promise<void>(resolve=>{release=resolve;});groupPreparation.set(input.key,mine);await previous;
  const botId=input.botId;
  const owned=engine?undefined:new CognitiveStore(store),context=engine||new ContextEngine(owned!,model,()=>{});
 try{
  const prepared=await context.prepare({...input,botId,scopeKey:input.key,sharedScope:true,legacyHead:{through:store.data.contextOffsets[input.key]||0,summary:store.data.summaries[input.key]||''}});
  store.data.contextOffsets[input.key]=prepared.head.through;store.data.summaries[input.key]=prepared.head.summary;store.save();
  return {...prepared,estimatedTokens:prepared.stats.estimatedTokens,compactions:prepared.stats.compactions};
 }finally{owned?.close();release();if(groupPreparation.get(input.key)===mine)groupPreparation.delete(input.key);}
}
