import {useEffect,useRef,useState} from 'react';
import type {Bot,InteractionAction,InteractionRequest} from './shared';
import {Avatar,Icon} from './ui';
import {CompanionBadge} from './CompanionCard';
import {useI18n} from './i18n';
import './interactions.css';
import './permission-modes.css';

type Permission=Extract<InteractionRequest,{kind:'host_permission'}>;
type Takeover=Extract<InteractionRequest,{kind:'vm_takeover'}>;
type Questions=Extract<InteractionRequest,{kind:'user_input'}>;
const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');
function PermissionCard({request,count}:{request:Permission;count:number}){
  const {t}=useI18n();
  const [ready,setReady]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const sending=useRef(false);
  const decide=async(action:'allow'|'allow-always'|'deny')=>{
    if(sending.current)return;sending.current=true;setPending(true);setError('');
    try{await window.aelion.respondInteraction({id:request.id,action});}catch(error){setError(errorText(error));sending.current=false;setPending(false);}
  };
  useEffect(()=>{const timer=setTimeout(()=>setReady(true),250);return()=>clearTimeout(timer);},[]);
  const details=request.details,reviewing=request.approval?.phase==='reviewing';
  const titles={delete_file:'删除或移动本机文件',command:'执行本机命令',read_file:'读取本机文件',write_file:details.overwrite?'覆盖本机文件':'写入本机文件',mcp:'使用本机 MCP 服务'};
  return <section id={`interaction-${request.id}`} className={`conversation-request permission-card companion-surface ${reviewing?'approval-reviewing':''}`} tabIndex={-1} aria-label={t('本机操作权限')}>
    <header><CompanionBadge kind="permission" activity={reviewing?'thinking':'waiting'}/><div className="request-heading-copy"><h2>{t(titles[details.operation])}</h2></div><span className="request-status companion-status">{reviewing?t('审核中'):count>1?t('还有 {count} 项',{count:count-1}):t('等待确认')}</span></header>
    <div className="permission-body">{request.approval&&(reviewing||request.approval.reason)&&<p className="approval-review-note" role="status">{reviewing?t('{reviewer} 正在审核本次操作',{reviewer:request.approval.reviewer||t('默认模型')}):request.approval.decision==='deny'?t('自动审核未放行：{reason}',{reason:request.approval.reason||''}):request.approval.reason}</p>}<p className="permission-reason">{details.reason}</p>
    <div className="permission-scope">
      {details.cwd&&<div><span>{t('工作目录')}</span><code>{details.cwd}</code></div>}
      {details.path&&<div><span>{t(details.operation==='mcp'?'来源配置':'文件路径')}</span><code>{details.path}</code></div>}
      {details.server&&<div><span>{t('服务')}</span><code>{details.server}</code></div>}
      {details.tool&&<div><span>{t('操作')}</span><code>{details.tool}</code></div>}
    </div>
    {details.command!==undefined&&<div className="permission-content"><span>{t('命令')}</span><pre tabIndex={0}>{details.command}</pre></div>}
    {details.content!==undefined&&<div className="permission-content"><span>{t('写入内容')}</span><pre tabIndex={0}>{details.content||t('（空文件）')}</pre></div>}
    {details.arguments&&<div className="permission-content"><span>{t('参数')}</span><pre tabIndex={0}>{JSON.stringify(details.arguments,null,2)}</pre></div>}
    {error&&<p className="permission-error" role="alert">{error}</p>}</div>
    <footer>
      <div className="permission-actions">
        <button type="button" className="companion-button permission-deny-button" disabled={pending} onClick={()=>void decide('deny')}>{t('拒绝本次')}</button>
        {details.commandPattern&&<button type="button" className="companion-button permission-always-button" disabled={!ready||pending} aria-label={t('始终允许 {pattern}',{pattern:details.commandPattern.pattern})} aria-describedby={`interaction-${request.id}-always-scope`} onClick={event=>{if(event.isTrusted&&event.detail<2)void decide('allow-always');}}>{t('始终允许')}</button>}
        <button type="button" className="companion-button companion-primary" disabled={!ready||pending} onClick={event=>{if(event.isTrusted&&event.detail<2)void decide('allow');}}>{pending?t('正在处理…'):t('允许本次')}</button>
      </div>
      {details.commandPattern&&<div className="permission-always-scope" id={`interaction-${request.id}-always-scope`}>
        <div className="permission-pattern"><span>{t('始终允许范围')}</span><code>{details.commandPattern.pattern}</code></div>
        <span className="permission-pattern-scope">{t('当前工作目录')} · {t(details.commandPattern.kind==='prefix'?'命令前缀匹配':'完整命令匹配')}</span>
      </div>}
    </footer>
  </section>;
}
function TakeoverCard({request,onTakeover}:{request:Takeover;onTakeover:(request:Takeover)=>Promise<void>}){
  const {t}=useI18n();
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const act=async(action:InteractionAction)=>{if(pending)return;setPending(true);setError('');try{if(action==='takeover')await onTakeover(request);else await window.aelion.respondInteraction({id:request.id,action});}catch(error){setError(errorText(error));}finally{setPending(false);}};
  return <section id={`interaction-${request.id}`} className="conversation-request takeover-card companion-surface" tabIndex={-1} aria-label={t('需要人工接管')}><header><CompanionBadge kind="takeover" activity="waiting"/><div className="request-heading-copy"><h2>{t('接管工作电脑')}</h2></div><span className="request-status companion-status">{request.phase==='controlling'?t('接管中'):t('等待接管')}</span></header><div className="permission-body"><p className="permission-reason">{request.reason}</p>{error&&<p className="permission-error" role="alert">{error}</p>}</div><footer><button type="button" className="companion-button" disabled={pending} onClick={()=>void act('cancel')}>{t('取消任务')}</button><button type="button" className="companion-button companion-primary" disabled={pending} onClick={()=>void act('takeover')}>{request.phase==='controlling'?t('返回工作电脑'):t('接管电脑')}</button></footer></section>;
}
export function ConversationInteractions({requests,botId,onTakeover}:{requests:InteractionRequest[];botId:string;onTakeover:(request:Takeover)=>Promise<void>}){
  const pending=requests.filter(request=>request.botId===botId&&(request.kind!=='host_permission'||request.approval?.phase!=='reviewing')),request=pending[0];
  if(!request)return null;
  return request.kind==='host_permission'?<PermissionCard key={request.id} request={request} count={pending.length}/>:request.kind==='user_input'?<QuestionCard key={request.id} request={request}/>:<TakeoverCard key={request.id} request={request} onTakeover={onTakeover}/>;
}
function QuestionCard({request}:{request:Questions}){
  const {t}=useI18n();
  const [answers,setAnswers]=useState<Record<string,string>>({}),[sending,setSending]=useState(false),[error,setError]=useState('');
  const send=async()=>{if(sending)return;setSending(true);setError('');try{await window.aelion.respondInteraction({id:request.id,action:'answer',answers});}catch(error){setError(errorText(error));setSending(false);}};
  return <form className="conversation-request question-card companion-surface" id={`interaction-${request.id}`} aria-label={t('回答 Bot 的问题')} onSubmit={event=>{event.preventDefault();void send();}}>
    <header><CompanionBadge kind="permission" activity="waiting"/><div className="request-heading-copy"><h2>{t('需要你的回答')}</h2></div></header>
    <div className="permission-body">{request.questions.map(question=><fieldset key={question.id} disabled={sending}><legend>{question.title}</legend>{question.options?.map(option=><label className="question-option" key={option}><input type="radio" name={`${request.id}-${question.id}`} checked={answers[question.id]===option} onChange={()=>setAnswers({...answers,[question.id]:option})}/><span>{option}</span></label>)}<textarea aria-label={t('{title}：填写回答',{title:question.title})} placeholder={question.options?t('也可以填写自己的答案'):t('填写回答')} value={question.options?.includes(answers[question.id])?'':answers[question.id]||''} maxLength={4000} rows={2} onChange={event=>setAnswers({...answers,[question.id]:event.target.value})}/></fieldset>)}{error&&<p className="permission-error" role="alert">{error}</p>}</div>
    <footer><button className="companion-button companion-primary" disabled={sending||request.questions.some(question=>!answers[question.id]?.trim())}>{sending?t('正在发送…'):t('发送回答')}</button></footer>
  </form>;
}

