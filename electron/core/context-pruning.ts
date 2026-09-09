import {createHash} from 'node:crypto';
import type {WireMessage} from '../../src/shared';
import type {CognitiveStore} from './cognitive-store';
import {pruneToolOutputs,textTokens} from './context-budget';

const source=(message:WireMessage)=>createHash('sha256').update(JSON.stringify([message.tool_call_id,message.content])).digest('hex');
const MAX_ENTRIES=4096,MAX_BYTES=4*1024*1024;
export class ContextPruning {
 private entries:Map<string,string>;
 private loaded:Map<string,string>;
 constructor(private storage:CognitiveStore,private botId:string,private scope:string){this.entries=storage.readContextPruning(botId,scope);this.loaded=new Map(this.entries);}
 apply(history:WireMessage[]){return history.map(message=>{if(message.role!=='tool')return message;const content=this.entries.get(source(message));return content===undefined?message:{...message,content};});}
 prune(original:WireMessage[],view:WireMessage[],protectedFrom:number,archivedOnly=false,minSavings=0){
  const before=new Map(this.entries);
  const skipped=new Set<number>();original.forEach((message,index)=>{if(message.role==='tool'&&this.entries.has(source(message)))skipped.add(index);});
  const result=pruneToolOutputs(view,protectedFrom,archivedOnly,skipped);let bytes=[...this.entries.values()].reduce((sum,value)=>sum+Buffer.byteLength(value),0),pruned=0;
  const messages=result.messages.map((message,index)=>{
   if(message.role!=='tool'||message.content===view[index].content)return view[index];
   const content=message.content||'',size=Buffer.byteLength(content);
   if(this.entries.size>=MAX_ENTRIES||bytes+size>MAX_BYTES)return view[index];
   this.entries.set(source(original[index]),content);bytes+=size;pruned++;return message;
  });
  if(minSavings>0&&messages.reduce((sum,message,index)=>sum+(message.content!==view[index].content?textTokens(view[index].content||'')-textTokens(message.content||''):0),0)<minSavings){this.entries=before;return {messages:view,pruned:0};}
  return {messages,pruned};
 }
 persist(history:WireMessage[],view:WireMessage[]){
  const retained=new Set(history.flatMap((message,index)=>message.role==='tool'&&this.entries.get(source(message))===view[index]?.content?[source(message)]:[]));for(const key of this.entries.keys())if(!retained.has(key))this.entries.delete(key);
  const changed=this.entries.size!==this.loaded.size||[...this.entries].some(([key,value])=>this.loaded.get(key)!==value);
  if(changed)this.storage.writeContextPruning(this.botId,this.scope,this.entries);
 }
}
