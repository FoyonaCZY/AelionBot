import {useState} from 'react';
import type {AttachmentScope} from './attachment-types';
import {DEFAULT_HOST_PERMISSION_MODE,HOST_PERMISSION_MODES,type HostPermissionMode} from './permission-types';
import {Select} from './Select';
import {Icon} from './ui';
import {useI18n} from './i18n';
import './permission-modes.css';

export function PermissionModePicker({scope,mode=DEFAULT_HOST_PERMISSION_MODE}:{scope:AttachmentScope;mode?:HostPermissionMode}){
  const {t}=useI18n();
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const current=HOST_PERMISSION_MODES.find(item=>item.id===mode)||HOST_PERMISSION_MODES[0];
  const change=async(next:HostPermissionMode)=>{setPending(true);setError('');try{await window.aelion.setHostPermissionMode({scope,mode:next});}catch(error){setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}finally{setPending(false);}};
  return <div className={`permission-mode permission-mode-${current.id}`}>
    <Select aria-label={t('本机权限模式')} title={`${t('当前会话')} · ${t(current.description)}`} value={current.id} disabled={pending} onChange={event=>void change(event.target.value as HostPermissionMode)}>{HOST_PERMISSION_MODES.map(item=><option key={item.id} value={item.id} title={t(item.description)}>{t(item.label)}</option>)}</Select>
    {error&&<div className="permission-mode-error" role="alert">{error}<button type="button" aria-label={t('关闭权限模式提示')} onClick={()=>setError('')}><Icon name="close" size={13}/></button></div>}
  </div>;
}
