import {useState,type ComponentProps,type MouseEvent} from 'react';
import type {ExtraProps} from 'react-markdown';
import {externalWebUrl} from './external-links';

export function MessageLink({href,children,node,onClick,onAuxClick,...props}:ComponentProps<'a'>&ExtraProps){
  const [failedUrl,setFailedUrl]=useState<string>();
  const url=externalWebUrl(href);
  const open=async(event:MouseEvent<HTMLAnchorElement>)=>{
    if(event.defaultPrevented||!url||!window.aelion?.openExternalUrl)return;
    event.preventDefault();setFailedUrl(undefined);
    try{await window.aelion.openExternalUrl(url);}catch{setFailedUrl(url);}
  };
  // Footnotes and other in-document anchors stay inside the message view.
  if(href?.startsWith('#'))return <a {...props} href={href} onClick={onClick} onAuxClick={onAuxClick}>{children}</a>;
  if(!url)return <>{children}</>;
  return <><a {...props} href={url} title={props.title||url} target="_blank" rel="noopener noreferrer"
    onClick={event=>{onClick?.(event);if(event.button===0)void open(event);}}
    onAuxClick={event=>{onAuxClick?.(event);if(event.button===1)void open(event);}}>{children}</a>
    {failedUrl===url&&<span className="message-link-error" role="alert">无法打开浏览器，请复制链接后打开。</span>}</>;
}
