import {createHash} from 'node:crypto';
import {getEncoding} from 'js-tiktoken';
import {visibleImages} from '../../src/model-images';
import type {WireMessage} from '../../src/shared';
import type {ToolDefinition} from './model';

const encoding=getEncoding('o200k_base');
const cache=new Map<string,number>();
export function textTokens(text:string){
  if(!text)return 0;
  const key=createHash('sha256').update(text).digest('hex');const known=cache.get(key);if(known!==undefined)return known;
  // The provider may use another tokenizer; actual reported usage calibrates this base count.
  const tokens=encoding.encode(text,[],[]).length;
  if(cache.size>2048)cache.clear();cache.set(key,tokens);return tokens;
}
export function messageTokens(message:WireMessage){return 5+textTokens(message.content||'')+textTokens(message.tool_calls?JSON.stringify(message.tool_calls):'');}
export function estimateRequest(messages:WireMessage[],tools:ToolDefinition[],calibration=1){
  const text=messages.reduce((total,message)=>total+messageTokens(message),3),schema=textTokens(JSON.stringify(tools));
  const images=visibleImages(messages);
  // Vision token accounting varies by provider. Keep an explicit reserve instead of counting IDs as pixels.
  const vision=images.reduce((sum,image)=>sum+Math.max(1024,Math.ceil(image.width/768)*Math.ceil(image.height/768)*1024),0);
  return {tokens:Math.ceil((text+schema+vision)*Math.max(1,calibration)),textTokens:text,toolTokens:schema,imageTokens:vision,calibration:Math.max(1,calibration)};
}
export function contextBudget(capacity:number){
  const output=Math.min(4096,Math.max(1024,Math.floor(capacity*.2))),safety=Math.max(768,Math.min(8192,Math.floor(capacity*.08)));
  const input=capacity-output-safety;
  return {capacity,output,safety,input,trigger:Math.floor(input*.85),tail:Math.min(12000,Math.max(1200,Math.floor(input*.3))),summary:Math.min(3000,Math.max(600,Math.floor(input*.12)))};
}
export interface Exchange {start:number;end:number;tokens:number;complete:boolean;}
export function exchanges(history:WireMessage[],from=0):Exchange[]{
  const groups:Exchange[]=[];
  for(let i=from;i<history.length;){const start=i,message=history[i++];let complete=true;
    if(message.tool_calls?.length){const pending=new Set(message.tool_calls.map(call=>call.id));while(i<history.length&&history[i].role==='tool'){pending.delete(history[i].tool_call_id||'');i++;}while(i<history.length&&history[i].role==='user'&&history[i].images?.length)i++;complete=pending.size===0;}
    else if(message.role==='tool')complete=false;
    groups.push({start,end:i,tokens:history.slice(start,i).reduce((sum,item)=>sum+messageTokens(item),0),complete});
  }
  return groups;
}
export function tailBoundary(history:WireMessage[],from:number,budget:number){
  const groups=exchanges(history,from);if(groups.length<4)return from;
  let count=0,total=0,boundary=history.length;
  for(let i=groups.length-1;i>=0;i--){const group=groups[i];if(count>=2&&total+group.tokens>budget)break;boundary=group.start;total+=group.tokens;count++;}
  if(groups.some(group=>group.end<=boundary&&!group.complete))return from;
  return boundary;
}
export function resultDigest(content:string,limit=900){
  let value:any;try{const parsed=JSON.parse(content);value=parsed.result??parsed;}catch{return excerpt(content,limit);}
  let resultId:string|undefined;try{resultId=JSON.parse(content).resultId;}catch{}
  const result:Record<string,unknown>={archived:true,...(resultId?{resultId,readWith:'read_result'}:{})};
  for(const key of ['exitCode','isError','error','path','vmPath','saved','name','tool','durationMs','location'])if(value?.[key]!==undefined)result[key]=typeof value[key]==='string'?excerpt(value[key],300):value[key];
  if(value?.stderr)result.stderr=excerpt(String(value.stderr),500);
  const text=value?.stdout??value?.content??value?.preview;
  if(text)result.preview=excerpt(typeof text==='string'?text:JSON.stringify(text),limit);
  if(Array.isArray(value))result.items=value.length;
  if(Array.isArray(value?.files))result.files=value.files.slice(0,8);
  return JSON.stringify(result);
}
export function excerpt(text:string,limit:number){if(text.length<=limit)return text;const head=Math.floor(limit*.65);return `${text.slice(0,head)}\n[…内容已外置，可回查原记录…]\n${text.slice(-(limit-head))}`;}
export function pruneToolOutputs(history:WireMessage[],protectedFrom:number){
  const view=history.map(message=>({...message}));let pruned=0;
  for(let i=0;i<protectedFrom;i++)if(view[i].role==='tool'&&textTokens(view[i].content||'')>350){const digest=resultDigest(view[i].content||'');if(digest.length<(view[i].content?.length||0)){view[i].content=digest;pruned++;}}
  return {messages:view,pruned};
}
export function sourceHash(messages:WireMessage[]){return createHash('sha256').update(JSON.stringify(messages)).digest('hex');}
export function serializeForSummary(history:WireMessage[],maxTokens:number){
  let limit=1800;
  const serialize=()=>history.map((message,index)=>({index,role:message.role,text:excerpt(message.content||'',limit),...(message.tool_calls?{tools:message.tool_calls.map(call=>({id:call.id,name:call.function.name,arguments:excerpt(call.function.arguments,limit)}))}:{}),...(message.images?.length?{images:message.images.map(image=>image.id)}:{})}));
  let items=serialize();while(textTokens(JSON.stringify(items))>maxTokens&&limit>120){limit=Math.floor(limit/2);items=serialize();}
  return {text:JSON.stringify(items),fits:textTokens(JSON.stringify(items))<=maxTokens,abbreviated:history.some(message=>(message.content?.length||0)>limit||message.tool_calls?.some(call=>call.function.arguments.length>limit))};
}
