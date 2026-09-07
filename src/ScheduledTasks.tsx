import {Select} from './Select';
import {Combobox} from './Combobox';
import {useEffect,useRef,useState} from 'react';
import {Avatar,Icon} from './ui';
import {localDateParts,nextTaskTime,sameTaskTarget,scheduleLabel,taskExecuting,wallTimeToInstant,type ScheduledTask,type ScheduledTaskStatus,type TaskSchedule,type TaskTarget} from './scheduled-types';
import './companion-cards.css';
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
    <header><h2>定时任务{scoped.length>0&&<span>{scoped.length}</span>}</h2><button type="button" className="scheduled-add" aria-label="创建定时任务" title="创建定时任务" disabled={!target} onClick={()=>setEditing('new')}><Icon name="plus" size={17}/></button></header>
    {scoped.length>0&&<div className="scheduled-filters" aria-label="筛选定时任务">{(['all','enabled','paused','completed'] as const).map(value=><button type="button" key={value} aria-pressed={filter===value} className={filter===value?'active':''} onClick={()=>setFilter(value)}>{value==='all'?'全部':statuses[value]}</button>)}</div>}
    <div className="scheduled-list">{visible.map(task=>{
      const running=taskExecuting(task),failed=Boolean(task.error)&&!running;
      return <article key={task.id} className={`scheduled-row ${task.status} ${running?'is-running':''} ${failed?'has-error':''}`} data-task-id={task.id}>
        <button type="button" className="scheduled-open" onClick={()=>setEditing(task)} aria-label={`编辑定时任务 ${task.title}`}><strong title={task.title}>{task.title}</strong><span className="scheduled-frequency" title={`${scheduleLabel(task.schedule)} · ${task.schedule.timeZone}`}>{scheduleLabel(task.schedule)}</span></button>
        <div className="scheduled-row-footer"><small className={`scheduled-next ${failed?'scheduled-failed':''}`} title={failed?task.error:undefined}>{failed?'上次执行未完成':nextLabel(task,now)}</small>{task.status!=='completed'&&<button type="button" className="scheduled-toggle" disabled={pending===task.id} aria-label={`${task.status==='enabled'?'暂停':'恢复'}定时任务 ${task.title}`} onClick={()=>void toggle(task)}>{task.status==='enabled'?'暂停':'恢复'}</button>}</div>
      </article>;
    })}{!visible.length&&<div className="scheduled-empty">{!scoped.length&&<Avatar bot={{name:'AelionBot',color:'#8b6bea'}} size={36}/>}<strong>{scoped.length?'没有符合条件的任务':'暂无定时任务'}</strong>{!target&&<p>选择一个会话来安排任务。</p>}{scoped.length?<button type="button" onClick={()=>setFilter('all')}>查看全部</button>:<button type="button" disabled={!target} onClick={()=>setEditing('new')}><Icon name="plus" size={13}/>添加任务</button>}</div>}</div>
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
  const root=useRef<HTMLElement>(null),deleteButton=useRef<HTMLButtonElement>(null),deleteCancel=useRef<HTMLButtonElement>(null),wasDeleting=useRef(false);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.querySelector('input')?.focus();return()=>{previous?.isConnected&&previous.focus();};},[]);
  useEffect(()=>{if(deleting)deleteCancel.current?.focus({preventScroll:true});else if(wasDeleting.current)deleteButton.current?.focus({preventScroll:true});wasDeleting.current=deleting;},[deleting]);
  const run=async(action:()=>Promise<unknown>)=>{if(pending)return;setPending(true);setError('');try{await action();onClose();}catch(error){setError(errorText(error));}finally{setPending(false);}};
  const currentSchedule=():TaskSchedule=>{
    if(kind==='once'){
      if(existing?.kind==='once'&&timeZone===existing.timeZone&&at===localInput(Date.parse(existing.at),timeZone))return existing;
      const [date,clock]=at.split('T'),value=date&&clock?wallTimeToInstant(date,clock,timeZone):undefined;if(value===undefined)throw new Error('执行日期或时间无效');return {kind:'once',at:new Date(value).toISOString(),timeZone};
    }
    if(kind==='interval')return {kind,minutes,timeZone};if(kind==='daily')return {kind,time,timeZone};return {kind:'weekly',time,weekdays:kind==='weekdays'?[1,2,3,4,5]:[...days].sort(),timeZone};
  };
  let dirty=Boolean(task);try{dirty=Boolean(task&&(title!==task.title||prompt!==task.prompt||status!==task.status||JSON.stringify(currentSchedule())!==JSON.stringify(task.schedule)));}catch{/* Incomplete time fields are validated on save. */}
  let preview='设置时间后查看执行安排';
  try{
    const schedule=currentSchedule(),current=live||task,savedTiming=task&&JSON.stringify(schedule)===JSON.stringify(task.schedule);
    const describeNext=(value:string)=>`下次执行 ${new Date(value).toLocaleString('zh-CN',{timeZone:schedule.timeZone,month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})}`;
    if(status==='paused')preview='已暂停，恢复后按此安排执行';
    else if(status==='completed')preview='任务已结束';
    else if(savedTiming&&current&&taskExecuting(current))preview=executionLabels[current.lastRun!.status];
    else if(savedTiming&&current?.nextRunAt)preview=Date.parse(current.nextRunAt)>Date.now()?describeNext(current.nextRunAt):'等待执行';
    else if(schedule.kind==='interval')preview=Number.isInteger(schedule.minutes)&&schedule.minutes>=1?`${scheduleLabel(schedule)}执行一次`:'请输入执行间隔';
    else{const next=nextTaskTime(schedule,Date.now());preview=next?describeNext(next):'执行时间已过去，请重新选择';}
  }catch{/* Keep partial date and timezone input editable. */}
  const save=()=>run(async()=>{
    const schedule=currentSchedule();
    if(task)await window.aelion.updateScheduledTask({id:task.id,title,prompt,schedule,status});else await window.aelion.createScheduledTask({target,title,prompt,schedule});
  });
  return <div className="scheduled-layer" onMouseDown={event=>{if(event.target===event.currentTarget&&!pending)onClose();}}><section ref={root} className="scheduled-editor companion-surface" role="dialog" aria-modal="true" aria-label={task?'编辑定时任务':'创建定时任务'} onKeyDown={event=>{
    if(event.key==='Escape'&&!pending){event.preventDefault();event.stopPropagation();if(deleting)setDeleting(false);else onClose();}
    if(event.key==='Tab'){const items=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')].filter(item=>item.tabIndex>=0),index=items.indexOf(document.activeElement as HTMLElement);if(event.shiftKey&&index<=0){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&index===items.length-1){event.preventDefault();items[0]?.focus();}}
  }}>
    <header><Avatar bot={{name:'AelionBot',color:'#8b6bea'}} size={30} activity={pending?'working':'idle'}/><div className="scheduled-editor-heading"><h2>{task?'编辑定时任务':'新建定时任务'}</h2><span title={targetName}>{target.kind==='group'?'群聊':'Bot'} · {targetName}</span></div><button type="button" className="icon-button" aria-label="关闭定时任务" disabled={pending} onClick={onClose}><Icon name="close" size={18}/></button></header>
    <form onSubmit={event=>{event.preventDefault();void save();}}><div className="scheduled-editor-body">
      <label className="scheduled-name">任务名称<input aria-label="任务名称" value={title} onChange={event=>setTitle(event.target.value)} maxLength={80} placeholder="例如：每日简报" disabled={pending} required/></label>
      <label>任务内容<textarea aria-label="任务内容" value={prompt} onChange={event=>setPrompt(event.target.value)} rows={3} maxLength={8000} placeholder="到时间后需要 Bot 做什么？" disabled={pending} required/></label>
      <section className="scheduled-timing"><h3>执行安排</h3><div className="scheduled-form-grid"><label>重复<Select aria-label="重复方式" value={kind} onChange={event=>setKind(event.target.value as typeof kind)} disabled={pending}><option value="once">仅一次</option><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="interval">固定间隔</option></Select></label>
        {kind==='once'?<label>执行时间<input aria-label="执行时间" type="datetime-local" value={at} onChange={event=>setAt(event.target.value)} disabled={pending} required/></label>:kind==='interval'?<label>间隔（分钟）<input aria-label="间隔分钟" type="number" min={1} max={525600} value={minutes} onChange={event=>setMinutes(Number(event.target.value))} disabled={pending} required/></label>:<label>时间<input aria-label="执行时刻" type="time" value={time} onChange={event=>setTime(event.target.value)} disabled={pending} required/></label>}
      </div>
      {kind==='weekly'&&<div className="scheduled-weekday-field"><span>执行日期</span><div className="scheduled-weekdays" role="group" aria-label="执行星期">{[1,2,3,4,5,6,0].map(day=><button type="button" aria-pressed={days.includes(day)} key={day} disabled={pending} className={days.includes(day)?'selected':''} onClick={()=>setDays(days.includes(day)?days.filter(value=>value!==day):[...days,day])}>周{'日一二三四五六'[day]}</button>)}</div></div>}
      <div className="scheduled-form-grid"><label>时区<Combobox aria-label="任务时区" value={timeZone} onChange={setTimeZone} options={[...new Set([defaultZone,'Asia/Shanghai','Asia/Tokyo','Europe/London','America/New_York','America/Los_Angeles','UTC'])]} emptyMessage="可直接输入其他 IANA 时区" disabled={pending} required/></label>{task&&<label>状态<Select aria-label="任务状态" value={status} onChange={event=>setStatus(event.target.value as ScheduledTaskStatus)} disabled={pending}>{Object.entries(statuses).map(([value,label])=><option value={value} key={value}>{label}</option>)}</Select></label>}</div>
      <div className="scheduled-preview"><Icon name="clock" size={14}/><span>{preview}</span></div><p className="scheduled-local-note">客户端运行时自动执行，结果发送到此会话。</p></section>
      {live?.lastRun&&<div className={`scheduled-last-run ${['failed','interrupted'].includes(live.lastRun.status)?'is-failed':''}`}><div><span className="scheduled-status-dot"/><span>{executionLabels[live.lastRun.status]}</span></div><time>{new Date(live.lastRun.finishedAt||live.lastRun.startedAt).toLocaleString('zh-CN')}</time></div>}
      {(error||live?.error)&&<p className="scheduled-error" role="alert">{error||live?.error}</p>}
    </div><footer>{deleting?<div className="scheduled-delete-confirm"><span>删除此定时任务？</span><button ref={deleteCancel} type="button" className="companion-button" disabled={pending} onClick={()=>setDeleting(false)}>取消</button><button type="button" className="companion-button scheduled-confirm-delete" disabled={pending} onClick={()=>void run(()=>window.aelion.deleteScheduledTask(task!.id))}>{pending?'正在删除…':'确认删除'}</button></div>:<>{task&&<button ref={deleteButton} type="button" className="scheduled-delete" aria-label="删除定时任务" disabled={pending} onClick={()=>setDeleting(true)}><Icon name="trash" size={14}/>删除任务</button>}<div className="scheduled-save-actions">{task&&<button type="button" className="companion-button" title={dirty?'请先保存修改':undefined} disabled={pending||dirty||Boolean(live&&taskExecuting(live))} onClick={()=>void run(()=>window.aelion.runScheduledTask(task.id))}>立即运行</button>}<button className="companion-button companion-primary" disabled={pending||!title.trim()||!prompt.trim()||kind==='weekly'&&!days.length}>{pending?'保存中…':task?'保存修改':'创建任务'}</button></div></>}</footer></form>
  </section></div>;
}
