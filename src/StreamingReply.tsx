import type {Bot,StreamingReply as Reply} from './shared';
import {Avatar,MentionContent} from './ui';
import './streaming.css';

export function StreamingReply({reply,bots=[],context='main'}:{reply:Reply;bots?:Bot[];context?:'main'|'peer'}){
  const bot=bots.find(bot=>bot.id===reply.botId),text=<div className="markdown streaming-text"><MentionContent content={reply.content} mentions={reply.mentions} markdown/></div>;
  const label=reply.purpose==='progress'?'正在汇报':'正在回复';
  if(context==='peer')return <div className="peer-message streaming-reply" data-stream-id={reply.id} aria-busy="true">{bot&&<Avatar bot={bot} size={29} activity="thinking"/>}<div><span className="peer-author">{bot?.name||'Bot'}<span className="streaming-label">{label}</span></span><div className="peer-bubble">{text}</div></div></div>;
  return <div className="message-row assistant streaming-reply" data-stream-id={reply.id} aria-busy="true" aria-label={label}><div className="bubble">{text}</div></div>;
}
