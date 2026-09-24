import {useI18n} from './i18n';
import type {CanvasExportFormat} from './canvas-export';
import './canvas-export-status.css';
export interface CanvasExportState{phase:'running'|'success'|'error'|'cancelled';format:CanvasExportFormat|'original';name:string;itemId:string;detail?:string;}
export function CanvasExportStatus({state,onDismiss,onRetry}:{state:CanvasExportState;onDismiss:()=>void;onRetry?:()=>void}){
 const {language}=useI18n(),l=(cn:string,en:string)=>language==='en'?en:cn;
 const format=state.format==='original'?l('文件','file'):state.format==='sketch'?'Sketch':state.format.toUpperCase();
 const title=state.phase==='running'?l('正在导出 '+format+'…','Exporting '+format+'…'):state.phase==='success'?l(format+' 已导出',format+' exported'):state.phase==='error'?l('导出失败','Export failed'):l('已取消导出','Export cancelled');
 return <div className={'fp-export-status is-'+state.phase} role={state.phase==='error'?'alert':'status'} aria-live={state.phase==='error'?'assertive':'polite'} aria-atomic="true">
  {state.phase==='running'?<span className="fp-export-spinner" aria-hidden="true"/>:<span className="fp-export-status-symbol" aria-hidden="true">{state.phase==='success'?'✓':state.phase==='error'?'!':'−'}</span>}
  <div className="fp-export-status-copy"><strong>{title}</strong><span title={state.detail||state.name}>{state.detail||state.name}</span></div>
  {state.phase==='error'&&onRetry&&<button type="button" onClick={onRetry}>{l('重试','Retry')}</button>}
  {state.phase!=='running'&&<button type="button" className="fp-export-dismiss" onClick={onDismiss} aria-label={l('关闭导出提示','Dismiss export status')}>×</button>}
 </div>;
}
