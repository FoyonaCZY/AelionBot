import {useEffect,useId,useState} from 'react';
import type {AttachmentScope} from './attachment-types';
import type {Bot} from './shared';
import type {WorkItem,WorkAction} from './work-types';
import {Avatar,Icon} from './ui';
import {CompanionBadge} from './CompanionCard';
import './work-items.css';

const labels={planning:'正在规划',ready:'等待确认',running:'执行中',paused:'已暂停',blocked:'需要处理',completed:'已完成',cancelled:'已取消'};
function WorkCard({item,bots}:{item:WorkItem;bots:Bot[]}){
  const bodyId=useId();
  const [open,setOpen]=useState(item.status==='ready'),[pending,setPending]=useState(false),[error,setError]=useState('');
  useEffect(()=>{if(item.status==='ready')setOpen(true);else if(item.status==='running')setOpen(false);},[item.status]);
  const act=async(action:WorkAction['action'])=>{if(pending)return;setPending(true);setError('');try{await window.aelion.workAction({id:item.id,action});}catch(error){setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}finally{setPending(false);}};
  const ended=['completed','cancelled'].includes(item.status),active=Boolean(item.activeRunId),steps=item.plan?.steps||[],done=steps.filter(step=>step.status==='done'||step.status==='skipped').length,bot=bots.find(bot=>bot.id===item.botId);
  const activity=item.status==='planning'?'thinking':item.status==='running'?'working':['ready','blocked'].includes(item.status)?'waiting':'idle';
  return <section className={`work-card companion-surface work-${item.status} ${open?'is-open':''}`} data-work-id={item.id} aria-label={`${item.kind==='plan'?'计划':'目标'}：${item.objective}`}>
    <div className="work-card-heading"><button type="button" className="work-card-toggle" aria-expanded={open} aria-controls={open?bodyId:undefined} aria-label={`${open?'收起':'展开'}${item.kind==='plan'?'计划':'目标'}：${item.objective}`} onClick={()=>setOpen(!open)}>
      <CompanionBadge kind={item.kind} activity={activity}/><span className="work-heading-copy"><span className="work-heading-meta"><span className="work-kind">{item.kind==='plan'?'计划':'目标'}</span><span className="work-status companion-status">{labels[item.status]}</span></span>{!open&&<span className="work-card-title" title={item.objective}>{item.objective}</span>}</span>
      {steps.length>0&&<span className="work-progress-count" aria-label={`已处理 ${done} 步，共 ${steps.length} 步`}><span aria-hidden="true">{done} / {steps.length}</span></span>}<span className="work-card-chevron"><Icon name={open?'down':'arrow'} size={13}/></span>
    </button>{item.scope.kind==='group'&&bot&&<span className="work-owner" title={bot.name}><Avatar bot={bot} size={22}/></span>}</div>
    {open&&<div className="work-card-body" id={bodyId}><p className="work-objective">{item.objective}</p>{steps.length>0&&<ol className="work-steps">{steps.map((step,index)=><li key={step.id} data-status={step.status}><span className="work-step-mark" role="img" aria-label={step.status==='done'?'已完成':step.status==='skipped'?'已跳过':step.status==='working'?'进行中':`第 ${index+1} 步`}>{step.status==='done'?<Icon name="check" size={12}/>:step.status==='skipped'?'−':step.status==='working'?<span className="work-step-orbit"/>:index+1}</span><div><strong>{step.title}</strong>{step.acceptance&&<p>{step.acceptance}</p>}{step.note&&<p className="work-step-note">{step.note}</p>}</div></li>)}</ol>}{item.summary&&<p className="work-summary">{item.summary}</p>}{item.workspaceDir&&<div className="work-directory" title={item.workspaceDir}><Icon name="folder" size={12}/><span>{item.workspaceDir}</span></div>}</div>}
    {item.reason&&!ended&&<p className="work-reason">{item.reason}</p>}
    {!ended&&<div className="work-card-actions"><button type="button" className="companion-button companion-quiet" disabled={pending} onClick={()=>void act('cancel')}>取消</button>{active?<button type="button" className="companion-button" disabled={pending||['paused','blocked'].includes(item.status)} onClick={()=>void act('pause')}><Icon name="pause" size={13}/>{item.status==='paused'?'正在暂停…':'暂停'}</button>:<button type="button" className="work-start companion-button companion-primary" disabled={pending} onClick={()=>void act('start')}>{pending?'正在处理…':item.kind==='plan'&&!item.approvedAt?(steps.length?'开始执行':'继续规划'):'继续执行'}</button>}</div>}
    {error&&<p className="work-error" role="alert">{error}</p>}
  </section>;
}
export function WorkItemsPanel({items=[],scope,bots}:{items?:WorkItem[];scope:AttachmentScope;bots:Bot[]}){
  const [history,setHistory]=useState(false);
  const scoped=items.filter(item=>item.scope.kind===scope.kind&&item.scope.id===scope.id&&bots.some(bot=>bot.id===item.botId)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  if(!scoped.length)return null;
  const active=scoped.filter(item=>!['completed','cancelled'].includes(item.status)),past=scoped.filter(item=>['completed','cancelled'].includes(item.status));
  return <div className="work-items-panel">{active.map(item=><WorkCard key={item.id} item={item} bots={bots}/>)}{past.length>0&&<><button className="work-history-toggle" aria-expanded={history} onClick={()=>setHistory(!history)}>{history?'收起':'查看'}已结束的计划与目标（{past.length}）<Icon name={history?'down':'arrow'} size={12}/></button>{history&&past.map(item=><WorkCard key={item.id} item={item} bots={bots}/>)}</>}</div>;
}
