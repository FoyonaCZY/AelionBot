import {useLayoutEffect,useState,type RefObject} from 'react';

// DOM layout uses fractional CSS pixels. Avoid rounding up into an overflow
// scrollbar, which can feed a different viewport size back into auto-scaling.
export function previewViewportSize(width:number,height:number,inset=0){
  const size=(value:number)=>Math.max(0,Math.floor((value-inset*2)*64)/64);
  return {width:size(width),height:size(height)};
}
export function usePreviewViewport(ref:RefObject<HTMLElement|null>,ready=true,inset=0){
  const [size,setSize]=useState({width:0,height:0});
  useLayoutEffect(()=>{
    const el=ref.current;if(!ready||!el)return;
    const update=(width:number,height:number)=>{
      const next=previewViewportSize(width,height,inset);
      setSize(previous=>previous.width===next.width&&previous.height===next.height?previous:next);
    };
    const rect=el.getBoundingClientRect();update(rect.width,rect.height);
    const observer=new ResizeObserver(([entry])=>update(entry.contentRect.width,entry.contentRect.height));
    observer.observe(el);return()=>observer.disconnect();
  },[ref,ready,inset]);
  return size;
}
