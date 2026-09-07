import {useState} from 'react';
import type {AttachmentScope} from './attachment-types';
import {HOST_PERMISSION_MODES,type HostPermissionMode} from './permission-types';
import {Select} from './Select';
import {Icon} from './ui';
import './permission-modes.css';

export function PermissionModePicker({scope,mode='ask'}:{scope:AttachmentScope;mode?:HostPermissionMode}){
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const current=HOST_PERMISSION_MODES.find(item=>item.id===mode)||HOST_PERMISSION_MODES[0];
  const change=async(next:HostPermissionMode)=>{setPending(true);setError('');try{await window.aelion.setHostPermissionMode({scope,mode:next});}catch(error){setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}finally{setPending(false);}};
  return <div className={`permission-mode permission-mode-${current.id}`}>
    <Select aria-label="本机权限模式" title={`当前会话 · ${current.description}`} value={current.id} disabled={pending} onChange={event=>void change(event.target.value as HostPermissionMode)}>{HOST_PERMISSION_MODES.map(item=><option key={item.id} value={item.id} title={item.description}>{item.label}</option>)}</Select>
    {error&&<div className="permission-mode-error" role="alert">{error}<button type="button" aria-label="关闭权限模式提示" onClick={()=>setError('')}><Icon name="close" size={13}/></button></div>}
  </div>;
}
