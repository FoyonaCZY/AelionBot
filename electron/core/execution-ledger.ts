import {createHash,randomUUID} from 'node:crypto';
import {posix,win32} from 'node:path';
import type {ToolCall} from '../../src/shared';
import type {ToolExecution} from '../../src/execution-types';
import type {Store} from './store';
import {redactHost} from './host';

function stable(value:unknown):string {if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+stable(item)).join(',')+'}';return JSON.stringify(value)??'null';}
export function executionTarget(tool:string,args:Record<string,unknown>,botId:string,hostWorkspace=''){
  let target:string,operation=tool;
  if(['file_write','file_read','file_patch'].includes(tool)){operation=tool==='file_read'?'vm-read':'vm-write';target=posix.resolve('/work/'+botId,String(args.path||''));}
  else if(['host_file_write','host_file_read','host_file_patch'].includes(tool)){operation=tool==='host_file_read'?'host-read':'host-write';target=win32.normalize(String(args.path||'')).toLowerCase();}
  else if(tool==='mcp_call'){target=String(args.server)+':'+String(args.name)+':'+createHash('sha256').update(stable(args.arguments)).digest('hex').slice(0,16);}
  else if(tool==='host_execute'){target=(String(args.cwd||hostWorkspace)).toLowerCase()+':'+createHash('sha256').update(String(args.command)).digest('hex').slice(0,16);}
  else target=createHash('sha256').update(stable(args)).digest('hex').slice(0,20);
  return {target:redactHost(target).slice(0,600),targetKey:createHash('sha256').update(`${botId}:${operation}:${target}`).digest('hex')};
}
export class ExecutionLedger {
  constructor(private store:Store){}
  list(botId:string,runId?:string){this.store.bot(botId);const run=this.store.data.runs.find(r=>r.id===runId&&r.botId===botId),work=this.store.data.workItems?.find(w=>w.id===run?.workItemId&&w.botId===botId);return this.store.data.runs.filter(run=>run.botId===botId&&(!runId||run.id===runId||work?.runIds.includes(run.id))).flatMap(run=>run.executions||[]);}
  forTask(botId:string,runId:string){const run=this.store.data.runs.find(r=>r.id===runId&&r.botId===botId),work=this.store.data.workItems?.find(item=>item.id===run?.workItemId&&item.botId===botId);return work?this.store.data.runs.filter(r=>r.botId===botId&&work.runIds.includes(r.id)).flatMap(r=>r.executions||[]):this.list(botId,runId);}
  begin(botId:string,runId:string,call:ToolCall,args:Record<string,unknown>,hostWorkspace?:string){
    const run=this.store.data.runs.find(run=>run.id===runId&&run.botId===botId);if(!run)throw Error('执行任务不存在');
    const entry:ToolExecution={id:randomUUID(),callId:call.id,botId,runId,tool:call.function.name,...executionTarget(call.function.name,args,botId,hostWorkspace),status:'running',startedAt:new Date().toISOString()};
    (run.executions||=[]).push(entry);this.store.save();this.store.journal('execution.started',entry);return entry;
  }
  finish(entry:ToolExecution,status:ToolExecution['status'],output:unknown,resultId:string){
    entry.status=status;entry.resultId=resultId;entry.endedAt=new Date().toISOString();
    if(status==='failed'||status==='unknown')entry.error=redactHost(JSON.stringify(output)).slice(0,1400);
    if(status==='succeeded')for(const prior of this.forTask(entry.botId,entry.runId))if(prior.id!==entry.id&&prior.targetKey===entry.targetKey&&prior.status==='failed'&&!prior.resolution)this.resolveEntry(prior,'resolved','同一操作目标的后续执行成功',[entry.id]);
    this.store.save();this.store.journal('execution.finished',{id:entry.id,runId:entry.runId,status,resultId});
  }
  pending(botId:string,runId:string){return this.forTask(botId,runId).filter(entry=>['failed','unknown'].includes(entry.status)&&!entry.resolution);}
  failureMap(botId:string,runId:string){return new Map(this.pending(botId,runId).map(entry=>[entry.id,JSON.stringify({executionId:entry.id,tool:entry.tool,target:entry.target,status:entry.status,error:entry.error})]));}
  resolve(botId:string,runId:string,args:Record<string,unknown>){
    const entries=this.forTask(botId,runId),entry=entries.find(entry=>entry.id===args.executionId);
    if(!entry||!['failed','unknown'].includes(entry.status)||entry.resolution)throw Error('没有可处理的当前任务失败记录');
    if(!['resolved','unnecessary'].includes(String(args.kind)))throw Error('无效处理方式');
    const reason=String(args.reason||'').trim(),ids=Array.isArray(args.evidenceIds)?[...new Set(args.evidenceIds)]:[];
    if(reason.length<8||reason.length>1200||!ids.length||ids.length>8)throw Error('需要说明处理依据，并引用后续成功执行的记录');
    if(ids.some(id=>typeof id!=='string'||!entries.some(evidence=>evidence.id===id&&evidence.status==='succeeded'&&!/^(execution_|task_|plan_|goal_)/.test(evidence.tool)&&evidence.startedAt>=entry.startedAt)))throw Error('处理依据必须是当前 Bot、本次任务的后续成功执行记录');
    this.resolveEntry(entry,args.kind as 'resolved'|'unnecessary',reason,ids as string[]);this.store.save();this.store.journal('execution.resolved',{id:entry.id,resolution:entry.resolution});return {resolved:true,executionId:entry.id,resolution:entry.resolution};
  }
  private resolveEntry(entry:ToolExecution,kind:'resolved'|'unnecessary',reason:string,evidenceIds:string[]){
    entry.resolution={kind,reason,evidenceIds,at:new Date().toISOString()};
    for(const message of [...this.store.data.messages,...this.store.data.peerMessages,...this.store.data.groupRunMessages])if(message.botId===entry.botId&&message.executionId===entry.id)message.executionResolved=true;
  }
}
