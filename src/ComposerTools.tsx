import {useEffect,useRef,useState} from 'react';
import type {AttachmentScope} from './attachment-types';
import {AttachmentIcon} from './Attachments';
import {Icon} from './ui';
import {CompanionGlyph} from './CompanionCard';
import {useI18n} from './i18n';
import type {WorkMode} from './work-types';
import './work-items.css';

export function ComposerTools({scope,workspaceDir,onAttach,onCommand,onFolderPicked}:{scope:AttachmentScope;workspaceDir?:string;onAttach:()=>void;onCommand:(mode:WorkMode)=>void;onFolderPicked:()=>void}){
  const {t}=useI18n();
  const [open,setOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
  const close=()=>{setOpen(false);button.current?.focus();};
  const folder=async(reset=false)=>{close();setPending(true);setError('');try{if(reset)await window.aelion.resetConversationWorkspace(scope);else await window.aelion.pickConversationWorkspace(scope);}catch(error){setError((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,''));}finally{setPending(false);onFolderPicked();}};
  return <div ref={root} className="composer-tools" onKeyDown={event=>{
    if(!open)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=[...root.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')],at=items.indexOf(document.activeElement as HTMLElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowUp'?-1:1)+items.length)%items.length]?.focus();}
  }}>
    <button ref={button} type="button" className="icon-button composer-plus" aria-label={t('添加附件或工作目录')} aria-haspopup="menu" aria-expanded={open} disabled={pending} onClick={()=>setOpen(!open)}><Icon name="plus" size={23}/></button>
    {workspaceDir&&<div className="composer-workspace" title={workspaceDir}><button type="button" disabled={pending} onClick={()=>void folder()} aria-label={t('工作目录：{path}',{path:workspaceDir})}><Icon name="folder" size={15}/><span>{workspaceDir.split(/[\\/]/).filter(Boolean).at(-1)||workspaceDir}</span></button><button type="button" className="workspace-remove" aria-label={t('清除会话工作目录')} disabled={pending} onClick={()=>void folder(true)}><Icon name="close" size={13}/></button></div>}
    {open&&<div className="composer-add-menu" role="menu" aria-label={t('添加到会话')}>
      <button type="button" role="menuitem" onClick={()=>{close();onAttach();}}><span className="composer-menu-icon"><AttachmentIcon/></span><span>{t('上传附件')}</span></button>
      <button type="button" role="menuitem" onClick={()=>void folder()}><span className="composer-menu-icon"><Icon name="folder"/></span><span>{workspaceDir?t('更换工作目录'):t('选择工作目录')}</span></button>
      <div className="composer-menu-divider"/>
      <button type="button" role="menuitem" onClick={()=>{close();onCommand('plan');}}><span className="composer-menu-icon composer-menu-plan"><CompanionGlyph kind="plan"/></span><span>{t('制定计划')}</span><kbd>/plan</kbd></button>
      <button type="button" role="menuitem" onClick={()=>{close();onCommand('goal');}}><span className="composer-menu-icon composer-menu-goal"><CompanionGlyph kind="goal"/></span><span>{t('执行目标')}</span><kbd>/goal</kbd></button>
    </div>}
    {pending&&<span className="workspace-pending" role="status">{t('正在选择目录…')}</span>}
    {error&&<div className="composer-tools-error" role="alert">{error}<button aria-label={t('关闭目录错误')} onClick={()=>setError('')}><Icon name="close" size={14}/></button></div>}
  </div>;
}
