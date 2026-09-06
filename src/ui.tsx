import {AttachmentList} from './Attachments';
import {FileInfo,FileTypeBadge} from './FileAppearance';
import {attachmentSummary} from './attachment-types';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import Markdown,{defaultUrlTransform} from 'react-markdown';
import RFB from '@novnc/novnc';
import type {Bot,BotMention,ChatMessage} from './shared';
import {mentionMarkdown,validMentions} from './mentions';
import {readableContent} from './activity';
import {MessageActions} from './MessagePins';
import type {BotActivity} from './bot-activity';
import './avatar.css';

export function Icon({name,size=20}:{name:string;size?:number}){
  const shapes:Record<string,React.ReactNode>={
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    shield:<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/></>,
    message:<><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 9h9M7 13h6"/></>,
    back:<path d="m14 5-7 7 7 7"/>,
    info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
    memory:<><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M9 9h6v6H9z"/></>,
    bot:<><rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M8 12v2M16 12v2M9 17h6M1 11v5M23 11v5"/></>,
    edit:<><path d="m14 5 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14z"/></>,
    trash:<><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>,
    plus:<path d="M12 5v14M5 12h14"/>,search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
    settings:<><path d="m9 3-.5 3-2 1-3-.5-1.5 3 2.5 2v2l-2.5 2 1.5 3 3-.5 2 1 .5 3h4l.5-3 2-1 3 .5 1.5-3-2.5-2v-2l2.5-2-1.5-3-3 .5-2-1-.5-3z"/><circle cx="11" cy="12" r="3"/></>,
    computer:<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    send:<path d="m5 12 7-7 7 7M12 5v15"/>,close:<path d="m6 6 12 12M18 6 6 18"/>,
    check:<path d="m5 12 4 4L19 6"/>,alert:<><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/></>,pause:<><path d="M8 6v12M16 6v12"/></>,copy:<><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/></>,
    file:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/><path d="M8 13h8M8 17h5"/></>,
    terminal:<><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 3 3-3 3M12 15h5"/></>,
    restart:<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>,download:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    folder:<path d="M3 5h7l2 3h9v12H3z"/>,arrow:<path d="m8 5 7 7-7 7"/>,down:<path d="m6 9 6 6 6-6"/>,
    globe:<><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
    expand:<path d="M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"/>,book:<><path d="M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3zM12 6v16"/></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]||shapes.file}</svg>;
}
export function Avatar({bot,size=44,activity='idle'}:{bot:Pick<Bot,'name'|'color'>&{id?:string};size?:number;activity?:BotActivity}){
  let phase=0;for(const letter of bot.id||bot.name)phase=(phase*31+letter.charCodeAt(0))>>>0;
  const label={idle:'',thinking:'正在思考',working:'正在工作',waiting:'等待你处理'}[activity];
  return <svg width={size} height={size} viewBox="0 0 60 60" className="avatar" role="img" data-activity={activity} style={{'--avatar-motion-delay':`-${phase%2400}ms`} as React.CSSProperties} aria-label={label?`${bot.name}，${label}`:bot.name}>
    <circle className="avatar-halo" cx="30" cy="30" r="28.2" fill="none" stroke={bot.color} strokeWidth="1.4" strokeDasharray="22 155" strokeLinecap="round"/>
    <g className="avatar-body"><path d="M31 3C47 3 56 14 56 31C56 46 46 56 29 56C12 56 4 46 4 30C4 14 15 3 31 3Z" fill={bot.color}/><g className="avatar-gaze"><g className="avatar-eye"><ellipse cx="24" cy="26" rx="2.5" ry="5" fill="white" transform="rotate(-14 24 26)"/></g><g className="avatar-eye"><ellipse cx="36" cy="24" rx="2.5" ry="5" fill="white" transform="rotate(-14 36 24)"/></g></g></g>
  </svg>;
}
export const time=(value:string)=>new Date(value).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
export const bytes=(size:number)=>size<1024?`${size} B`:size<1048576?`${Math.round(size/102.4)/10} KB`:`${Math.round(size/104857.6)/10} MB`;

