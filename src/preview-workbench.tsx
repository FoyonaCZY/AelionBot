import {createContext,useContext} from 'react';
import type {AttachmentScope} from './attachment-types';
import type {BotMention} from './peer-types';
import type {PreviewAnnotation} from './preview-editor-types';
export interface PreviewChatInput{text:string;mentions?:BotMention[];replyToMessageId?:string;attachmentIds?:string[];edits?:import('./preview-editor-types').DomEdit[];}
export interface PreviewWorkbenchInfo{scope?:AttachmentScope;itemId:string;name:string;docked:boolean;annotations:PreviewAnnotation[];}
export interface PreviewWorkbench{
 info?:PreviewWorkbenchInfo;
 activate:(scope?:AttachmentScope)=>void;navigate:(action:()=>void)=>void;close:()=>void;
 update:(info:PreviewWorkbenchInfo)=>void;registerSender:(sender:(input:PreviewChatInput)=>Promise<unknown>)=>()=>void;
 send:(scope:AttachmentScope,input:PreviewChatInput)=>Promise<boolean>;
}
export const WorkbenchContext=createContext<PreviewWorkbench|undefined>(undefined);
export const usePreviewWorkbench=()=>useContext(WorkbenchContext);
