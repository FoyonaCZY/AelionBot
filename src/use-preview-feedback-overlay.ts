import {useEffect,useLayoutEffect,useRef,type RefObject} from 'react';
import type {FeedbackOverlayInput,FeedbackOverlayState} from './preview-feedback-overlay';
type State=Pick<FeedbackOverlayState,'id'|'editVersion'|'text'|'pending'|'status'|'failed'|'language'>;
export function usePreviewFeedbackOverlay(wrapper:RefObject<HTMLDivElement|null>,panel:{current:HTMLElement|null},state:State,onInput:(value:FeedbackOverlayInput)=>void){
 const snapshot=useRef(state),handler=useRef(onInput),sync=useRef<()=>void>(()=>{});snapshot.current=state;handler.current=onInput;
 useLayoutEffect(()=>sync.current(),[state.text,state.pending,state.status,state.failed,state.language]);
 useEffect(()=>{
  if(!window.aelion.updatePreviewFeedbackOverlay||!window.aelion.onPreviewFeedbackInput)return;
  const node=wrapper.current,host=panel.current,layer=host?.closest<HTMLElement>('.fp-layer');if(!node||!host||!layer)return;
  let frame=0,closed=false,revision=0;
  const accessible=(native:boolean)=>{node.dataset.nativeFeedback=String(native);node.setAttribute('aria-hidden',String(native));for(const control of node.querySelectorAll<HTMLElement>('textarea,button'))control.tabIndex=native?-1:0;};
  const update=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
   const serial=++revision,rect=node.getBoundingClientRect(),field=node.querySelector('textarea')!,style=getComputedStyle(field),web=host.querySelector('.web-preview-slot');
   const visible=Boolean(web)&&layer.classList.contains('is-expanded')&&layer.dataset.feedbackCapture!=='true'&&!node.closest('[inert]')&&document.visibilityState!=='hidden';
   void window.aelion.updatePreviewFeedbackOverlay(web?{state:{...snapshot.current,fontFamily:style.fontFamily,fontSize:style.fontSize,fontWeight:style.fontWeight},rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},visible}:null).then(native=>{if(!closed&&revision===serial)accessible(native);}).catch(()=>{if(!closed)accessible(false);});
  });};sync.current=update;
  const off=window.aelion.onPreviewFeedbackInput(value=>{if(value.id===state.id)handler.current(value);});
  const resize=new ResizeObserver(update);resize.observe(node);resize.observe(host);
  const mutations=new MutationObserver(update);mutations.observe(layer,{childList:true,subtree:true,attributes:true,attributeFilter:['class','inert','data-feedback-capture']});
  window.addEventListener('resize',update);document.addEventListener('visibilitychange',update);update();
  return()=>{closed=true;cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();off();sync.current=()=>{};window.removeEventListener('resize',update);document.removeEventListener('visibilitychange',update);accessible(false);void window.aelion.updatePreviewFeedbackOverlay(null).catch(()=>{});};
 },[state.id,panel,wrapper]);
}
