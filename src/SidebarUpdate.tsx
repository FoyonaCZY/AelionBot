import type {UpdateState} from './update-types';
import {Icon} from './ui';
import {useI18n} from './i18n';
import './updates.css';

export function SidebarUpdate({update,onOpen}:{update?:UpdateState;onOpen:()=>void}){
  const {t}=useI18n();
  if(!update?.latestVersion||!['available','downloading','cancelling','downloaded','installing','error'].includes(update.phase))return null;
  const label=update.phase==='downloading'?`${Math.round(update.progress?.percent||0)}%`:update.phase==='downloaded'?t('重启更新'):update.phase==='installing'?t('更新中'):update.phase==='cancelling'?t('取消中'):t('更新');
  const status=update.phase==='downloading'?`${t('正在下载')} ${label}`:update.phase==='downloaded'?t('更新已下载'):update.phase==='error'?t('更新需要重试'):label;
  return <button className="sidebar-update" aria-label={t('查看更新')} aria-haspopup="dialog" title={`${status} · ${t('版本')} ${update.latestVersion}`} onClick={onOpen}><Icon name="download" size={14}/><span>{label}</span></button>;
}
