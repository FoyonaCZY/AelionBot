import type {ModelProtocol} from '../../src/model-types';
import type {ModelUsage} from '../../src/runtime-types';

const count=(value:unknown):number|undefined=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;

// Keep missing values absent: a compatible endpoint may not report cache usage.
export function modelUsage(protocol:ModelProtocol,raw:any,previous?:ModelUsage):ModelUsage|undefined {
  if(!raw||typeof raw!=='object')return previous;
  let usage:ModelUsage;
  if(protocol==='responses')usage={inputTokens:count(raw.input_tokens),outputTokens:count(raw.output_tokens),totalTokens:count(raw.total_tokens),cachedTokens:count(raw.input_tokens_details?.cached_tokens),cacheWriteTokens:count(raw.input_tokens_details?.cache_write_tokens),reasoningTokens:count(raw.output_tokens_details?.reasoning_tokens)};
  else if(protocol==='chat')usage={inputTokens:count(raw.prompt_tokens),outputTokens:count(raw.completion_tokens),totalTokens:count(raw.total_tokens),cachedTokens:count(raw.prompt_tokens_details?.cached_tokens),cacheWriteTokens:count(raw.prompt_tokens_details?.cache_write_tokens),reasoningTokens:count(raw.completion_tokens_details?.reasoning_tokens)};
  else if(protocol==='anthropic'){
    const read=count(raw.cache_read_input_tokens)??previous?.cachedTokens,write=count(raw.cache_creation_input_tokens)??previous?.cacheWriteTokens;
    const ordinary=count(raw.input_tokens)??(previous?.inputTokens===undefined?undefined:Math.max(0,previous.inputTokens-(previous.cachedTokens??0)-(previous.cacheWriteTokens??0)));
    usage={inputTokens:ordinary===undefined?undefined:ordinary+(read??0)+(write??0),outputTokens:count(raw.output_tokens),cachedTokens:read,cacheWriteTokens:write};
  }else {
    const thoughts=count(raw.thoughtsTokenCount)??previous?.reasoningTokens,candidates=count(raw.candidatesTokenCount)??(previous?.outputTokens===undefined?undefined:Math.max(0,previous.outputTokens-(previous.reasoningTokens??0)));
    usage={inputTokens:count(raw.promptTokenCount),outputTokens:candidates===undefined?undefined:candidates+(thoughts??0),totalTokens:count(raw.totalTokenCount),cachedTokens:count(raw.cachedContentTokenCount),reasoningTokens:thoughts};
  }
  const fields=Object.fromEntries(Object.entries(usage).filter(([,value])=>value!==undefined));
  if(!Object.keys(fields).length)return previous;
  const result:ModelUsage={...previous,...fields,version:2};
  // Cumulative streaming counts replace earlier counts; they are never summed per event.
  const countersChanged=['input_tokens','output_tokens','prompt_tokens','completion_tokens','promptTokenCount','candidatesTokenCount','thoughtsTokenCount','cache_read_input_tokens','cache_creation_input_tokens'].some(key=>count(raw[key])!==undefined);
  if(result.inputTokens!==undefined&&result.outputTokens!==undefined&&count(raw.total_tokens??raw.totalTokenCount)===undefined&&(countersChanged||result.totalTokens===undefined)){
    const extra=protocol==='gemini'&&previous?.totalTokens!==undefined&&previous.inputTokens!==undefined&&previous.outputTokens!==undefined?Math.max(0,previous.totalTokens-previous.inputTokens-previous.outputTokens):0;
    result.totalTokens=result.inputTokens+result.outputTokens+extra;
  }
  return result;
}
