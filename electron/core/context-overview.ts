import type {ModelConfig,WireMessage} from '../../src/shared';
import {CONTEXT_PARTS,type ContextOverview,type ContextPart} from '../../src/context-overview';
import {estimateRequest,messageTokens,textTokens} from './context-budget';
import type {ToolDefinition} from './model';

function toolPart(name:string):ContextPart{
  if(name.startsWith('mcp_'))return 'mcp';
  if(/^(skill_|skills_)/.test(name))return 'skills';
  return 'conversation';
}
/** Numeric telemetry only: does not alter the request, retain prompt text, or enter the model context. */
export function contextOverview(messages:WireMessage[],tools:ToolDefinition[],model:Pick<ModelConfig,'model'|'providerId'|'contextTokens'>,anchor?:{estimatedTokens:number;estimateSource?:'tokenizer'|'usage-anchor'}):ContextOverview{
  const parts=Object.fromEntries(CONTEXT_PARTS.map(key=>[key,0])) as Record<ContextPart,number>;
  const calls=new Map(messages.flatMap(message=>(message.tool_calls||[]).map(call=>[call.id,call.function.name] as const)));
  parts.system=3;
  for(const message of messages){
    let kind:ContextPart=message.role==='system'?'system':message.role==='tool'?toolPart(calls.get(message.tool_call_id||'')||''):'conversation';
    if((message.role==='system'&&message.content?.startsWith('当前可用技能清单：'))||(message.role==='assistant'&&message.content?.startsWith('已使用技能的参考快照（')))kind='skills';
    parts[kind]+=messageTokens(message);
  }
  // Attribute the shared JSON array framing proportionally to its real schemas.
  const schemaTokens=textTokens(JSON.stringify(tools));
  const mcp=tools.filter(tool=>tool.function.name.startsWith('mcp_')).reduce((sum,tool)=>sum+textTokens(JSON.stringify(tool)),0);
  const builtin=tools.filter(tool=>!tool.function.name.startsWith('mcp_')).reduce((sum,tool)=>sum+textTokens(JSON.stringify(tool)),0);
  parts.mcp+=Math.round(schemaTokens*mcp/Math.max(1,mcp+builtin));
  parts.tools+=schemaTokens-Math.round(schemaTokens*mcp/Math.max(1,mcp+builtin));
  const estimate=estimateRequest(messages,tools);parts.conversation+=estimate.imageTokens;
  const total=anchor&&Number.isFinite(anchor.estimatedTokens)&&anchor.estimatedTokens>0?Math.ceil(anchor.estimatedTokens):estimate.tokens;
  const raw=CONTEXT_PARTS.reduce((sum,key)=>sum+parts[key],0);
  // Proportional calibration keeps displayed categories additive, including usage-anchor estimates.
  let allocated=0;
  const fractions=CONTEXT_PARTS.map(key=>{const exact=parts[key]*total/Math.max(1,raw);parts[key]=Math.floor(exact);allocated+=parts[key];return {key,remainder:exact-parts[key]};}).sort((a,b)=>b.remainder-a.remainder);
  for(let i=0;i<total-allocated;i++)parts[fractions[i%fractions.length].key]++;
  return {model:model.model,providerId:model.providerId,capacity:model.contextTokens,tokens:total,parts,measuredAt:new Date().toISOString(),estimateSource:anchor?.estimateSource||'tokenizer'};
}
