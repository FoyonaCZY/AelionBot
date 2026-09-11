import {sourceTextFile} from './source-language';
import {useEffect,useState} from 'react';
import {useFilePreview,type PreviewItem} from './FilePreviewContext';
import {FilePreview} from './FilePreview';
import type {Attachment} from './attachment-types';
import type {ArtifactPreview} from './shared';
import {FileInfo,FilePreviewHint,FileTypeBadge} from './FileAppearance';
import {useI18n} from './i18n';
import './attachments.css';

const cache=new Map<string,Promise<ArtifactPreview>>();
const preview=(id:string)=>{let value=cache.get(id);if(!value){value=window.aelion.previewAttachment(id).catch(error=>{cache.delete(id);throw error;});if(cache.size>=8)cache.delete(cache.keys().next().value!);cache.set(id,value);}return value;};
export function AttachmentIcon(){return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M7 13l6-6" strokeLinecap="round" strokeLinejoin="round"/></svg>;}
function AttachmentCard({file,compact,onRemove,onOpen}:{file:Attachment;compact:boolean;onRemove?:()=>void;onOpen:()=>void}){
  const {t}=useI18n();
  const [image,setImage]=useState('');
  useEffect(()=>{let active=true;if(file.image)void preview(file.id).then(value=>{if(active)setImage(value.dataUrl||'');}).catch(()=>{});return()=>{active=false;};},[file.id,file.image?.id]);
  return <article className={`attachment-card file-tile ${compact?'attachment-tag':''} ${image?'has-image':''}`} data-attachment-id={file.id}>
    <button type="button" className="attachment-open file-tile-open" onClick={onOpen} title={t('预览 {name}',{name:file.name})} aria-label={t('预览附件 {name}',{name:file.name})}>
      {image?<img src={image} alt=""/>:<FileTypeBadge name={file.name} mime={file.mime}/>}<FileInfo name={file.name} size={file.size} mime={file.mime} compact={compact}/>{!compact&&<FilePreviewHint/>}
    </button>
    {onRemove&&<button type="button" className="attachment-remove" title={t('移除附件')} aria-label={t('移除附件 {name}',{name:file.name})} onClick={onRemove}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>}
  </article>;
}
export function AttachmentList({files=[],compact=false,onRemove}:{files?:Attachment[];compact?:boolean;onRemove?:(id:string)=>void}){
  const openPreview=useFilePreview(),[selected,setSelected]=useState<{items:PreviewItem[];index:number}>();
  const open=(index:number)=>{
    const items=files.map(file=>({id:'attachment:'+file.id,name:file.name,size:file.size,load:()=>preview(file.id),save:()=>window.aelion.saveAttachment(file.id),...(sourceTextFile(file.name)?{editor:{read:()=>window.aelion.readEditableAttachment(file.id)}}:{})}));
    if(openPreview)openPreview(items,index);else setSelected({items,index});
  };
  if(!files.length)return null;
  return <><div className={`message-attachments ${compact?'composer-attachments':''}`}>{files.map((file,index)=><AttachmentCard key={file.id} file={file} compact={compact} onOpen={()=>open(index)} onRemove={onRemove?()=>onRemove(file.id):undefined}/>)}</div>{selected&&<FilePreview key={selected.items[selected.index].id} items={selected.items} initialIndex={selected.index} onClose={()=>setSelected(undefined)}/>}</>;
}
