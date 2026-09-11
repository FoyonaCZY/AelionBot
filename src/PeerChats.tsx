import {MessageTime} from './ConversationTime';
import {formatConversationTime} from './conversation-time';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {AttachmentList} from './Attachments';
import {BotWorkingStatus} from './BotWorkingStatus';
import {liveBotProgress as liveBotStep} from './live-bot-progress';
import Markdown from './MessageMarkdown';
import type {Bot,ChatMessage,RunRecord,StreamingReply as Reply} from './shared';
import type {BotIdentity,PeerChatPage,PeerExchangeView,PeerMessage,PeerView} from './peer-types';
import {peerPending,peerStatusLabel} from './peer-types';
import {Avatar,Icon,time} from './ui';
import './peer-chat.css';
import {StreamingReply} from './StreamingReply';
import type {BotActivities} from './bot-activity';
import {useI18n} from './i18n';

const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');
export interface PeerPanel {ownerId:string;threadId?:string;exchangeId?:string;}
export function PeerTaskMessage({message,view,onOpen}:{message:ChatMessage;view?:PeerView;onOpen:(panel:PeerPanel)=>void}){
  const {t}=useI18n();
  const source=message.taskSource!;
  const exchange=view?.exchanges.find(item=>item.id===source.exchangeId),thread=view?.threads.find(item=>item.id===exchange?.threadId);
  const sender=thread?.members.find(member=>member.id===source.botId)||{id:source.botId,name:source.name,color:'#8b6bea'};
  return <><MessageTime id={message.id} time={message.time}/><div className="peer-task-message"><button className="peer-task-source" disabled={!thread} onClick={()=>onOpen({ownerId:message.botId,threadId:thread!.id,exchangeId:source.exchangeId})}><Avatar bot={sender} size={19}/><span>{source.continuation?t('继续来自'):t('来自')} <strong>{sender.name}</strong> {t('的任务')}</span><Icon name="arrow" size={12}/></button><p>{message.content}</p></div></>;
}
export function PeerNotice({message,view,onOpen}:{message:ChatMessage;view?:PeerView;onOpen:(panel:PeerPanel)=>void}){
  const {t}=useI18n();
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const exchange=view?.exchanges.find(exchange=>exchange.id===message.peer?.exchangeId),thread=view?.threads.find(thread=>thread.id===exchange?.threadId);
  if(!exchange||!thread)return <div className="event-message">{message.content}</div>;
  const other=thread.members.find(member=>member.id!==message.botId)!,direction=message.peer!.direction;
  const label=direction==='sent'?t('已发送消息'):t('收到消息');
  const status=exchange.status==='completed'?'':peerStatusLabel(exchange.status);
  return <div className="peer-notice" data-exchange-id={exchange.id}>
    <button className="peer-notice-open" onClick={()=>onOpen({ownerId:message.botId,threadId:thread.id,exchangeId:exchange.id})} aria-label={t('查看与 {name} 的私聊',{name:other.name})}><span>{label}</span><Avatar bot={other} size={17}/><strong>{other.name}</strong>{status&&<span className="peer-notice-status">· {status}</span>}</button>
    {direction==='sent'&&peerPending(exchange.status)&&<button className="peer-notice-cancel" disabled={pending} onClick={async()=>{setPending(true);setError('');try{await window.aelion.cancelPeerExchange(exchange.id);}catch(error){setError(errorText(error));}finally{setPending(false);}}}>{t('取消联络')}</button>}
    {(error||direction==='failed'&&exchange.error)&&<span className="peer-notice-error" title={error||exchange.error}>{error||exchange.error}</span>}
  </div>;
}

