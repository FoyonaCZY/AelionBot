import {liveBotStep,toolOperation,type LiveBotStep} from './activity';
import type {ChatMessage,RunRecord} from './shared';

export interface LiveBotProgress extends LiveBotStep{
  runId?:string;
  description?:string;
  receipt?:string;
  recent?:Array<{id:string;time:string;label:string}>;
  since?:string;
  waitingOn?:'model'|'tool'|'stream';
  retry?:boolean;
  needsInput?:boolean;
}
const batch=(name:string)=>name==='code_exec'||name==='tools_batch';
function purpose(tool:string){
  if(/^(host_)?file_read$|attachment_read|skill_read|skill_file_read/.test(tool))return '正在读取已有内容，结果返回后会继续处理。';
  if(/file_write|file_patch|apply_patch|skill_save|skill_patch/.test(tool))return '正在写入修改，完成后会继续核对结果。';
  if(/search|find_files|list_directory/.test(tool))return '正在查找相关内容，定位需要处理的资料。';
  if(/web_read/.test(tool))return '正在读取网页内容，等待来源返回。';
  if(/terminal|execute|code_exec/.test(tool))return '操作已经开始，正在等待执行结果。';
  if(/process_wait|process_status/.test(tool))return '正在获取后台任务的最新状态。';
  if(/mcp/.test(tool))return '请求已交给外部工具，等待返回结果。';
  if(/image|computer/.test(tool))return '正在处理工作电脑中的当前操作。';
  if(/read_result|execution_/.test(tool))return '正在核对已记录的执行结果。';
  return '当前操作结束后会继续处理任务。';
}
export function liveBotProgress(messages:ChatMessage[],run?:RunRecord,waiting?:'host_permission'|'vm_takeover'|'user_input',reviewing=false):LiveBotProgress|undefined{
  const executions=(run?.executions||[]).filter(e=>e.runId===run?.id&&e.botId===run?.botId);
  const base=liveBotStep(messages,run?{...run,executions}:undefined,waiting,reviewing);if(!base||!run)return;
  const recent=executions.filter(e=>e.status==='succeeded'&&e.endedAt&&!batch(e.tool)).sort((a,b)=>Date.parse(a.endedAt!)-Date.parse(b.endedAt!)).slice(-3).map(e=>({id:e.id,time:e.endedAt!,label:`已完成：${toolOperation(e.tool).label}`}));
  // Older runs may have only committed tool messages. Never count both sources.
  if(!executions.length)for(const m of messages.filter(m=>m.runId===run.id&&m.role==='tool'&&m.status==='done'&&!batch(m.tool||'')).slice(-3))recent.push({id:m.id,time:m.time,label:`已返回：${toolOperation(m.tool).label}`});
  const common={...base,runId:run.id,recent,receipt:recent.at(-1)?.label};
  if(reviewing)return {...common,description:'正在审核本次操作的范围，审核结束后会更新状态。'};
  if(waiting)return {...common,description:waiting==='host_permission'?'本次操作尚未执行，需要你确认后才能继续。':waiting==='user_input'?'需要你的回答，才能继续处理相关步骤。':'需要你完成电脑上的操作，再交还给伙伴。',needsInput:true};
  const execution=[...executions].reverse().find(e=>e.status==='running'&&!batch(e.tool))||[...executions].reverse().find(e=>e.status==='running');
  const current=[...messages].reverse().find(m=>m.runId===run.id&&m.role==='tool'&&m.status==='running');
  if(base.phase==='working'){
    const tool=batch(current?.tool||'')?execution?.tool||current?.tool:current?.tool||execution?.tool||'';
    return {...common,description:purpose(tool||''),since:execution&&execution.tool===tool?execution.startedAt:current?.time||execution?.startedAt,waitingOn:'tool'};
  }
  const request=run.modelRequest;
  if(request){
    if(request.phase!=='streaming'&&(request.phase==='retrying'||request.attempt>0||request.reason==='fallback'))return {...common,label:request.reason==='fallback'?'正在尝试备用模型':request.reason==='rate_limit'?'服务繁忙，正在重试':'正在重试模型请求',description:request.reason==='fallback'?'正在使用配置的备用模型继续请求。':`正在进行第 ${Math.max(1,request.attempt)} 次重试，最多 ${request.maxRetries} 次。`,since:request.startedAt,retry:true,waitingOn:'model'};
    if(request.phase==='streaming')return {...common,label:'正在生成回复',description:'已收到模型输出，内容会陆续显示在对话中。',since:request.updatedAt,waitingOn:'stream'};
    return {...common,label:'正在处理你的请求',description:'请求已发送，等待模型返回下一步。',since:request.startedAt,waitingOn:'model'};
  }
  return {...common,label:run.modelCalls?'正在准备下一步':'正在准备处理',description:run.modelCalls?'正在衔接下一步操作，已有过程消息会保留。':'已收到任务，正在准备处理所需的上下文。'};
}
export function waitingExplanation(step:LiveBotProgress,now:number){
  if(!step.since||!step.waitingOn||step.needsInput)return;
  const seconds=Math.floor((now-Date.parse(step.since))/1000);if(!Number.isFinite(seconds)||seconds<60)return;
  const elapsed=seconds<120?'超过 1 分钟':`约 ${Math.floor(seconds/60)} 分钟`;
  return step.waitingOn==='model'?`本次请求已等待${elapsed}，还没有返回结果。`:step.waitingOn==='stream'?`回复已有${elapsed}没有新增内容，仍在等待后续输出。`:`当前操作已持续${elapsed}，尚未返回最终结果。`;
}
