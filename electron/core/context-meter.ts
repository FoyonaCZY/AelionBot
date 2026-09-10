import type {WireMessage,ModelConfig} from '../../src/shared';
import type {Completion,ToolDefinition} from './model';
import type {CognitiveStore} from './cognitive-store';
import {estimateRequest,sourceHash} from './context-budget';
import {nativeKey} from './model-protocol';
interface Anchor {version:1;identity:string;messages:string[];tokens:number;estimate:number;}
export class ContextMeter {
 private anchor?:Anchor;
 private identity:string;
 constructor(private storage:CognitiveStore,private botId:string,private scope:string,private config:ModelConfig,tools:ToolDefinition[]){
  this.identity=sourceHash([{role:'system',content:JSON.stringify([config.providerId,config.baseUrl,config.protocol,config.model,config.reasoningEffort,config.thinkingBudget,config.supportsImages,tools])}]);
  try{const state=JSON.parse(storage.contextState(botId,scope,'meter')||'null');if(state?.version===1&&state.identity===this.identity)this.anchor=state;}catch{}
 }
 estimate(messages:WireMessage[],tools:ToolDefinition[],calibration:number){
  const base=estimateRequest(messages,tools,calibration),anchor=this.anchor;
  if(anchor&&messages.length>=anchor.messages.length&&anchor.messages.every((hash,index)=>hash===sourceHash([messages[index]]))){
   const raw=estimateRequest(messages,tools,1).tokens,delta=Math.max(0,raw-anchor.estimate);
   // Only appended content is estimated; the already sent prefix uses actual usage.
   return {...base,tokens:Math.ceil(anchor.tokens+delta*calibration),estimateSource:'usage-anchor' as const};
  }
  return {...base,estimateSource:'tokenizer' as const};
 }
 record(messages:WireMessage[],tools:ToolDefinition[],result:Completion){
  if(result.inputImagesOmitted)return;const tokens=result.usage?.inputTokens;if(!Number.isSafeInteger(tokens)||tokens!<=0||result.native&&(result.native.protocol!==(this.config.protocol||'chat')||result.native.key!==nativeKey(this.config)))return;
  const anchor:Anchor={version:1,identity:this.identity,messages:messages.map(message=>sourceHash([message])),tokens:tokens!,estimate:estimateRequest(messages,tools,1).tokens};
  this.storage.contextState(this.botId,this.scope,'meter',JSON.stringify(anchor));this.anchor=anchor;
 }
}
