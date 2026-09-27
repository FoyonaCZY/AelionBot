import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {ContextOverview,ContextPart} from './context-overview';
import {CONTEXT_PARTS,foldContextParts} from './context-overview';
import {useI18n} from './i18n';
import './context-usage.css';

const labels:Record<ContextPart,string>={system:'系统提示词',conversation:'对话',skills:'Skill',tools:'系统工具',mcp:'MCP'};
type CompactResult={compacted:boolean;freedTokens:number;queued?:boolean;issue?:string};
// Manual compaction with an optional focus, like /compact in other agents.
function CompactContext({onCompact}:{onCompact:(focus:string)=>Promise<CompactResult>}){
  const {t,language}=useI18n(),[focus,setFocus]=useState(''),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  return <form className="context-compact" onSubmit={async event=>{
    event.preventDefault();if(busy)return;setBusy(true);setStatus('');
    try{const result=await onCompact(focus);setStatus(result.queued?t('将在下一次模型请求前压缩'):result.compacted?t('已压缩，释放约 {tokens} Token',{tokens:new Intl.NumberFormat(language).format(result.freedTokens)})+(result.issue?' · '+result.issue:''):result.issue||t('没有可以压缩的较早记录'));if(result.compacted||result.queued)setFocus('');}
    catch(error){setStatus((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}
    finally{setBusy(false);}
  }}>
    <input type="text" value={focus} maxLength={1000} aria-label={t('压缩重点（可选）')} placeholder={t('压缩重点（可选）')} disabled={busy} onChange={event=>setFocus(event.target.value)}/>
    <button type="submit" disabled={busy}>{busy?t('压缩中…'):t('立即压缩')}</button>
    {status&&<p role="status">{status}</p>}
  </form>;
}
export function ContextUsageIndicator({overview,capacity,onCompact}:{overview?:ContextOverview;capacity?:number;onCompact?:(focus:string)=>Promise<CompactResult>}){
  const {t,language}=useI18n(),[open,setOpen]=useState(false),[position,setPosition]=useState({left:12,bottom:60,width:340});
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  const parts=foldContextParts(overview?.parts);
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
    <div className="context-usage-total"><div className="context-usage-bar" role="progressbar" aria-label={t('上下文容量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent===undefined?undefined:Math.min(100,Math.round(percent))}>{CONTEXT_PARTS.map(part=><span className={`context-part-${part}`} key={part} style={{width:overview&&limit?`${parts[part]/Math.max(limit,overview.tokens)*100}%`:'0%'}}/>)}</div><strong>{percent===undefined?'—':percentage(percent)}</strong></div>
    <div className="context-usage-parts">{CONTEXT_PARTS.map(part=><div key={part}><span><i className={`context-part-${part}`}/>{t(labels[part])}</span><span>{overview?number(parts[part]):'—'} <small>{overview&&limit?percentage(parts[part]/limit*100):''}</small></span></div>)}</div>
    {onCompact&&<CompactContext onCompact={onCompact}/>}
  </div>,document.body)}</>;
}
