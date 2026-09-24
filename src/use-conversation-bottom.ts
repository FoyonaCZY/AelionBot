import {useLayoutEffect,useRef,type UIEvent,type WheelEvent} from 'react';
/** Enter at the newest message; continue following only while the reader stays near the end. */
export function useConversationBottom(conversationKey:string){
 const pane=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),following=useRef(true),metrics=useRef({height:0,width:0,client:0});
 const pin=()=>{const node=pane.current;if(!node||!node.clientHeight||!following.current)return;node.scrollTop=node.scrollHeight;metrics.current={height:node.scrollHeight,width:node.clientWidth,client:node.clientHeight};};
 const followLatest=()=>{following.current=true;pin();};
 useLayoutEffect(()=>{
  following.current=true;metrics.current={height:0,width:0,client:0};const node=pane.current,sheet=content.current;if(!node||!sheet)return;
  const resize=new ResizeObserver(()=>{if(following.current)pin();else metrics.current={height:node.scrollHeight,width:node.clientWidth,client:node.clientHeight};});resize.observe(node);resize.observe(sheet);
  pin();const frame=requestAnimationFrame(pin);
  return()=>{cancelAnimationFrame(frame);resize.disconnect();};
 },[conversationKey]);
 const onScroll=(event:UIEvent<HTMLDivElement>)=>{
  const node=event.currentTarget;if(!node.clientHeight)return;
  const relayout=node.scrollHeight!==metrics.current.height||node.clientWidth!==metrics.current.width||node.clientHeight!==metrics.current.client;
  if(following.current&&relayout){pin();return;}
  following.current=node.scrollHeight-node.clientHeight-node.scrollTop<64;
  metrics.current={height:node.scrollHeight,width:node.clientWidth,client:node.clientHeight};
 };
 const onWheel=(event:WheelEvent<HTMLDivElement>)=>{if(event.deltaY<0)following.current=false;};
 return {pane,content,onScroll,onWheel,followLatest};
}
