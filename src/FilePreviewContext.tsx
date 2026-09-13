import {createContext,useCallback,useContext,useRef,useState,useMemo,type ReactNode} from 'react';
import type {AttachmentScope} from './attachment-types';
import type {ArtifactPreview} from './shared';
import {FilePreview} from './FilePreview';

export interface PreviewItem{
  id:string;name:string;size:number;
  workspace?:{botId:string;path:string};
  load:()=>Promise<ArtifactPreview>;
  save:()=>Promise<unknown>;
  openInComputer?:()=>Promise<unknown>;
  editor?:{read:()=>Promise<import('./editable-text').EditableText>;write?:(edit:import('./editable-text').TextEdit)=>Promise<import('./editable-text').EditableText>};
}
export type PreviewGuard=(proceed:()=>void)=>void;
export type RegisterPreviewGuard=(guard:PreviewGuard)=>()=>void;
interface PreviewOptions {expanded?:boolean;scope?:AttachmentScope;}
const Context=createContext<((items:PreviewItem[],index?:number,options?:PreviewOptions)=>void)|undefined>(undefined);
const ScopeContext=createContext<AttachmentScope|undefined>(undefined);
export const usePreviewScope=()=>useContext(ScopeContext);
export function PreviewScopeProvider({scope,children}:{scope?:AttachmentScope;children:ReactNode}){return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;}
export function useFilePreview(){const open=useContext(Context),scope=usePreviewScope();return useMemo(()=>open?((items:PreviewItem[],index=0,options?:PreviewOptions)=>open(items,index,{...options,scope:options?.scope||scope})):undefined,[open,scope]);}
export function FilePreviewProvider({children}:{children:ReactNode}){
  const [session,setSession]=useState<{items:PreviewItem[];index:number;expanded?:boolean;scope?:AttachmentScope;generation:number}>();
  const generation=useRef(0);
  const guard=useRef<PreviewGuard|undefined>(undefined);
  const registerGuard=useCallback<RegisterPreviewGuard>(value=>{guard.current=value;return()=>{if(guard.current===value)guard.current=undefined;};},[]);
  return <Context.Provider value={(items,index=0,options)=>{const open=()=>setSession({items,index,expanded:options?.expanded,scope:options?.scope,generation:++generation.current});if(guard.current)guard.current(open);else open();}}>{children}{session&&<ScopeContext.Provider value={session.scope}><FilePreview key={session.generation} initialExpanded={session.expanded} feedbackScope={session.scope} items={session.items} initialIndex={session.index} registerGuard={registerGuard} onClose={()=>setSession(undefined)}/></ScopeContext.Provider>}</Context.Provider>;
}
