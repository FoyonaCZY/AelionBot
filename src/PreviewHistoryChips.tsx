import {Icon} from './ui';
import {useI18n} from './i18n';
import type {PreviewHistoryEntry} from './agent-preview';
import './preview-history.css';

export function PreviewHistoryChips({entries,runIds,artifactNames,attachmentIds,onOpen}:{entries:PreviewHistoryEntry[];runIds?:string[];artifactNames?:Set<string>;attachmentIds?:Set<string>;onOpen:(entry:PreviewHistoryEntry)=>void}){
  const {t}=useI18n();
  const match=new Set(runIds||[]);
  const scoped=entries.filter(entry=>{
    if(!match.has(entry.runId))return false;
    if(entry.target.kind==='workspace'&&artifactNames?.has(entry.target.path))return false;
    if(entry.target.kind==='attachment'&&attachmentIds?.has(entry.target.file.id))return false;
    return true;
  });
  if(!scoped.length)return null;
  return <div className="message-artifacts preview-history">{scoped.map(entry=><button key={entry.id} type="button" className="preview-history-chip" onClick={()=>onOpen(entry)} title={t('重新打开预览')}><span className="preview-history-symbol" aria-hidden="true">{entry.target.kind==='url'?<Icon name="globe" size={16}/>:<Icon name="file" size={16}/>}</span><span className="preview-history-name">{entry.name}</span><span className="preview-history-action"><Icon name="expand" size={14}/></span></button>)}</div>;
}
