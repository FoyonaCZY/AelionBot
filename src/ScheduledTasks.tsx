import {useEffect,useRef,useState} from 'react';
import {Icon} from './ui';
import {localDateParts,sameTaskTarget,scheduleLabel,taskExecuting,wallTimeToInstant,type ScheduledTask,type ScheduledTaskStatus,type TaskSchedule,type TaskTarget} from './scheduled-types';
import './scheduled-tasks.css';

const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');
const statuses={enabled:'已开启',paused:'已暂停',completed:'已完成'};
const executionLabels={queued:'等待执行',running:'正在执行',completed:'执行完成',failed:'执行失败',cancelled:'执行已停止',interrupted:'执行中断'};
function nextLabel(task:ScheduledTask,now:number){
  if(taskExecuting(task))return executionLabels[task.lastRun!.status];
  if(task.status!=='enabled')return statuses[task.status];
  if(!task.nextRunAt)return '等待执行';const delta=Date.parse(task.nextRunAt)-now;
  if(delta<=0)return '等待会话空闲';if(delta<60000)return '即将运行';
  return `下次运行 ${delta<3600000?Math.ceil(delta/60000)+' 分钟后':delta<86400000?Math.ceil(delta/3600000)+' 小时后':Math.floor(delta/86400000)+' 天后'}`;
}
export function ScheduledTasks({target,targetName,tasks,onError,onModalChange}:{target?:TaskTarget;targetName:string;tasks:ScheduledTask[];onError:(text:string)=>void;onModalChange:(open:boolean)=>void}){
  const [filter,setFilter]=useState<'all'|ScheduledTaskStatus>('all'),[editing,setEditing]=useState<ScheduledTask|'new'>(),[pending,setPending]=useState(''),[now,setNow]=useState(Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{setEditing(undefined);setFilter('all');},[target?.kind,target?.id]);
  useEffect(()=>{onModalChange(Boolean(editing));return()=>onModalChange(false);},[Boolean(editing)]);
  const scoped=target?tasks.filter(task=>sameTaskTarget(task.target,target)):[],visible=scoped.filter(task=>filter==='all'||task.status===filter).sort((a,b)=>Number(b.status==='enabled')-Number(a.status==='enabled')||(a.nextRunAt||a.createdAt).localeCompare(b.nextRunAt||b.createdAt));
  const toggle=async(task:ScheduledTask)=>{setPending(task.id);try{await window.aelion.updateScheduledTask({id:task.id,status:task.status==='enabled'?'paused':'enabled'});}catch(error){onError(errorText(error));}finally{setPending('');}};
  return <section className="scheduled-panel" aria-label="定时任务">
    <header><h2>定时任务{scoped.length>0&&<span>{scoped.length}</span>}</h2><button className="icon-button" aria-label="创建定时任务" title="创建定时任务" disabled={!target} onClick={()=>setEditing('new')}><Icon name="plus" size={18}/></button></header>
    <div className="scheduled-filters" aria-label="筛选定时任务">{(['all','enabled','paused','completed'] as const).map(value=><button key={value} aria-pressed={filter===value} className={filter===value?'active':''} onClick={()=>setFilter(value)}>{value==='all'?'全部':statuses[value]}</button>)}</div>
    <div className="scheduled-list">{visible.map(task=><article key={task.id} className={`scheduled-row ${task.status}`} data-task-id={task.id}>
      <button className="scheduled-state" disabled={task.status==='completed'||pending===task.id} aria-label={`${task.status==='enabled'?'暂停':'恢复'}定时任务 ${task.title}`} title={task.status==='enabled'?'暂停任务':task.status==='paused'?'恢复任务':'已完成'} onClick={()=>void toggle(task)}>{task.status==='completed'?<Icon name="check" size={14}/>:task.status==='paused'?<Icon name="pause" size={12}/>:taskExecuting(task)?<span className="scheduled-running"/>:null}</button>
      <button className="scheduled-open" onClick={()=>setEditing(task)} aria-label={`编辑定时任务 ${task.title}`}><strong>{task.title}</strong><span>{scheduleLabel(task.schedule)}</span><small className={task.error?'scheduled-failed':''}>{task.error?'上次执行未完成':nextLabel(task,now)}</small></button>
    </article>)}{!visible.length&&<p className="scheduled-empty">{scoped.length?'没有符合条件的任务':'暂无定时任务'}</p>}</div>
    {editing&&target&&<ScheduledTaskEditor key={editing==='new'?'new':editing.id} task={editing==='new'?undefined:editing} live={editing==='new'?undefined:tasks.find(task=>task.id===editing.id)} target={target} targetName={targetName} onClose={()=>setEditing(undefined)}/>}
  </section>;
}

