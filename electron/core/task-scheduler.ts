import {randomUUID} from 'node:crypto';
import type {Store} from './store';
import {groupPending} from '../../src/group-types';
import {nextTaskTime,sameTaskTarget,taskExecuting,type ScheduledTask,type ScheduledTaskInput,type ScheduledTaskUpdate,type TaskSchedule,type TaskTarget,type ScheduledTrigger,type ScheduledExecution} from '../../src/scheduled-types';
import type {HarnessRunOptions} from './peer-runtime-types';

interface Dispatcher {ready:(target:TaskTarget)=>boolean;send:(target:TaskTarget,prompt:string,trigger:ScheduledTrigger)=>void;}
function required(value:unknown,label:string,max:number){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new Error(`${label}无效`);return value.trim();}
export function validateTaskSchedule(value:unknown):TaskSchedule{
  if(!value||typeof value!=='object')throw new Error('请设置执行时间');const s=value as Record<string,unknown>;
  const timeZone=required(s.timeZone,'时区',100);try{new Intl.DateTimeFormat('en',{timeZone}).format();}catch{throw new Error('时区无效，请使用 Asia/Shanghai 等时区名称');}
  if(s.kind==='once'){const at=required(s.at,'执行时间',80);if(!/(Z|[+-]\d{2}:\d{2})$/i.test(at)||!Number.isFinite(Date.parse(at)))throw new Error('一次性任务需要包含时区的完整日期时间');return {kind:'once',at:new Date(at).toISOString(),timeZone};}
  if(s.kind==='interval'){if(!Number.isInteger(s.minutes)||Number(s.minutes)<1||Number(s.minutes)>525600)throw new Error('间隔应为 1–525600 分钟');return {kind:'interval',minutes:Number(s.minutes),timeZone};}
  if(s.kind!=='daily'&&s.kind!=='weekly')throw new Error('不支持的重复方式');
  if(typeof s.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))throw new Error('时间格式应为 HH:mm');
  if(s.kind==='daily')return {kind:'daily',time:s.time,timeZone};
  if(!Array.isArray(s.weekdays)||!s.weekdays.length||s.weekdays.length>7||s.weekdays.some(day=>!Number.isInteger(day)||day<0||day>6))throw new Error('请选择星期（0 为周日，1–6 为周一到周六）');
  return {kind:'weekly',time:s.time,weekdays:[...new Set(s.weekdays)].sort(),timeZone};
}

