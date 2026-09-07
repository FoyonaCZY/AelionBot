import {useEffect,useState,type PointerEvent,type RefObject} from 'react';

export function useMotionPreference(){
  const [reduced,setReduced]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{
    const query=window.matchMedia('(prefers-reduced-motion: reduce)');
    const update=()=>setReduced(query.matches);
    query.addEventListener('change',update);
    return()=>query.removeEventListener('change',update);
  },[]);
  return {enabled:!reduced};
}

export function useSiteMotion(rootRef:RefObject<HTMLDivElement|null>,enabled:boolean){
  useEffect(()=>{
    const root=rootRef.current;if(!root)return;
    let scrollFrame=0,pointerFrame=0,clientX=0,clientY=0;
    const scenes=[...root.querySelectorAll<HTMLElement>('[data-scroll-scene]')];
    const updateScroll=()=>{
      scrollFrame=0;
      const distance=document.documentElement.scrollHeight-window.innerHeight;
      root.style.setProperty('--scroll-progress',String(distance>0?Math.min(1,Math.max(0,window.scrollY/distance)):0));
      root.dataset.scrolled=String(window.scrollY>28);
      for(const scene of scenes){
        const box=scene.getBoundingClientRect(),kind=scene.dataset.scrollScene;
        const progress=kind==='hero'?-box.top/box.height:kind==='making'?(72-box.top)/Math.max(1,box.height-window.innerHeight+72):(window.innerHeight-box.top)/(window.innerHeight+box.height*.3);
        scene.style.setProperty('--scene-progress',String(enabled?Math.max(0,Math.min(1,progress)):1));
      }
    };
    const onScroll=()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(updateScroll);};
    const onPointer=(event:globalThis.PointerEvent)=>{
      if(!enabled||event.pointerType!=='mouse')return;
      clientX=event.clientX;clientY=event.clientY;
      if(pointerFrame)return;
      pointerFrame=requestAnimationFrame(()=>{
        pointerFrame=0;
        root.style.setProperty('--eye-x',`${((clientX/window.innerWidth-.5)*3).toFixed(2)}px`);
        root.style.setProperty('--eye-y',`${((clientY/window.innerHeight-.5)*2).toFixed(2)}px`);
      });
    };
    const onFocus=(event:FocusEvent)=>{(event.target as HTMLElement).closest('[data-reveal]')?.classList.add('is-visible');};
    const onVisibility=()=>{root.dataset.pageHidden=String(document.hidden);};
    let revealObserver:IntersectionObserver|undefined,regionObserver:IntersectionObserver|undefined;
    if(enabled&&'IntersectionObserver' in window){
      revealObserver=new IntersectionObserver(entries=>{
        for(const entry of entries){if(entry.isIntersecting){entry.target.classList.add('is-visible');revealObserver?.unobserve(entry.target);}}
      },{threshold:.08,rootMargin:'0px 0px -30px 0px'});
      root.classList.add('motion-ready');
      root.querySelectorAll('[data-reveal]').forEach(element=>revealObserver!.observe(element));
      regionObserver=new IntersectionObserver(entries=>{
        for(const entry of entries)(entry.target as HTMLElement).dataset.inView=String(entry.isIntersecting);
      },{rootMargin:'100px'});
      root.querySelectorAll('[data-motion-region]').forEach(element=>regionObserver!.observe(element));
    }
    updateScroll();onVisibility();
    window.addEventListener('scroll',onScroll,{passive:true});window.addEventListener('resize',onScroll,{passive:true});
    root.addEventListener('pointermove',onPointer,{passive:true});root.addEventListener('focusin',onFocus);
    document.addEventListener('visibilitychange',onVisibility);
    return()=>{
      window.removeEventListener('scroll',onScroll);window.removeEventListener('resize',onScroll);
      root.removeEventListener('pointermove',onPointer);root.removeEventListener('focusin',onFocus);
      document.removeEventListener('visibilitychange',onVisibility);
      cancelAnimationFrame(scrollFrame);cancelAnimationFrame(pointerFrame);
      revealObserver?.disconnect();regionObserver?.disconnect();root.classList.remove('motion-ready');
      root.style.removeProperty('--eye-x');root.style.removeProperty('--eye-y');
    };
  },[rootRef,enabled]);
}

export function trackSurface(event:PointerEvent<HTMLElement>){
  if(event.pointerType!=='mouse'||event.currentTarget.closest('[data-motion="off"]'))return;
  const surface=event.currentTarget,rect=surface.getBoundingClientRect();
  const x=Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width));
  const y=Math.min(1,Math.max(0,(event.clientY-rect.top)/rect.height));
  surface.style.setProperty('--pointer-x',`${(x*100).toFixed(1)}%`);
  surface.style.setProperty('--pointer-y',`${(y*100).toFixed(1)}%`);
  surface.style.setProperty('--tilt-x',`${((.5-y)*3).toFixed(2)}deg`);
  surface.style.setProperty('--tilt-y',`${((x-.5)*4).toFixed(2)}deg`);
}

export function resetSurface(event:PointerEvent<HTMLElement>){
  event.currentTarget.style.setProperty('--tilt-x','0deg');
  event.currentTarget.style.setProperty('--tilt-y','0deg');
}
