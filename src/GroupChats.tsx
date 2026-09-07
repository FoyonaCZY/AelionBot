import {WorkItemsPanel} from './WorkItems';
import {workspaceKey} from './work-types';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {Bot,ChatMessage,InteractionRequest,Snapshot} from './shared';
import {GROUP_LIMITS,type GroupPage,type GroupSummary,type GroupsView} from './group-types';
import {Avatar,Icon,time,FileCard,MentionContent,type FileItem} from './ui';
import {groupReplyContent} from './message-envelope';
import {botMentions} from './mentions';
import {BotComposer,type ComposerDraft} from './BotComposer';
import {ConversationInteractions} from './InteractionPrompts';
import './group-chat.css';
import {AttachmentList} from './Attachments';
import {attachmentSummary} from './attachment-types';
import {MessageActions} from './MessagePins';
import type {BotActivities} from './bot-activity';

const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');
const merge=<T extends {id:string}>(older:T[],newer:T[])=>[...new Map([...older,...newer].map(item=>[item.id,item])).values()];
export function GroupAvatar({group,activities={}}:{group:GroupSummary;activities?:BotActivities}){
  const members=group.members.filter(member=>!member.leftAt).slice(0,4);
  return <span className="group-avatar" data-count={members.length} role="img" aria-label="群聊">{members.length?members.map(member=><Avatar key={member.id} bot={member} activity={activities[member.id]}/>):<Icon name="message" size={23}/>}</span>;
}
export function GroupTaskMessage({message,view,onOpen}:{message:ChatMessage;view?:GroupsView;onOpen:(id:string)=>void}){
  const source=message.groupTaskSource!,room=view?.rooms.find(room=>room.id===source.groupId);
  return <div className="peer-task-message group-task-message"><button className="peer-task-source" disabled={!room} onClick={()=>onOpen(source.groupId)}><Icon name="message" size={17}/><span>{source.continuation?'继续来自':'来自'} <strong>{room?.name||source.name}</strong> 的群任务</span><Icon name="arrow" size={12}/></button><p><MentionContent content={message.content} mentions={message.mentions}/></p></div>;
}
export function GroupEditor({bots,group,onClose,onSaved,onDeleted}:{bots:Bot[];group?:GroupSummary;onClose:()=>void;onSaved:(id:string)=>void;onDeleted:(id:string)=>void}){
  const [name,setName]=useState(group?.name||''),[ids,setIds]=useState(group?.members.filter(m=>!m.leftAt&&bots.some(b=>b.id===m.id)).map(m=>m.id)||[]),[error,setError]=useState(''),[pending,setPending]=useState(false),[deleting,setDeleting]=useState(false);
  const root=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.querySelector('input')?.focus();return()=>{previous?.isConnected&&previous.focus();};},[]);
  const save=async()=>{if(pending)return;setPending(true);setError('');try{if(group){await window.aelion.updateGroup({id:group.id,name,botIds:ids});onSaved(group.id);}else{const result=await window.aelion.createGroup({name,botIds:ids});onSaved(result.id);}}catch(error){setError(errorText(error));}finally{setPending(false);}};
  return <div className="peer-chat-layer group-editor-layer" onMouseDown={event=>{if(event.target===event.currentTarget&&!pending)onClose();}}><section ref={root} className="group-editor" role="dialog" aria-modal="true" aria-label={group?'群聊设置':'创建群聊'} onKeyDown={event=>{
    if(event.key==='Escape'&&!pending){event.preventDefault();event.stopPropagation();onClose();}
    if(event.key==='Tab'){const items=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];const index=items.indexOf(document.activeElement as HTMLElement);if(event.shiftKey&&index<=0){event.preventDefault();items.at(-1)?.focus();}else if(!event.shiftKey&&index===items.length-1){event.preventDefault();items[0]?.focus();}}
  }}>
    <header><h2>{group?'群聊设置':'创建群聊'}</h2><button className="icon-button" aria-label="关闭群聊设置" disabled={pending} onClick={onClose}><Icon name="close"/></button></header>
    <label className="group-name">群名称<input value={name} maxLength={80} placeholder="例如：项目协作" onChange={event=>setName(event.target.value)}/></label>
    <div className="group-member-title"><span>成员</span><small>你 + {ids.length} 位 Bot</small></div>
    <div className="group-member-picker">{bots.map(bot=><label key={bot.id}><input type="checkbox" checked={ids.includes(bot.id)} disabled={pending||!ids.includes(bot.id)&&ids.length>=GROUP_LIMITS.bots} onChange={event=>setIds(value=>event.target.checked?[...value,bot.id]:value.filter(id=>id!==bot.id))}/><Avatar bot={bot} size={32}/><span><strong>{bot.name}</strong><small>{bot.role||'Bot'}</small></span></label>)}{bots.length<2&&!group&&<p className="subtle">至少需要两位 Bot 才能建群。</p>}</div>
    {error&&<p className="group-error" role="alert">{error}</p>}
    {deleting&&<div className="group-delete-confirm"><p>删除「{group?.name}」及群聊记录？群内正在处理的任务也会停止。</p><button className="secondary-button" disabled={pending} onClick={()=>setDeleting(false)}>取消</button><button className="danger-button" disabled={pending} onClick={async()=>{setPending(true);try{await window.aelion.deleteGroup(group!.id);onDeleted(group!.id);}catch(error){setError(errorText(error));}finally{setPending(false);}}}>确认删除</button></div>}
    <footer>{group&&<button className="group-delete" disabled={pending} onClick={()=>setDeleting(true)}>删除群聊</button>}<button className="secondary-button" disabled={pending} onClick={onClose}>取消</button><button className="primary-button" disabled={pending||!name.trim()||ids.length<(group?1:2)} onClick={()=>void save()}>{pending?'保存中…':group?'保存':'创建群聊'}</button></footer>
  </section></div>;
}

