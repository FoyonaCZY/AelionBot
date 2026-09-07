import {Select} from './Select';
import {WorkItemsPanel} from './WorkItems';
import {workspaceKey} from './work-types';
import {RuntimeSettings} from './RuntimeSettings';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import Markdown from 'react-markdown';
import {attachmentSummary} from './attachment-types';
import type {ArtifactPreview,Bot,InteractionRequest,ModelSelection,Snapshot} from './shared';
import {Avatar,bytes,FileCard,type FileItem,Icon,Message,time,Vnc} from './ui';
import {RunMessage} from './activity-ui';
import {conversationTimeline,friendlyError,readableContent} from './activity';
import {SkillsSettings,McpSettings} from './integration-ui';
import {SettingsWindow,SettingsSection,type SettingsTab} from './SettingsWindow';
import {CommandPermissionsSettings} from './CommandPermissionsSettings';
import {HostWorkspaceSettings} from './HostWorkspaceSettings';
import {ModelSettings} from './ModelSettings';
import {AboutSettings} from './AboutSettings';
import {ComputerSetup,ComputerStatus} from './ComputerSetup';
import {computerDesktopReady,shouldOfferComputerSetup} from './computer-setup-state';
import {ScheduledTasks} from './ScheduledTasks';
import {ModelSelectionFields,validModelSelection} from './ModelSelectionFields';
import {StreamingReply} from './StreamingReply';
import {BotContextMenu,type BotMenuAnchor} from './BotContextMenu';
import {ConversationInteractions,InteractionNotifications} from './InteractionPrompts';
import {BotComposer,type ComposerDraft} from './BotComposer';
import {PeerNotice,PeerTaskMessage,PeerNotifications,PrivateChatWindow,type PeerPanel} from './PeerChats';
import {isPrivatePeerOrigin} from './peer-types';
import {conversationRows} from './conversation-list';
import {GroupAvatar,GroupConversation,GroupEditor,GroupNotifications,GroupTaskMessage} from './GroupChats';
import {randomBotColor} from './bot-colors';
import {botActivities} from './bot-activity';

type Modal='new'|'profile'|'delete-bot'|'settings'|'computer'|'computer-setup'|'terminal'|'files'|'preview'|'screen'|null;
type PreviewFile=FileItem&{botId:string};
const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');

function CsvPreview({text}:{text:string}){
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length&&rows.length<201;i++){
    const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(cell);cell='';}
    else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
  return <div className="table-preview"><table><thead><tr>{rows[0]?.map((value,i)=><th key={i}>{value}</th>)}</tr></thead><tbody>{rows.slice(1,201).map((values,i)=><tr key={i}>{values.slice(0,30).map((value,j)=><td key={j}>{value}</td>)}</tr>)}</tbody></table>{rows.length>200&&<p className="subtle">预览前 200 行，完整内容可保存到本机。</p>}</div>;
}

