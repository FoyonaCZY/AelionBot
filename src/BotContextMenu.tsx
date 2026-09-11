import {useEffect,useLayoutEffect,useRef} from 'react';
import {Icon} from './ui';
import {useI18n} from './i18n';

export interface BotMenuAnchor {id:string;x:number;y:number;trigger:HTMLButtonElement;}
export function BotContextMenu({anchor,name,canDelete,onEdit,onDelete,onClose,onPrivateChats}:{anchor:BotMenuAnchor;name:string;canDelete:boolean;onEdit:()=>void;onDelete:()=>void;onClose:()=>void;onPrivateChats?:()=>void}){
  const {t}=useI18n();
  const menu=useRef<HTMLDivElement>(null),close=useRef(onClose);close.current=onClose;
  useLayoutEffect(()=>{
    const element=menu.current;if(!element)return;
    const box=element.getBoundingClientRect();
    element.style.left=`${Math.max(8,Math.min(anchor.x,window.innerWidth-box.width-8))}px`;
    element.style.top=`${Math.max(8,Math.min(anchor.y,window.innerHeight-box.height-8))}px`;
    element.querySelector<HTMLButtonElement>('button')?.focus();
  },[anchor]);
  useEffect(()=>{
    const dismiss=(event:PointerEvent)=>{if(!menu.current?.contains(event.target as Node))close.current();};
    const hide=()=>close.current();
    document.addEventListener('pointerdown',dismiss);window.addEventListener('blur',hide);window.addEventListener('resize',hide);window.addEventListener('scroll',hide,true);
    return()=>{document.removeEventListener('pointerdown',dismiss);window.removeEventListener('blur',hide);window.removeEventListener('resize',hide);window.removeEventListener('scroll',hide,true);};
  },[]);
  return <div ref={menu} role="menu" aria-label={t('{name} 的菜单',{name})} className="bot-context-menu" style={{left:anchor.x,top:anchor.y}} onContextMenu={event=>event.preventDefault()} onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();if(anchor.trigger.isConnected)anchor.trigger.focus();return;}
    if(event.key==='Tab'){onClose();return;}
    const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const current=buttons.indexOf(document.activeElement as HTMLButtonElement);
    if((event.key==='Enter'||event.key===' ')&&current>=0){event.preventDefault();buttons[current].click();return;}
    const next=event.key==='ArrowDown'?(current+1)%buttons.length:event.key==='ArrowUp'?(current-1+buttons.length)%buttons.length:event.key==='Home'?0:event.key==='End'?buttons.length-1:undefined;
    if(next!==undefined){event.preventDefault();buttons[next]?.focus();}
  }}>
    <button role="menuitem" onClick={onEdit}><Icon name="edit" size={16}/>{t('编辑')}</button>
    {onPrivateChats&&<button role="menuitem" onClick={onPrivateChats}><Icon name="message" size={16}/>{t('私聊记录')}</button>}
    <div className="bot-menu-separator" role="separator"/>
    <button role="menuitem" className="destructive" disabled={!canDelete} title={canDelete?undefined:t('请先停止这个 Bot 的任务')} onClick={onDelete}><Icon name="trash" size={16}/>{t('删除')}</button>
  </div>;
}
