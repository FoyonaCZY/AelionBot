import {useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
/** Keep format controls in the shared header without moving their state out of the viewer. */
export function PreviewToolbar({children,editing=false}:{children:ReactNode;editing?:boolean}){
 const anchor=useRef<HTMLSpanElement>(null),[host,setHost]=useState<HTMLElement|null>(null);
 useLayoutEffect(()=>{setHost(anchor.current?.closest('.fp-panel')?.querySelector<HTMLElement>('.fp-file-controls-slot')||null);},[]);
 return <><span hidden ref={anchor}/>{host&&createPortal(<div className={editing?'fp-edit-toolbar':'fp-toolbar'}>{children}</div>,host)}</>;
}
