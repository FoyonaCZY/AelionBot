import {currentLanguage,translate} from './i18n';

export type TaskTarget={kind:'bot'|'group';id:string};
export type TaskSchedule=({kind:'once';at:string}|{kind:'daily';time:string}|{kind:'weekly';time:string;weekdays:number[]}|{kind:'interval';minutes:number})&{timeZone:string};
export type ScheduledTaskStatus='enabled'|'paused'|'completed';
export interface ScheduledTrigger {taskId:string;occurrenceId:string;title:string;scheduledFor:string;}
export interface ScheduledExecution {id:string;scheduledFor:string;startedAt:string;finishedAt?:string;status:'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted';error?:string;}
export interface ScheduledTask {id:string;target:TaskTarget;title:string;prompt:string;schedule:TaskSchedule;status:ScheduledTaskStatus;nextRunAt?:string;createdAt:string;updatedAt:string;createdBy:{kind:'user'|'bot';id:string;name:string};lastRun?:ScheduledExecution;error?:string;}
export interface ScheduledTaskInput {target:TaskTarget;title:string;prompt:string;schedule:TaskSchedule;}
export interface ScheduledTaskUpdate {id:string;title?:string;prompt?:string;schedule?:TaskSchedule;status?:ScheduledTaskStatus;}
export const sameTaskTarget=(a:TaskTarget,b:TaskTarget)=>a.kind===b.kind&&a.id===b.id;
export const taskExecuting=(task:ScheduledTask)=>Boolean(task.lastRun&&['queued','running'].includes(task.lastRun.status));

const formatters=new Map<string,Intl.DateTimeFormat>();
export function localDateParts(value:number,timeZone:string){
  let formatter=formatters.get(timeZone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});if(formatters.size>100)formatters.clear();formatters.set(timeZone,formatter);}
  const parts=Object.fromEntries(formatter.formatToParts(value).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  return {year:parts.year,month:parts.month,day:parts.day,hour:parts.hour,minute:parts.minute,second:parts.second};
}

// Resolve the first occurrence of a wall-clock minute; skip nonexistent DST minutes.
export function wallTimeToInstant(date:string,time:string,timeZone:string):number|undefined{
  const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number),wall=Date.UTC(year,month-1,day,hour,minute);
  const offsets=new Set<number>();
  for(const delta of [-86400000,0,86400000]){const at=wall+delta,p=localDateParts(at,timeZone);offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-at);}
  const candidates=[...offsets].map(offset=>wall-offset).filter(at=>{const p=localDateParts(at,timeZone);return p.year===year&&p.month===month&&p.day===day&&p.hour===hour&&p.minute===minute;});
  return candidates.length?Math.min(...candidates):undefined;
}
export function nextTaskTime(schedule:TaskSchedule,after:number,previous?:number):string|undefined{
  if(schedule.kind==='once')return Date.parse(schedule.at)>after?schedule.at:undefined;
  if(schedule.kind==='interval'){const step=schedule.minutes*60000,anchor=previous??after;return new Date(anchor+(Math.floor(Math.max(0,after-anchor)/step)+1)*step).toISOString();}
  const p=localDateParts(after,schedule.timeZone);
  for(let offset=0;offset<9;offset++){
    const day=new Date(Date.UTC(p.year,p.month-1,p.day+offset));if(schedule.kind==='weekly'&&!schedule.weekdays.includes(day.getUTCDay()))continue;
    const at=wallTimeToInstant(day.toISOString().slice(0,10),schedule.time,schedule.timeZone);if(at!==undefined&&at>after)return new Date(at).toISOString();
  }
  throw new Error('无法计算下次运行时间');
}
export function scheduleLabel(schedule:TaskSchedule){
  if(schedule.kind==='once')return new Date(schedule.at).toLocaleString(currentLanguage(),{timeZone:schedule.timeZone,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  if(schedule.kind==='interval')return translate('每 {value}',{value:schedule.minutes%60===0?translate('{count} 小时',{count:schedule.minutes/60}):translate('{count} 分钟',{count:schedule.minutes})});
  if(schedule.kind==='daily')return translate('每天 {time}',{time:schedule.time});
  const days=[...schedule.weekdays].sort((a,b)=>(a||7)-(b||7));
  return translate('{days} {time}',{days:days.join(',')==='1,2,3,4,5'?translate('工作日'):days.map(day=>translate('周{day}',{day:translate('日一二三四五六'[day])})).join(translate('、')),time:schedule.time});
}
