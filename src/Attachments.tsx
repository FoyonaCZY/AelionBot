import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {Attachment} from './attachment-types';
import type {ArtifactPreview} from './shared';
import {FileInfo,FilePreviewHint,FileTypeBadge,fileSize} from './FileAppearance';
import './attachments.css';

const cache=new Map<string,Promise<ArtifactPreview>>();
const preview=(id:string)=>{let value=cache.get(id);if(!value){value=window.aelion.previewAttachment(id).catch(error=>{cache.delete(id);throw error;});if(cache.size>=40)cache.delete(cache.keys().next().value!);cache.set(id,value);}return value;};
const errorText=(error:unknown)=>(error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /,'');
export function AttachmentIcon(){return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M7 13l6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>;}
function AttachmentCard({file,compact,onRemove,onOpen}:{file:Attachment;compact:boolean;onRemove?:()=>void;onOpen:()=>void}){
  const [image,setImage]=useState('');
  useEffect(()=>{let active=true;if(file.image)void preview(file.id).then(value=>{if(active)setImage(value.dataUrl||'');}).catch(()=>{});return()=>{active=false;};},[file.id,file.image?.id]);
  return <article className={`attachment-card file-tile ${compact?'attachment-tag':''} ${image?'has-image':''}`} data-attachment-id={file.id}>
    <button type="button" className="attachment-open file-tile-open" onClick={onOpen} title={`预览 ${file.name}`} aria-label={`预览附件 ${file.name}`}>
      {image?<img src={image} alt=""/>:<FileTypeBadge name={file.name} mime={file.mime}/>}<FileInfo name={file.name} size={file.size} mime={file.mime} compact={compact}/>{!compact&&<FilePreviewHint/>}
    </button>
    {onRemove&&<button type="button" className="attachment-remove" title="移除附件" aria-label={`移除附件 ${file.name}`} onClick={onRemove}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>}
  </article>;
}
export function AttachmentList({files=[],compact=false,onRemove}:{files?:Attachment[];compact?:boolean;onRemove?:(id:string)=>void}){
  const [selected,setSelected]=useState<Attachment>();
  if(!files.length)return null;
  return <><div className={`message-attachments ${compact?'composer-attachments':''}`}>{files.map(file=><AttachmentCard key={file.id} file={file} compact={compact} onOpen={()=>setSelected(file)} onRemove={onRemove?()=>onRemove(file.id):undefined}/>)}</div>{selected&&<AttachmentPreview file={selected} onClose={()=>setSelected(undefined)}/>}</>;
}
function AttachmentPreview({file,onClose}:{file:Attachment;onClose:()=>void}){
  const [value,setValue]=useState<ArtifactPreview>(),[error,setError]=useState(''),[saving,setSaving]=useState(false),root=useRef<HTMLElement>(null);
  useEffect(()=>{let active=true;preview(file.id).then(value=>{if(active)setValue(value);}).catch(error=>{if(active)setError(errorText(error));});return()=>{active=false;};},[file.id]);
  useLayoutEffect(()=>{const previous=document.activeElement as HTMLElement|null;root.current?.focus({preventScroll:true});return()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};},[]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();onClose();}};window.addEventListener('keydown',key,true);return()=>{window.removeEventListener('keydown',key,true);};},[onClose]);
  return createPortal(<div className="attachment-preview-layer" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section className="attachment-preview" ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`附件 ${file.name}`} onKeyDown={event=>{if(event.key!=='Tab')return;const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));if(!buttons.length)return;const at=buttons.indexOf(document.activeElement as HTMLButtonElement);if(event.shiftKey&&at<=0){event.preventDefault();buttons.at(-1)?.focus();}else if(!event.shiftKey&&(at<0||at===buttons.length-1)){event.preventDefault();buttons[0].focus();}}}>
    <header><div><strong>{file.name}</strong><small>{fileSize(file.size)}</small></div><button type="button" disabled={saving} onClick={async()=>{setSaving(true);try{await window.aelion.saveAttachment(file.id);}catch(error){setError(errorText(error));}finally{setSaving(false);}}}>{saving?'保存中…':'保存'}</button><button type="button" className="attachment-preview-close" aria-label="关闭附件预览" onClick={onClose}>×</button></header>
    {error&&<p className="attachment-error" role="alert">{error}</p>}
    <div className="attachment-preview-body">{!value&&!error?<span className="attachment-empty">正在读取附件…</span>:value?.kind==='image'?<img src={value.dataUrl} alt={file.name}/>:value?.kind==='pdf'?<iframe title={file.name} src={value.dataUrl} sandbox=""/>:value?.content!==undefined?<pre>{value.content}{value.truncated?'\n…':''}</pre>:value?<div className="attachment-empty"><AttachmentIcon/><p>此文件可保存后打开</p></div>:null}</div>
  </section></div>,document.body);
}
