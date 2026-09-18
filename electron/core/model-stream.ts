import type {ModelProtocol} from '../../src/model-types';
export interface ModelActivity {kind:'text'|'tool'|'reasoning'|'response';argumentChars?:number;}
const nonempty=(s:unknown)=>typeof s==='string'&&s.length>0;
/** Only semantic output counts as progress; role-only frames and pings do not. */
export function modelEventActivity(protocol:ModelProtocol,event:any):ModelActivity|undefined{
 if(protocol==='chat'){
  const d=event.choices?.[0]?.delta||event.choices?.[0]?.message;
  if(d?.tool_calls?.length){const argumentChars=d.tool_calls.reduce((n:number,c:any)=>n+(typeof c.function?.arguments==='string'?c.function.arguments.length:0),0);if(argumentChars||d.tool_calls.some((c:any)=>nonempty(c.function?.name)||nonempty(c.id)))return {kind:'tool',argumentChars};}
  if(nonempty(d?.content))return {kind:'text'};
  if(['reasoning_content','reasoning','reasoning_details'].some(k=>nonempty(d?.[k])||Array.isArray(d?.[k])&&d[k].length))return {kind:'reasoning'};
 }else if(protocol==='responses'){
  if(event.type==='response.function_call_arguments.delta'&&nonempty(event.delta))return {kind:'tool',argumentChars:event.delta.length};
  if(event.type==='response.output_text.delta'&&nonempty(event.delta))return {kind:'text'};
  if(/reasoning.*delta$/.test(event.type||'')&&nonempty(event.delta))return {kind:'reasoning'};
  if(event.type==='response.output_item.added'&&event.item?.type==='function_call')return {kind:'tool'};
  if(event.type==='response.output_item.added'&&['web_search_call','image_generation_call'].includes(event.item?.type)||/web_search_call|image_generation_call/.test(event.type||''))return {kind:'response'};
 }else if(protocol==='anthropic'){
  const d=event.delta;if(event.type==='content_block_delta'){
   if(d?.type==='input_json_delta'&&nonempty(d.partial_json))return {kind:'tool',argumentChars:d.partial_json.length};
   if(d?.type==='text_delta'&&nonempty(d.text))return {kind:'text'};
   if(d?.type==='thinking_delta'&&nonempty(d.thinking)||d?.type==='signature_delta'&&nonempty(d.signature))return {kind:'reasoning'};
  }
  if(event.type==='content_block_start'&&event.content_block?.type==='tool_use')return {kind:'tool'};
 }else if(protocol==='gemini'){
  const parts=event.candidates?.[0]?.content?.parts||[];const call=parts.find((p:any)=>p.functionCall);if(call)return {kind:'tool',argumentChars:JSON.stringify(call.functionCall.args||{}).length};
  if(parts.some((p:any)=>!p.thought&&nonempty(p.text)))return {kind:'text'};if(parts.some((p:any)=>p.thought&&nonempty(p.text)))return {kind:'reasoning'};
 }
 return undefined;
}
export interface StreamReadOptions {signal:AbortSignal;consume:(event:any)=>void;completed:()=>boolean;finish:()=>void;bytes?:(count:number)=>void;jsonProgress?:()=>void;completionGraceMs?:number;}
const LIMIT=16*1024*1024;
export async function readModelResponse(response:Response,options:StreamReadOptions){
 if(!response.body)throw Error('模型返回空响应');
 const reader=response.body.getReader(),decoder=new TextDecoder();let total=0,pending='',fields:string[]=[],done=false,completedAt=0;
 const flush=()=>{if(!fields.length)return;const data=fields.join('\n');fields=[];if(data.trim()==='[DONE]'){done=true;return;}let event;try{event=JSON.parse(data);}catch{throw Error('模型流返回无效 JSON，未执行本次工具调用');}options.consume(event);if(options.completed()&&!completedAt){completedAt=Date.now();options.finish();}};
 const line=(value:string)=>{if(value===''){flush();return;}if(value.startsWith(':'))return;const at=value.indexOf(':'),name=at<0?value:value.slice(0,at);let text=at<0?'':value.slice(at+1);if(text.startsWith(' '))text=text.slice(1);if(name==='data')fields.push(text);};
 const parse=(final=false)=>{let start=0;for(let i=0;i<pending.length;i++){const c=pending[i];if(c!=='\r'&&c!=='\n')continue;if(c==='\r'&&i===pending.length-1&&!final)break;line(pending.slice(start,i));if(c==='\r'&&pending[i+1]==='\n')i++;start=i+1;if(done)break;}pending=pending.slice(start);if(final&&!done){if(pending)line(pending);pending='';flush();}};
 const read=async()=>{
  options.signal.throwIfAborted();let timer:ReturnType<typeof setTimeout>|undefined;let abort!:()=>void;
  const stopped=new Promise<null>((resolve,reject)=>{abort=()=>reject(options.signal.reason);options.signal.addEventListener('abort',abort,{once:true});if(options.signal.aborted)abort();if(completedAt)timer=setTimeout(()=>resolve(null),Math.max(0,(options.completionGraceMs??1000)-(Date.now()-completedAt)));});
  try{return await Promise.race([reader.read(),stopped]);}finally{clearTimeout(timer);options.signal.removeEventListener('abort',abort);}
 };
 try{
  const json=response.headers.get('content-type')?.includes('application/json');
  while(!done){const next=await read();if(!next)break;if(next.done){pending+=decoder.decode();if(json){options.consume(JSON.parse(pending));if(options.completed())options.finish();}else parse(true);break;}
   total+=next.value.length;options.bytes?.(next.value.length);if(total>LIMIT)throw Error('模型响应超过 16 MB');const text=decoder.decode(next.value,{stream:true});pending+=text;
   if(json){if(text.trim())options.jsonProgress?.();}else parse();
  }
  options.signal.throwIfAborted();
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
