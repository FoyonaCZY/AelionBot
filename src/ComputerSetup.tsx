import React,{useEffect,useRef,useState} from 'react';
import type {Bot,VmState} from './shared';
import {Avatar,Icon} from './ui';
import {computerSetupActions,computerSetupActionLabel,computerSetupState} from './computer-setup-state';
import {useI18n} from './i18n';
import './computer-setup.css';

function SetupProgress({vm}:{vm:VmState}){
  const {t}=useI18n();
  const downloading=vm.status==='preparing',percent=downloading&&Number.isFinite(vm.progress)?Math.round(Math.min(1,Math.max(0,vm.progress!))*100):vm.maintenance&&Number.isFinite(vm.installation?.percent)?Math.floor(vm.installation!.percent!):undefined;
  return <div className="setup-progress" role="progressbar" aria-label={downloading?t('系统镜像下载进度'):t('工作电脑准备进度')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent===undefined?t('正在准备'):`${percent}%`}><span className={percent===undefined?'indeterminate':''} style={percent===undefined?undefined:{width:`${percent}%`}}/></div>;
}
export function ComputerStatus({vm,onOpen,minimal=false,bot}:{vm:VmState;onOpen:()=>void;minimal?:boolean;bot?:Pick<Bot,'id'|'name'|'color'|'avatarStyle'>}){
  const {t}=useI18n();
  const view=computerSetupState(vm);
  if(minimal){
    const title=t(view.kind==='stopped'?'电脑已关闭':view.kind==='invite'?'准备一个工作桌面':view.kind==='download'?'正在准备系统':view.kind==='starting'?'正在启动':view.kind==='stopping'?'正在关闭':view.kind==='installing'?'正在准备应用':view.kind==='restart'?'需要重启':view.kind==='error'?'准备未完成':view.kind==='incomplete'?'继续准备桌面':'桌面已就绪');
    const label=t(view.working?'查看进度':view.kind==='stopped'?'启动电脑':view.kind==='invite'?'开始设置':view.kind==='error'?'重试':view.kind==='restart'?'重启电脑':'继续设置');
    return <section className="computer-rest-card" data-state={view.kind} aria-label={t('工作电脑状态')}><div className={`computer-rest-visual ${view.working?'':'is-sleeping'}`} aria-hidden="true">
      <svg className="computer-rest-scene" viewBox="0 0 198 139" fill="none"><ellipse cx="99" cy="128" rx="65" ry="3" fill="#eeebf2"/><path d="M85 100h28l4 21H81l4-21Z" fill="#e4dfec"/><rect x="69" y="120" width="60" height="4" rx="2" fill="#d9d2e4"/><rect x="26" y="19" width="146" height="89" rx="10" fill="#f2eff7" stroke="#d7d0e2" strokeWidth="1.4"/><rect x="32" y="25" width="134" height="71" rx="5" fill="#faf8fd"/><circle cx="99" cy="102" r="1.6" fill="#c4b7d5"/><path d="M17 38h-5m151-28 3-4m16 45h5" stroke="#e1dbea" strokeWidth="2" strokeLinecap="round"/></svg>
      <Avatar bot={bot||{name:'AelionBot',color:'#a38cc7'}} size={46} activity={view.working?'thinking':'idle'}/>
    </div><span className="computer-rest-title" role="status" aria-live="polite">{title}</span>{view.working&&<SetupProgress vm={vm}/>}<button type="button" className="computer-rest-start" onClick={onOpen} aria-label={view.working?t('查看工作电脑准备进度'):t(computerSetupActionLabel(vm))}>{!view.working&&<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 3v9m-5-7a9 9 0 1 0 10 0"/></svg>}{label}</button></section>;
  }
  return <section className="computer-setup-card" aria-label={t('工作电脑状态')}>
    <Icon name="computer" size={29}/><strong>{t(view.title)}</strong>
    <p>{view.kind==='stopped'&&vm.appsReady?t('启动后即可使用工作桌面。'):view.kind==='restart'?t('应用已安装，请重启工作电脑继续。'):view.kind==='error'?t('查看原因后可继续重试。'):view.working?vm.detail:t('让 Bot 使用浏览器、文件和办公软件。')}</p>
    {view.working&&<SetupProgress vm={vm}/>}
    {!(view.kind==='stopped'&&vm.appsReady)&&<span className="setup-estimate-small">{t('首次准备约 5～15 分钟')}</span>}
    <button className={view.working?'secondary-button':'primary-button'} onClick={onOpen}>{view.working?t('查看进度'):t(computerSetupActionLabel(vm))}</button>
  </section>;
}
export function ComputerSetup({vm,disabled,bot,onClose,onReady,onNotify}:{vm:VmState;disabled:boolean;bot?:Pick<Bot,'id'|'name'|'color'|'avatarStyle'>;onClose:()=>void;onReady:()=>void;onNotify:(message:string)=>void}){
  const {t}=useI18n();
  const [pending,setPending]=useState(false),[error,setError]=useState(''),inFlight=useRef(false),content=useRef<HTMLDivElement>(null);
  const view=computerSetupState(vm),ready=view.kind==='ready';
  useEffect(()=>{
    const dialog=content.current?.closest<HTMLElement>('[role="dialog"]'),previous=document.activeElement as HTMLElement|null;
    const buttons=()=>Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"],summary')||[]);
    (content.current?.querySelector<HTMLElement>('.primary-button')||buttons()[0])?.focus();
    const trap=(event:KeyboardEvent)=>{if(event.key!=='Tab')return;const items=buttons(),first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}};
    dialog?.addEventListener('keydown',trap);return()=>{dialog?.removeEventListener('keydown',trap);if(previous?.isConnected)previous.focus();};
  },[]);
  const run=async()=>{
    if(inFlight.current)return;inFlight.current=true;setPending(true);setError('');
    try{for(const action of computerSetupActions(vm))await window.aelion.vmAction(action);}
    catch(reason){const message=(reason as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');setError(message);onNotify(message);}
    finally{inFlight.current=false;setPending(false);}
  };
  const busy=view.working||pending,firstTime=!vm.appsReady;
  const title=t(error?'准备暂时停住了':pending?'正在唤醒桌面':({invite:'给伙伴一个桌面',stopped:'让伙伴开始工作',download:'正在准备新桌面',starting:'桌面正在醒来',stopping:'让桌面休息一下',installing:'把工具准备好',restart:'就差最后一步',error:'准备暂时停住了',incomplete:'接着准备桌面',ready:'一切就绪'}[view.kind]));
  const subtitle=error||view.kind==='error'?t('进度会保留，可以继续重试。'):ready?t('浏览网页、整理文件，现在就开始。'):view.kind==='restart'?t('重启一下，就可以开始工作。'):busy?t('你可以先去聊天，我们会继续准备。'):view.kind==='stopped'&&vm.appsReady?t('你的文件和应用，都还在。'):t('浏览网页、处理文件，把想法做出来。');
  const action=t(error||view.kind==='error'?'重试':view.kind==='restart'?'重启并继续':view.kind==='stopped'?'启动电脑':view.kind==='incomplete'?'继续准备':'准备桌面');
  return <div className="computer-setup" ref={content} data-state={error?'error':busy?'working':view.kind} aria-busy={busy}>
    <div className="setup-mascot" aria-hidden="true"><span className="setup-mascot-floor"/><span className="setup-mascot-spark spark-one"/><span className="setup-mascot-spark spark-two"/><Avatar bot={bot||{name:'AelionBot',color:'#9273d4'}} size={76} activity={busy?'working':error||view.kind==='error'||view.kind==='restart'?'waiting':'idle'}/>{ready&&<span className="setup-mascot-check"><Icon name="check" size={14}/></span>}</div>
    <div className="setup-intro"><h3 aria-live="polite">{title}</h3><p>{subtitle}</p></div>
    {busy?<div className="setup-current" role="status"><div className="setup-current-label"><span>{pending?t('正在连接'):view.kind==='download'?t('下载系统'):view.kind==='installing'?t('准备应用'):view.kind==='stopping'?t('保存并关闭'):t('连接桌面')}</span><span>{view.kind==='download'&&Number.isFinite(vm.progress)?`${Math.round(Math.min(1,Math.max(0,vm.progress!))*100)}%`:view.kind==='installing'&&Number.isFinite(vm.installation?.percent)?`${Math.floor(vm.installation!.percent!)}%`:t('请稍候')}</span></div><SetupProgress vm={vm}/></div>:!ready&&firstTime&&view.kind==='invite'?<div className="setup-capabilities" aria-label={t('工作电脑可以使用')}><span><Icon name="globe" size={15}/>{t('浏览器')}</span><span><Icon name="folder" size={15}/>{t('文件')}</span><span><Icon name="file" size={15}/>{t('办公应用')}</span></div>:null}
    {(error||view.kind==='error')&&<details className="setup-diagnostics"><summary>{t('查看原因')}</summary><p className="setup-error" role="alert">{error||vm.lastError||t('初始化未完成，请重试。')}</p></details>}
    {view.working&&vm.detail&&<details className="setup-diagnostics"><summary>{t('查看进度详情')}</summary><p>{vm.detail}</p></details>}
    {disabled&&!ready&&!busy&&<p className="setup-requirements">{t('请先结束正在运行的 Bot 任务')}</p>}
    <div className="setup-actions">{busy?<button className="primary-button setup-background" onClick={onClose}>{t('后台继续')}<Icon name="arrow" size={15}/></button>:<><button className="secondary-button" onClick={onClose}>{ready?t('关闭'):t('稍后')}</button><button className="primary-button" disabled={!ready&&disabled} onClick={ready?onReady:()=>void run()}>{ready?t('打开桌面'):action}<Icon name={ready?'arrow':view.kind==='restart'?'restart':'arrow'} size={15}/></button></>}</div>
    {!ready&&firstTime&&!busy&&view.kind==='invite'&&<div className="setup-footnote">{t('首次约 5～15 分钟 · 需要联网')}<details><summary aria-label={t('查看准备要求')}><Icon name="info" size={13}/></summary><p>{t('初始化期间请保持应用开启。Windows 需启用硬件虚拟化和虚拟机监控程序平台。')}</p></details></div>}
    {busy&&<p className="setup-footnote">{t('保持 AelionBot 开启即可')}</p>}
  </div>;
}