export class TaskScheduler {
  private timer?:ReturnType<typeof setInterval>;private ticking=false;private closed=false;
  constructor(private store:Store,private dispatcher:Dispatcher,private changed:()=>void,private clock:()=>number=Date.now){
    store.data.scheduledTasks||=[];
    // Existing runs are inspected after the chat queues restore their state. Never replay a claimed occurrence.
    if(this.reconcile())store.save();
  }
  private now(){return new Date(this.clock()).toISOString();}
  private save(){this.store.save();this.changed();}
  list(target?:TaskTarget){return structuredClone(this.store.data.scheduledTasks.filter(task=>!target||sameTaskTarget(task.target,target)));}
  private target(value:TaskTarget){
    if(!value||!['bot','group'].includes(value.kind)||typeof value.id!=='string')throw new Error('任务会话无效');
    if(value.kind==='bot')this.store.bot(value.id);else if(!this.store.data.groups.some(group=>group.id===value.id&&group.members.some(member=>!member.leftAt&&this.store.data.bots.some(bot=>bot.id===member.id))))throw new Error('群聊不存在或没有 Bot 成员');
    return {kind:value.kind,id:value.id};
  }
  private get(id:string){const task=this.store.data.scheduledTasks.find(task=>task.id===id);if(!task)throw new Error('定时任务不存在');return task;}
  create(input:ScheduledTaskInput,createdBy:ScheduledTask['createdBy']={kind:'user',id:'user',name:'你'}){
    if(this.closed)throw new Error('客户端正在退出');
    const target=this.target(input?.target),title=required(input.title,'任务名称',80),prompt=required(input.prompt,'任务内容',8000),schedule=validateTaskSchedule(input.schedule);
    const nextRunAt=nextTaskTime(schedule,this.clock());if(!nextRunAt)throw new Error('执行时间应晚于当前时间');
    const existing=this.store.data.scheduledTasks.find(task=>sameTaskTarget(task.target,target)&&task.status!=='completed'&&task.title===title&&task.prompt===prompt&&JSON.stringify(task.schedule)===JSON.stringify(schedule));if(existing)return structuredClone(existing);
    if(this.store.data.scheduledTasks.length>=1000||this.list(target).length>=100)throw new Error('定时任务数量已达上限');
    const task:ScheduledTask={id:randomUUID(),target,title,prompt,schedule,status:'enabled',nextRunAt,createdAt:this.now(),updatedAt:this.now(),createdBy};
    this.store.data.scheduledTasks.push(task);this.save();return structuredClone(task);
  }
  update(input:ScheduledTaskUpdate){
    const task=this.get(required(input?.id,'任务 ID',80));this.target(task.target);
    const title=input.title===undefined?task.title:required(input.title,'任务名称',80),prompt=input.prompt===undefined?task.prompt:required(input.prompt,'任务内容',8000),schedule=input.schedule===undefined?task.schedule:validateTaskSchedule(input.schedule),status=input.status??task.status;
    if(!['enabled','paused','completed'].includes(status))throw new Error('无效任务状态');
    const scheduleChanged=JSON.stringify(schedule)!==JSON.stringify(task.schedule);
    let nextRunAt=task.nextRunAt;
    if(status==='enabled'&&(status!==task.status||scheduleChanged||!nextRunAt&&!taskExecuting(task))){nextRunAt=nextTaskTime(schedule,this.clock());if(!nextRunAt)throw new Error('请先将执行时间改到未来');}
    if(status!=='enabled')nextRunAt=undefined;
    Object.assign(task,{title,prompt,schedule,status,nextRunAt,updatedAt:this.now(),error:undefined});this.save();return structuredClone(task);
  }
  remove(id:string){this.get(id);this.store.data.scheduledTasks=this.store.data.scheduledTasks.filter(task=>task.id!==id);this.save();}
  removeTarget(target:TaskTarget){this.store.data.scheduledTasks=this.store.data.scheduledTasks.filter(task=>!sameTaskTarget(task.target,target));this.save();}
  runNow(id:string){const task=this.get(id);this.target(task.target);if(taskExecuting(task))throw new Error('这项任务正在执行');if(!this.dispatcher.ready(task.target))throw new Error('会话正在处理其他任务，请稍后再试');this.dispatch(task,this.now(),true);this.save();}
  start(){if(this.timer||this.closed)return;this.tick();this.timer=setInterval(()=>this.tick(),1000);this.timer.unref?.();}
  dispose(){this.closed=true;clearInterval(this.timer);this.timer=undefined;}
  private outcome(task:ScheduledTask):Pick<ScheduledExecution,'status'|'error'>|undefined{
    const execution=task.lastRun;if(!execution)return;
    if(task.target.kind==='bot'){
      const message=this.store.data.messages.find(message=>message.scheduled?.occurrenceId===execution.id);
      if(!message)return {status:'interrupted',error:'执行记录未完整保存，未自动重试'};
      const run=message.runId?this.store.data.runs.find(run=>run.id===message.runId):undefined;
      if(run)return {status:run.status==='running'?'running':run.status,error:run.error};
      if(message.inputState==='queued')return {status:'queued'};
      return {status:message.inputState==='cancelled'?'cancelled':'interrupted',error:'执行已中断，未自动重试'};
    }
    const room=this.store.data.groups.find(room=>room.id===task.target.id),message=room?.messages.find(message=>message.scheduled?.occurrenceId===execution.id);
    if(!message)return {status:'interrupted',error:'群任务记录未完整保存，未自动重试'};
    const deliveries=this.store.data.groupDeliveries.filter(delivery=>delivery.rootId===message.rootId&&delivery.recipientId!=='user');
    if(deliveries.some(delivery=>groupPending(delivery.status)))return {status:deliveries.some(delivery=>delivery.status==='running')?'running':'queued'};
    const failed=deliveries.find(delivery=>['failed','interrupted','cancelled','limited'].includes(delivery.status));
    return failed?{status:failed.status==='interrupted'?'interrupted':failed.status==='cancelled'?'cancelled':'failed',error:failed.reason||'群任务未完成'}:{status:'completed'};
  }
  private reconcile(){
    let dirty=false;
    for(const task of this.store.data.scheduledTasks){
      if(!taskExecuting(task))continue;const outcome=this.outcome(task);if(!outcome||outcome.status===task.lastRun!.status&&outcome.error===task.lastRun!.error)continue;
      Object.assign(task.lastRun!,outcome);dirty=true;
      if(!['queued','running'].includes(outcome.status)){
        task.lastRun!.finishedAt=this.now();task.error=outcome.error?.slice(0,300);
        if(task.schedule.kind==='once'&&task.status==='enabled'&&!task.nextRunAt)task.status=outcome.status==='completed'?'completed':'paused';
      }
    }
    return dirty;
  }
  private dispatch(task:ScheduledTask,scheduledFor:string,manual=false){
    const execution:ScheduledExecution={id:randomUUID(),scheduledFor,startedAt:this.now(),status:'queued'};
    task.lastRun=execution;task.error=undefined;
    if(!manual||task.schedule.kind==='once'||task.nextRunAt&&Date.parse(task.nextRunAt)<=this.clock())task.nextRunAt=task.status==='enabled'&&task.schedule.kind!=='once'?nextTaskTime(task.schedule,Math.max(this.clock(),Date.parse(scheduledFor)),Date.parse(scheduledFor)):undefined;
    try{this.dispatcher.send(task.target,task.prompt,{taskId:task.id,occurrenceId:execution.id,title:task.title,scheduledFor});}
    catch(error){execution.status='failed';execution.finishedAt=this.now();execution.error=String((error as Error).message).slice(0,300);task.error=execution.error;task.status='paused';task.nextRunAt=undefined;}
  }
  tick(){
    if(this.closed||this.ticking)return;this.ticking=true;
    try{let dirty=this.reconcile();for(const task of this.store.data.scheduledTasks){
      if(task.status!=='enabled'||taskExecuting(task)||!task.nextRunAt||Date.parse(task.nextRunAt)>this.clock())continue;
      try{this.target(task.target);}catch(error){task.status='paused';task.error=(error as Error).message;task.nextRunAt=undefined;dirty=true;continue;}
      if(!this.dispatcher.ready(task.target))continue;
      this.dispatch(task,task.nextRunAt);dirty=true;
    }if(dirty)this.save();}finally{this.ticking=false;}
  }
  invoke(botId:string,runId:string,name:string,args:Record<string,unknown>,signal:AbortSignal,options:HarnessRunOptions){
    const run=this.store.data.runs.find(run=>run.id===runId&&run.botId===botId&&run.status==='running');if(signal.aborted||!run)throw new Error('当前任务已结束');
    const bot=this.store.bot(botId),target:TaskTarget=run.groupOrigin?{kind:'group',id:run.groupOrigin.groupId}:{kind:'bot',id:botId};
    if(target.kind==='group'&&!this.store.data.groups.some(room=>room.id===target.id&&room.members.some(member=>member.id===botId&&!member.leftAt)))throw new Error('不能管理未加入群聊的定时任务');
    if(name==='scheduled_tasks_list')return this.list(target);
    if(name==='scheduled_task_create')return this.create({target,title:args.title as string,prompt:args.prompt as string,schedule:args.schedule as TaskSchedule},{kind:'bot',id:botId,name:bot.name});
    const task=this.get(required(args.id,'任务 ID',80));if(!sameTaskTarget(task.target,target))throw new Error('只能管理当前会话的定时任务');
    if(name==='scheduled_task_update')return this.update({id:task.id,title:args.title as string|undefined,prompt:args.prompt as string|undefined,schedule:args.schedule as TaskSchedule|undefined,status:args.status as ScheduledTask['status']|undefined});
    if(name==='scheduled_task_delete'){this.remove(task.id);return {deleted:true};}
    throw new Error('未知定时任务工具');
  }
}
