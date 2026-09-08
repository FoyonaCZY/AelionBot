import {useEffect,useRef,useState} from 'react';
import type {MessageReply} from './message-replies';
import './message-replies.css';

export function MessageQuote({reply,onCancel}:{reply:MessageReply;onCancel?:()=>void}){
  const [missing,setMissing]=useState(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>{setMissing(false);clearTimeout(timer.current);return()=>clearTimeout(timer.current);},[reply.messageId]);
  const jump=()=>{
    const target=[...document.querySelectorAll<HTMLElement>('[data-message-id],[data-group-message-id]')].find(el=>el.dataset.messageId===reply.messageId||el.dataset.groupMessageId===reply.messageId);
    if(!target){setMissing(true);clearTimeout(timer.current);timer.current=setTimeout(()=>setMissing(false),2200);return;}
    target.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});
    target.querySelector<HTMLElement>('.message-context-target')?.focus({preventScroll:true});
  };
  return <div className={`message-quote ${onCancel?'is-draft':''}`}><button type="button" className="message-quote-content" onClick={jump} title="查看原消息" aria-label={`引用 ${reply.author} 的消息：${reply.excerpt}`}><span className="message-quote-author">{reply.author}</span><span className="message-quote-excerpt">{missing?'原消息不在当前已加载的记录中':reply.excerpt}</span></button>{onCancel&&<button type="button" className="message-quote-cancel" onClick={onCancel} aria-label="取消回复" title="取消回复"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>}</div>;
}
