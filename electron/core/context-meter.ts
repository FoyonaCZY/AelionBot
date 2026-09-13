import type {WireMessage,ModelConfig} from '../../src/shared';
import type {Completion,ToolDefinition} from './model';
import type {CognitiveStore} from './cognitive-store';
import {estimateRequest,sourceHash} from './context-budget';
import {displayCalibration,recordDisplayCalibration} from './token-calibration';
import {nativeKey} from './model-protocol';
interface Anchor {version:1;identity:string;messages:string[];tokens:number;estimate:number;imageTokens?:number;}
export class ContextMeter {
 private anchor?:Anchor;
 private identity:string;
 private calibrationScope:string;
 constructor(private storage:CognitiveStore,private botId:string,private scope:string,private config:ModelConfig,tools:ToolDefinition[]){
  this.identity=sourceHash([{role:'system',content:JSON.stringify([config.providerId,config.baseUrl,config.protocol,config.model,config.reasoningEffort,config.thinkingBudget,config.supportsImages,tools])}]);
  this.calibrationScope='display-calibration:'+sourceHash([{role:'system',content:JSON.stringify([config.providerId,config.baseUrl,config.protocol,config.model,config.reasoningEffort,config.thinkingBudget,config.supportsImages])}]);
  try{const state=JSON.parse(storage.contextState(botId,scope,'meter')||'null');if(state?.version===1&&state.identity===this.identity)this.anchor=state;}catch{}
 }
 estimate(messages:WireMessage[],tools:ToolDefinition[],calibration:number){
  const base=estimateRequest(messages,tools,calibration),anchor=this.anchor,raw=calibration===1?base.tokens:estimateRequest(messages,tools,1).tokens;
  const kind=messages.some(message=>message.images?.length)?'vision':'text';
  const learned=displayCalibration(this.storage.contextState(this.botId,this.calibrationScope,kind),anchor&&anchor.estimate>=1024&&((anchor.imageTokens||0)>0)===(kind==='vision')?anchor.tokens/anchor.estimate:undefined);
  if(anchor&&messages.length>=anchor.messages.length&&anchor.messages.every((hash,index)=>hash===sourceHash([messages[index]]))){
   const delta=Math.max(0,raw-anchor.estimate);
   // Safety budgeting remains conservative; only the displayed incremental estimate uses the learned ratio.
   return {...base,tokens:Math.ceil(anchor.tokens+delta*calibration),estimateSource:'usage-anchor' as const,displayTokens:Math.ceil(anchor.tokens+delta*learned.factor),displaySource:'usage-anchor' as const};
  }
  return {...base,estimateSource:'tokenizer' as const,displayTokens:Math.ceil(raw*learned.factor),displaySource:learned.calibrated?'calibrated' as const:'tokenizer' as const};
 }
 record(messages:WireMessage[],tools:ToolDefinition[],result:Completion){
  if(result.inputImagesOmitted||result.requestModelKey&&result.requestModelKey!==nativeKey(this.config))return;const tokens=result.usage?.inputTokens;if(!Number.isSafeInteger(tokens)||tokens!<=0||result.native&&(result.native.protocol!==(this.config.protocol||'chat')||result.native.key!==nativeKey(this.config)))return;
  const raw=estimateRequest(messages,tools,1);
  const anchor:Anchor={version:1,identity:this.identity,messages:messages.map(message=>sourceHash([message])),tokens:tokens!,estimate:raw.tokens,imageTokens:raw.imageTokens};
  this.storage.contextState(this.botId,this.scope,'meter',JSON.stringify(anchor));this.anchor=anchor;
  const kind=messages.some(message=>message.images?.length)?'vision':'text';
  const learned=recordDisplayCalibration(this.storage.contextState(this.botId,this.calibrationScope,kind),tokens!,anchor.estimate);
  if(learned)this.storage.contextState(this.botId,this.calibrationScope,kind,learned);
 }
}
