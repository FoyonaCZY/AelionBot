import {useState} from 'react';
import {version} from '../package.json';
import type {UpdateState} from './update-types';
import {SettingsSection} from './SettingsWindow';
import {FeedbackSettings} from './FeedbackSettings';
import {bytes} from './ui';
import './updates.css';

const labels={idle:'',checking:'正在检查更新…',current:'已是最新版本',available:'有新版本可用',downloading:'正在下载更新…',cancelling:'正在取消下载…',downloaded:'更新已下载',installing:'正在准备安装更新…',error:'更新未完成',unsupported:'开发模式下不安装更新，请使用发行版。'};
export function AboutSettings({update,onNotify}:{update?:UpdateState;onNotify:(text:string)=>void}){
  const [pending,setPending]=useState(false),phase=update?.phase||'idle',working=['checking','downloading','cancelling','installing'].includes(phase);
  const act=async(action:()=>Promise<unknown>)=>{setPending(true);try{await action();}catch(error){onNotify((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}finally{setPending(false);}};
  const check=()=>void act(()=>window.aelion.checkForUpdates());
  return <><SettingsSection title="应用"><div className="about-app">
    <div className="about-update-heading"><div><span className="brand">Aelion<span>Bot</span></span><p className="about-version">版本 {update?.currentVersion||version}</p></div><button className="secondary-button" disabled={pending||working||phase==='unsupported'} onClick={check}>{phase==='checking'?'检查中…':'检查更新'}</button></div>
    {update&&<div className="about-update-content">
      <div className="about-update-status" role="status">{labels[phase]}{update.latestVersion&&['available','downloading','downloaded','installing'].includes(phase)&&<strong> {update.latestVersion}</strong>}</div>
      {update.progress&&<><div className="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.progress.percent)}><div style={{width:update.progress.percent+'%'}}/></div><div className="update-progress-detail"><span>{bytes(update.progress.transferred)}{update.progress.total>0?` / ${bytes(update.progress.total)}`:''}</span><span>{Math.round(update.progress.percent)}%</span></div></>}
      {update.error&&<p className="update-error" role="alert">{update.error}</p>}
      {update.manualInstall&&<p className="update-note">Mac 预览版尚未公证，更新时请下载新版安装包并替换应用。</p>}
      {phase==='downloaded'&&update.installBlockedReason&&<p className="update-note">{update.installBlockedReason}</p>}
      {phase==='installing'&&<p className="update-note">正在保存状态并关闭工作电脑，安装后会重新打开。</p>}
      <div className="about-update-actions"><button className="text-button" onClick={()=>void act(()=>window.aelion.openUpdateRelease())} disabled={pending||phase==='installing'}>查看 GitHub Release</button>
        {['available','error'].includes(phase)&&update.latestVersion&&<button className="primary-button" disabled={pending} onClick={()=>void act(()=>update.manualInstall?window.aelion.openUpdateRelease():window.aelion.downloadUpdate())}>{update.manualInstall?'前往下载':phase==='error'?'重试下载':'下载更新'}</button>}
        {phase==='downloading'&&<button className="secondary-button" onClick={()=>void window.aelion.cancelUpdateDownload()}>取消下载</button>}
        {phase==='downloaded'&&<button className="primary-button" disabled={pending||Boolean(update.installBlockedReason)} onClick={()=>void act(()=>window.aelion.installUpdate())}>重启并更新</button>}
      </div>
      <p className="update-source">更新来源：{update.repository}</p>
    </div>}
  </div></SettingsSection><FeedbackSettings onNotify={onNotify}/></>;
}
