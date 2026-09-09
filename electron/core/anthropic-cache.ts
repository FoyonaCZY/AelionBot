import type {WireMessage} from '../../src/shared';

// Cache complete tool transactions rather than consuming both history breakpoints
// on individual results from the same parallel call. Native thinking stays intact.
export function anthropicHistoryEndpoints(messages:WireMessage[],native:(message:WireMessage)=>unknown){
 const endpoints:number[]=[];let lastNonSystem=-1;
 for(let i=0;i<messages.length;i++)if(messages[i].role!=='system')lastNonSystem=i;
 for(let i=0;i<messages.length;i++){
  const message=messages[i];if(message.role==='system'||message.role==='tool')continue;
  const kept=native(message),blocks=Array.isArray(kept)?kept:[];
  const ids=message.tool_calls?.length?message.tool_calls.map(call=>call.id):blocks.filter(block=>block.type==='tool_use'&&typeof block.id==='string').map(block=>block.id);
  if(message.role==='assistant'&&ids.length){
   const pending=new Set(ids);let end=i+1,valid=pending.size===ids.length;
   while(end<messages.length&&messages[end].role==='tool'){if(!pending.delete(messages[end].tool_call_id||''))valid=false;end++;}
   if(valid&&!pending.size&&end>i+1)endpoints.push(end-1);i=end-1;continue;
  }
  if(message.role==='assistant'&&(message.content||blocks.some(block=>block.type==='text'&&block.text))||message.role==='user'&&i===lastNonSystem)endpoints.push(i);
 }
 return new Set(endpoints.slice(-2));
}
