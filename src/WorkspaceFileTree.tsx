import {useEffect,useState} from 'react';
import {Icon} from './ui';
import {previewErrorText} from './preview-utils';
import {useI18n} from './i18n';
import type {WorkspaceDirectory,WorkspaceFileEntry} from './workspace-files';
import './workspace-file-tree.css';

function Branch({botId,path,activePath,onOpen,revision,depth=0}:{botId:string;path:string;activePath?:string;onOpen:(file:WorkspaceFileEntry)=>void;revision:number;depth?:number}){
  const {t}=useI18n();
  const [data,setData]=useState<WorkspaceDirectory>(),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{let active=true;setData(undefined);setError('');Promise.resolve().then(()=>window.aelion.listWorkspaceDirectory({botId,path})).then(value=>{if(active)setData(value);}).catch(reason=>{if(active)setError(previewErrorText(reason));});return()=>{active=false;};},[botId,path,revision,retry]);
  if(error)return <div className="wft-state" role="alert">{error}<button onClick={()=>setRetry(v=>v+1)}>{t('重试')}</button></div>;
  if(!data)return <div className="wft-state" role="status">{t('正在读取…')}</div>;
  return <ul className="wft-list">{data.entries.map(entry=><Entry key={entry.path} entry={entry} botId={botId} activePath={activePath} onOpen={onOpen} revision={revision} depth={depth}/>)}{!data.entries.length&&<li className="wft-state">{t('空文件夹')}</li>}{data.truncated&&<li className="wft-state">{t('此目录仅显示前 500 项')}</li>}</ul>;
}
function Entry({entry,botId,activePath,onOpen,revision,depth}:{entry:WorkspaceFileEntry;botId:string;activePath?:string;onOpen:(file:WorkspaceFileEntry)=>void;revision:number;depth:number}){
  const directory=entry.kind==='directory',contains=Boolean(activePath?.startsWith(entry.path+'/'));
  const [open,setOpen]=useState(contains);
  useEffect(()=>{if(contains)setOpen(true);},[contains]);
  return <li><button type="button" className={`wft-entry ${activePath===entry.path?'is-current':''}`} style={{paddingLeft:10+Math.min(depth,12)*14}} aria-expanded={directory?open:undefined} aria-current={!directory&&activePath===entry.path?'page':undefined} title={entry.path} onClick={()=>directory?setOpen(v=>!v):onOpen(entry)}>
    <span className={`wft-chevron ${open?'is-open':''}`}>{directory&&<Icon name="arrow" size={11}/>}</span><Icon name={directory?'folder':'file'} size={15}/><span>{entry.name}</span>
  </button>{directory&&open&&<Branch botId={botId} path={entry.path} activePath={activePath} onOpen={onOpen} revision={revision} depth={depth+1}/>}</li>;
}
export function WorkspaceFileTree({botId,activePath,onOpen}:{botId:string;activePath?:string;onOpen:(file:WorkspaceFileEntry)=>void}){
  const {t}=useI18n();
  const [revision,setRevision]=useState(0);
  return <div className="workspace-file-tree"><header><span>{t('工作目录')}</span><button type="button" aria-label={t('刷新目录')} title={t('刷新目录')} onClick={()=>setRevision(v=>v+1)}><Icon name="restart" size={15}/></button></header><nav aria-label={t('工作目录文件结构')}><Branch key={botId} botId={botId} path="" activePath={activePath} onOpen={onOpen} revision={revision}/></nav></div>;
}
