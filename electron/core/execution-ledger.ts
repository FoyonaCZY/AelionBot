import {createHash,randomUUID} from 'node:crypto';
import {posix,win32} from 'node:path';
import type {ToolCall} from '../../src/shared';
import type {ToolExecution} from '../../src/execution-types';
import type {Store} from './store';
import {redactHost} from './host';
import {hostPathKey} from './host-platform';
import {READ_TOOLS} from './tool-pipeline';
import {boundedInteger,FileToolError} from './file-text';

// Failed reads remain in the ledger and model history, but do not represent
// unfinished side effects that must be repaired before a task can finish.
const planTools=new Set(['task_update','plan_update']);
const controlTools=new Set([...planTools,'goal_set','goal_update','execution_resolve']);
const nonBlockingFailures=new Set([...READ_TOOLS,'tools_batch',...controlTools]);
const blocksCompletion=(entry:ToolExecution)=>!entry.resolution&&(entry.status==='unknown'||entry.status==='failed'&&!nonBlockingFailures.has(entry.tool));
const isEvidence=(entry:ToolExecution)=>entry.status==='succeeded'&&!/^(execution_|task_|plan_|goal_)/.test(entry.tool);

function stable(value:unknown):string {if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+stable(item)).join(',')+'}';return JSON.stringify(value)??'null';}
export function executionTarget(tool:string,args:Record<string,unknown>,botId:string,hostWorkspace=''){
  let target:string,operation=tool;
  if(['file_write','file_read','file_patch'].includes(tool)){operation=tool==='file_read'?'vm-read':'vm-write';target=posix.resolve('/work/'+botId,String(args.path||''));}
  else if(['host_file_write','host_file_read','host_file_patch','host_list_directory'].includes(tool)){operation=tool==='host_file_read'?'host-read':tool==='host_list_directory'?'host-list':'host-write';const path=String(args.path||hostWorkspace),windows=/^[a-z]:[\\/]|^\\\\/i.test(path)||/^[a-z]:[\\/]|^\\\\/i.test(hostWorkspace),api=windows?win32:posix;target=hostPathKey(hostWorkspace&&!api.isAbsolute(path)?api.resolve(hostWorkspace,path):path,windows?'win32':process.platform);}
  else if(tool==='mcp_call'){target=String(args.server)+':'+String(args.name)+':'+createHash('sha256').update(stable(args.arguments)).digest('hex').slice(0,16);}
  else if(tool==='host_execute'){target=hostPathKey(String(args.cwd||hostWorkspace))+':'+createHash('sha256').update(String(args.command)).digest('hex').slice(0,16);}
  else target=createHash('sha256').update(stable(args)).digest('hex').slice(0,20);
  return {target:redactHost(target).slice(0,600),targetKey:createHash('sha256').update(`${botId}:${operation}:${target}`).digest('hex')};
}
export class ExecutionLedger {
  constructor(private store:Store){}
  list(botId:string,runId?:string){this.store.bot(botId);return runId?this.forTask(botId,runId):this.store.data.runs.filter(run=>run.botId===botId).flatMap(run=>run.executions||[]);}
  forTask(botId:string,runId:string){
    const run=this.store.data.runs.find(r=>r.id===runId&&r.botId===botId);if(!run)return [];
    const work=this.store.data.workItems?.find(item=>item.id===run.workItemId&&item.botId===botId),ids=new Set(work?.runIds||[runId]);
    for(const id of ids){const current=this.store.data.runs.find(r=>r.id===id&&r.botId===botId),previous=this.store.data.runs.find(r=>r.id===current?.resumedFromRunId&&r.botId===botId&&r.workspaceDir===current.workspaceDir);if(previous)ids.add(previous.id);}
    return this.store.data.runs.filter(r=>r.botId===botId&&ids.has(r.id)).flatMap(r=>r.executions||[]);
  }
  begin(botId:string,runId:string,call:ToolCall,args:Record<string,unknown>,hostWorkspace?:string){
    const run=this.store.data.runs.find(run=>run.id===runId&&run.botId===botId);if(!run)throw Error('执行任务不存在');
    const entry:ToolExecution={id:randomUUID(),callId:call.id,botId,runId,tool:call.function.name,...executionTarget(call.function.name,args,botId,hostWorkspace),status:'running',startedAt:new Date().toISOString()};
    (run.executions||=[]).push(entry);this.store.save();this.store.journal('execution.started',entry);return entry;
  }
  finish(entry:ToolExecution,status:ToolExecution['status'],output:unknown,resultId:string){
    entry.status=status;entry.resultId=resultId;entry.endedAt=new Date().toISOString();
    if(status==='failed'||status==='unknown')entry.error=redactHost(JSON.stringify(output)).slice(0,1400);
    if(status==='succeeded')for(const prior of this.forTask(entry.botId,entry.runId))if(prior.id!==entry.id&&prior.status==='failed'&&!prior.resolution){
      if(planTools.has(entry.tool)&&planTools.has(prior.tool))this.resolveEntry(prior,'unnecessary','当前计划已成功更新，旧的失败提交已被替代',[entry.id]);
      else if(prior.targetKey===entry.targetKey)this.resolveEntry(prior,'resolved','同一操作目标的后续执行成功',[entry.id]);
    }
    this.store.save();this.store.journal('execution.finished',{id:entry.id,runId:entry.runId,status,resultId});
  }
  pending(botId:string,runId:string){return this.forTask(botId,runId).filter(entry=>['failed','unknown'].includes(entry.status)&&!entry.resolution);}
  blocking(botId:string,runId:string){return this.forTask(botId,runId).filter(blocksCompletion);}
  failureMap(botId:string,runId:string){return new Map(this.blocking(botId,runId).map(entry=>[entry.id,JSON.stringify({executionId:entry.id,tool:entry.tool,target:entry.target,status:entry.status,error:entry.error})]));}
  query(botId:string,runId:string,args:Record<string,unknown>={}){
    const all=this.forTask(botId,runId),filter=args.filter??'recent',limit=boundedInteger(args.limit,10,1,50,'limit');
    if(!['recent','blocking','evidence','all'].includes(String(filter)))throw new FileToolError('INVALID_ARGUMENT','filter 必须是 recent、blocking、evidence 或 all');
    if(args.executionId!==undefined){const entry=all.find(entry=>entry.id===args.executionId);if(!entry)throw new FileToolError('EXECUTION_NOT_FOUND','当前任务没有这个 executionId，请从 execution_list 复制完整 ID');return {entry:structuredClone(entry),blocksCompletion:blocksCompletion(entry),evidenceEligible:isEvidence(entry)};}
    let end=all.length;if(args.before!==undefined){end=all.findIndex(entry=>entry.id===args.before);if(end<0)throw new FileToolError('INVALID_CURSOR','分页游标不属于当前任务，请重新查询');}
    const include=(entry:ToolExecution)=>filter==='blocking'?blocksCompletion(entry):filter==='evidence'?isEvidence(entry):filter==='all'||!['execution_list','execution_resolve','read_result'].includes(entry.tool);
    const selected=all.slice(0,end).filter(include).reverse(),items:Array<Record<string,unknown>>=[];let bytes=0;
    for(const entry of selected){const item={id:entry.id,executionId:entry.id,tool:entry.tool,status:entry.status,startedAt:entry.startedAt,resultId:entry.resultId,target:entry.target.slice(0,160),blocksCompletion:blocksCompletion(entry),evidenceEligible:isEvidence(entry),...(entry.error?{error:entry.error.slice(0,240)}:{}),...(entry.resolution?{resolution:{kind:entry.resolution.kind,evidenceIds:entry.resolution.evidenceIds}}:{})};const size=JSON.stringify(item).length;if(items.length&&(items.length>=limit||bytes+size>5000))break;items.push(item);bytes+=size;}
    const eof=items.length===selected.length;
    return {items,total:all.filter(include).length,remaining:selected.length-items.length,blockingCount:all.filter(blocksCompletion).length,eof,...(!eof&&items.length?{nextBefore:items.at(-1)!.id}:{}),order:'newest-first'};
  }
  resolve(botId:string,runId:string,args:Record<string,unknown>){
    const entries=this.forTask(botId,runId),entry=entries.find(entry=>entry.id===args.executionId);
    if(!entry||!['failed','unknown'].includes(entry.status))throw Error('没有可处理的当前任务失败记录');
    if(entry.resolution)return {resolved:true,alreadyResolved:true,executionId:entry.id,resolution:entry.resolution};
    if(entry.status==='failed'&&controlTools.has(entry.tool))return {resolved:false,required:false,executionId:entry.id,blocksCompletion:false,reason:'计划或目标更新的失败不代表外部工作未完成。读取当前计划/目标状态后继续，不需要读取无关文件来处理旧的控制记录。'};
    if(!['resolved','unnecessary'].includes(String(args.kind)))throw Error('无效处理方式');
    const reason=String(args.reason||'').trim(),ids=Array.isArray(args.evidenceIds)?[...new Set(args.evidenceIds)]:[];
    if(reason.length<8||reason.length>1200||!ids.length||ids.length>8)throw Error('需要说明处理依据，并引用后续成功执行的记录');
    if(ids.some(id=>typeof id!=='string'||!entries.some(evidence=>evidence.id===id&&isEvidence(evidence)&&evidence.startedAt>=entry.startedAt)))throw Error('处理依据必须是当前 Bot、本次任务的后续成功执行记录');
    this.resolveEntry(entry,args.kind as 'resolved'|'unnecessary',reason,ids as string[]);this.store.save();this.store.journal('execution.resolved',{id:entry.id,resolution:entry.resolution});return {resolved:true,executionId:entry.id,resolution:entry.resolution};
  }
  private resolveEntry(entry:ToolExecution,kind:'resolved'|'unnecessary',reason:string,evidenceIds:string[]){
    entry.resolution={kind,reason,evidenceIds,at:new Date().toISOString()};
    for(const message of [...this.store.data.messages,...this.store.data.peerMessages,...this.store.data.groupRunMessages])if(message.botId===entry.botId&&message.executionId===entry.id)message.executionResolved=true;
  }
}
