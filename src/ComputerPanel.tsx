import {useEffect,useRef,useState,type ReactNode} from 'react';
import type {Bot,VmState} from './shared';
import {ComputerStatus} from './ComputerSetup';
import {Icon} from './ui';
import {useI18n} from './i18n';
import './computer-panel.css';

export function ComputerPanel({vm,ready,bot,onOpen,onSetup,onSettings,children}:{vm:VmState;ready:boolean;bot?:Pick<Bot,'id'|'name'|'color'|'avatarStyle'>;onOpen:()=>void;onSetup:()=>void;onSettings:()=>void;children?:ReactNode}){
  const {t}=useI18n();
  const surface=useRef<HTMLDivElement>(null),[aspect,setAspect]=useState(16/10);
  useEffect(()=>{
    const root=surface.current;if(!ready||!root)return;
    const measure=()=>{const canvas=root.querySelector('canvas');if(canvas&&canvas.width>1&&canvas.height>1){const next=canvas.width/canvas.height;if(Number.isFinite(next)&&next>0)setAspect(current=>Math.abs(current-next)<.001?current:next);}};
    measure();const observer=new MutationObserver(measure);observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['width','height']});return()=>observer.disconnect();
  },[ready]);
  return <section className={`computer-panel ${ready?'is-online':'is-offline'}`} aria-label={t('工作电脑')}>
    {ready?<div className="computer-panel-screen" role="button" tabIndex={0} aria-label={t('全屏查看工作电脑')} title={t('全屏查看工作电脑')} style={{aspectRatio:aspect}} onClick={onOpen} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onOpen();}}}>
      <div ref={surface} className="computer-panel-display" inert>{children}</div><span className="computer-panel-expand" aria-hidden="true"><Icon name="expand" size={15}/></span>
    </div>:<ComputerStatus vm={vm} bot={bot} minimal onOpen={onSetup}/>}
    <button type="button" className="computer-panel-settings" aria-label={t('电脑设置')} title={t('电脑设置')} onClick={onSettings}><Icon name="settings" size={17}/></button>
  </section>;
}