export function GroupConversation({group,state,avatarActivities,draft,onDraft,onManage,onTakeover,onOpenFile,onSaveFile,visible}:{group:GroupSummary;state:Snapshot;avatarActivities?:BotActivities;draft:ComposerDraft;onDraft:(draft:ComposerDraft)=>void;onManage:()=>void;onTakeover:(request:Extract<InteractionRequest,{kind:'vm_takeover'}>)=>Promise<void>;onOpenFile:(file:FileItem&{botId:string})=>void;onSaveFile:(file:FileItem&{botId:string})=>void;visible:boolean}){
  const [page,setPage]=useState<GroupPage>(),[error,setError]=useState(''),[sending,setSending]=useState(false),[loading,setLoading]=useState(false);
  const body=useRef<HTMLDivElement>(null),follow=useRef(true),scroll=useRef<{height:number;top:number}|undefined>(undefined),active=useRef(true),sendLock=useRef(false),draftRef=useRef(draft);draftRef.current=draft;
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  useEffect(()=>{let live=true;window.aelion.readGroup({id:group.id}).then(next=>{if(live)setPage(current=>current?{...next,messages:merge(current.messages,next.messages).map(message=>next.pins?{...message,pins:next.pins[message.id]||[]}:message),deliveries:merge(current.deliveries,next.deliveries),before:current.before}:next);}).catch(error=>{if(live)setError(errorText(error));});return()=>{live=false;};},[group.id,state.groups?.revision]);
  useLayoutEffect(()=>{const element=body.current;if(!element)return;if(scroll.current){element.scrollTop=scroll.current.top+element.scrollHeight-scroll.current.height;scroll.current=undefined;}else if(follow.current)element.scrollTop=element.scrollHeight;},[page]);
  useEffect(()=>{if(!visible||!page||!document.hasFocus())return;void window.aelion.markGroupRead({id:group.id,seq:page.messages.at(-1)?.seq||0}).catch(()=>{});},[page?.messages.at(-1)?.seq,visible]);
  useEffect(()=>{const read=()=>{if(visible)void window.aelion.markGroupRead({id:group.id,seq:group.lastSeq}).catch(()=>{});};window.addEventListener('focus',read);return()=>window.removeEventListener('focus',read);},[visible,group.lastSeq]);
  const send=async()=>{if(sendLock.current||!draft.text.trim()&&!draft.attachments?.length)return;const saved=draft;sendLock.current=true;setSending(true);onDraft({text:'',mentions:[]});follow.current=true;try{await window.aelion.sendGroup({id:group.id,message:saved.text,mentions:saved.mentions,attachmentIds:saved.attachments?.map(file=>file.id)});if(active.current)setError('');}catch(error){if(!draftRef.current.text&&!draftRef.current.attachments?.length)onDraft(saved);if(active.current)setError(errorText(error));}finally{sendLock.current=false;if(active.current)setSending(false);}};
  const older=async()=>{if(!page?.before||loading)return;setLoading(true);try{const result=await window.aelion.readGroup({id:group.id,before:page.before});if(body.current)scroll.current={height:body.current.scrollHeight,top:body.current.scrollTop};follow.current=false;setPage(current=>current?{...current,messages:merge(result.messages,current.messages),deliveries:merge(result.deliveries,current.deliveries),before:result.before}:result);}catch(error){setError(errorText(error));}finally{setLoading(false);}};
  const members=state.bots.filter(bot=>group.members.some(member=>member.id===bot.id&&!member.leftAt)),requests=(state.interactions||[]).filter(request=>state.runs.some(run=>run.id===request.runId&&run.groupOrigin?.groupId===group.id)),owner=state.bots.find(bot=>bot.id===requests[0]?.botId);
  return <><header className="chat-header drag"><button className="bot-heading no-drag" onClick={onManage}><GroupAvatar group={group} activities={avatarActivities}/><strong>{group.name}</strong><span className="group-member-count">{members.length+1} 人</span></button><div className="header-actions no-drag"><button className="icon-button" aria-label="群聊设置" onClick={onManage}><Icon name="settings"/></button></div></header>
    <section ref={body} className="messages group-messages" onScroll={event=>{const element=event.currentTarget;follow.current=element.scrollHeight-element.scrollTop-element.clientHeight<90;}}>{page?.before&&<button className="peer-chat-load" disabled={loading} onClick={()=>void older()}>加载更早消息</button>}{page?.messages.map(message=>{
      if(message.scheduled)return <div key={message.id} className="scheduled-trigger" data-group-message-id={message.id}><div><Icon name="clock" size={15}/><span>定时任务 · {message.scheduled.title}</span><time>{time(message.time)}</time></div><p>{message.content}</p></div>;
      if(message.kind==='reaction')return null;
      if(message.kind==='system'||message.kind==='continue')return <div key={message.id} className="event-message group-system">{message.content}</div>;
      const bot=message.sender.kind==='bot'?state.bots.find(b=>b.id===message.sender.id)||message.sender:undefined,runId=page.deliveries.find(d=>d.replyMessageId===message.id)?.runId,artifacts=state.artifacts.filter(file=>(file.runId===runId||message.runIds?.includes(file.runId))&&!message.attachments?.some(attachment=>attachment.name===file.name&&attachment.size===file.size));
      const body=groupReplyContent(message.content,bot?.id),formatted=body===message.content?{content:body,mentions:message.mentions}:botMentions(body,members,bot?.id,false);
      return <article className={`group-message ${message.sender.kind==='user'?'from-user':''}`} key={message.id} data-group-message-id={message.id}>{bot&&<Avatar bot={bot} size={31}/>}<div className="group-message-copy"><div className="group-message-author">{bot?.name||'你'}<time>{time(message.time)}</time></div><MessageActions messageId={message.id} content={formatted.content||attachmentSummary(message.attachments)} pins={message.pins} bubbleClassName="group-message-bubble markdown" onPin={input=>window.aelion.pinGroup({...input,groupId:group.id})}><MentionContent content={formatted.content} mentions={formatted.mentions} markdown/><AttachmentList files={message.attachments}/></MessageActions>{artifacts.map(file=><FileCard key={file.id} file={file} onOpen={()=>onOpenFile(file)} onSave={()=>onSaveFile(file)} disabled={state.vm.status!=='ready'}/>)}</div></article>;
    })}{page&&!page.messages.some(message=>message.kind==='message'||message.kind==='progress')&&!group.activities?.length&&<div className="group-empty">发条消息，开始一起协作</div>}</section>
    <div className={`composer-wrap ${requests.length?'with-request':''}`}>{error&&<div className="group-error" role="alert">{error}</div>}{owner&&<div className="group-permission"><div className="group-request-owner"><Avatar bot={owner} size={19}/>{owner.name}{requests.length>1&&<span> · 共 {requests.length} 项请求</span>}</div><ConversationInteractions requests={requests} botId={owner.id} onTakeover={onTakeover}/></div>}<WorkItemsPanel items={state.workItems} scope={{kind:'group',id:group.id}} bots={state.bots}/><BotComposer workspaceDir={state.conversationWorkspaces?.[workspaceKey({kind:'group',id:group.id})]} attachmentScope={{kind:'group',id:group.id}} bot={group} bots={members} draft={draft} running={false} onChange={onDraft} onSend={()=>{if(!sending)void send();}} onStop={()=>{}}/></div>
  </>;
}

