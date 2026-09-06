import {useEffect,useRef,type ReactNode} from 'react';
import {Icon} from './ui';

export type SettingsTab='model'|'skills'|'mcp'|'memory'|'computer'|'permissions'|'about';
const pages:ReadonlyArray<{id:SettingsTab;label:string;icon:string}>=[
  {id:'model',label:'模型',icon:'settings'},
  {id:'skills',label:'技能',icon:'book'},
  {id:'mcp',label:'MCP',icon:'globe'},
  {id:'memory',label:'记忆',icon:'memory'},
  {id:'computer',label:'电脑',icon:'computer'},
  {id:'permissions',label:'权限',icon:'shield'},
  {id:'about',label:'关于',icon:'info'},
];

export function SettingsWindow({tab,onTabChange,onClose,children}:{tab:SettingsTab;onTabChange:(tab:SettingsTab)=>void;onClose:()=>void;children:ReactNode}){
  const content=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(content.current)content.current.scrollTop=0;},[tab]);
  return <>
    <nav className="settings-sidebar" aria-label="设置分类">
      {pages.map(page=><button key={page.id} className={tab===page.id?'active':''} aria-current={tab===page.id?'page':undefined} onClick={()=>onTabChange(page.id)}><Icon name={page.icon} size={21}/><span>{page.label}</span></button>)}
    </nav>
    <div className="settings-pane">
      <header className="settings-heading"><h2>{pages.find(page=>page.id===tab)?.label}</h2></header>
      <button className="settings-close icon-button" aria-label="关闭对话框" onClick={onClose}><Icon name="close" size={21}/></button>
      <div className="settings-body" ref={content}>{children}</div>
    </div>
  </>;
}

export function SettingsSection({title,children}:{title:string;children:ReactNode}){
  return <section className="settings-section"><h3>{title}</h3>{children}</section>;
}
