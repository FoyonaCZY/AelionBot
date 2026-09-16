import {createContext,useCallback,useContext,useRef,useState,useMemo,type ReactNode} from 'react';
import type {AttachmentScope} from './attachment-types';
import type {ArtifactPreview} from './shared';
import {FilePreview} from './FilePreview';
import {WorkbenchContext,type PreviewWorkbenchInfo,type PreviewChatInput} from './preview-workbench';
export interface PreviewItem{designSessionId?:string;
 id:string;name:string;size:number;workspace?:{botId:string;path:string};directoryBotId?:string;
 load:()=>Promise<ArtifactPreview>;save?:()=>Promise<unknown>;openInComputer?:()=>Promise<unknown>;
 editor?:{read:()=>Promise<import('./editable-text').EditableText>;write?:(edit:import('./editable-text').TextEdit)=>Promise<import('./editable-text').EditableText>};
}
export type PreviewGuard=(proceed:()=>void)=>void;
export type RegisterPreviewGuard=(guard:PreviewGuard)=>()=>void;
interface PreviewOptions{expanded?:boolean;scope?:AttachmentScope|null;}
interface Session{closed?:boolean;annotationCache?:Record<string,import('./preview-editor-types').PreviewAnnotation[]>;items:PreviewItem[];index:number;expanded?:boolean;scope?:AttachmentScope;generation:number;}
const scopeKey=(scope?:AttachmentScope)=>scope?scope.kind+':'+scope.id:'';
const Context=createContext<((items:PreviewItem[],index?:number,options?:PreviewOptions)=>void)|undefined>(undefined);
const ScopeContext=createContext<AttachmentScope|undefined>(undefined);
export const usePreviewScope=()=>useContext(ScopeContext);
export function PreviewScopeProvider({scope,children}:{scope?:AttachmentScope;children:ReactNode}){return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;}
export function useFilePreview(){const open=useContext(Context),scope=usePreviewScope();return useMemo(()=>open?((items:PreviewItem[],index=0,options?:PreviewOptions)=>open(items,index,{...options,scope:options&&'scope' in options?options.scope:scope})):undefined,[open,scope]);}
export function FilePreviewProvider({children}:{children:ReactNode}){
 const [session,setSession]=useState<Session>(),[info,setInfo]=useState<PreviewWorkbenchInfo>(),[attached,setAttached]=useState(true),attachedRef=useRef(attached);attachedRef.current=attached;
 const generation=useRef(0),guard=useRef<PreviewGuard|undefined>(undefined),current=useRef<Session|undefined>(undefined),activeScope=useRef(''),cache=useRef(new Map<string,Session>()),sender=useRef<((input:PreviewChatInput)=>Promise<unknown>)|undefined>(undefined);current.current=session;
 const show=(next?:Session)=>{setInfo(undefined);setSession(next?{...next,generation:++generation.current}:undefined);setAttached(true);};
 const navigate=useCallback((action:()=>void)=>{if(guard.current)guard.current(action);else action();},[]);
 const activate=useCallback((scope?:AttachmentScope)=>{const key=scopeKey(scope);if(key===activeScope.current)return;if(current.current)cache.current.set(scopeKey(current.current.scope),current.current);activeScope.current=key;const saved=key?cache.current.get(key):undefined;show(saved?.closed?undefined:saved);},[]);
 const close=useCallback(()=>{if(current.current)cache.current.set(scopeKey(current.current.scope),{...current.current,closed:true});show();},[]);
 const registerGuard=useCallback<RegisterPreviewGuard>(value=>{guard.current=value;return()=>{if(guard.current===value)guard.current=undefined;};},[]);
 const registerSender=useCallback((value:(input:PreviewChatInput)=>Promise<unknown>)=>{sender.current=value;return()=>{if(sender.current===value)sender.current=undefined;};},[]);
 const infoRef=useRef(info);infoRef.current=info;
 const send=useCallback(async(scope:AttachmentScope,input:PreviewChatInput)=>{const view=infoRef.current;if(!input.text.trim()||!attachedRef.current||!view?.docked||scopeKey(view.scope)!==scopeKey(scope)||!sender.current)return false;await sender.current(input);return true;},[]);
 const update=useCallback((value:PreviewWorkbenchInfo)=>setInfo(previous=>JSON.stringify(previous)===JSON.stringify(value)?previous:value),[]);
 const remember=useCallback((value:{annotationCache?:Record<string,import('./preview-editor-types').PreviewAnnotation[]>;items:PreviewItem[];index:number;expanded:boolean})=>{if(current.current){Object.assign(current.current,value);cache.current.set(scopeKey(current.current.scope),current.current);}},[]);
 return <WorkbenchContext.Provider value={{info,attached,setAttached,activate,navigate,close,update,registerSender,send}}><Context.Provider value={(items,index=0,options)=>navigate(()=>{const next:Session={annotationCache:cache.current.get(scopeKey(options?.scope||undefined))?.annotationCache,closed:false,items,index,expanded:options?.expanded,scope:options?.scope||undefined,generation:++generation.current};cache.current.set(scopeKey(next.scope),next);show(next);})}>{children}{session&&<ScopeContext.Provider value={session.scope}><FilePreview key={session.generation} initialExpanded={session.expanded} feedbackScope={session.scope} initialAnnotations={session.annotationCache} items={session.items} initialIndex={session.index} registerGuard={registerGuard} onClose={close} onSessionChange={remember}/></ScopeContext.Provider>}</Context.Provider></WorkbenchContext.Provider>;
}
