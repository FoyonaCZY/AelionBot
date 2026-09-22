import {liveBotStep,toolOperation,type LiveBotStep} from './activity';
import type {ChatMessage,RunRecord} from './shared';
import {translate} from './i18n';

export interface LiveBotProgress extends LiveBotStep{
  runId?:string;
  description?:string;
  receipt?:string;
  recent?:Array<{id:string;time:string;label:string}>;
  since?:string;
  waitingOn?:'model'|'tool'|'stream'|'output';
  retry?:boolean;
  needsInput?:boolean;
}
const batch=(name:string)=>name==='code_exec'||name==='tools_batch';
export function liveBotProgress(messages:ChatMessage[],run?:RunRecord,waiting?:'host_permission'|'vm_takeover'|'user_input',reviewing=false):LiveBotProgress|undefined{
  const executions=(run?.executions||[]).filter(e=>e.runId===run?.id&&e.botId===run?.botId);
  const base=liveBotStep(messages,run?{...run,executions}:undefined,waiting,reviewing);if(!base||!run)return;
  const recent=executions.filter(e=>e.status==='succeeded'&&e.endedAt&&!batch(e.tool)).sort((a,b)=>Date.parse(a.endedAt!)-Date.parse(b.endedAt!)).slice(-3).map(e=>({id:e.id,time:e.endedAt!,label:translate('已完成：{label}',{label:toolOperation(e.tool).label})}));
  // Older runs may have only committed tool messages. Never count both sources.
  if(!executions.length)for(const m of messages.filter(m=>m.runId===run.id&&m.role==='tool'&&m.status==='done'&&!batch(m.tool||'')).slice(-3))recent.push({id:m.id,time:m.time,label:translate('已返回：{label}',{label:toolOperation(m.tool).label})});
  const common={...base,runId:run.id,recent,receipt:recent.at(-1)?.label};
  if(reviewing)return {...common,description:translate('正在审核操作权限。')};
  if(waiting)return {...common,description:translate(waiting==='host_permission'?'尚未执行，等待你授权。':waiting==='user_input'?'等待你的回答。':'完成操作后，请交还电脑控制权。'),needsInput:true};
  const execution=[...executions].reverse().find(e=>e.status==='running'&&!batch(e.tool))||[...executions].reverse().find(e=>e.status==='running');
  const current=[...messages].reverse().find(m=>m.runId===run.id&&m.role==='tool'&&m.status==='running');
  if(base.phase==='working'){
    const tool=batch(current?.tool||'')?execution?.tool||current?.tool:current?.tool||execution?.tool||'';
    return {...common,since:execution&&execution.tool===tool?execution.startedAt:current?.time||execution?.startedAt,waitingOn:'tool'};
  }
  const request=run.modelRequest;
  if(request){
    if(request.phase==='retrying')return {...common,label:translate(request.reason==='fallback'?'正在尝试备用模型':request.reason==='rate_limit'?'服务繁忙，正在重试':request.reason==='connect_timeout'?'连接模型服务超时，准备重试':'正在重试模型请求'),description:request.reason==='fallback'?translate('正在使用配置的备用模型继续请求。'):translate('正在进行第 {attempt} 次重试，最多 {max} 次。',{attempt:Math.max(1,request.attempt),max:request.maxRetries}),since:request.startedAt,retry:true,waitingOn:'model'};
    if(request.phase==='waiting'&&request.attempt>0){
      const reason=translate(request.reason==='connect_timeout'?'连接模型服务超时':request.reason==='timeout'?'等待模型响应超时':request.reason==='rate_limit'?'模型服务限流':'模型连接中断');
      return {...common,label:translate('等待重试请求响应'),description:translate('第 {attempt} 次重试已开始，正在等待响应。上次原因：{reason}。',{attempt:request.attempt,reason}),since:request.startedAt,waitingOn:'model'};
    }
    if(request.phase==='waiting'&&request.reason==='fallback')return {...common,label:translate('正在尝试备用模型'),description:translate('正在使用配置的备用模型继续请求。'),since:request.startedAt,waitingOn:'model'};
    if(request.phase==='streaming'&&request.activity==='tool')return {...common,label:translate('正在接收代码与工具参数'),description:translate('工具参数接收完整后开始执行。'),since:request.updatedAt,waitingOn:'output'};
    if(request.phase==='streaming'&&request.activity==='reasoning')return {...common,label:translate('模型正在处理'),since:request.updatedAt,waitingOn:'output'};
    if(request.phase==='streaming')return {...common,label:translate('正在生成回复'),since:request.updatedAt,waitingOn:'stream'};
    return {...common,label:translate('正在处理你的请求'),since:request.startedAt,waitingOn:'model'};
  }
  return {...common,label:translate(run.modelCalls?'正在准备下一步':'正在准备处理')};
}
export function waitingExplanation(step:LiveBotProgress,now:number){
  if(!step.since||!step.waitingOn||step.needsInput)return;
  const seconds=Math.floor((now-Date.parse(step.since))/1000);if(!Number.isFinite(seconds)||seconds<60)return;
  const elapsed=seconds<120?translate('超过 1 分钟'):translate('约 {count} 分钟',{count:Math.floor(seconds/60)});
  return step.waitingOn==='output'?translate('模型已有{elapsed}没有返回新的有效输出，仍在等待。',{elapsed}):step.waitingOn==='model'?translate('本次请求已等待{elapsed}，还没有返回结果。',{elapsed}):step.waitingOn==='stream'?translate('回复已有{elapsed}没有新增内容，仍在等待后续输出。',{elapsed}):translate('当前操作已持续{elapsed}，尚未返回最终结果。',{elapsed});
}
