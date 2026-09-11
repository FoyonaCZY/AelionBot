import {useEffect,useState} from 'react';
import type {Bot} from './shared';
import {waitingExplanation,type LiveBotProgress} from './live-bot-progress';
import {Avatar,Icon} from './ui';
import {useI18n} from './i18n';
import './bot-working-status.css';

export function BotWorkingStatus({bot,step,showName=false,onStop,onReview}:{bot:Pick<Bot,'id'|'name'|'color'|'avatarStyle'>;step:LiveBotProgress;showName?:boolean;onStop?:()=>Promise<unknown>;onReview?:()=>void}){
  const {t,language}=useI18n();
  const [now,setNow]=useState(Date.now),[expanded,setExpanded]=useState(false),[stopping,setStopping]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setNow(Date.now());if(!step.since)return;const timer=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(timer);},[step.since]);
  useEffect(()=>{setExpanded(false);setError('');setStopping(false);},[step.runId]);
  const slow=waitingExplanation(step,now),description=slow||step.description||t('已收到任务，正在准备处理。'),recent=step.recent||[];
  const stop=async()=>{if(!onStop||stopping)return;setStopping(true);setError('');try{await onStop();}catch(reason){setError((reason as Error).message);setStopping(false);}};
  return <div className="bot-working-status" data-working-bot={bot.id} data-phase={step.phase}>
    <span className="bot-working-avatar" aria-hidden="true"><Avatar bot={bot} size={48} activity={step.phase}/></span>
    <div className="bot-working-copy">{showName&&<span className="bot-working-name">{bot.name}</span>}
      <div role="status" aria-live="polite" aria-atomic="true"><div className="bot-working-title"><span className="bot-working-label">{slow&&step.waitingOn==='model'&&!step.retry?t('还在等待模型回复'):step.label}</span>{slow&&<span className="bot-working-tag">{t('等待较久')}</span>}</div><p className="bot-working-description">{description}</p></div>
      {(step.detail||step.receipt||slow||recent.length>0)&&<div className="bot-working-meta"><span>{slow?(step.receipt||t('可以切换会话，任务会继续。')):step.detail?t('当前：{detail}',{detail:step.detail}):step.receipt}</span>{recent.length>0&&<button type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?t('收起进展'):t('查看进展')}<Icon name="down" size={12}/></button>}</div>}
      {expanded&&recent.length>0&&<ol className="bot-working-recent" aria-label={t('最近确认的进展')}>{recent.map(item=><li key={item.id}><time dateTime={item.time}>{Number.isFinite(Date.parse(item.time))?new Date(item.time).toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit'}):'—'}</time><span>{item.label}</span></li>)}</ol>}
      {(step.needsInput&&onReview||(slow||step.retry)&&onStop)&&<div className="bot-working-actions">{step.needsInput&&onReview&&<button type="button" onClick={onReview}>{t('查看请求')}<Icon name="arrow" size={12}/></button>}{(slow||step.retry)&&onStop&&<button type="button" disabled={stopping} onClick={()=>void stop()}>{stopping?t('正在停止…'):t('停止任务')}</button>}</div>}
      {error&&<p className="bot-working-error" role="alert">{error}</p>}
    </div>
  </div>;
}
