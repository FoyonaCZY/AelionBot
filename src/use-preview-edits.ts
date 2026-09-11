import {useEffect,useRef,useState} from 'react';
import type {EditableText} from './editable-text';
import type {PreviewItem} from './FilePreviewContext';
import type {ArtifactPreview} from './shared';
import {previewErrorText} from './preview-utils';

export interface PreviewDraft extends EditableText{baseline:string;item:PreviewItem;editing:boolean;loading:boolean;saving:boolean;error:string;}
export const draftChanged=(draft:Pick<PreviewDraft,'content'|'baseline'>)=>draft.content!==draft.baseline;
export function usePreviewEdits(){
  const [drafts,setDrafts]=useState<Record<string,PreviewDraft>>({}),ref=useRef(drafts);
  const [pending,setPending]=useState<{proceed:()=>void;ids:string[]}>(),[guardError,setGuardError]=useState(''),[notice,setNotice]=useState('');
  const update=(id:string,value:PreviewDraft|undefined)=>{const next={...ref.current};if(value)next[id]=value;else delete next[id];ref.current=next;setDrafts(next);};
  const dirty=Object.values(drafts).some(draftChanged),saving=Object.values(drafts).some(d=>d.saving);
  useEffect(()=>{void window.aelion.setPreviewDirty?.(dirty).catch(()=>{});},[dirty]);
  useEffect(()=>()=>{void window.aelion.setPreviewDirty?.(false).catch(()=>{});},[]);
  useEffect(()=>{if(!dirty&&!saving)return;const before=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[dirty,saving]);
  const edit=async(item:PreviewItem)=>{
    if(!item.editor)return;const existing=ref.current[item.id];if(existing){update(item.id,{...existing,editing:!existing.editing});return;}
    const waiting:PreviewDraft={item,content:'',baseline:'',revision:'',bytes:0,lineSeparator:'\n',editing:true,loading:true,saving:false,error:''};update(item.id,waiting);
    try{const source=await item.editor.read();if(ref.current[item.id]===waiting)update(item.id,{...waiting,...source,baseline:source.content,loading:false});}
    catch(reason){if(ref.current[item.id]===waiting)update(item.id,{...waiting,loading:false,error:previewErrorText(reason)});}
  };
  const save=async(id:string,copy=false)=>{
    const draft=ref.current[id];if(!draft||draft.loading||draft.saving||!draft.revision)return false;
    if(!copy&&!draftChanged(draft))return true;
    update(id,{...draft,saving:true,error:''});
    try{
      let written:EditableText|undefined;
      if(!copy&&draft.item.editor?.write)written=await draft.item.editor.write({content:draft.content,revision:draft.revision});
      else{const path=await window.aelion.exportEditedText({name:draft.item.name,content:draft.content});if(!path){update(id,draft);return false;}setNotice(draft.item.editor?.write?'草稿已另存为副本':'已另存为，原附件未修改');}
      const latest=ref.current[id]||draft;
      // A copy of a workspace draft does not mark the original file as saved.
      const baseline=written?.content??(copy&&draft.item.editor?.write?draft.baseline:draft.content);
      update(id,{...latest,...written,baseline,saving:false,error:''});if(written)setNotice('已保存修改');return true;
    }catch(reason){const latest=ref.current[id]||draft;update(id,{...latest,saving:false,error:previewErrorText(reason)});return false;}
  };
  const request=(proceed:()=>void,ids=Object.keys(ref.current))=>{
    if(Object.values(ref.current).some(d=>d.saving)){setNotice('文件正在保存，请稍候');return;}
    const changed=ids.filter(id=>ref.current[id]&&draftChanged(ref.current[id]));
    if(changed.length){setGuardError('');setPending({proceed,ids:changed});}else proceed();
  };
  const saveAndContinue=async()=>{if(!pending)return;for(const id of pending.ids)if(!await save(id)){setGuardError('保存未完成，修改仍保留。可以继续编辑查看原因。');return;}const proceed=pending.proceed;setPending(undefined);proceed();};
  const discardAndContinue=()=>{if(!pending)return;for(const id of pending.ids)update(id,undefined);const proceed=pending.proceed;setPending(undefined);proceed();};
  return {drafts,dirty,saving,pending,guardError,notice,edit,save,request,saveAndContinue,discardAndContinue,cancel:()=>setPending(undefined),drop:(id:string)=>update(id,undefined),change:(id:string,content:string)=>{const d=ref.current[id];if(d&&!d.saving)update(id,{...d,content,error:''});}};
}
export function editedPreview(name:string,draft:PreviewDraft):ArtifactPreview|undefined{
  if(!draft.revision||draft.loading)return;
  const extension=name.split('.').at(-1)?.toLowerCase();
  if(extension==='svg')return {kind:'image',dataUrl:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(draft.content)};
  return {kind:['md','markdown'].includes(extension||'')?'markdown':['html','htm'].includes(extension||'')?'html':'text',content:draft.content};
}
