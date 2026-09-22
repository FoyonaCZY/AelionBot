import {useEffect,useRef,type ReactNode} from 'react';
import {Icon} from './ui';
import {useI18n} from './i18n';

export type SettingsTab='appearance'|'profile'|'runtime'|'model'|'usage'|'memory'|'computer'|'permissions'|'about';
const pages:ReadonlyArray<{id:SettingsTab;label:string;icon:string}>=[
  {id:'profile',label:'个人资料',icon:'user'},
  {id:'appearance',label:'外观',icon:'appearance'},
  {id:'model',label:'模型',icon:'layers'},
  {id:'usage',label:'用量',icon:'chart'},
  {id:'memory',label:'记忆',icon:'memory'},
  {id:'runtime',label:'运行',icon:'sliders'},
  {id:'computer',label:'电脑',icon:'computer'},
  {id:'permissions',label:'权限',icon:'shield'},
  {id:'about',label:'关于',icon:'info'},
];

export function SettingsWindow({tab,onTabChange,onClose,children}:{tab:SettingsTab;onTabChange:(tab:SettingsTab)=>void;onClose:()=>void;children:ReactNode}){
  const content=useRef<HTMLDivElement>(null);
  const {t}=useI18n();
  useEffect(()=>{if(content.current)content.current.scrollTop=0;},[tab]);
  return <>
    <nav className="settings-sidebar" aria-label={t('设置分类')}>
      {pages.map(page=><button key={page.id} title={t(page.label)} className={tab===page.id?'active':''} aria-current={tab===page.id?'page':undefined} onClick={()=>onTabChange(page.id)}><Icon name={page.icon} size={18}/><span>{t(page.label)}</span></button>)}
    </nav>
    <div className={`settings-pane settings-pane-${tab}`}>
      <header className="settings-heading"><h2>{t(pages.find(page=>page.id===tab)?.label||'偏好设置')}</h2></header>
      <button className="settings-close icon-button" aria-label={t('关闭对话框')} onClick={onClose}><Icon name="close" size={21}/></button>
      <div className={`settings-body settings-page-${tab}`} ref={content}>{children}</div>
    </div>
  </>;
}

export function SettingsSection({title,children}:{title:string;children:ReactNode}){
  return <section className="settings-section"><h3>{title}</h3>{children}</section>;
}

export function SettingsEmpty({icon='bot',title,description}:{icon?:string;title:string;description?:string}){
  return <div className="settings-empty settings-empty-state"><span className="settings-empty-symbol" aria-hidden="true"><Icon name={icon} size={24}/></span><strong>{title}</strong>{description&&<p>{description}</p>}</div>;
}
