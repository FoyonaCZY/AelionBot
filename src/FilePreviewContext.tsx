import {createContext,useContext,useState,type ReactNode} from 'react';
import type {ArtifactPreview} from './shared';
import {FilePreview} from './FilePreview';

export interface PreviewItem{
  id:string;name:string;size:number;
  workspace?:{botId:string;path:string};
  load:()=>Promise<ArtifactPreview>;
  save:()=>Promise<unknown>;
  openInComputer?:()=>Promise<unknown>;
}
const Context=createContext<((items:PreviewItem[],index?:number)=>void)|undefined>(undefined);
export const useFilePreview=()=>useContext(Context);
export function FilePreviewProvider({children}:{children:ReactNode}){
  const [session,setSession]=useState<{items:PreviewItem[];index:number}>();
  return <Context.Provider value={(items,index=0)=>setSession({items,index})}>{children}{session&&<FilePreview key={session.items[session.index].id} items={session.items} initialIndex={session.index} onClose={()=>setSession(undefined)}/>}</Context.Provider>;
}