export function GroupNotifications({view,selected,onView}:{view?:GroupsView;selected?:string;onView:(id:string)=>void}){
  const seen=useRef<Map<string,number>|undefined>(undefined),[visible,setVisible]=useState<string>();
  useEffect(()=>{if(!view)return;const current=new Map(view.rooms.map(room=>[room.id,room.lastSeq]));if(seen.current){const incoming=view.rooms.find(room=>room.id!==selected&&room.unread>0&&room.lastSeq>(seen.current?.get(room.id)||0));if(incoming)setVisible(incoming.id);}seen.current=current;},[view?.revision]);
  useEffect(()=>{if(!visible)return;const timer=setTimeout(()=>setVisible(undefined),6500);return()=>clearTimeout(timer);},[visible]);
  const room=view?.rooms.find(room=>room.id===visible);if(!room||room.id===selected)return null;
  return <aside className="interaction-notification group-notification" role="status"><button className="interaction-notification-open" onClick={()=>{setVisible(undefined);onView(room.id);}}><GroupAvatar group={room}/><span><strong>{room.name}</strong><small>{room.preview}</small></span><span className="notification-view">查看</span></button><button className="icon-button notification-close" aria-label="关闭群聊通知" onClick={()=>setVisible(undefined)}><Icon name="close" size={16}/></button></aside>;
}
