import {randomUUID} from 'node:crypto';
import type {ModelConfig,WireMessage,ToolCall} from '../../src/shared';
import type {ModelProtocol,NativeAssistant} from '../../src/model-types';
import type {Completion,ToolDefinition} from './model';
import {visibleImages} from '../../src/model-images';
import {modelUsage} from './model-usage';
import {anthropicHistoryEndpoints} from './anthropic-cache';
import {repairToolHistory} from './tool-history';

export const nativeKey=(cfg:ModelConfig)=>`${cfg.providerId||''}:${cfg.baseUrl.replace(/\/$/,'')}:${cfg.model}`;
const rawCall=(name:string,args:unknown,id?:string):ToolCall=>({id:id??randomUUID(),type:'function',function:{name,arguments:typeof args==='string'?args:JSON.stringify(args||{})}});
export function protocolRequest(cfg:ModelConfig,messages:WireMessage[],tools:ToolDefinition[],output:number,key:string,resolveImage:(id:string)=>string,usage=true,cacheKey?:string,affinityKey?:string,allowPendingTail=false){
 const repaired=repairToolHistory(messages,allowPendingTail);return {...buildProtocolRequest(cfg,repaired.messages,tools,output,key,resolveImage,usage,cacheKey,affinityKey),historyRepairs:repaired.repairs};
}
function buildProtocolRequest(cfg:ModelConfig,messages:WireMessage[],tools:ToolDefinition[],output:number,key:string,resolveImage:(id:string)=>string,usage=true,cacheKey?:string,affinityKey?:string){
 const protocol=cfg.protocol||'chat',base=cfg.baseUrl.replace(/\/$/,''),nk=nativeKey(cfg),visible=new Set(visibleImages(messages).map(i=>i.id));
 const images=(message:WireMessage)=>(message.images||[]).filter(i=>visible.has(i.id)).map(i=>resolveImage(i.id));
 const native=(m:WireMessage)=>m.native?.protocol===protocol&&m.native.key===nk?m.native.data:undefined;
 const headers:Record<string,string>={'Content-Type':'application/json'};
 if(affinityKey){headers['x-session-affinity']=affinityKey;headers['x-session-id']=affinityKey;}
 const temperature=cfg.temperature===undefined?{}:{temperature:cfg.temperature};
 if(protocol==='chat'){
  if(key)headers.Authorization=`Bearer ${key}`;
  const wire=messages.map(m=>{const urls=images(m);return {role:m.role,content:urls.length?[{type:'text',text:m.content||'图像资料'},...urls.map(url=>({type:'image_url',image_url:{url,detail:'high'}}))]:m.content,...(m.tool_calls?{tool_calls:structuredClone(m.tool_calls)}:{}),...(m.tool_call_id?{tool_call_id:m.tool_call_id}:{}),...(m.role==='assistant'?structuredClone(native(m)||{}):{})};});
  return {url:base+'/chat/completions',headers,body:{model:cfg.model,messages:wire,stream:true,...(usage?{stream_options:{include_usage:true}}:{}),...(/^(gpt-[56]|o[134])/.test(cfg.model)?{max_completion_tokens:output}:{max_tokens:output}),...temperature,...(cfg.reasoningEffort?{reasoning_effort:cfg.reasoningEffort}:{}),...(tools.length?{tools,tool_choice:'auto',parallel_tool_calls:true}:{})}};
 }
 if(protocol==='responses'){
  if(key)headers.Authorization=`Bearer ${key}`;
  const input:any[]=[];
  for(const m of messages){const preserved=native(m);if(m.role==='assistant'&&Array.isArray(preserved)){input.push(...structuredClone(preserved));continue;}
   if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.tool_call_id,output:m.content||''});continue;}
   if(m.content||m.images?.length)input.push({role:m.role,content:[{type:m.role==='assistant'?'output_text':'input_text',text:m.content||'图像资料'},...images(m).map(url=>({type:'input_image',image_url:url,detail:'high'}))]});
   for(const call of m.tool_calls||[])input.push({type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments});
  }
  return {url:base+'/responses',headers,body:{model:cfg.model,input,stream:true,store:false,include:['reasoning.encrypted_content'],...(cacheKey?{prompt_cache_key:cacheKey}:{}),max_output_tokens:output,...temperature,...(cfg.reasoningEffort?{reasoning:{effort:cfg.reasoningEffort}}:{}),...(tools.length?{tools:tools.map(t=>({type:'function',...t.function,strict:false})),parallel_tool_calls:true}:{})}};
 }
 const system:string[]=[],wire:any[]=[],cacheCandidates:any[]=[];
 const cacheEndpoints=protocol==='anthropic'?anthropicHistoryEndpoints(messages,native):new Set<number>();
 const cacheEnd=(index:number)=>{if(!cacheEndpoints.has(index))return;const content=wire.at(-1)?.content,last=content?.at(-1);if(last&&['text','image','tool_result'].includes(last.type))cacheCandidates.push(last);};
 const push=(role:string,parts:any[])=>{if(!parts.length)return;if(wire.at(-1)?.role===role)wire.at(-1)[protocol==='gemini'?'parts':'content'].push(...parts);else wire.push({role,[protocol==='gemini'?'parts':'content']:parts});};
 const callNames=new Map(messages.flatMap(m=>(m.tool_calls||[]).map(c=>[c.id,c.function.name] as const)));
 const providerCallIds=new Set(messages.flatMap(m=>{const kept=native(m);return Array.isArray(kept)?kept.flatMap(p=>p.functionCall?.id?[p.functionCall.id]:[]):(m.tool_calls||[]).map(c=>c.id);}));
 for(const [index,m] of messages.entries()){
  // Only leading system messages are lifted; later control messages retain their chronology.
  if(m.role==='system'&&!wire.length){if(m.content)system.push(m.content);continue;}
  const preserved=native(m);if(m.role==='assistant'&&Array.isArray(preserved)){push(protocol==='gemini'?'model':'assistant',structuredClone(preserved));cacheEnd(index);continue;}
  const role=m.role==='assistant'?(protocol==='gemini'?'model':'assistant'):'user';let parts:any[]=[];
  if(m.role==='tool')parts=protocol==='gemini'?[{functionResponse:{...(providerCallIds.has(m.tool_call_id)?{id:m.tool_call_id}:{}),name:callNames.get(m.tool_call_id!)||'unknown',response:{output:m.content||''}}}]:[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content||''}];
  else {
   if(m.content)parts.push(protocol==='gemini'?{text:m.content}:{type:'text',text:m.content});
   for(const url of images(m)){const match=/^data:([^;]+);base64,([\s\S]+)$/.exec(url);if(!match)throw Error('原生模型图像需要本地 base64 数据');parts.push(protocol==='gemini'?{inlineData:{mimeType:match[1],data:match[2]}}:{type:'image',source:{type:'base64',media_type:match[1],data:match[2]}});}
   for(const call of m.tool_calls||[])parts.push(protocol==='gemini'?{functionCall:{id:call.id,name:call.function.name,args:JSON.parse(call.function.arguments)}}:{type:'tool_use',id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments)});
  }push(role,parts);cacheEnd(index);
 }
 if(protocol==='anthropic'){
  if(key)headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';
  for(const message of wire)for(const part of message.content)delete part.cache_control;
  const systemParts=system.map((text,index)=>({type:'text',text,...(index===0||index===system.length-1?{cache_control:{type:'ephemeral'}}:{})}));
  for(const part of [...new Set(cacheCandidates)].slice(-2))part.cache_control={type:'ephemeral'};
  return {url:base+'/messages',headers,body:{model:cfg.model,system:systemParts.length?systemParts:undefined,messages:wire,stream:true,max_tokens:output,...temperature,...(cfg.thinkingBudget&&output>1024?{thinking:{type:'enabled',budget_tokens:Math.min(cfg.thinkingBudget,output-1)}}:{}),...(tools.length?{tools:tools.map(t=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}))}:{})}};
 }
 if(key)headers['x-goog-api-key']=key;
 return {url:`${base}/models/${encodeURIComponent(cfg.model.replace(/^models\//,''))}:streamGenerateContent?alt=sse`,headers,body:{systemInstruction:system.length?{parts:[{text:system.join('\n\n')}]}:undefined,contents:wire,generationConfig:{maxOutputTokens:output,...temperature,...(cfg.thinkingBudget!==undefined?{thinkingConfig:{thinkingBudget:cfg.thinkingBudget}}:{})},...(tools.length?{tools:[{functionDeclarations:tools.map(t=>({name:t.function.name,description:t.function.description,parametersJsonSchema:t.function.parameters}))}]}:{})}};
}