function localInput(at:number,timeZone:string){const p=localDateParts(at,timeZone),pad=(n:number)=>String(n).padStart(2,'0');return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;}
function ScheduledTaskEditor({task,live,target,targetName,onClose}:{task?:ScheduledTask;live?:ScheduledTask;target:TaskTarget;targetName:string;onClose:()=>void}){
  const existing=task?.schedule,defaultZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [title,setTitle]=useState(task?.title||''),[prompt,setPrompt]=useState(task?.prompt||''),[status,setStatus]=useState<ScheduledTaskStatus>(task?.status||'enabled');
  const [kind,setKind]=useState<'once'|'daily'|'weekdays'|'weekly'|'interval'>(existing?.kind==='weekly'&&[...existing.weekdays].sort().join(',')==='1,2,3,4,5'?'weekdays':existing?.kind||'daily');
  const [timeZone,setTimeZone]=useState(existing?.timeZone||defaultZone),[time,setTime]=useState(existing&&(existing.kind==='daily'||existing.kind==='weekly')?existing.time:'09:00'),[at,setAt]=useState(existing?.kind==='once'?localInput(Date.parse(existing.at),existing.timeZone):localInput(Date.now()+3600000,defaultZone));
  const [days,setDays]=useState(existing?.kind==='weekly'?existing.weekdays:[1]),[minutes,setMinutes]=useState(existing?.kind==='interval'?existing.minutes:60),[pending,setPending]=useState(false),[error,setError]=useState(''),[deleting,setDeleting]=useState(false);
  const root=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.querySelector('input')?.focus();return()=>{previous?.isConnected&&previous.focus();};},[]);
  const run=async(action:()=>Promise<unknown>)=>{if(pending)return;setPending(true);setError('');try{await action();onClose();}catch(error){setError(errorText(error));}finally{setPending(false);}};
  const currentSchedule=():TaskSchedule=>{
    if(kind==='once'){
      if(existing?.kind==='once'&&timeZone===existing.timeZone&&at===localInput(Date.parse(existing.at),timeZone))return existing;
      const [date,clock]=at.split('T'),value=date&&clock?wallTimeToInstant(date,clock,timeZone):undefined;if(value===undefined)throw new Error('执行日期或时间无效');return {kind:'once',at:new Date(value).toISOString(),timeZone};
    }
    if(kind==='interval')return {kind,minutes,timeZone};if(kind==='daily')return {kind,time,timeZone};return {kind:'weekly',time,weekdays:kind==='weekdays'?[1,2,3,4,5]:[...days].sort(),timeZone};
  };
  let dirty=Boolean(task);try{dirty=Boolean(task&&(title!==task.title||prompt!==task.prompt||status!==task.status||JSON.stringify(currentSchedule())!==JSON.stringify(task.schedule)));}catch{/* Incomplete time fields are validated on save. */}
  const save=()=>run(async()=>{
    const schedule=currentSchedule();
    if(task)await window.aelion.updateScheduledTask({id:task.id,title,prompt,schedule,status});else await window.aelion.createScheduledTask({target,title,prompt,schedule});
  });
  return <div className="scheduled-layer" onMouseDown={event=>{if(event.target===event.currentTarget&&!pending)onClose();}}><section ref={root} className="scheduled-editor" role="dialog" aria-modal="true" aria-label={task?'编辑定时任务':'创建定时任务'} onKeyDown={event=>{
    if(event.key==='Escape'&&!pending){event.preventDefault();event.stopPropagation();onClose();}
    if(event.key==='Tab'){const items=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')],index=items.indexOf(document.activeElement as HTMLElement);if(event.shiftKey&&index<=0){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&index===items.length-1){event.preventDefault();items[0]?.focus();}}
  }}>
    <header><div><h2>{task?'编辑定时任务':'创建定时任务'}</h2><span>{target.kind==='group'?'群聊':'Bot'} · {targetName}</span></div><button className="icon-button" aria-label="关闭定时任务" disabled={pending} onClick={onClose}><Icon name="close"/></button></header>
    <form onSubmit={event=>{event.preventDefault();void save();}}><div className="scheduled-editor-body">
      <label>任务名称<input aria-label="任务名称" value={title} onChange={event=>setTitle(event.target.value)} maxLength={80} placeholder="例如：每日简报" disabled={pending} required/></label>
      <label>任务内容<textarea aria-label="任务内容" value={prompt} onChange={event=>setPrompt(event.target.value)} rows={4} maxLength={8000} placeholder="到时间后需要 Bot 做什么？" disabled={pending} required/></label>
      <div className="scheduled-form-grid"><label>重复<select aria-label="重复方式" value={kind} onChange={event=>setKind(event.target.value as typeof kind)} disabled={pending}><option value="once">仅一次</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="interval">固定间隔</option></select></label>
        {kind==='once'?<label>执行时间<input aria-label="执行时间" type="datetime-local" value={at} onChange={event=>setAt(event.target.value)} disabled={pending} required/></label>:kind==='interval'?<label>间隔（分钟）<input aria-label="间隔分钟" type="number" min={1} max={525600} value={minutes} onChange={event=>setMinutes(Number(event.target.value))} disabled={pending} required/></label>:<label>时间<input aria-label="执行时刻" type="time" value={time} onChange={event=>setTime(event.target.value)} disabled={pending} required/></label>}
      </div>
      {kind==='weekly'&&<div className="scheduled-weekdays" aria-label="执行星期">{[1,2,3,4,5,6,0].map(day=><button type="button" aria-pressed={days.includes(day)} key={day} disabled={pending} className={days.includes(day)?'selected':''} onClick={()=>setDays(days.includes(day)?days.filter(value=>value!==day):[...days,day])}>周{'日一二三四五六'[day]}</button>)}</div>}
      <div className="scheduled-form-grid"><label>时区<input aria-label="任务时区" value={timeZone} onChange={event=>setTimeZone(event.target.value)} list="schedule-timezones" disabled={pending} required/><datalist id="schedule-timezones">{[...new Set([defaultZone,'Asia/Shanghai','Asia/Tokyo','Europe/London','America/New_York','America/Los_Angeles','UTC'])].map(zone=><option value={zone} key={zone}/>)}</datalist></label>{task&&<label>状态<select aria-label="任务状态" value={status} onChange={event=>setStatus(event.target.value as ScheduledTaskStatus)} disabled={pending}>{Object.entries(statuses).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>}</div>
      <p className="scheduled-local-note">客户端运行时自动执行，结果发送到此会话。</p>
      {live?.lastRun&&<div className="scheduled-last-run"><span>{executionLabels[live.lastRun.status]}</span><time>{new Date(live.lastRun.finishedAt||live.lastRun.startedAt).toLocaleString('zh-CN')}</time></div>}
      {(error||live?.error)&&<p className="scheduled-error" role="alert">{error||live?.error}</p>}
      {deleting&&<div className="scheduled-delete-confirm"><span>删除此定时任务？</span><button type="button" disabled={pending} onClick={()=>setDeleting(false)}>取消</button><button type="button" disabled={pending} onClick={()=>void run(()=>window.aelion.deleteScheduledTask(task!.id))}>确认删除</button></div>}
    </div><footer>{task&&<button type="button" className="scheduled-delete icon-button" aria-label="删除定时任务" disabled={pending} onClick={()=>setDeleting(true)}><Icon name="trash" size={18}/></button>}<div>{task&&<button type="button" className="secondary-button" title={dirty?'请先保存修改':undefined} disabled={pending||dirty||Boolean(live&&taskExecuting(live))} onClick={()=>void run(()=>window.aelion.runScheduledTask(task.id))}>立即运行</button>}<button className="primary-button" disabled={pending||!title.trim()||!prompt.trim()||kind==='weekly'&&!days.length}>{pending?'保存中…':task?'保存修改':'创建任务'}</button></div></footer></form>
  </section></div>;
}
