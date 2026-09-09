import {randomUUID} from 'node:crypto';
import {visibleImages} from '../../src/model-images';
import type {ModelConfig,ToolCall,WireMessage} from '../../src/shared';
import {DEFAULT_RUNTIME,type RuntimeSettings,type ModelUsage,type UsageRecord,type ContextUsage} from '../../src/runtime-types';
import type {NativeAssistant} from '../../src/model-types';
import {nativeKey,protocolRequest,StreamAccumulator} from './model-protocol';
import {redactHost} from './host';
import {estimateRequest} from './context-budget';
import {PromptCacheDiagnostics,promptCacheKey,rejectsPromptCacheKey} from './prompt-cache';
import type {RequestCacheDiagnostics} from '../../src/runtime-types';
import {stableToolDefinitions,transportErrorCodes} from './request-snapshot';
import {ResponsesTransport,websocketEnabled,type TransportStats} from './responses-transport';
export interface ToolDefinition {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>};}
export interface Completion {content:string;calls:ToolCall[];finishReason:string;usage?:ModelUsage;native?:NativeAssistant;}
export interface CompletionOptions {contextStats?:ContextUsage;botId?:string;runId?:string;cacheScope?:string;purpose?:string;maxOutputTokens?:number;timeoutMs?:number;retries?:number;onReset?:()=>void;}
export class ContextOverflowError extends Error {constructor(){super('模型报告上下文容量不足，需要压缩后继续');this.name='ContextOverflowError';}}
class RequestError extends Error {constructor(message:string,readonly retryable=false,readonly retryAfterMs=0,readonly truncated=false){super(message);}}
export function validateModelEndpoint(value:string){const url=new URL(value);if(url.username||url.password||url.search||url.hash)throw Error('API 地址不能包含凭据、查询参数或片段');if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('API 必须使用 HTTPS，本地模型可使用 localhost HTTP');return url.toString().replace(/\/$/,'');}
export function imageContext(messages:WireMessage[],resolveImage:(id:string)=>string){const ids=new Set(visibleImages(messages).map(i=>i.id));return messages.map(({images,groupMessageId,native,...m})=>{const visible=(images||[]).filter(i=>ids.has(i.id));return visible.length?{...m,content:[{type:'text',text:m.content||'工作电脑截图'},...visible.map(i=>({type:'image_url',image_url:{url:resolveImage(i.id),detail:'high'}}))]}:m;});}
export function assistantMessage(result:Completion):WireMessage{return {role:'assistant',content:result.content||null,...(result.calls.length?{tool_calls:result.calls}:{}),...(result.native?{native:result.native}:{})};}
export async function backoff(ms:number,signal:AbortSignal){signal.throwIfAborted();await new Promise<void>((resolve,reject)=>{const cleanup=()=>signal.removeEventListener('abort',abort);const timer=setTimeout(()=>{cleanup();resolve();},ms);const abort=()=>{clearTimeout(timer);cleanup();reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});});}
export class ModelClient {
 private noUsage=new Set<string>();
 private noCacheKey=new Set<string>();
 private cacheDiagnostics=new PromptCacheDiagnostics();
 private responses=new ResponsesTransport();
 dispose(){this.responses.dispose();}
 constructor(private getConfig:(botId?:string)=>ModelConfig,private getKey:(botId?:string)=>string,private resolveImage:(id:string)=>string=()=>{throw Error('屏幕图像解析器未配置');},private settings:()=>RuntimeSettings=()=>DEFAULT_RUNTIME,private observe:(record:UsageRecord)=>void=()=>{}){}
 async complete(messages:WireMessage[],tools:ToolDefinition[],signal:AbortSignal,onText:(text:string)=>void=()=>{},options:CompletionOptions={}):Promise<Completion>{
  let cfg=this.getConfig(options.botId);if(cfg.issue)throw Error(cfg.issue);if(!cfg.model.trim())throw Error('请先为这个 Bot 选择 Provider 和模型');
  cfg={...cfg,baseUrl:validateModelEndpoint(cfg.baseUrl)};const key=this.getKey(options.botId),settings=this.settings();
  if(!key&&!['localhost','127.0.0.1','[::1]'].includes(new URL(cfg.baseUrl).hostname))throw Error('请先在设置中填写 API Key');
  const contextStats=options.contextStats?{estimatedTokens:options.contextStats.estimatedTokens,calibration:options.contextStats.calibration,prunedOutputs:options.contextStats.prunedOutputs,epoch:options.contextStats.epoch,estimateSource:options.contextStats.estimateSource,contextChanges:options.contextStats.contextChanges?.slice(),archivedImages:options.contextStats.archivedImages}:undefined;
  const images=new Map<string,string>(),resolveImage=(id:string)=>{let value=images.get(id);if(value===undefined){value=this.resolveImage(id);images.set(id,value);}return value;};
  messages=structuredClone(messages);tools=stableToolDefinitions(tools);const ceiling=Math.max(256,Math.min(settings.maxOutputTokens,cfg.contextTokens,options.maxOutputTokens||65536)),requested=options.maxOutputTokens||Math.min(4096,ceiling);let output=Math.min(ceiling,Math.max(256,requested));
  const retries=options.retries??settings.modelRetries;let emitted=false,fallback=false;
  for(let attempt=0;;attempt++){
   signal.throwIfAborted();const start=Date.now(),timeout=AbortSignal.timeout(options.timeoutMs||settings.requestTimeoutMs),requestSignal=AbortSignal.any([signal,timeout]);let accumulator:StreamAccumulator|undefined,requestCache:RequestCacheDiagnostics|undefined;
   try{
    const featureKey=`${cfg.protocol||'chat'}:${nativeKey(cfg)}`,scope=options.cacheScope||options.botId,cacheKey=scope?promptCacheKey(featureKey,scope,options.purpose||'foreground'):undefined;
    const send=async()=>{const request=protocolRequest(cfg,messages,tools,output,key,resolveImage,!this.noUsage.has(featureKey),cfg.protocol==='responses'&&!this.noCacheKey.has(featureKey)?cacheKey:undefined,cacheKey);requestCache=this.cacheDiagnostics.record(cacheKey||promptCacheKey(featureKey,'unscoped',options.purpose||'foreground'),request.body);requestCache.cacheKeyRejected=this.noCacheKey.has(featureKey);requestCache.sessionAffinitySent=Boolean(cacheKey);const transport:TransportStats=Object.assign(requestCache,{transport:'http' as const,incremental:false,sentInputItems:(request.body as any).input?.length||0});const stream=websocketEnabled(cfg)?await this.responses.request(cacheKey||featureKey,request,requestSignal,transport):undefined;Object.assign(requestCache,transport);return stream||fetch(request.url,{method:'POST',redirect:'error',headers:request.headers,body:JSON.stringify(request.body),signal:requestSignal});};
    let response=await send();
    if([400,422].includes(response.status)&&cfg.protocol==='responses'&&cacheKey&&!this.noCacheKey.has(featureKey)&&rejectsPromptCacheKey(await response.clone().text())){await response.body?.cancel();if(this.noCacheKey.size>=128)this.noCacheKey.clear();this.noCacheKey.add(featureKey);response=await send();}
    if(response.status===400&&!this.noUsage.has(featureKey)&&(cfg.protocol||'chat')==='chat'){const body=await response.clone().text();if(/stream_options|include_usage/i.test(body)&&/unknown|unsupported|not supported|unrecognized|extra/i.test(body)){await response.body?.cancel();this.noUsage.add(featureKey);response=await send();}}
    if(!response.ok){const body=(await response.text()).slice(0,1200);if([400,413].includes(response.status)&&/context[_ ]?(length|window)|maximum.*tokens|too many.*tokens|prompt.*too long/i.test(body))throw new ContextOverflowError();const retry=response.headers.get('retry-after'),after=retry?Number.isFinite(Number(retry))?Number(retry)*1000:Date.parse(retry)-Date.now():0;throw new RequestError(`模型请求失败 HTTP ${response.status}: ${redactHost(body,[key])}`,[408,409,429].includes(response.status)||response.status>=500,Math.min(30000,Math.max(0,after||0)));}
    if(!response.body)throw new RequestError('模型返回空响应',true);
    let streamed='',visible='';accumulator=new StreamAccumulator(cfg.protocol||'chat',nativeKey(cfg),delta=>{streamed+=delta;const trimmed=streamed.trimStart();if('</think>'.startsWith(trimmed)&&trimmed!=='</think>')return;const clean=streamed.replace(/^\s*<\/think>\s*/,'');if(clean.length>visible.length){onText(clean.slice(visible.length));visible=clean;emitted=true;}});
    if(response.headers.get('content-type')?.includes('application/json')){const data=await response.json();if((cfg.protocol||'chat')==='chat')accumulator.consume(data);else if(cfg.protocol==='responses')accumulator.consume({type:'response.'+(data.status||'completed'),response:data});else throw new RequestError('原生模型没有返回流式协议');}
    else {
     const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',total=0,doneMarker=false;
     const line=(line:string)=>{if(!line.startsWith('data:'))return;const data=line.slice(5).trim();if(!data)return;if(data==='[DONE]'){doneMarker=true;return;}try{accumulator!.consume(JSON.parse(data));if(accumulator!.ended&&['responses','anthropic'].includes(cfg.protocol||''))doneMarker=true;}catch(error){throw new RequestError(redactHost((error as Error).message,[key]),/overload|temporar|rate.limit/i.test((error as Error).message));}};
     try{while(!doneMarker){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>16*1024*1024)throw Error('模型响应超过 16 MB');pending+=decoder.decode(next.value,{stream:true});let pos:number;while((pos=pending.indexOf('\n'))>=0){line(pending.slice(0,pos).replace(/\r$/,''));pending=pending.slice(pos+1);if(doneMarker)break;}}pending+=decoder.decode();if(!doneMarker&&pending.trim())line(pending.trim());}finally{await reader.cancel().catch(()=>{});}
    }
    signal.throwIfAborted();const result=accumulator.result();
    if(!accumulator.ended||!result.finishReason)throw new RequestError('模型连接在完整响应之前断开，未执行不完整工具调用',true);
    if(['length','incomplete'].includes(result.finishReason))throw new RequestError('模型输出达到上限，未执行不完整响应，请拆分任务后继续',true,0,true);
    if(['content_filter','SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT'].includes(result.finishReason))throw new RequestError('模型未能提供本次回复：'+result.finishReason);
    if(!result.content.trim()&&!result.calls.length)throw new RequestError('模型返回空响应',true);
    for(const call of result.calls){if(!call.id||!call.function.name)throw new RequestError('模型工具调用缺少 ID 或名称');try{const args=JSON.parse(call.function.arguments);if(!args||typeof args!=='object'||Array.isArray(args))throw Error();}catch{throw new RequestError('模型工具参数不是完整 JSON 对象，未执行');}}
    if(new Set(result.calls.map(c=>c.id)).size!==result.calls.length)throw new RequestError('模型返回重复的工具调用 ID，未执行');
    const completedRequest=protocolRequest(cfg,[...messages,assistantMessage(result)],tools,output,key,resolveImage,!this.noUsage.has(`${cfg.protocol||'chat'}:${nativeKey(cfg)}`),cfg.protocol==='responses'&&!this.noCacheKey.has(featureKey)?cacheKey:undefined,cacheKey);this.cacheDiagnostics.success(cacheKey||promptCacheKey(featureKey,'unscoped',options.purpose||'foreground'),completedRequest.body);
    if(result.usage)result.usage={...result.usage,latencyMs:Date.now()-start,attempts:attempt+1};
    this.observe({id:randomUUID(),botId:options.botId,runId:options.runId,purpose:options.purpose||'foreground',model:cfg.model,providerId:cfg.providerId,providerName:cfg.providerName,time:new Date().toISOString(),usage:result.usage,requestCache,...(contextStats?{context:contextStats}:{}),estimatedTokens:estimateRequest(messages,tools).tokens+Math.ceil(JSON.stringify(result.calls).length/3)+Math.ceil(result.content.length/3)});return result;
   }catch(error){
    const safe=redactHost((error as Error)?.message||String(error),[key]),transportCodes=transportErrorCodes(error);this.observe({id:randomUUID(),botId:options.botId,runId:options.runId,purpose:options.purpose||'foreground',model:cfg.model,providerId:cfg.providerId,providerName:cfg.providerName,time:new Date().toISOString(),usage:accumulator?.usage,requestCache,...(contextStats?{context:contextStats}:{}),...(transportCodes.length?{transportErrorCodes:transportCodes}:{}),error:safe});
    signal.throwIfAborted();if(error instanceof ContextOverflowError)throw error;
    const retryable=error instanceof RequestError?error.retryable:error instanceof TypeError||timeout.aborted;
    if(!retryable||emitted&&!options.onReset)throw Error(safe);
    if(attempt>=retries){if(!fallback&&cfg.fallbackModel?.trim()&&cfg.fallbackModel!==cfg.model){cfg={...cfg,model:cfg.fallbackModel};fallback=true;attempt=-1;}else throw Error(safe);}
    if(emitted){options.onReset?.();emitted=false;}if(error instanceof RequestError&&error.truncated){if(output>=ceiling)messages.push({role:'system',content:'上次响应超出输出预算，没有执行该响应中的调用。请缩短回复或拆分工具参数，返回完整 JSON，保留已经完成的工具结果。'});else output=Math.min(ceiling,output*2);}
    await backoff(error instanceof RequestError&&error.retryAfterMs?error.retryAfterMs:Math.min(10000,500*2**Math.max(0,attempt)),signal);
   }
  }
 }
}
