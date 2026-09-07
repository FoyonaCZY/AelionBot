import {useEffect} from 'react';

// Derive the native titlebar state from all mounted dialogs. A nested dialog
// closing must not restore the titlebar while its parent is still visible.
export function useWindowDimming(){
  useEffect(()=>{
    let previous='';
    const sync=()=>{
      const dimmed=Boolean(document.querySelector('[aria-modal="true"]'));let color=[247,247,247];
      // Native caption buttons paint outside the DOM. Match the actual backdrop
      // at their location, including different modal opacities and nested layers.
      for(const element of document.elementsFromPoint(Math.max(0,window.innerWidth-80),18).reverse()){
        const style=getComputedStyle(element),rgba=style.backgroundColor.match(/^rgba?\(([^)]+)\)$/)?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);if(!rgba||rgba.length<3)continue;
        const alpha=(rgba[3]??1)*Number(style.opacity);color=color.map((base,index)=>rgba[index]*alpha+base*(1-alpha));
      }
      const hex='#'+color.map(value=>Math.round(Math.max(0,Math.min(255,value))).toString(16).padStart(2,'0')).join(''),key=dimmed+hex;if(previous===key)return;previous=key;void window.aelion.setWindowDimmed?.(dimmed,hex).catch(()=>{});
    };
    const observer=new MutationObserver(sync);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-modal','class','style']});window.addEventListener('resize',sync);document.addEventListener('transitionend',sync,true);document.addEventListener('animationend',sync,true);sync();
    return()=>{observer.disconnect();window.removeEventListener('resize',sync);document.removeEventListener('transitionend',sync,true);document.removeEventListener('animationend',sync,true);void window.aelion.setWindowDimmed?.(false).catch(()=>{});};
  },[]);
}
