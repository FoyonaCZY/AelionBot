import {createContext,useCallback,useContext,useRef,useState,type ReactNode} from 'react';
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
const Context=createContext<((items:PreviewItem[],index?:number)=>void)|undefined>(undefined);
export const useFilePreview=()=>useContext(Context);
export function FilePreviewProvider({children}:{children:ReactNode}){
  const [session,setSession]=useState<{items:PreviewItem[];index:number}>();
  const guard=useRef<PreviewGuard|undefined>(undefined);
  const registerGuard=useCallback<RegisterPreviewGuard>(value=>{guard.current=value;return()=>{if(guard.current===value)guard.current=undefined;};},[]);
  return <Context.Provider value={(items,index=0)=>{const open=()=>setSession({items,index});if(guard.current)guard.current(open);else open();}}>{children}{session&&<FilePreview key={session.items[session.index].id} items={session.items} initialIndex={session.index} registerGuard={registerGuard} onClose={()=>setSession(undefined)}/>}</Context.Provider>;
}
