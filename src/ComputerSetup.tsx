import React,{useEffect,useRef,useState} from 'react';
import type {VmState} from './shared';
import {Icon} from './ui';
import {COMPUTER_SETUP_ESTIMATE,computerSetupActions,computerSetupActionLabel,computerSetupState} from './computer-setup-state';
import './computer-setup.css';

const steps=['下载系统镜像','启动系统','安装桌面与应用','重启并连接桌面'];
function SetupProgress({vm}:{vm:VmState}){
  const downloading=vm.status==='preparing',percent=downloading&&Number.isFinite(vm.progress)?Math.round(Math.min(1,Math.max(0,vm.progress!))*100):undefined;
  return <div className="setup-progress" role="progressbar" aria-label={downloading?'系统镜像下载进度':'工作环境安装进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={percent===undefined?'正在准备':`${percent}%`}><span className={percent===undefined?'indeterminate':''} style={percent===undefined?undefined:{width:`${percent}%`}}/></div>;
}
export function ComputerStatus({vm,onOpen}:{vm:VmState;onOpen:()=>void}){
  const view=computerSetupState(vm);
  return <section className="computer-setup-card" aria-label="工作电脑状态">
    <Icon name="computer" size={29}/><strong>{view.title}</strong>
    <p>{view.kind==='stopped'&&vm.appsReady?'启动后即可使用工作桌面。':view.kind==='restart'?'应用已安装，请重启工作电脑继续。':view.kind==='error'?'查看原因后可继续重试。':view.working?vm.detail:'让 Bot 使用浏览器、文件和办公软件。'}</p>
    {view.working&&<SetupProgress vm={vm}/>}
    {!(view.kind==='stopped'&&vm.appsReady)&&<span className="setup-estimate-small">首次准备约 5～15 分钟</span>}
    <button className={view.working?'secondary-button':'primary-button'} onClick={onOpen}>{view.working?'查看进度':computerSetupActionLabel(vm)}</button>
  </section>;
}
export function ComputerSetup({vm,disabled,onClose,onReady,onNotify}:{vm:VmState;disabled:boolean;onClose:()=>void;onReady:()=>void;onNotify:(message:string)=>void}){
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
  return <div className="computer-setup" ref={content}>
    <div className="setup-intro"><span className="setup-computer-icon"><Icon name="computer" size={32}/></span><h3 aria-live="polite">{view.title}</h3><p>{ready?'现在可以让 Bot 浏览网页、处理文件和使用应用。':view.kind==='restart'?'桌面和应用已安装。重启工作电脑后，将完成最后的配置。':'为 Bot 准备一台独立的工作电脑，用于浏览网页、处理文件和使用应用。'}</p></div>
    {!ready&&!(view.kind==='stopped'&&vm.appsReady)&&<div className="setup-time"><strong>首次初始化预计 5～15 分钟</strong><span>{COMPUTER_SETUP_ESTIMATE} 初始化期间请保持应用开启。</span></div>}
    <ol className="setup-steps" aria-label="初始化步骤">{steps.map((step,index)=><li key={step} className={index<view.step?'complete':index===view.step?'active':''} aria-current={index===view.step?'step':undefined}><span aria-hidden="true">{index<view.step?'✓':index+1}</span><div><strong>{step}</strong>{index===2&&<small>浏览器 · 文件管理器 · 办公套件</small>}</div></li>)}</ol>
    {view.working&&<div className="setup-current" role="status"><span>{vm.detail}</span><SetupProgress vm={vm}/><p>完成后会自动更新状态，你也可以先去配置模型或聊天。</p></div>}
    {(error||view.kind==='error')&&<p className="setup-error" role="alert">{error||vm.lastError||'初始化未完成，请重试。'}</p>}
    {view.kind==='invite'&&<p className="setup-requirements">需要联网，并启用硬件虚拟化和 Windows 虚拟机监控程序平台。</p>}
    {disabled&&!ready&&!view.working&&<p className="setup-requirements">请先结束正在运行的 Bot 任务，再维护工作电脑。</p>}
    <div className="setup-actions"><button className="secondary-button" onClick={onClose}>{view.kind==='invite'?'稍后设置':ready?'关闭':view.working||pending?'后台继续':'稍后处理'}</button>{ready?<button className="primary-button" onClick={onReady}>查看工作电脑</button>:<button className="primary-button" disabled={pending||disabled||view.working} onClick={()=>void run()}>{pending||view.working?'正在初始化…':error?'重试':computerSetupActionLabel(vm)}</button>}</div>
  </div>;
}