export class StreamAccumulator {
 content='';finishReason='';ended=false;usage?:Completion['usage'];
 private calls=new Map<number,ToolCall>();private blocks=new Map<number,any>();private json=new Map<number,string>();private extras:Record<string,any>={};private output:any[]=[];private parts:any[]=[];
 constructor(private protocol:ModelProtocol,private key:string,private onText:(delta:string)=>void){}
 private text(value:unknown){if(typeof value==='string'){this.content+=value;this.onText(value);}}
 consume(item:any){
  if(this.protocol==='responses'&&item.type==='response.failed')this.usage=modelUsage('responses',item.response?.usage,this.usage);
  if(item.error||item.type==='error'||item.type==='response.failed')throw Error(`模型流错误：${item.error?.message||item.response?.error?.message||'unknown'}`);
  if(this.protocol==='responses'){
   if(item.type==='response.output_text.delta')this.text(item.delta);
   if(item.type==='response.completed'||item.type==='response.incomplete'){
    const r=item.response;this.output=r.output||[];this.finishReason=item.type==='response.completed'?'stop':r.incomplete_details?.reason==='max_output_tokens'?'length':'incomplete';this.ended=true;
    const completedText=this.output.filter(i=>i.type==='message').flatMap(i=>i.content||[]).filter(i=>i.type==='output_text').map(i=>i.text).join('');
    if(!this.content&&completedText)this.text(completedText);else this.content=completedText||this.content;
    for(const i of this.output)if(i.type==='function_call')this.calls.set(this.calls.size,rawCall(i.name,i.arguments,i.call_id||''));
    this.usage=modelUsage('responses',r.usage,this.usage);
   }return;
  }
  if(this.protocol==='anthropic'){
   if(item.type==='message_start')this.usage=modelUsage('anthropic',item.message?.usage,this.usage);
   if(item.type==='content_block_start'){this.blocks.set(item.index,structuredClone(item.content_block));if(item.content_block.type==='text')this.text(item.content_block.text);}
   if(item.type==='content_block_delta'){const b=this.blocks.get(item.index),d=item.delta;if(!b)throw Error('模型内容块缺少起始事件');if(d.type==='text_delta'){b.text=(b.text||'')+d.text;this.text(d.text);}if(d.type==='input_json_delta')this.json.set(item.index,(this.json.get(item.index)||'')+d.partial_json);if(d.type==='thinking_delta')b.thinking=(b.thinking||'')+d.thinking;if(d.type==='signature_delta')b.signature=(b.signature||'')+d.signature;}
   if(item.type==='message_delta'){if(item.delta?.stop_reason)this.finishReason=item.delta.stop_reason==='max_tokens'?'length':item.delta.stop_reason;this.usage=modelUsage('anthropic',item.usage,this.usage);}
   if(item.type==='message_stop'){this.ended=true;for(const [index,b] of this.blocks){if(b.type==='tool_use'){if(this.json.has(index))b.input=JSON.parse(this.json.get(index)!);this.calls.set(index,rawCall(b.name,b.input,b.id||''));}}}return;
  }
  if(this.protocol==='gemini'){
   const c=item.candidates?.[0];if(c){for(const part of c.content?.parts||[]){this.parts.push(structuredClone(part));if(part.text&&!part.thought)this.text(part.text);if(part.functionCall){const f=part.functionCall;this.calls.set(this.calls.size,rawCall(f.name,f.args,f.id));}}if(c.finishReason){this.finishReason=c.finishReason==='MAX_TOKENS'?'length':c.finishReason;this.ended=true;}}
   this.usage=modelUsage('gemini',item.usageMetadata,this.usage);return;
  }
  this.usage=modelUsage('chat',item.usage,this.usage);
  const c=item.choices?.[0];if(!c)return;if(c.finish_reason){this.finishReason=c.finish_reason;this.ended=true;}const d=c.delta||c.message||{};
  if(typeof d.content==='string')this.text(d.content);
  for(const key of ['reasoning_content','reasoning','reasoning_details'])if(d[key]!==undefined){if(typeof d[key]==='string')this.extras[key]=(this.extras[key]||'')+d[key];else if(Array.isArray(d[key]))this.extras[key]=[...(this.extras[key]||[]),...d[key]];}
  for(const p of d.tool_calls||[]){const n=p.index??this.calls.size,call=this.calls.get(n)||rawCall('','','');if(p.id)call.id=p.id;if(p.function?.name)call.function.name+=p.function.name;if(p.function?.arguments)call.function.arguments+=p.function.arguments;this.calls.set(n,call);}
 }
 result():Completion{
  const data=this.protocol==='responses'?this.output:this.protocol==='anthropic'?[...this.blocks.entries()].sort(([a],[b])=>a-b).map(([,v])=>v):this.protocol==='gemini'?this.parts:this.extras;
  return {content:this.content.replace(/^\s*<\/think>\s*/,''),calls:[...this.calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>call),finishReason:this.finishReason,usage:this.usage,native:{protocol:this.protocol,key:this.key,data} satisfies NativeAssistant};
 }
}
