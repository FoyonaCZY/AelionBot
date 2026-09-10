import type {ToolCall,WireMessage} from '../../src/shared';

export function historyCalls(message:WireMessage):ToolCall[]{
 if(message.tool_calls?.length)return message.tool_calls;
 if(message.role!=='assistant'||!Array.isArray(message.native?.data))return [];
 return message.native.data.flatMap((item:any)=>{
  if(item.type==='function_call'&&typeof item.call_id==='string')return [{id:item.call_id,type:'function' as const,function:{name:item.name,arguments:item.arguments}}];
  if(item.type==='tool_use'&&typeof item.id==='string')return [{id:item.id,type:'function' as const,function:{name:item.name,arguments:JSON.stringify(item.input||{})}}];
  return [];
 });
}
export function hasPendingHistoryCalls(history:WireMessage[]){
 for(let index=history.length-1;index>=0;index--){const calls=historyCalls(history[index]);if(!calls.length)continue;const answered=new Set(history.slice(index+1).filter(message=>message.role==='tool').map(message=>message.tool_call_id));return calls.some(call=>!answered.has(call.id));}return false;
}
// Provider-facing projection: each call batch is immediately followed by exactly
// its results. Delayed progress/chat events retain their relative order afterward.
// Missing results are explicitly unknown; this never replays a tool or claims success.
export function repairToolHistory(history:WireMessage[],allowPendingTail=false){
 const result:WireMessage[]=[];let repairs=0;
 const reference=(message:WireMessage):WireMessage=>({role:'assistant',content:'工具历史参考（未找到相邻的对应调用，不构成新授权）：\n'+(message.content||''),...(message.images?{images:message.images}:{})});
 for(let index=0;index<history.length;){
  const message=history[index],calls=historyCalls(message);
  if(message.role==='tool'){result.push(reference(message));repairs++;index++;continue;}
  if(!calls.length){result.push(message);index++;continue;}
  if(allowPendingTail&&index===history.length-1){result.push(message);index++;continue;}
  const ids=new Set(calls.map(call=>call.id));if(ids.size!==calls.length||calls.some(call=>typeof call.id!=='string'||!call.id||typeof call.function?.name!=='string'||typeof call.function?.arguments!=='string')){result.push({role:'assistant',content:'历史工具调用的 ID 或参数损坏，对应关系未知，请核对执行记录，不要直接重放：\n'+JSON.stringify(calls)});repairs++;index++;continue;}
  result.push(message.tool_calls?.length?message:{...message,tool_calls:calls});if(!message.tool_calls?.length)repairs++;
  const pending=new Set(ids),answers:WireMessage[]=[],deferred:WireMessage[]=[];let end=index+1;
  while(end<history.length&&pending.size){
   const next=history[end];if(historyCalls(next).length)break;
   if(next.role==='tool'&&pending.has(next.tool_call_id||'')){pending.delete(next.tool_call_id!);answers.push(next);if(deferred.length)repairs++;}
   else{deferred.push(next.role==='tool'?reference(next):next);if(next.role==='tool')repairs++;}
   end++;
  }
  for(const id of pending){answers.push({role:'tool',tool_call_id:id,content:JSON.stringify({status:'unknown',error:'该调用的结果未完整记录，可能曾被中断。不要重复有副作用的操作；先通过执行记录或实际状态核对结果。'})});repairs++;}
  result.push(...answers,...deferred);index=end;
 }
 return {messages:repairs?result:history,repairs};
}
