import {createContext,useContext,type ReactNode} from 'react';
import type {AttachmentScope} from './attachment-types';
import type {BotMention} from './peer-types';
import type {PreviewAnnotation} from './preview-editor-types';
export interface PreviewChatInput{text:string;mentions?:BotMention[];replyToMessageId?:string;attachmentIds?:string[];edits?:import('./preview-editor-types').DomEdit[];}
export interface PreviewWorkbenchInfo{scope?:AttachmentScope;itemId:string;name:string;docked:boolean;annotations:PreviewAnnotation[];}
export interface PreviewWorkbench{
 info?:PreviewWorkbenchInfo;attached:boolean;setAttached:(value:boolean)=>void;
 activate:(scope?:AttachmentScope)=>void;navigate:(action:()=>void)=>void;close:()=>void;
 update:(info:PreviewWorkbenchInfo)=>void;registerSender:(sender:(input:PreviewChatInput)=>Promise<unknown>)=>()=>void;
 send:(scope:AttachmentScope,input:PreviewChatInput)=>Promise<boolean>;
}
export const WorkbenchContext=createContext<PreviewWorkbench|undefined>(undefined);
export const usePreviewWorkbench=()=>useContext(WorkbenchContext);
export function PreviewComposerContext({scope}:{scope:AttachmentScope}){
 const preview=usePreviewWorkbench(),info=preview?.info;if(!info?.docked||info.scope?.kind!==scope.kind||info.scope.id!==scope.id)return null;
 return <div className="preview-composer-context"><label><input type="checkbox" checked={preview!.attached} onChange={e=>preview!.setAttached(e.target.checked)}/><span>{info.name}{info.annotations.length?' · '+info.annotations.length+' 处标注':''}</span><small title="发送时附上当前可见画面">附带画面</small></label></div>;
}
