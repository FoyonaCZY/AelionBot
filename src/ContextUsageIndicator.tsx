import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {ContextOverview,ContextPart} from './context-overview';
import {CONTEXT_PARTS} from './context-overview';
import {useI18n} from './i18n';
import './context-usage.css';

const labels:Record<ContextPart,string>={system:'系统提示词',conversation:'对话',skills:'Skill',tools:'系统工具',mcp:'MCP',results:'工具结果',images:'图片'};
export function ContextUsageIndicator({overview,capacity}:{overview?:ContextOverview;capacity?:number}){
  const {t,language}=useI18n(),[open,setOpen]=useState(false),[position,setPosition]=useState({left:12,bottom:60,width:340});
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const limit=overview?.capacity||capacity||0,percent=overview&&limit>0?overview.tokens/limit*100:undefined;
  const number=(value:number)=>new Intl.NumberFormat(language).format(value);
  const percentage=(value:number)=>new Intl.NumberFormat(language,{maximumFractionDigits:1}).format(value)+'%';
  useLayoutEffect(()=>{if(!open)return;const place=()=>{const rect=trigger.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(350,window.innerWidth-24);setPosition({width,left:Math.max(12,Math.min(rect.right-width,window.innerWidth-width-12)),bottom:Math.max(12,window.innerHeight-rect.top+10)});};place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true);return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};},[open]);
  useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!trigger.current?.contains(event.target as Node)&&!panel.current?.contains(event.target as Node))setOpen(false);};const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setOpen(false);trigger.current?.focus();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',key,true);return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',key,true);};},[open]);
  const title=percent===undefined?t('上下文占用'):t('上下文占用 {percent}',{percent:percentage(percent)});
  return <><button ref={trigger} type="button" className="context-usage-trigger" aria-label={title} title={t('查看上下文占用')} aria-expanded={open} aria-haspopup="dialog" onClick={()=>setOpen(value=>!value)}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="context-ring-track" cx="12" cy="12" r="8"/><circle className={`context-ring-value ${(percent||0)>=90?'context-ring-high':''}`} cx="12" cy="12" r="8" pathLength="100" strokeDasharray={`${Math.max(0,Math.min(100,percent||0))} 100`}/></svg>
  </button>{open&&createPortal(<div ref={panel} className="context-usage-panel" role="dialog" aria-label={t('上下文占用')} style={{...position,maxHeight:`calc(100vh - ${position.bottom+12}px)`}}>
    <header><strong>{t('上下文容量')}</strong><span>{overview?`${number(overview.tokens)} / ${number(limit)}`:limit?`— / ${number(limit)}`:'—'}</span></header>
    <div className="context-usage-total"><div className="context-usage-bar" role="progressbar" aria-label={t('上下文容量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent===undefined?undefined:Math.min(100,Math.round(percent))}>{CONTEXT_PARTS.map(part=><span className={`context-part-${part}`} key={part} style={{width:overview&&limit?`${overview.parts[part]/Math.max(limit,overview.tokens)*100}%`:'0%'}}/>)}</div><strong>{percent===undefined?'—':percentage(percent)}</strong></div>
    <div className="context-usage-parts">{CONTEXT_PARTS.map(part=><div key={part}><span><i className={`context-part-${part}`}/>{t(labels[part])}</span><span>{overview?number(overview.parts[part]):'—'} <small>{overview&&limit?percentage(overview.parts[part]/limit*100):''}</small></span></div>)}</div>
    <footer>{overview?<><span>{t('最近一次请求 · 估算')} · {overview.model}</span><p>{t('各项占比以模型窗口为基准。分类按消息和工具类型估算，批量结果计入工具结果。')}</p></>:<p>{t('发送请求后显示上下文占用。')}</p>}</footer>
  </div>,document.body)}</>;
}
