import type {Bot,ChatMessage,WireMessage} from '../../src/shared';
import {readableContent,technicalOutput,toolDisplay} from '../../src/activity';
import type {ModelClient} from './model';
import {createHash} from 'node:crypto';
import type {RunRecord} from '../../src/shared';

export const PROGRESS_STEPS=3;
export function progressDue(run:RunRecord,steps:ChatMessage[],seconds:number,now=Date.now()){
 const digest=createHash('sha256').update(JSON.stringify(steps.map(s=>[s.executionTarget||s.tool,s.status,technicalOutput(s)]))).digest('hex');
 // New results and elapsed time are both required; a tool count must not bypass the rate limit.
 return {digest,due:steps.length>0&&now-Date.parse(run.lastProgressAt||run.startedAt)>=seconds*1000&&digest!==run.lastProgressDigest};
}
export async function describeProgress(model:ModelClient,bot:Bot,task:string,steps:ChatMessage[],signal:AbortSignal,observation?:WireMessage,onText:(text:string)=>void=()=>{}){
  const messages:WireMessage[]=[{role:'system',content:`你是 ${bot.name}，职责：${bot.role.slice(0,400)}。现在只向用户简短汇报工作进度，不调用工具。根据已执行步骤的实际结果，用一句自然的中文说明刚做完什么，以及接下来要检查或处理什么。遇到失败如实说明，不把尝试说成成功。不要宣称整个任务完成，不展示内部推理，不复述命令或 API 参数，不 @ 其他成员，不用表情回应代替。最多 100 个汉字，只返回进度正文。`},{role:'user',content:JSON.stringify({task:task.slice(0,1800),steps:steps.map(step=>({operation:toolDisplay(step).label,status:step.status,result:technicalOutput(step).slice(0,1100)}))})}];
  if(observation?.images?.length)messages.push({...observation,images:observation.images.slice(-1)});
  const result=await model.complete(messages,[],signal,onText,{botId:bot.id,runId:steps.at(-1)?.runId,purpose:'progress',maxOutputTokens:256,timeoutMs:30000});signal.throwIfAborted();
  const text=readableContent(result.content).trim();if(result.calls.length||!text||/^\[(?:群聊|表情)静默\]$/.test(text))return;
  return Array.from(text.replace(/\s+/g,' ')).slice(0,240).join('');
}
