import type {UpdateState} from './update-types';
import {Icon} from './ui';
import './updates.css';

export function SidebarUpdate({update,onOpen}:{update?:UpdateState;onOpen:()=>void}){
  if(!update?.latestVersion||!['available','downloading','cancelling','downloaded','installing','error'].includes(update.phase))return null;
  const label=update.phase==='downloading'?`${Math.round(update.progress?.percent||0)}%`:update.phase==='downloaded'?'重启更新':update.phase==='installing'?'更新中':update.phase==='cancelling'?'取消中':'更新';
  const status=update.phase==='downloading'?`正在下载 ${label}`:update.phase==='downloaded'?'更新已下载':update.phase==='error'?'更新需要重试':label;
  return <button className="sidebar-update" aria-label="查看更新" aria-haspopup="dialog" title={`${status} · 版本 ${update.latestVersion}`} onClick={onOpen}><Icon name="download" size={14}/><span>{label}</span></button>;
}