export default function App(){
  const [state,setState]=useState<Snapshot>(),[selected,setSelected]=useState(''),[query,setQuery]=useState(''),[drafts,setDrafts]=useState<Record<string,ComposerDraft>>({});
  const avatarActivities=useMemo(()=>state?botActivities(state):{},[state]);
  const [peerPanel,setPeerPanel]=useState<PeerPanel>();
  const [selectedGroup,setSelectedGroup]=useState(''),[groupEditor,setGroupEditor]=useState<string>(),[newMenu,setNewMenu]=useState(false);
  const [groupDrafts,setGroupDrafts]=useState<Record<string,ComposerDraft>>({});
  const [newBotColor,setNewBotColor]=useState(randomBotColor);
  const group=state?.groups?.rooms.find(room=>room.id===selectedGroup);
  const [modal,setModal]=useState<Modal>(null),[settingsTab,setSettingsTab]=useState<SettingsTab>('model'),[scope,setScope]=useState('');
  const [botMenu,setBotMenu]=useState<BotMenuAnchor>(),[editingId,setEditingId]=useState(''),[deletingId,setDeletingId]=useState('');
  const [busy,setBusy]=useState(false),[toast,setToast]=useState(''),[name,setName]=useState(''),[role,setRole]=useState('');
  const [profileModel,setProfileModel]=useState<ModelSelection|null>(null);
  const [taskModalOpen,setTaskModalOpen]=useState(false);
  const setupPrompted=useRef('');
  useEffect(()=>{if(taskModalOpen)void window.aelion.setWindowDimmed(true);return()=>{if(taskModalOpen)void window.aelion.setWindowDimmed(false);};},[taskModalOpen]);
  const [controlPending,setControlPending]=useState(false),controlBusy=useRef(false);
  const [computerBotId,setComputerBotId]=useState('');
  const [viewingRequest,setViewingRequest]=useState('');

  const [command,setCommand]=useState('uname -s; id -u; pwd'),[output,setOutput]=useState(''),[files,setFiles]=useState<FileItem[]>([]);
  const [previewFile,setPreviewFile]=useState<PreviewFile>(),[preview,setPreview]=useState<ArtifactPreview>(),[previewError,setPreviewError]=useState(''),[screen,setScreen]=useState('');
  const sending=useRef(new Set<string>());
  const bottom=useRef<HTMLDivElement>(null),follow=useRef(true),selectedRef=useRef(selected);selectedRef.current=selected;
  const bot=state?.bots.find(item=>item.id===selected)||state?.bots[0];
  const currentModel=bot?(state?.botModels?.[bot.id]||state?.model):state?.model;
  const menuBot=state?.bots.find(item=>item.id===botMenu?.id),editingBot=state?.bots.find(item=>item.id===editingId),deletingBot=state?.bots.find(item=>item.id===deletingId);
  const profileRunning=state?.runs.some(run=>run.botId===editingId&&run.status==='running')||false;
  const profileModelChanged=JSON.stringify(profileModel)!==JSON.stringify(editingBot?.model||null);
  const messages=state?.messages.filter(message=>message.botId===bot?.id&&(message.audience==='user'||!state.runs.some(run=>run.id===message.runId&&isPrivatePeerOrigin(run.peerOrigin))))||[];
  const runMessages=new Map<string,typeof messages>();for(const message of messages)if(message.runId){const list=runMessages.get(message.runId)||[];list.push(message);runMessages.set(message.runId,list);}
  const timeline=conversationTimeline(messages);
  const liveReplies=(state?.streamingReplies||[]).filter(reply=>reply.main&&reply.botId===bot?.id),liveSignature=liveReplies.map(reply=>reply.id+':'+reply.content).join('|');
  const latestRun=state?.runs.filter(run=>run.botId===bot?.id&&!isPrivatePeerOrigin(run.peerOrigin)&&(!run.groupOrigin||run.groupTask)).at(-1);
  const running=Boolean(state?.runs.some(run=>run.botId===bot?.id&&run.status==='running')||currentModel?.model&&state!.messages.some(message=>message.botId===bot?.id&&message.inputState==='queued'));
  const anyRunning=state?.runs.some(run=>run.status==='running')||false;
  const greeting=state?.greetingBotIds?.includes(bot?.id||'')||false;
  const draft=drafts[bot?.id||'']||{text:'',mentions:[]};
  const vmReady=state?.vm.status==='ready',desktopAvailable=Boolean(state&&computerDesktopReady(state.vm));
  const desktopBot=state?.bots.find(item=>item.id===computerBotId)||bot;
  const desktop=state?.computer.desktops?.[desktopBot?.id||''];
  const controlled=desktop?.manualControl||false;
  const requests=state?.interactions||[];
  const takeover=requests.find((request):request is Extract<InteractionRequest,{kind:'vm_takeover'}>=>request.kind==='vm_takeover'&&request.botId===desktopBot?.id);
  const waiting=requests.find(request=>request.botId===bot?.id&&(!state?.runs.find(run=>run.id===request.runId)?.groupOrigin||state?.runs.find(run=>run.id===request.runId)?.groupTask));
  const scopeBot=state?.bots.find(item=>item.id===scope)||bot;
  const act=async(operation:()=>Promise<unknown>)=>{setBusy(true);try{await operation();}catch(error){setToast(errorText(error));}finally{setBusy(false);}};
  const computerAction=async(operation:()=>Promise<unknown>)=>{if(controlBusy.current)return;controlBusy.current=true;setControlPending(true);try{await operation();}catch(error){setToast(errorText(error));}finally{controlBusy.current=false;setControlPending(false);}};
  const closeModal=async()=>{if(modal==='computer'&&controlled&&desktopBot)await window.aelion.setComputerControl({botId:desktopBot.id,enabled:false});if(modal==='computer-setup'&&state)try{localStorage.setItem(`aelion-computer-setup:${state.dataDir}`,'dismissed');}catch{}setModal(null);};
  const startTakeover=(request:Extract<InteractionRequest,{kind:'vm_takeover'}>)=>computerAction(async()=>{await closeModal();await window.aelion.respondInteraction({id:request.id,action:'takeover'});setPeerPanel(undefined);setSelected(request.botId);setComputerBotId(request.botId);setModal('computer');});
  const viewInteraction=(request:InteractionRequest)=>void computerAction(async()=>{await closeModal();setPeerPanel(undefined);setQuery('');setSelected(request.botId);setSelectedGroup(state?.runs.find(run=>run.id===request.runId)?.groupOrigin?.groupId||'');setFiles([]);setBotMenu(undefined);setViewingRequest(request.id);});
  const openGroup=(id:string)=>void computerAction(async()=>{await closeModal();setPeerPanel(undefined);setGroupEditor(undefined);setNewMenu(false);setBotMenu(undefined);setSelectedGroup(id);});
  const openPrivateChat=(panel:PeerPanel)=>void computerAction(async()=>{await closeModal();setBotMenu(undefined);setPeerPanel(panel);});
  const toggleComputerControl=()=>computerAction(async()=>{if(!desktopBot)return;if(takeover)await window.aelion.respondInteraction({id:takeover.id,action:controlled&&takeover.phase==='controlling'?'resume':'takeover'});else await window.aelion.setComputerControl({botId:desktopBot.id,enabled:!controlled});});
  useEffect(()=>{if(bot)setComputerBotId(bot.id);},[bot?.id]);
  useEffect(()=>{if(!desktopBot||!desktopAvailable)return;let active=true;void window.aelion.ensureComputerDesktop(desktopBot.id).catch(error=>{if(active)setToast(errorText(error));});return()=>{active=false;};},[desktopBot?.id,desktopAvailable,state?.vm.pid]);
  useEffect(()=>{
    if(!window.aelion)return;
    window.aelion.snapshot().then(value=>{setState(value);setSelected(value.messages.at(-1)?.botId||value.bots[0]?.id||'');}).catch(error=>setToast(errorText(error)));
    return window.aelion.onEvent(event=>setState(event.snapshot));
  },[]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(''),6000);return()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{
    if(!state||modal||peerPanel||groupEditor||taskModalOpen||setupPrompted.current===state.dataDir)return;
    setupPrompted.current=state.dataDir;let dismissed=false;try{dismissed=localStorage.getItem(`aelion-computer-setup:${state.dataDir}`)==='dismissed';}catch{}
    if(shouldOfferComputerSetup(state.vm,dismissed))setModal('computer-setup');
  },[state?.dataDir,state?.vm.status,modal,peerPanel,groupEditor,taskModalOpen]);
  useEffect(()=>{
    if(!state||state.bots.some(item=>item.id===selected))return;
    const next=state.bots[0]?.id||'';selectedRef.current=next;setSelected(next);setFiles([]);
  },[state?.bots,selected]);
  useEffect(()=>{setBotMenu(undefined);setNewMenu(false);},[modal]);
  useEffect(()=>{if(!newMenu)return;const close=(event:Event)=>{if(!(event.target as HTMLElement)?.closest('.new-menu-anchor'))setNewMenu(false);};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')setNewMenu(false);};window.addEventListener('pointerdown',close);window.addEventListener('keydown',escape);return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',escape);};},[newMenu]);
  useEffect(()=>{if(!viewingRequest||modal)return;const panel=document.getElementById(`interaction-${viewingRequest}`);if(panel){panel.focus({preventScroll:true});setViewingRequest('');}},[viewingRequest,bot?.id,modal]);
  useEffect(()=>{
    if(!window.aelion)return;
    void window.aelion.setComputerFullscreen(modal==='computer').catch(error=>setToast(errorText(error)));
    return()=>{void window.aelion.setComputerFullscreen(false).catch(()=>{});};
  },[modal]);
  useEffect(()=>{follow.current=true;bottom.current?.scrollIntoView();},[selected]);
  useEffect(()=>{if(follow.current)bottom.current?.scrollIntoView();},[messages.length,messages.at(-1)?.content,state?.artifacts.length,liveSignature]);
  useEffect(()=>{if(!vmReady||!bot)return;const owner=bot.id;window.aelion.listFiles(owner).then(values=>{if(selectedRef.current===owner)setFiles(values);}).catch(()=>{});},[bot?.id,vmReady]);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&modal&&!(modal==='computer'&&controlled)){if(modal==='computer')void computerAction(closeModal);else void act(closeModal);}};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[modal,controlled]);
  const openSettings=(tab:SettingsTab='model')=>{setScope(bot?.id||'');setSettingsTab(tab);setModal('settings');};
  const send=async()=>{if(!bot||sending.current.has(bot.id)||!draft.text.trim()&&!draft.attachments?.length)return;if(draft.text.length>32000){setToast('消息过长，请分段发送');return;}if(!currentModel?.model||currentModel.issue){openSettings();setToast('先为这个 Bot 选择模型');return;}const saved=draft,botId=bot.id;sending.current.add(botId);setDrafts(value=>({...value,[botId]:{text:'',mentions:[]}}));follow.current=true;try{await window.aelion.send({botId,message:saved.text,mentions:saved.mentions,attachmentIds:saved.attachments?.map(file=>file.id)});}catch(error){setDrafts(value=>value[botId]?.text||value[botId]?.attachments?.length?value:{...value,[botId]:saved});setToast(errorText(error));}finally{sending.current.delete(botId);}};
  const continueWork=()=>{if(!bot||running)return;follow.current=true;void window.aelion.send({botId:bot.id,message:'请从现有工作记录继续。先核对上次操作的实际结果，再完成尚未结束的部分；不要重复已经成功的操作。'}).catch(error=>setToast(errorText(error)));};
  const refreshFiles=()=>bot&&act(async()=>{const owner=bot.id;const result=await window.aelion.listFiles(owner);if(selectedRef.current===owner)setFiles(result.map(file=>({...file,path:file.path||file.name})));});
  const openFiles=()=>{setFiles([]);setModal('files');void refreshFiles();};
  const openPreview=async(file:PreviewFile)=>{setPreviewFile(file);setPreview(undefined);setPreviewError('');setModal('preview');try{setPreview(await window.aelion.previewFile({botId:file.botId,path:file.path}));}catch(error){setPreviewError(errorText(error));}};
  const saveFile=(file:PreviewFile)=>act(async()=>{const path=await window.aelion.exportFile({botId:file.botId,path:file.path});if(path)setToast(`已保存：${path}`);});
  const openNewBot=()=>{setName('');setRole('');setModal('new');};
  const editBot=(target:Bot)=>{setBotMenu(undefined);setEditingId(target.id);setName(target.name);setRole(target.role);setProfileModel(target.model?{...target.model}:null);setModal('profile');};
  const showBotMenu=(target:Bot,trigger:HTMLButtonElement,x?:number,y?:number)=>{
    const box=trigger.getBoundingClientRect();setBotMenu({id:target.id,trigger,x:x??box.left+24,y:y??box.bottom});
  };
  const removeBot=()=>act(async()=>{
    if(!deletingBot)return;
    const id=deletingBot.id;await window.aelion.deleteBot(id);
    setDrafts(value=>{const next={...value};delete next[id];return next;});
    setScope(value=>value===id?'':value);setDeletingId('');setModal(null);setToast('Bot 已删除');
  });
  if(!window.aelion)return <div className="launch-note"><h1>AelionBot</h1><p>请通过桌面客户端启动。</p></div>;
  if(!state)return <div className="launch-note">正在打开工作台…</div>;
  const rows=conversationRows(state.bots,state.messages,state.groups?.rooms||[],state.runs);
  const title=modal==='computer-setup'?'工作电脑设置':modal==='settings'?'设置':modal==='new'?'创建新 Bot':modal==='profile'?'Bot 资料':modal==='delete-bot'?'删除 Bot':modal==='terminal'?'工作终端':modal==='files'?`${bot?.name||'Bot'} 的文件`:modal==='preview'?previewFile?.name:modal==='screen'?'操作截图':'工作电脑';
  const scopePicker=<label className="scope-picker"><span>Bot</span><Select aria-label="选择 Bot" disabled={!state.bots.length} value={scopeBot?.id||''} onChange={event=>setScope(event.target.value)}>{state.bots.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>;
  return <div className="app-shell" data-platform={state.platform}>
    <aside className="sidebar">
      <div className="sidebar-top drag"><span className="brand">Aelion<span>Bot</span></span><div className="new-menu-anchor no-drag"><button className="icon-button" aria-label="新建" aria-haspopup="menu" aria-expanded={newMenu} onClick={()=>{if(!newMenu)setNewBotColor(randomBotColor(newBotColor));setNewMenu(value=>!value);}}><Icon name="plus"/></button>{newMenu&&<div className="new-conversation-menu" role="menu"><button role="menuitem" onClick={()=>{setNewMenu(false);openNewBot();}}><span className="new-bot-icon" aria-hidden="true"><Avatar bot={{name:'新 Bot',color:newBotColor}} size={20}/></span>新建 Bot</button><button role="menuitem" onClick={()=>{setNewMenu(false);setGroupEditor('new');}}><Icon name="message" size={20}/>创建群聊</button></div>}</div></div>
      <label className="search"><Icon name="search" size={18}/><input placeholder="搜索" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <div className="bot-list conversation-list" role="region" aria-label="会话列表">{rows.filter(row=>(row.kind==='bot'?row.bot.name:row.group.name).toLowerCase().includes(query.toLowerCase())).map(row=>{
        if(row.kind==='group'){
          const room=row.group;
          return <button key={`group:${room.id}`} className={`bot-item group-item ${group?.id===room.id?'selected':''}`} data-group-id={room.id} onClick={()=>openGroup(room.id)}><GroupAvatar group={room} activities={avatarActivities}/><span className="bot-copy"><span className="bot-line"><strong>{room.name}</strong><small>{time(row.time)}</small></span><span className="bot-preview">{room.activities?.length?`${room.activities.length} 位成员正在处理…`:room.preview}</span></span>{room.unread>0&&<span className="group-unread">{room.unread>99?'99+':room.unread}</span>}</button>;
        }
        const {bot:item,last}=row;
        const active=state.runs.some(run=>run.botId===item.id&&run.status==='running'),introducing=state.greetingBotIds?.includes(item.id)||false;
        const pending=requests.find(request=>request.botId===item.id);const lastRun=last?.runId?state.runs.find(run=>run.id===last.runId):undefined;const preview=pending?(pending.kind==='host_permission'?(pending.approval?.phase==='reviewing'?'默认模型正在审核操作':'等待你的本机操作许可'):'等待人工接管'):active?'正在工作…':introducing?'正在打招呼…':lastRun?.status==='failed'||lastRun?.status==='interrupted'?friendlyError(lastRun.error||'').title:lastRun?.groupUpdated?'已接收新的群消息':lastRun?.status==='cancelled'?'已停止，工作记录已保留':readableContent(last?.content||attachmentSummary(last?.attachments)).replace(/[#*`]/g,'');
        return <button className={`bot-item ${!group&&bot?.id===item.id?'selected':''}`} key={`bot:${item.id}`} data-bot-id={item.id} aria-haspopup="menu" aria-expanded={botMenu?.id===item.id} onClick={()=>{setSelectedGroup('');setSelected(item.id);setFiles([]);}} onContextMenu={event=>{event.preventDefault();showBotMenu(item,event.currentTarget,event.clientX||undefined,event.clientY||undefined);}} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();showBotMenu(item,event.currentTarget);}}}><Avatar bot={item} activity={avatarActivities[item.id]}/><span className="bot-copy"><span className="bot-line"><strong>{item.name}</strong><small>{last?time(last.time):''}</small></span><span className="bot-preview">{preview}</span></span>{(active||introducing)&&<span className={`bot-working ${pending?'needs-user':''}`}/>}</button>;
      })}</div>
      <div className="sidebar-bottom"><button className="sidebar-link" onClick={()=>openSettings()}><Icon name="settings"/><span>设置</span></button></div>
    </aside>
    <main className="conversation">
      {group?<GroupConversation key={group.id} group={group} state={state} avatarActivities={avatarActivities} draft={groupDrafts[group.id]||{text:'',mentions:[]}} onDraft={draft=>setGroupDrafts(value=>({...value,[group.id]:draft}))} onManage={()=>setGroupEditor(group.id)} onTakeover={startTakeover} onOpenFile={file=>void openPreview(file)} onSaveFile={file=>void saveFile(file)} visible={!modal&&!peerPanel&&!groupEditor&&!taskModalOpen}/>:bot?<><header className="chat-header drag"><button className="bot-heading no-drag" onClick={()=>editBot(bot)}><Avatar bot={bot} size={31} activity={avatarActivities[bot.id]}/><strong>{bot.name}</strong></button><div className="header-actions no-drag"><button className="bot-model-button" aria-label="选择 Bot 模型" onClick={()=>editBot(bot)}>{currentModel?.model||'选择模型'}</button>{(running||greeting||!currentModel?.model)&&<span className={`connection-status ${running||greeting?'working':''}`}>{running?(waiting?.kind==='host_permission'?(waiting.approval?.phase==='reviewing'?'正在审核':'等待许可'):waiting?'等待接管':'正在工作'):greeting?'正在打招呼…':'尚未连接模型'}</span>}</div></header>
      <section key={bot.id} className="messages" onScroll={event=>{const el=event.currentTarget;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;}}><div className="day-separator">对话记录</div>{timeline.map(item=>{
        const key=`${bot.id}:${item.kind}:${item.kind==='run'?item.segmentId:item.id}`;
        if(item.kind==='message')return item.message.groupTaskSource?<GroupTaskMessage key={key} message={item.message} view={state.groups} onOpen={openGroup}/>:item.message.groupLink?<div key={key} className="peer-notice"><button className="peer-notice-open" disabled={!state.groups?.rooms.some(room=>room.id===item.message.groupLink?.groupId)} onClick={()=>openGroup(item.message.groupLink!.groupId)}><Icon name="message" size={16}/>{item.message.content}</button></div>:item.message.taskSource?<PeerTaskMessage key={key} message={item.message} view={state.peers} onOpen={openPrivateChat}/>:item.message.peer?<PeerNotice key={key} message={item.message} view={state.peers} onOpen={openPrivateChat}/>:<Message key={key} message={item.message} allowPins={!state.runs.find(run=>run.id===item.message.runId)?.groupOrigin}/>;
        const run=state.runs.find(run=>run.id===item.id),allRunMessages=runMessages.get(item.id)||[],outputs=item.isLast?state.artifacts.filter(file=>file.botId===bot.id&&file.runId===item.id&&!allRunMessages.some(message=>message.attachments?.some(attachment=>attachment.name===file.name&&attachment.size===file.size))):[];
        return <React.Fragment key={key}><RunMessage messages={item.messages} allMessages={allRunMessages} isLast={item.isLast} run={run} stream={item.isLast?liveReplies.find(reply=>reply.runId===item.id&&reply.purpose!=='progress'):undefined} waiting={item.isLast?requests.find(request=>request.runId===item.id)?.kind:undefined} latest={item.isLast&&latestRun?.id===item.id} canContinue={!running&&!busy} reviewing={item.isLast&&requests.some(request=>request.runId===item.id&&request.kind==='host_permission'&&request.approval?.phase==='reviewing')} onContinue={continueWork} onSettings={openSettings} onScreen={url=>{setScreen(url);setModal('screen');}}/>{outputs.length>0&&<div className="message-artifacts">{outputs.map(file=><FileCard key={file.id} file={file} onOpen={()=>void openPreview(file)} onSave={()=>void saveFile(file)} disabled={busy||!vmReady}/>)}</div>}</React.Fragment>;
      })}{liveReplies.filter(reply=>reply.purpose==='progress'||!reply.runId||!timeline.some(item=>item.kind==='run'&&item.id===reply.runId)).map(reply=><StreamingReply key={reply.id} reply={reply}/>)}<div ref={bottom}/></section>
      <div className={`composer-wrap ${waiting?'with-request':''}`}>
        <ConversationInteractions requests={requests.filter(request=>!state.runs.find(run=>run.id===request.runId)?.groupOrigin||state.runs.find(run=>run.id===request.runId)?.groupTask)} botId={bot.id} onTakeover={startTakeover}/>
        <WorkItemsPanel items={state.workItems} scope={{kind:'bot',id:bot.id}} bots={state.bots}/>
        <BotComposer permissionMode={state.hostPermissionModes?.[workspaceKey({kind:'bot',id:bot.id})]} workspaceDir={state.conversationWorkspaces?.[workspaceKey({kind:'bot',id:bot.id})]} key={bot.id} bot={bot} bots={state.bots} draft={draft} running={running} onChange={draft=>setDrafts(value=>({...value,[bot.id]:draft}))} onSend={()=>void send()} onStop={()=>void window.aelion.cancel(bot.id)}/>
      </div>
      </>:<div className="empty-workspace"><Icon name="bot" size={38}/><h2>还没有 Bot</h2><button className="primary-button" onClick={openNewBot}>创建 Bot</button></div>}
    </main>
    <aside className="details computer-details">
      <div className="computer-detail-header drag"><span>工作电脑</span><button className="icon-button no-drag" aria-label="电脑设置" onClick={()=>openSettings('computer')}><Icon name="settings" size={18}/></button></div>
      {desktopAvailable?<div className="computer-preview" role="button" tabIndex={0} aria-label="全屏查看工作电脑" title="全屏查看工作电脑" onClick={()=>setModal('computer')} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();setModal('computer');}}}><div className="computer-preview-surface" inert>{modal!=='computer'&&<Vnc key={desktopBot?.id} url={desktop?.vncUrl}/>}</div><span className="preview-expand"><Icon name="expand" size={15}/></span></div>:<ComputerStatus vm={state.vm} onOpen={()=>setModal('computer-setup')}/>}
      {desktop?.status==='error'&&<div className="desktop-status" role="status"><span title={desktop.error}>独立桌面暂未就绪</span><button onClick={()=>desktopBot&&void act(()=>window.aelion.ensureComputerDesktop(desktopBot.id))}>重试</button></div>}
      <ScheduledTasks target={group?{kind:'group',id:group.id}:bot?{kind:'bot',id:bot.id}:undefined} targetName={group?.name||bot?.name||''} tasks={state.scheduledTasks||[]} onError={setToast} onModalChange={setTaskModalOpen}/>
    </aside>
    {toast&&<div className="toast" role="status">{toast}</div>}
    <InteractionNotifications requests={requests} bots={state.bots} onView={viewInteraction}/>
    <GroupNotifications view={state.groups} selected={!modal&&!peerPanel&&!taskModalOpen?group?.id:undefined} onView={openGroup}/>
    {groupEditor&&<GroupEditor key={groupEditor} bots={state.bots} group={state.groups?.rooms.find(room=>room.id===groupEditor)} onClose={()=>setGroupEditor(undefined)} onSaved={id=>{setGroupEditor(undefined);setSelectedGroup(id);}} onDeleted={id=>{setGroupEditor(undefined);if(selectedGroup===id)setSelectedGroup('');setGroupDrafts(value=>{const next={...value};delete next[id];return next;});}}/>}
    <PeerNotifications view={state.peers} bots={state.bots} onView={openPrivateChat}/>
    {peerPanel&&<PrivateChatWindow panel={peerPanel} view={state.peers} bots={state.bots} streamingReplies={state.streamingReplies} avatarActivities={avatarActivities} onNavigate={setPeerPanel} onClose={()=>setPeerPanel(undefined)}/>}
    {botMenu&&menuBot&&<BotContextMenu anchor={botMenu} name={menuBot.name} canDelete={!state.runs.some(run=>run.botId===menuBot.id&&run.status==='running')} onEdit={()=>editBot(menuBot)} onDelete={()=>{setDeletingId(menuBot.id);setBotMenu(undefined);setModal('delete-bot');}} onPrivateChats={()=>openPrivateChat({ownerId:menuBot.id})} onClose={()=>setBotMenu(undefined)}/>}
    {modal&&<div className={`modal-backdrop ${modal==='settings'?'settings-backdrop':modal==='computer'?'computer-backdrop':['preview','screen'].includes(modal)?'wide-backdrop':''}`} onMouseDown={event=>{if(event.target===event.currentTarget)void act(closeModal);}}><section className={`modal ${modal==='computer-setup'?'computer-setup-modal':modal==='settings'?'settings-modal':modal==='profile'?'bot-profile-modal':modal==='computer'?'computer-modal':['preview','screen'].includes(modal)?'preview-modal':modal==='terminal'?'terminal-modal':''}`} role="dialog" aria-modal="true" aria-label={title}>
      {modal!=='computer'&&modal!=='settings'&&<header><h2>{title}</h2><div className="modal-header-actions">{modal==='preview'&&previewFile&&<button className="icon-button" aria-label={`保存 ${previewFile.name}`} disabled={busy} onClick={()=>void saveFile(previewFile)}><Icon name="download"/></button>}<button className="icon-button" aria-label="关闭对话框" onClick={()=>void act(closeModal)}><Icon name="close"/></button></div></header>}
      {modal==='computer-setup'&&<ComputerSetup vm={state.vm} disabled={anyRunning} onClose={()=>void closeModal()} onReady={()=>setModal('computer')} onNotify={setToast}/>}
      {(modal==='new'||modal==='profile')&&<form onSubmit={event=>{event.preventDefault();void act(async()=>{if(modal==='new'){const created=await window.aelion.createBot({name:name||'新 Bot',role:role||'完成办公和代码任务，使用工作电脑实际执行并核对成果。',color:newBotColor});setSelected(created.id);}else await window.aelion.updateBot({id:editingId,name,role,model:profileModel});setModal(null);});}}>
        <div className="new-avatar"><Avatar bot={{name:name||'新 Bot',color:modal==='new'?newBotColor:editingBot?.color||'#268bfa'}} size={modal==='profile'?56:76}/></div>
        <label>名称<input autoFocus value={name} onChange={event=>setName(event.target.value)} maxLength={80} placeholder="给你的新伙伴起个名字"/></label>
        <label>职责描述<textarea rows={modal==='profile'?3:4} maxLength={4000} value={role} onChange={event=>setRole(event.target.value)}/></label>
        {modal==='profile'&&<div className="bot-profile-model"><h3>模型</h3><ModelSelectionFields providers={state.providers||[]} value={profileModel} onChange={setProfileModel} defaultModel={state.defaultModel} inheritDefault disabled={busy||profileRunning}/></div>}
        {modal==='new'&&<div className="presets">{['整理资料与写作','分析数据与报表','编写代码与测试'].map(value=><button type="button" key={value} onClick={()=>{setName(value.split('与')[0]);setRole(`帮助我${value}，使用工作电脑执行并验证成果。`);}}>{value}</button>)}</div>}
        <button className="primary-button full" disabled={busy||modal==='profile'&&(!name.trim()||!validModelSelection(profileModel,state.providers||[])||profileModelChanged&&profileRunning)}>{modal==='new'?'创建伙伴':'保存资料'}</button>
      </form>}
      {modal==='delete-bot'&&deletingBot&&<div className="delete-bot-confirmation"><p>删除“{deletingBot.name}”及其对话和记忆？工作文件和私聊记录会保留。</p><div className="dialog-actions"><button className="secondary-button" autoFocus disabled={busy} onClick={()=>setModal(null)}>取消</button><button className="danger-button" disabled={busy} onClick={()=>void removeBot()}>{busy?'正在删除…':'删除 Bot'}</button></div></div>}
      {modal==='settings'&&<SettingsWindow tab={settingsTab} onTabChange={setSettingsTab} onClose={()=>void act(closeModal)}>
        {settingsTab==='runtime'&&<RuntimeSettings settings={state.runtime} onNotify={setToast}/>}
        {settingsTab==='model'&&<ModelSettings state={state} onNotify={setToast}/>}
        {settingsTab==='skills'&&(scopeBot?<>{scopePicker}<SkillsSettings botId={scopeBot.id} skills={state.skills.filter(skill=>!skill.botId||skill.botId===scopeBot.id)} integrations={state.integrations} busy={busy||anyRunning} act={act}/></>:<div className="settings-empty">先创建一个 Bot</div>)}
        {settingsTab==='mcp'&&<McpSettings integrations={state.integrations} busy={busy||anyRunning} act={act}/>}
        {settingsTab==='memory'&&<>
          {scopePicker}
          {state.cognition&&<SettingsSection title="后台学习"><div className="learning-setting">
            <div><strong>后台整理经验</strong>{(state.cognition.learning.runningBotId||state.cognition.learning.queued>0)&&<span>{state.cognition.learning.runningBotId?'正在整理经验':`${state.cognition.learning.queued} 项等待整理`}</span>}</div>
            <button role="switch" aria-label="后台整理经验" aria-checked={state.cognition.learning.enabled} className={state.cognition.learning.enabled?'learning-switch enabled':'learning-switch'} disabled={busy} onClick={()=>act(()=>window.aelion.setBackgroundLearning(!state.cognition!.learning.enabled))}><i/></button>
          </div></SettingsSection>}
          <SettingsSection title="已有记忆">
            {scopeBot?.memories.length?<div className="settings-card">{scopeBot.memories.map((value,i)=><div className="memory-card" key={i}>{value}</div>)}</div>:<div className="settings-empty">暂无记忆</div>}
            {state.cognition?.bots.find(item=>item.botId===scopeBot?.id)?.lastLearning&&<p className="settings-note">最近一次知识更新：{new Date(state.cognition.bots.find(item=>item.botId===scopeBot?.id)!.lastLearning!.time).toLocaleString('zh-CN')}</p>}
          </SettingsSection>
        </>}
        {settingsTab==='computer'&&<>
          {state.hostWorkspace&&<HostWorkspaceSettings settings={state.hostWorkspace} busy={busy||anyRunning} act={act} onSaved={()=>setToast('本机工作目录已保存')}/>}
          <SettingsSection title="工作电脑">
            {desktopAvailable?<div className="settings-computer-title"><Icon name="computer" size={34}/><div><strong>Linux 工作电脑</strong><p>{state.vm.detail}</p></div></div>:<ComputerStatus vm={state.vm} onOpen={()=>setModal('computer-setup')}/>}
          </SettingsSection>
          <SettingsSection title="环境信息"><dl className="settings-specs">
            <div><dt>应用环境</dt><dd>{state.vm.appsReady?'Chrome · 文件管理器 · 办公套件':'需要准备'}</dd></div>
            <div><dt>桌面</dt><dd>Aelion 桌面 · Linux</dd></div>
            <div><dt>资源</dt><dd>4 GB 内存 · 4 vCPU</dd></div>
            <div><dt>工作磁盘文件</dt><dd>{bytes(state.vm.diskBytes||0)}</dd></div>
          </dl></SettingsSection>
          <SettingsSection title="维护"><div className="settings-maintenance">
            <button disabled={!vmReady||busy||anyRunning} onClick={()=>{setOutput('');setModal('terminal');}}><Icon name="terminal"/>打开工作终端<Icon name="arrow" size={16}/></button>
            <button disabled={!vmReady||busy||anyRunning} onClick={()=>act(()=>window.aelion.vmAction('restart'))}><Icon name="restart"/>重启电脑<Icon name="arrow" size={16}/></button>
            <button disabled={!vmReady||busy||anyRunning||state.vm.maintenance} onClick={()=>act(()=>window.aelion.vmAction('repair-tools'))}><Icon name="settings"/>{state.vm.maintenance?'正在准备工作环境…':'修复工作环境'}<Icon name="arrow" size={16}/></button>
            <button disabled={!vmReady||busy||anyRunning} onClick={()=>act(()=>window.aelion.vmAction('stop'))}><Icon name="computer"/>关闭工作电脑<Icon name="arrow" size={16}/></button>
            <button onClick={()=>act(()=>window.aelion.openData())}><Icon name="folder"/>打开本地数据目录<Icon name="arrow" size={16}/></button>
          </div></SettingsSection>
          {state.vm.lastError&&<p className="computer-notice">{state.vm.lastError}</p>}
        </>}
        {settingsTab==='permissions'&&<CommandPermissionsSettings rules={state.commandPermissions||[]} busy={busy} act={act}/>}
        {settingsTab==='about'&&<AboutSettings update={state.updates} onNotify={setToast}/>}
      </SettingsWindow>}

      {modal==='terminal'&&<><form className="terminal-input" onSubmit={event=>{event.preventDefault();void act(async()=>{setOutput('正在执行…');try{const result=await window.aelion.vmTerminal(command);setOutput(`${result.stdout}${result.stderr?'\n'+result.stderr:''}\n\n退出码 ${result.exitCode} · ${result.durationMs} ms`);}catch(error){setOutput(errorText(error));throw error;}});}}><input value={command} onChange={event=>setCommand(event.target.value)} spellCheck={false}/><button className="primary-button" disabled={busy}>运行</button></form><pre className="terminal-output">{output}</pre></>}
      {modal==='computer'&&<><div className="expanded-screen"><Vnc key={desktopBot?.id} url={vmReady?desktop?.vncUrl:undefined} control={controlled}/></div><div className="computer-floating-controls"><span className="desktop-owner">{desktopBot?.name}</span><button className="computer-control" aria-pressed={controlled} disabled={!vmReady||desktop?.status!=='ready'||controlPending} onClick={toggleComputerControl}>{controlled?(takeover?.phase==='controlling'?'交还并继续':'交还控制'):'接管电脑'}</button><button className="computer-close icon-button" aria-label="退出全屏" title="退出全屏" disabled={controlPending} onClick={()=>void computerAction(closeModal)}><Icon name="close"/></button></div></>}
      {modal==='files'&&<><div className="files-toolbar"><span>工作电脑中的文件</span><button className="text-button" disabled={!vmReady||busy} onClick={()=>void refreshFiles()}>刷新</button></div>{files.length?<div className="file-library">{files.map(file=><FileCard key={file.path} file={file} onOpen={()=>void openPreview({...file,botId:bot?.id||''})} onSave={()=>void saveFile({...file,botId:bot?.id||''})} disabled={busy||!vmReady}/>)}</div>:<div className="settings-empty">{busy?'正在读取文件…':vmReady?'还没有工作文件':'启动工作电脑后查看文件'}</div>}</>}
      {modal==='preview'&&previewFile&&<><div className="preview-meta"><span>{bytes(previewFile.size)}</span><button className="text-button" disabled={busy||Boolean(state.computer.desktops?.[previewFile.botId]?.ownerBotId)} onClick={()=>act(async()=>{await window.aelion.openFile({botId:previewFile.botId,path:previewFile.path});setComputerBotId(previewFile.botId);setModal('computer');})}>在工作电脑打开</button></div><div className="artifact-preview-body">{previewError?<div className="settings-empty">{previewError}</div>:!preview?<div className="settings-empty">正在加载文件…</div>:preview.kind==='markdown'?<div className="markdown document-preview"><Markdown>{preview.content||''}</Markdown></div>:preview.kind==='image'?<img className="artifact-image" src={preview.dataUrl} alt={previewFile.name}/>:preview.kind==='pdf'?<iframe title={previewFile.name} src={preview.dataUrl} className="artifact-frame"/>:preview.kind==='html'?<iframe title={previewFile.name} srcDoc={preview.content} sandbox="" className="artifact-frame"/>:preview.kind==='text'?previewFile.name.toLowerCase().endsWith('.csv')?<CsvPreview text={preview.content||''}/>:<pre className="text-preview">{preview.content}</pre>:<div className="unsupported-preview"><Icon name="file" size={52}/><strong>{previewFile.name}</strong></div>}</div>{preview?.truncated&&<p className="subtle">预览已截断，保存文件可查看完整内容。</p>}</>}
      {modal==='screen'&&<img className="artifact-image screen-full" src={screen} alt="Bot 操作后的工作电脑截图"/>}
    </section></div>}
  </div>;
}
