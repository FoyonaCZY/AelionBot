import {useState} from 'react';
import type {LiveWorkItem} from './live-work';
import {liveWorkTitle} from './live-work';
import {Icon} from './ui';
import {useI18n} from './i18n';
import './live-work.css';

function cwdName(cwd:string){return cwd.replace(/\\/g,'/').split('/').filter(Boolean).at(-1)||cwd;}
function LiveWorkRow({item}:{item:LiveWorkItem}){
  const {t}=useI18n();
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const stop=async()=>{if(busy)return;setBusy(true);setError('');try{await window.aelion.stopLiveWork({botId:item.botId,kind:item.kind,id:item.id});}catch(reason){setError((reason as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));setBusy(false);}};
  return <div className="live-work-row" data-live-kind={item.kind}>
    <span className="live-work-mark" aria-hidden="true"><Icon name="terminal" size={14}/></span>
    <span className="live-work-copy"><strong>{liveWorkTitle(item)}</strong><small>{item.location==='host'?t('本机'):t('工作电脑')}{cwdName(item.cwd)?` · ${cwdName(item.cwd)}`:''}{item.purpose==='service'?` · ${t('服务')}`:''}</small></span>
    <button type="button" className="live-work-stop" disabled={busy} onClick={()=>void stop()}>{busy?t('正在停止…'):t('停止')}</button>
    {error&&<p className="live-work-error" role="alert">{error}</p>}
  </div>;
}
export function LiveWorkStrip({items}:{items?:LiveWorkItem[]}){
  const {t}=useI18n();
  if(!items?.length)return null;
  return <div className="live-work-strip" aria-label={t('正在运行的任务')}>
    {items.map(item=><LiveWorkRow key={item.kind+':'+item.id} item={item}/>)}
  </div>;
}
