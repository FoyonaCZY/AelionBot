import {useEffect,useId,useState} from 'react';
import type {HostWorkspaceSettings as WorkspaceSettings} from './shared';
import {SettingsSection} from './SettingsWindow';
import {useI18n} from './i18n';

export function HostWorkspaceSettings({settings,busy,act,onSaved}:{settings:WorkspaceSettings;busy:boolean;act:(operation:()=>Promise<unknown>)=>Promise<void>;onSaved:()=>void}){
  const {t}=useI18n();
  const [path,setPath]=useState(settings.workspaceDir),inputId=useId();
  useEffect(()=>setPath(settings.workspaceDir),[settings.workspaceDir]);
  const persist=async(next:string)=>{if(!next.trim()||next===settings.workspaceDir){setPath(next||settings.workspaceDir);return;}setPath(next);try{await window.aelion.saveHostWorkspace(next);onSaved();}catch(error){setPath(settings.workspaceDir);throw error;}};
  return <SettingsSection title={t('用户电脑')}>
    <div className="settings-card"><div className="settings-row">
      <label htmlFor={inputId}>{t('默认工作目录')}</label>
      <div className="settings-path-field"><input id={inputId} aria-label={t('本机默认工作目录')} value={path} title={path} onChange={event=>setPath(event.target.value)} onBlur={()=>void act(()=>persist(path))} spellCheck={false} autoComplete="off" disabled={busy}/><button type="button" className="secondary-button" disabled={busy} onClick={()=>void act(async()=>{const selected=await window.aelion.pickHostWorkspace();if(selected)await persist(selected);})}>{t('浏览')}</button></div>
    </div></div>
    <div className="settings-actions workspace-actions"><button type="button" className="text-button" disabled={busy||path===settings.defaultWorkspaceDir} onClick={()=>void act(()=>persist(settings.defaultWorkspaceDir))}>{t('恢复默认')}</button></div>
  </SettingsSection>;
}
