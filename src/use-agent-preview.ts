import {useEffect,useRef,useState} from 'react';
import {useFilePreview,type PreviewItem} from './FilePreviewContext';
import {workspacePreviewItem} from './workspace-preview';
import {sourceTextFile} from './source-language';
import {previewForConversation,type AgentPreviewRequest} from './agent-preview';
import type {AttachmentScope} from './attachment-types';
export function useAgentPreview(requests:AgentPreviewRequest[]|undefined,scope:AttachmentScope,blocked:boolean,onError:(error:unknown)=>void){
  const show=useFilePreview(),seen=useRef(new Set<string>()),[focus,setFocus]=useState(0);
  useEffect(()=>{const update=()=>setFocus(value=>value+1);window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);return()=>{window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};},[]);
  useEffect(()=>{
    if(blocked||!show||!document.hasFocus()||document.visibilityState==='hidden')return;
    const request=previewForConversation(requests||[],scope);if(!request||seen.current.has(request.id))return;
    seen.current.add(request.id);if(seen.current.size>200)seen.current.delete(seen.current.values().next().value!);
    let item:PreviewItem;
    if(request.target.kind==='url'){const web={kind:'url' as const,url:request.target.url,location:request.target.location,botId:request.botId};item={id:'web:'+request.id,directoryBotId:request.botId,name:request.name,size:0,load:async()=>({kind:'web',web})};}
    else if(request.target.kind==='workspace')item=workspacePreviewItem(request.botId,{name:request.name,path:request.target.path,size:request.size});
    else{const file=request.target.file;item={id:'attachment:'+file.id,name:file.name,size:file.size,load:()=>window.aelion.previewAttachment(file.id),save:()=>window.aelion.saveAttachment(file.id),...(sourceTextFile(file.name)?{editor:{read:()=>window.aelion.readEditableAttachment(file.id)}}:{})};}
    show([item],0,{expanded:request.placement==='full',scope:request.scope});
    void window.aelion.acknowledgePreview(request.id).catch(onError);
  },[requests,scope.kind,scope.id,blocked,show,focus,onError]);
}
