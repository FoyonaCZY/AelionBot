import {visibleImages} from '../../src/model-images';
import type { ModelConfig, ToolCall, WireMessage } from '../../src/shared';
export interface ToolDefinition { type:'function'; function:{name:string;description:string;parameters:Record<string,unknown>}; }
export interface Completion { content:string; calls:ToolCall[]; finishReason:string; usage?:{inputTokens:number;outputTokens:number;cachedTokens:number}; }
export interface CompletionOptions {botId?:string;maxOutputTokens?:number;timeoutMs?:number;}
export class ContextOverflowError extends Error {constructor(){super('模型报告上下文容量不足，需要压缩后继续');this.name='ContextOverflowError';}}
export function validateModelEndpoint(value:string) {
  const url=new URL(value);
  if(url.username||url.password||url.search||url.hash)throw new Error('API 地址不能包含凭据、查询参数或片段');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('API 必须使用 HTTPS，本地模型可使用 localhost HTTP');
  return url.toString().replace(/\/$/,'');
}
export function imageContext(messages:WireMessage[],resolveImage:(id:string)=>string){
  const recent=visibleImages(messages);
  const ids=new Set(recent.map(image=>image.id));
  return messages.map(({images,groupMessageId,...message})=>{
    const visible=(images||[]).filter(image=>ids.has(image.id));
    if(!visible.length)return message;
    return {...message,content:[{type:'text',text:message.content||'工作电脑截图'},...visible.map(image=>({type:'image_url',image_url:{url:resolveImage(image.id),detail:'high'}}))]};
  });
}
export class ModelClient {
  private noUsage=new Set<string>();
  constructor(private getConfig:(botId?:string)=>ModelConfig,private getKey:(botId?:string)=>string,private resolveImage:(id:string)=>string=()=>{throw new Error('屏幕图像解析器未配置');}){}
  async complete(messages:WireMessage[],tools:ToolDefinition[],signal:AbortSignal,onText:(text:string)=>void=()=>{},options:CompletionOptions={}):Promise<Completion>{
    const cfg=this.getConfig(options.botId);if(cfg.issue)throw new Error(cfg.issue);if(!cfg.model.trim())throw new Error('请先为这个 Bot 选择 Provider 和模型');
    const base=validateModelEndpoint(cfg.baseUrl);const key=this.getKey(options.botId),featureKey=`${cfg.providerId||''}:${base}:${cfg.model}`;
    if(!key&&!['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname))throw new Error('请先在设置中填写 API Key');
    const output=Math.max(256,Math.min(8192,options.maxOutputTokens||4096));
    const limit=/^(gpt-[56]|o[134])/.test(cfg.model)?{max_completion_tokens:output}:{max_tokens:output};
    const send=()=>fetch(`${base}/chat/completions`,{
      method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},
      body:JSON.stringify({model:cfg.model,messages:imageContext(messages,this.resolveImage),stream:true,...(!this.noUsage.has(featureKey)?{stream_options:{include_usage:true}}:{}),...limit,...(tools.length?{tools,tool_choice:'auto',parallel_tool_calls:false}:{})}),
      signal:AbortSignal.any([signal,AbortSignal.timeout(options.timeoutMs||180000)])
    });
    let response=await send();
    if(response.status===400&&!this.noUsage.has(featureKey)){const body=await response.clone().text();if(/stream_options|include_usage/i.test(body)&&/unknown|unsupported|not supported|unrecognized|extra/i.test(body)){this.noUsage.add(featureKey);response=await send();}}
    if(!response.ok){const body=(await response.text()).slice(0,1200);if([400,413].includes(response.status)&&/context[_ ]?(length|window)|maximum.*tokens|too many.*tokens|prompt.*too long/i.test(body))throw new ContextOverflowError();throw new Error(`模型请求失败 HTTP ${response.status}: ${key?body.replaceAll(key,'[redacted]'):body}`);}
    if(!response.body)throw new Error('模型返回空响应');
    let content='';let emitted='';let finishReason='';const calls=new Map<number,ToolCall>();let pending='';let usage:Completion['usage'];let streamDone=false;
    const consume=(line:string)=>{
      if(!line.startsWith('data:'))return;const text=line.slice(5).trim();if(!text)return;if(text==='[DONE]'){streamDone=true;return;}
      const item=JSON.parse(text);if(item.error){const message=String(item.error.message||'unknown');throw new Error(`模型流错误：${(key?message.replaceAll(key,'[redacted]'):message).slice(0,600)}`);}
      if(Number.isFinite(item.usage?.prompt_tokens)&&Number.isFinite(item.usage?.completion_tokens))usage={inputTokens:item.usage.prompt_tokens,outputTokens:item.usage.completion_tokens,cachedTokens:item.usage.prompt_tokens_details?.cached_tokens||0};
      const choice=item.choices?.[0];if(!choice)return;
      if(choice.finish_reason)finishReason=choice.finish_reason;
      const delta=choice.delta||{};
      if(typeof delta.content==='string'){
        content+=delta.content;const trimmed=content.trimStart();
        if(!'</think>'.startsWith(trimmed)||trimmed==='</think>'){
          const clean=content.replace(/^\s*<\/think>\s*/,'');if(clean.length>emitted.length){onText(clean.slice(emitted.length));emitted=clean;}
        }
      }
      for(const part of delta.tool_calls||[]){
        const index=part.index||0;const call=calls.get(index)||{id:'',type:'function' as const,function:{name:'',arguments:''}};
        if(part.id)call.id=part.id;if(part.function?.name)call.function.name+=part.function.name;
        if(part.function?.arguments)call.function.arguments+=part.function.arguments;calls.set(index,call);
      }
    };
    const reader=response.body.getReader();const decoder=new TextDecoder();
    try{
      while(!streamDone){const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let pos;
        while(!streamDone&&(pos=pending.indexOf('\n'))>=0){consume(pending.slice(0,pos).replace(/\r$/,''));pending=pending.slice(pos+1);}
      }
      if(!streamDone){pending+=decoder.decode();if(pending.trim())consume(pending.trim());}
    }finally{await reader.cancel().catch(()=>{});}
    if(signal.aborted)throw new Error('任务已取消');
    if(!finishReason)throw new Error('模型连接在完整响应之前断开，未执行不完整工具调用');
    if(finishReason==='length')throw new Error('模型输出达到上限，未执行不完整响应，请拆分任务后继续');
    for(const call of calls.values())if(!call.id||!call.function.name)throw new Error('模型工具调用缺少 ID 或名称');
    return {content:content.replace(/^\s*<\/think>\s*/,''),calls:[...calls.values()],finishReason,...(usage?{usage}:{})};
  }
}