export function InteractionNotifications({requests,bots,onView}:{requests:InteractionRequest[];bots:Bot[];onView:(request:InteractionRequest)=>void}){
  const {t}=useI18n();
  const seen=useRef(new Set<string>()),[visible,setVisible]=useState<string>(),[paused,setPaused]=useState(false);
  useEffect(()=>{
    const incoming=requests.filter(request=>(request.kind==='host_permission'?request.approval?.phase!=='reviewing':request.phase==='waiting')&&!seen.current.has(request.id));
    for(const request of incoming)seen.current.add(request.id);
    if(incoming.length){setPaused(false);setVisible(incoming.at(-1)!.id);}
  },[requests]);
  useEffect(()=>{if(!visible||paused)return;const timer=setTimeout(()=>setVisible(current=>current===visible?undefined:current),6500);return()=>clearTimeout(timer);},[visible,paused]);
  const request=requests.find(request=>request.id===visible&&(request.kind==='host_permission'?request.approval?.phase!=='reviewing':request.phase==='waiting'));
  if(!request)return null;
  const bot=bots.find(bot=>bot.id===request.botId);
  return <aside className="interaction-notification companion-surface" role="status" aria-live="polite" onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)} onFocus={()=>setPaused(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setPaused(false);}}>
    <button className="interaction-notification-open" onClick={()=>{setVisible(undefined);onView(request);}} aria-label={t('查看 {name} 的{kind}',{name:bot?.name||'Bot',kind:t(request.kind==='host_permission'?'权限请求':request.kind==='user_input'?'问题':'接管请求')})}>
      {bot&&<Avatar bot={bot} size={34} activity="waiting"/>}<span><strong>{bot?.name||'Bot'}</strong><small>{request.kind==='host_permission'?t('等待你的本机操作许可'):request.kind==='user_input'?t('有问题需要你回答'):t('需要你接管工作电脑')}</small></span><span className="notification-view">{t('查看')}<Icon name="arrow" size={11}/></span>
    </button><button className="icon-button notification-close" aria-label={t('关闭通知')} onClick={()=>setVisible(undefined)}><Icon name="close" size={16}/></button>
  </aside>;
}
