import type {WireMessage} from '../../src/shared';

export class ContentPolicyError extends Error {
 constructor(readonly sanitized:boolean){
  super(sanitized?'当前模型拒绝了这次输入（内容审核）。已从会话中移除可能触发审核的工具输出，请再发一条消息；若仍失败请更换模型。':'当前模型拒绝了这次输入（内容审核）。可以更换模型，或发送新消息继续。');
  this.name='ContentPolicyError';
 }
}

export function contentPolicyRejected(status:number,text:string){
  return [400,403,451].includes(status)&&/content exists risk|content[_ ]filter|content[_ ]policy|prohibited_content|sensitive content|unsafe content|data_inspection|违禁|内容审核|内容.*风险/i.test(text);
}

export function omitToolResultBodies(messages:WireMessage[]){
  return messages.map(message=>{
    if(message.role!=='tool'||typeof message.content!=='string'||!message.content)return message;
    const content=policySafeToolContent(message.content);
    return content===message.content?message:{...message,content};
  });
}

export function omitToolCallArguments(messages:WireMessage[]){
  return messages.map(message=>{
    if(message.role!=='assistant'||!message.tool_calls?.length)return message;
    let changed=false;
    const tool_calls=message.tool_calls.map(call=>{
      const raw=call.function?.arguments;if(typeof raw!=='string'||!raw||/"reason"\s*:\s*"provider_content_policy"/.test(raw))return call;
      changed=true;return {...call,function:{...call.function,arguments:JSON.stringify({omitted:true,reason:'provider_content_policy'})}};
    });
    return changed?{...message,tool_calls}:message;
  });
}

export function persistOmittedToolOutputs(history:WireMessage[]){
  const omitted=omitToolCallArguments(omitToolResultBodies(history));let changed=false;
  for(let i=0;i<history.length;i++)if(history[i]!==omitted[i]){history[i]=omitted[i];changed=true;}
  return changed;
}

export function quarantinePolicyContext(history:WireMessage[],summaries?:Record<string,string>,offsets?:Record<string,number>,key?:string){
  let changed=persistOmittedToolOutputs(history);
  if(key&&summaries&&summaries[key]){delete summaries[key];changed=true;}
  if(key&&offsets&&offsets[key]!==undefined)delete offsets[key];
  return changed;
}

function policySafeToolContent(content:string){
  try{
    const parsed=JSON.parse(content);
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&(parsed.omitted===true||parsed.result?.omitted===true)&&(parsed.reason==='provider_content_policy'||parsed.result?.reason==='provider_content_policy'))return content;
    const result=parsed?.result??parsed;
    const safe:Record<string,unknown>={omitted:true,reason:'provider_content_policy'};
    if(typeof parsed?.resultId==='string'){safe.resultId=parsed.resultId;safe.readWith='read_result';}
    if(result&&typeof result==='object'&&!Array.isArray(result)){
      for(const key of ['exitCode','isError','path','vmPath','saved','durationMs','location','executed']){
        const value=(result as Record<string,unknown>)[key];
        if(typeof value==='number'||typeof value==='boolean')safe[key]=value;
        else if(typeof value==='string'&&['path','vmPath','location'].includes(key))safe[key]=value;
      }
    }
    return JSON.stringify(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&parsed.result!==undefined?{executionId:parsed.executionId,resultId:parsed.resultId,result:safe}:safe);
  }catch{
    return JSON.stringify({omitted:true,reason:'provider_content_policy'});
  }
}