export function Vnc({url,control=false}:{url?:string;control?:boolean}){
  const host=useRef<HTMLDivElement>(null),rfb=useRef<any>(null);const [connected,setConnected]=useState(false),[retry,setRetry]=useState(0),[failed,setFailed]=useState(false);
  const coldRetries=useRef(0);
  useEffect(()=>{coldRetries.current=0;},[url]);
  useEffect(()=>{
    setConnected(false);setFailed(false);if(!host.current||!url)return;
    let active=true;
    let frameTimer:ReturnType<typeof setInterval>|undefined;
    try{
      const client=new RFB(host.current,url,{shared:true});rfb.current=client;client.scaleViewport=true;client.resizeSession=false;client.viewOnly=!control;
      client.addEventListener('connect',()=>{
        if(!active)return;
        const begin=Date.now();
        frameTimer=setInterval(()=>{
          const canvas=host.current?.querySelector('canvas'),context=canvas?.getContext('2d');
          if(canvas&&context&&canvas.width>1&&canvas.height>1){
            const points=[[.08,.08],[.5,.08],[.5,.5],[.9,.5],[.5,.92]];
            let painted=false;try{painted=points.some(([x,y])=>{const pixel=context.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data;return pixel[3]>0&&pixel[0]+pixel[1]+pixel[2]>12;});}catch{/* Wait for a readable frame before showing a connected state. */}
            if(painted){clearInterval(frameTimer);setConnected(true);return;}
          }
          if(Date.now()-begin>2500){clearInterval(frameTimer);if(coldRetries.current++<2)setRetry(value=>value+1);else setFailed(true);}
        },150);
      });
      client.addEventListener('disconnect',()=>{clearInterval(frameTimer);if(active){setConnected(false);setFailed(true);}});
      return()=>{active=false;clearInterval(frameTimer);client.disconnect();rfb.current=null;};
    }catch{clearInterval(frameTimer);setFailed(true);}
  },[url,retry]);
  useEffect(()=>{if(rfb.current)rfb.current.viewOnly=!control;},[control]);
  return <div className="vnc-shell"><div ref={host} className="vnc-surface"/>{!connected&&<div className="vnc-overlay"><Icon name="computer" size={34}/><span>{!url?'正在等待工作电脑桌面':failed?'画面尚未恢复':'正在连接电脑画面'}</span>{url&&failed&&<button onClick={event=>{event.stopPropagation();coldRetries.current=0;setRetry(value=>value+1);}}>重新连接</button>}</div>}</div>;
}

export function ScreenImage({id,onOpen}:{id:string;onOpen:(url:string)=>void}){
  const [url,setUrl]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let active=true;window.aelion.screenshot(id).then(value=>{if(active)setUrl(value);}).catch(error=>{if(active)setError(error.message);});return()=>{active=false;};},[id]);
  return url?<button className="screen-evidence" onClick={()=>onOpen(url)} aria-label="查看操作截图"><img src={url} alt="Bot 操作后的工作电脑截图"/></button>:<p className="subtle">{error||'加载截图…'}</p>;
}
export function MentionTag({mention}:{mention:BotMention}){return <span className="bot-mention" data-bot-id={mention.id} title={`${mention.name} · ${mention.id.slice(0,8)}`}><Avatar bot={mention} size={16}/>@{mention.name}</span>;}
export function MentionContent({content,mentions=[],markdown=false}:{content:string;mentions?:BotMention[];markdown?:boolean}){
  const prepared=useMemo(()=>markdown&&mentions.length?mentionMarkdown(content,mentions):undefined,[content,JSON.stringify(mentions),markdown]);
  if(markdown)return <Markdown urlTransform={url=>prepared?.links.has(url)?url:defaultUrlTransform(url)} components={{a:({href,children,node,...props})=>{const mention=href?prepared?.links.get(href):undefined;return mention?<MentionTag mention={mention}/>:<a href={href} {...props}>{children}</a>;}}}>{prepared?.markdown||content}</Markdown>;
  const parts:React.ReactNode[]=[];let at=0;for(const mention of validMentions(content,mentions)){parts.push(content.slice(at,mention.start),<MentionTag key={`${mention.id}-${mention.start}`} mention={mention}/>);at=mention.end;}parts.push(content.slice(at));return <>{parts}</>;
}
export function Message({message,allowPins=true}:{message:ChatMessage;allowPins?:boolean}){
  if(message.scheduled)return <div className="scheduled-trigger" data-message-id={message.id}><div><Icon name="clock" size={15}/><span>定时任务 · {message.scheduled.title}</span><time>{time(message.time)}</time></div><p>{message.content}</p></div>;
  if(message.reaction)return null;
  if(message.role==='event')return <div className="event-message">{message.content}</div>;
  if(message.role==='tool')return null;
  if(!message.content&&!message.attachments?.length&&message.status!=='running')return null;
  const content=message.role==='assistant'?(message.content.startsWith('执行检查发现未解决')?'发现校验问题，继续检查并修正。':readableContent(message.content)):message.content;
  return <div className={`message-row ${message.role}`} data-message-id={message.id}><MessageActions messageId={message.id} content={content||attachmentSummary(message.attachments)} pins={message.pins} bubbleClassName={`bubble ${message.status==='failed'?'failed':''}`} onPin={allowPins&&(content||message.attachments?.length)&&(!message.status||message.status==='done')?input=>window.aelion.pinChat({...input,botId:message.botId}):undefined}>{content?(message.role==='assistant'?<div className="markdown"><MentionContent content={content} mentions={message.mentions} markdown/></div>:<MentionContent content={content} mentions={message.mentions}/>):message.attachments?.length?null:<span className="typing"><i/><i/><i/></span>}<AttachmentList files={message.attachments}/></MessageActions><span className="message-time">{time(message.time)}</span></div>;
}

export interface FileItem {name:string;path:string;size:number;}
export function FileCard({file,onOpen,onSave,disabled=false}:{file:FileItem;onOpen:()=>void;onSave:()=>void;disabled?:boolean}){
  return <article className="artifact-card file-tile"><button type="button" className="artifact-open file-tile-open" onClick={onOpen} disabled={disabled} title={`预览 ${file.name}`} aria-label={`打开 ${file.name}`}><FileTypeBadge name={file.name}/><FileInfo name={file.name} size={file.size}/></button><button type="button" className="artifact-save" title="保存到本地" aria-label={`保存 ${file.name}`} disabled={disabled} onClick={onSave}><Icon name="download" size={16}/></button></article>;
}