function merged<T extends {id:string}>(older:T[],newer:T[]){const values=new Map(older.map(item=>[item.id,item]));for(const item of newer)values.set(item.id,item);return [...values.values()];}
export function PrivateChatWindow({panel,view,bots,streamingReplies=[],avatarActivities={},runs=[],messages=[],onNavigate,onClose}:{panel:PeerPanel;view?:PeerView;bots:Bot[];streamingReplies?:Reply[];avatarActivities?:BotActivities;runs?:RunRecord[];messages?:ChatMessage[];onNavigate:(panel:PeerPanel)=>void;onClose:()=>void}){
  const {t,language}=useI18n();
  const streams=streamingReplies.filter(reply=>Boolean(panel.threadId)&&reply.peerThreadId===panel.threadId),streamSignature=streams.map(reply=>reply.id+':'+reply.content).join('|');
  const root=useRef<HTMLElement>(null),body=useRef<HTMLDivElement>(null),follow=useRef(true),jump=useRef(''),scroll=useRef<{top:number;height:number}|undefined>(undefined);
  const close=useRef(onClose);close.current=onClose;
  const [page,setPage]=useState<PeerChatPage>(),[error,setError]=useState(''),[loading,setLoading]=useState(false),[olderPending,setOlderPending]=useState(false);
  const owner=bots.find(bot=>bot.id===panel.ownerId),thread=view?.threads.find(thread=>thread.id===panel.threadId)||page?.thread;
  useLayoutEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.focus({preventScroll:true});return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});else document.querySelector<HTMLElement>('.bot-item.selected')?.focus({preventScroll:true});};},[]);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(document.querySelector('.attachment-preview-layer'))return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current();}};window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true);},[]);
  useEffect(()=>{setPage(undefined);setError('');follow.current=true;jump.current=panel.exchangeId||'';},[panel.threadId]);
  useEffect(()=>{
    if(!panel.threadId)return;let active=true;setLoading(true);
    window.aelion.readPrivateChat({threadId:panel.threadId}).then(next=>{if(!active)return;setPage(previous=>previous?.thread.id===next.thread.id?{...next,messages:merged(previous.messages,next.messages),exchanges:merged(previous.exchanges,next.exchanges),before:previous.before}:next);setError('');}).catch(error=>{if(active)setError(errorText(error));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[panel.threadId,view?.revision]);
  useLayoutEffect(()=>{
    const content=body.current;if(!content||!page)return;
    if(scroll.current){content.scrollTop=scroll.current.top+content.scrollHeight-scroll.current.height;scroll.current=undefined;return;}
    if(jump.current){const target=content.querySelector<HTMLElement>(`[data-exchange-id="${CSS.escape(jump.current)}"]`);if(target){content.scrollTop=target.offsetTop-content.offsetTop-24;jump.current='';follow.current=false;return;}}
    if(follow.current)content.scrollTop=content.scrollHeight;
  },[page,streamSignature]);
  const older=async()=>{
    if(!page?.before||olderPending)return;const id=page.thread.id,before=page.before;setOlderPending(true);follow.current=false;
    try{const previous=await window.aelion.readPrivateChat({threadId:id,before});if(body.current)scroll.current={top:body.current.scrollTop,height:body.current.scrollHeight};setPage(current=>current?.thread.id===id?{...current,messages:merged(previous.messages,current.messages),exchanges:merged(previous.exchanges,current.exchanges),before:previous.before}:current);}catch(error){setError(errorText(error));}finally{setOlderPending(false);}
  };
  const member=(identity:BotIdentity)=>bots.find(bot=>bot.id===identity.id)||identity;
  return <div className="peer-chat-layer" onMouseDown={event=>{if(event.currentTarget===event.target)onClose();}}><section ref={root} className="peer-chat-window" tabIndex={-1} role="dialog" aria-modal="true" aria-label={panel.threadId?t('Bot 私聊'):t('私聊记录')} onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();return;}
    if(event.key==='Tab'){const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')).filter(item=>item.getClientRects().length);if(!buttons.length)return;const index=buttons.indexOf(document.activeElement as HTMLElement);if(event.shiftKey&&index<=0){event.preventDefault();buttons.at(-1)?.focus();}else if(!event.shiftKey&&(index===buttons.length-1||index<0)){event.preventDefault();buttons[0]?.focus();}}
  }}>
    <header className="peer-chat-header">
      {panel.threadId&&<button className="icon-button" aria-label={t('返回私聊记录')} onClick={()=>onNavigate({ownerId:panel.ownerId})}><Icon name="back" size={18}/></button>}
      <h2>{panel.threadId&&thread?<>{thread.members.map((item,index)=><span className="peer-pair" key={item.id}>{index>0&&<span aria-hidden="true">↔</span>}<Avatar bot={member(item)} size={25} activity={avatarActivities[item.id]}/><span className="peer-pair-name">{member(item).name}{!bots.some(bot=>bot.id===item.id)?t('（已删除）'):''}</span></span>)}</>:<><Icon name="message" size={21}/><span>{owner?.name||'Bot'} {t('的私聊记录')}</span></>}</h2>
      {panel.threadId&&<span className="readonly-badge">{t('只读')}</span>}<button className="icon-button" aria-label={t('关闭私聊')} onClick={onClose}><Icon name="close" size={18}/></button>
    </header>
    {error&&<div className="peer-chat-notice-error" role="alert">{error}</div>}
    <div ref={body} className={`peer-chat-body ${panel.threadId?'':'peer-chat-history'}`} onScroll={event=>{const node=event.currentTarget;follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<80;}}>
      {!panel.threadId?(()=>{const threads=view?.threads.filter(thread=>thread.members.some(member=>member.id===panel.ownerId))||[];return threads.length?threads.map(thread=>{const other=thread.members.find(member=>member.id!==panel.ownerId)!;return <button key={thread.id} className="peer-thread-row" onClick={()=>onNavigate({...panel,threadId:thread.id})}><Avatar bot={member(other)} size={36}/><span><strong>{member(other).name}{!bots.some(bot=>bot.id===other.id)?t('（已删除）'):''}</strong><small>{thread.preview}</small></span>{thread.pending>0&&<span className="peer-pending-count">{t('等待回复')}</span>}<time>{time(thread.updatedAt)}</time><Icon name="arrow" size={16}/></button>;}):<div className="peer-chat-empty">{t('还没有私聊记录')}</div>;})():<>
        {page?.before&&<button className="peer-chat-load" disabled={olderPending} onClick={()=>void older()}>{olderPending?t('正在加载…'):t('加载更早的消息')}</button>}
        {!page&&loading&&<div className="peer-chat-empty">{t('正在读取私聊记录…')}</div>}
        {page?.messages.map((message,index)=>{const exchange=view?.exchanges.find(exchange=>exchange.id===message.exchangeId)||page.exchanges.find(exchange=>exchange.id===message.exchangeId),previous=page.messages[index-1],showDate=!previous||new Date(message.time).getTime()-new Date(previous.time).getTime()>15*60*1000;return <PrivateMessage key={message.id} message={message} exchange={exchange} showDate={showDate}/>;})}
        {streams.map(reply=><StreamingReply key={reply.id} reply={reply} bots={bots} context="peer"/>)}
        {[...new Map((view?.exchanges||page?.exchanges||[]).filter(exchange=>exchange.threadId===panel.threadId&&peerPending(exchange.status)).map(exchange=>[(['reply_queued','relaying'].includes(exchange.status)?exchange.fromBotId:exchange.toBotId),exchange])).entries()].map(([id,exchange])=>{const bot=bots.find(bot=>bot.id===id)||thread?.members.find(bot=>bot.id===id),run=[...runs].reverse().find(run=>run.botId===id&&run.peerOrigin?.exchangeId===exchange.id&&run.status==='running');return bot?<BotWorkingStatus key={id} bot={bot} showName step={liveBotStep(messages,run)||{phase:'thinking',label:exchange.status==='queued'?t('正在准备处理'):['reply_queued','relaying'].includes(exchange.status)?t('正在整理回复'):t('正在思考')}}/>:null;})}
      </>}
    </div>
  </section></div>;
}
function PrivateMessage({message,exchange,showDate}:{message:PeerMessage;exchange?:PeerExchangeView;showDate:boolean}){
  const {t}=useI18n();
  const status=message.kind==='request'&&exchange&&['failed','cancelled','interrupted'].includes(exchange.status)?exchange:undefined;
  return <>{showDate&&<div className="peer-date">{formatConversationTime(message.time)}</div>}<div className="peer-message" data-exchange-id={message.exchangeId}><Avatar bot={message.sender} size={29}/><div><span className="peer-author">{message.sender.name}</span><div className="peer-bubble markdown"><Markdown>{message.content}</Markdown><AttachmentList files={message.attachments}/></div>{status&&<small className={status.status}>{t(peerStatusLabel(status.status))}{status.error?` · ${status.error}`:''}</small>}</div></div></>;
}
export function PeerNotifications({view,bots,onView}:{view?:PeerView;bots:Bot[];onView:(panel:PeerPanel)=>void}){
  const {t}=useI18n();
  const seen=useRef(new Set<string>()),seeded=useRef(false),[visible,setVisible]=useState<string>(),[paused,setPaused]=useState(false);
  useEffect(()=>{
    if(!view)return;if(!seeded.current){for(const exchange of view.exchanges)if(!peerPending(exchange.status))seen.current.add(exchange.id);seeded.current=true;}
    const incoming=view.exchanges.filter(exchange=>!exchange.parentId&&!seen.current.has(exchange.id)&&['reply_queued','relaying','completed','failed','cancelled'].includes(exchange.status));
    for(const exchange of incoming)seen.current.add(exchange.id);if(incoming.length){setVisible(incoming.at(-1)!.id);setPaused(false);}
  },[view]);
  useEffect(()=>{if(!visible||paused)return;const timer=setTimeout(()=>setVisible(undefined),6500);return()=>clearTimeout(timer);},[visible,paused]);
  const exchange=view?.exchanges.find(exchange=>exchange.id===visible),from=bots.find(bot=>bot.id===exchange?.fromBotId),other=bots.find(bot=>bot.id===exchange?.toBotId);if(!exchange||!from)return null;
  const failed=['failed','cancelled','interrupted'].includes(exchange.status);
  return <aside className="interaction-notification peer-notification" role="status" aria-live="polite" onMouseEnter={()=>setPaused(true)} onMouseLeave={()=>setPaused(false)} onFocus={()=>setPaused(true)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setPaused(false);}}><button className="interaction-notification-open" onClick={()=>{setVisible(undefined);onView({ownerId:from.id,threadId:exchange.threadId,exchangeId:exchange.id});}} aria-label={t('查看 {name} 收到的私聊回复',{name:from.name})}><Avatar bot={from} size={32}/><span><strong>{from.name}</strong><small>{failed?t('私聊联络已停止'):t('收到 {name} 的回复',{name:other?.name||'Bot'})}</small></span><span className="notification-view">{t('查看')}</span></button><button className="icon-button notification-close" aria-label={t('关闭私聊通知')} onClick={()=>setVisible(undefined)}><Icon name="close" size={16}/></button></aside>;
}
