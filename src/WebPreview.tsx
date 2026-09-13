import {createPortal} from 'react-dom';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {PreviewIcon} from './FilePreview';
import {feedbackWebUrl,type WebPreviewSource,type WebPreviewState} from './web-preview';
import {useI18n} from './i18n';
import './web-preview.css';

/** The slot is a native browser surface. Keep app controls outside its rectangle. */
export function WebPreview({source,onSource}:{source:WebPreviewSource;onSource?:()=>void}){
 const {language}=useI18n(),label=(cn:string,en:string)=>language==='en'?en:cn;
 const id=useRef(crypto.randomUUID()),slot=useRef<HTMLDivElement>(null);
 const [state,setState]=useState<WebPreviewState>(),[error,setError]=useState(''),[address,setAddress]=useState('');
 const sourceKey=JSON.stringify(source),isUrl=source.kind==='url';
 const [navigationHost,setNavigationHost]=useState<HTMLElement|null>(null);
 useLayoutEffect(()=>{setNavigationHost(slot.current?.closest('.fp-panel')?.querySelector<HTMLElement>('.fp-web-navigation-slot')||null);},[]);
 useEffect(()=>{
  let disposed=false,ready=false,frame=0;const currentId=crypto.randomUUID();id.current=currentId;
  setError('');setState(undefined);
  const update=(next:WebPreviewState)=>{if(!disposed&&next.id===currentId)setState(next);};
  const off=window.aelion.onWebPreview(update),escape=window.aelion.onWebPreviewEscape(value=>{if(value===currentId){slot.current?.closest<HTMLElement>('.fp-panel')?.focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));}});
  const layout=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{
   const node=slot.current;if(!node||!ready||disposed)return;const rect=node.getBoundingClientRect(),layer=node.closest<HTMLElement>('.fp-layer');
   const capture=layer?.dataset.feedbackCapture==='true';
   const externalModal=layer?.classList.contains('is-docked')&&Boolean(document.querySelector('.modal-backdrop,.group-editor-layer,.scheduled-layer'));
   const blocked=externalModal||Boolean(layer?.querySelector('.fp-unsaved-backdrop'))||innerWidth<=700&&Boolean(layer?.querySelector('.fp-directory'))||Boolean(node.closest('[inert]'))&&!capture;
   void window.aelion.layoutWebPreview({id:currentId,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},visible:!blocked&&document.visibilityState!=='hidden'}).catch(()=>{});
  });};
  const resize=new ResizeObserver(layout),mutations=new MutationObserver(layout),node=slot.current;
  if(node){resize.observe(node);const layer=node.closest('.fp-layer');if(layer)mutations.observe(layer,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style','inert','data-feedback-capture']});}
  const overlays=new MutationObserver(records=>{if(records.some(record=>[...record.addedNodes,...record.removedNodes].some(node=>node instanceof Element&&(node.matches('.modal-backdrop,.group-editor-layer,.scheduled-layer')||node.querySelector('.modal-backdrop,.group-editor-layer,.scheduled-layer')))))layout();});overlays.observe(document.body,{childList:true,subtree:true});
  window.addEventListener('resize',layout);document.addEventListener('visibilitychange',layout);
  void window.aelion.openWebPreview({id:currentId,source:JSON.parse(sourceKey)}).then(next=>{if(!disposed){ready=true;update(next);layout();}}).catch(reason=>{if(!disposed)setError(String(reason.message||reason));});
  return()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();overlays.disconnect();off();escape();window.removeEventListener('resize',layout);document.removeEventListener('visibilitychange',layout);void window.aelion.closeWebPreview(currentId).catch(()=>{});};
 },[sourceKey]);
 useEffect(()=>{setAddress(state?.url||(source.kind==='url'?source.url:source.name));},[state?.url,sourceKey]);
 const action=async(action:'back'|'forward'|'reload'|'navigate',url?:string)=>{setError('');try{setState(await window.aelion.webPreviewAction({id:id.current,action,url}));}catch(reason){setError(String((reason as Error).message));}};
 const navigation=(<form className="web-preview-nav" onSubmit={event=>{event.preventDefault();if(isUrl)void action('navigate',address);}}>
   <button type="button" disabled={!state?.canBack} onClick={()=>void action('back')} aria-label={label('后退','Back')}><PreviewIcon name="left"/></button>
   <button type="button" disabled={!state?.canForward} onClick={()=>void action('forward')} aria-label={label('前进','Forward')}><PreviewIcon name="right"/></button>
   <button type="button" disabled={!state} onClick={()=>void action('reload')} aria-label={label('刷新网页','Reload page')}><PreviewIcon name="refresh"/></button>
   {isUrl?<input aria-label={label('网页地址','Web address')} value={address} onChange={event=>setAddress(event.target.value)} spellCheck={false} onFocus={event=>event.target.select()}/>:<span className="web-preview-document">{source.name}</span>}
   {error&&state&&<output className="web-preview-error" role="alert" title={error}>{error}</output>}
   {state?.loading&&<span className="web-preview-loading" role="status" aria-label={label('正在加载','Loading')}/>}
   {onSource&&<button type="button" onClick={onSource} aria-label={label('查看源码','View source')}><PreviewIcon name="code"/></button>}
  </form>);
 return <div className="web-preview" data-preview-url={/^https?:/.test(state?.url||'')?feedbackWebUrl(state!.url):isUrl?feedbackWebUrl(source.url):undefined}>
  {navigationHost?createPortal(navigation,navigationHost):navigation}
  <div ref={slot} className="web-preview-slot" tabIndex={0} aria-label={label('网页预览','Web preview')}>
   {(error||state?.error)?<div className="fp-state" role="alert"><strong>{label('暂时无法打开网页','Unable to open page')}</strong><p>{error||state?.error}</p></div>:!state&&<div className="fp-state" role="status"><span className="fp-loading"/><strong>{label('正在连接','Connecting')}</strong></div>}
  </div>
 </div>;
}
