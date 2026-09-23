import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {previewMenuVisibility} from './PreviewPicker';
import {useI18n} from './i18n';
import type {CanvasExportFormat} from './canvas-export';
import './canvas-export.css';
export function CanvasExportMenu({name,rich,disabled,onExport}:{name:string;rich:boolean;disabled:boolean;onExport:(format:CanvasExportFormat|'original')=>void}){
 const {language}=useI18n(),l=(cn:string,en:string)=>language==='en'?en:cn;
 const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),generation=useRef(0);
 const [open,setOpen]=useState(false),[position,setPosition]=useState({left:0,top:0});
 const close=()=>{generation.current++;setOpen(false);void previewMenuVisibility(false);};
 const show=async()=>{if(open){close();return;}const n=++generation.current;await previewMenuVisibility(true);if(n!==generation.current||!trigger.current)return;const r=trigger.current.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(r.right-260,innerWidth-268)),top:Math.max(8,Math.min(r.bottom+6,innerHeight-(rich?392:92)))});setOpen(true);};
 useLayoutEffect(()=>{if(open){menu.current?.showPopover();menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();}},[open]);
 useEffect(()=>()=>{generation.current++;void previewMenuVisibility(false);},[]);
 useEffect(()=>{if(!open)return;const resize=()=>close();window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[open]);
 const options:Array<{format:CanvasExportFormat|'original';name:string;detail:string;extension:string}>=rich?[
  {format:'sketch',name:'Sketch',detail:l('保真图层与可编辑文字，可导入 Figma','Appearance layers and editable text; import into Figma'),extension:'.sketch'},
  {format:'pdf',name:'PDF',detail:l('文档交付与打印','For sharing and printing'),extension:'.pdf'},
  {format:'png',name:'PNG',detail:l('完整页面图片','Full-page image'),extension:'.png'},
  {format:'svg',name:'SVG',detail:l('可导入 Figma，复杂效果可能不同','Import into Figma; complex effects may differ'),extension:'.svg'},
  {format:'html',name:'HTML',detail:l('包含字体和图片的独立网页','Standalone page with fonts and images'),extension:'.html'},
  {format:'zip',name:l('项目 ZIP','Project ZIP'),detail:l('网页、资源与字体授权文件','Page, assets and font licenses'),extension:'.zip'},
 ]:[{format:'original',name:l('原格式','Original format'),detail:name,extension:name.includes('.')?'.'+name.split('.').at(-1):''}];
 return <><button ref={trigger} type="button" className="fp-export-trigger" disabled={disabled} aria-label={l('导出','Export')} aria-haspopup="menu" aria-expanded={open} onClick={()=>void show()} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();void show();}}}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg><span>{l('导出','Export')}</span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>{open&&createPortal(<div ref={menu} popover="auto" role="menu" aria-label={l('导出格式','Export format')} className="fp-export-menu" style={position} onToggle={event=>{if((event.nativeEvent as ToggleEvent).newState==='closed')close();}} onKeyDown={event=>{event.stopPropagation();const controls=[...menu.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]')],at=controls.indexOf(document.activeElement as HTMLButtonElement);if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();controls[event.key==='Home'?0:event.key==='End'?controls.length-1:(at+(event.key==='ArrowDown'?1:controls.length-1))%controls.length]?.focus();}if(event.key==='Escape'){event.preventDefault();close();trigger.current?.focus();}}}>{options.map(option=><button type="button" role="menuitem" key={option.format} onClick={()=>{close();trigger.current?.focus();onExport(option.format);}}><span><strong>{option.name}</strong><small>{option.detail}</small></span><code>{option.extension}</code></button>)}</div>,document.body)}</>;
}
