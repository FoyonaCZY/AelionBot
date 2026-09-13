import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {AttachmentScope} from './attachment-types';
import type {PreviewItem} from './FilePreviewContext';
import type {PreviewFeedbackInput} from './preview-feedback';
import {useI18n} from './i18n';
import {previewErrorText} from './preview-utils';
import './preview-feedback.css';
const paint=()=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('预览窗口暂不可用，请重试')),5000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));});
export function PreviewFeedback({scope,item,panel,unsaved,onBusy}:{scope:AttachmentScope;item:PreviewItem;panel:{current:HTMLElement|null};unsaved:boolean;onBusy:(busy:boolean)=>void}){
 const {language}=useI18n(),label=(cn:string,en:string,tw=cn)=>language==='en'?en:language==='zh-TW'?tw:cn;
 const [drafts,setDrafts]=useState<Record<string,string>>({}),[pending,setPending]=useState(false),[status,setStatus]=useState(''),[failed,setFailed]=useState(false);
 const wrapper=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),lock=useRef(false),attempt=useRef<{key:string;id:string}|undefined>(undefined);const text=drafts[item.id]||'';
 useLayoutEffect(()=>{const node=input.current;if(node){node.style.height='0px';node.style.height=Math.min(108,Math.max(24,node.scrollHeight))+'px';}},[text,item.id]);
 useEffect(()=>{setStatus('');},[item.id]);
 useEffect(()=>{const node=wrapper.current,layer=panel.current?.closest<HTMLElement>('.fp-layer');if(!node||!layer)return;const update=()=>layer.style.setProperty('--fp-feedback-height',node.getBoundingClientRect().height+'px');update();const observer=new ResizeObserver(update);observer.observe(node);return()=>{observer.disconnect();layer.style.removeProperty('--fp-feedback-height');};},[panel]);
 useEffect(()=>{if(!status||failed)return;const timer=setTimeout(()=>setStatus(''),4000);return()=>clearTimeout(timer);},[status,failed]);
 const send=async()=>{
  if(lock.current||!text.trim())return;const host=panel.current;if(!host)return;
  lock.current=true;setPending(true);onBusy(true);setStatus('');setFailed(false);const layer=host.closest<HTMLElement>('.fp-layer');
  try{
   if(!window.aelion.sendPreviewFeedback)throw Error(label('此版本暂不支持截图反馈，请更新应用。','Update the app to use screenshot feedback.','此版本尚不支援截圖回饋，請更新應用程式。'));
   if(!layer||!layer.classList.contains('is-expanded'))throw Error(label('请在全屏预览中发送。','Send feedback from the full preview.','請在全螢幕預覽中傳送。'));
   layer.dataset.feedbackCapture='true';await paint();
   const content=host.querySelector<HTMLElement>('.fp-content'),area=content?.querySelector<HTMLElement>('.fp-pdf-viewport')||content;
   if(!area||!area.isConnected)throw Error('预览内容已关闭');const bounds=area.getBoundingClientRect(),x=Math.max(0,bounds.left),y=Math.max(0,bounds.top),width=Math.min(innerWidth,bounds.right)-x,height=Math.min(innerHeight,bounds.bottom)-y;
   if(width<1||height<1)throw Error('预览区域不可见');
   const page=Number(content?.querySelector<HTMLElement>('[data-preview-page]')?.dataset.previewPage)||undefined;
   const file={name:item.name,...(item.id.startsWith('attachment:')?{attachmentId:item.id.slice('attachment:'.length)}:{}),...(item.workspace?{path:'/work/'+item.workspace.botId+'/'+item.workspace.path.replace(/^\/+/, '')}:{}),...(page?{page}:{}),...(unsaved?{unsaved:true}:{})};
   const partial={scope,text,file,language,rect:{x,y,width,height},viewport:{width:innerWidth,height:innerHeight}};
   const key=JSON.stringify({...partial,scroll:[area.scrollLeft,area.scrollTop]});if(attempt.current?.key!==key)attempt.current={key,id:crypto.randomUUID()};
   const request:PreviewFeedbackInput={requestId:attempt.current.id,...partial};
   await window.aelion.sendPreviewFeedback(request);
   setDrafts(value=>({...value,[item.id]:''}));attempt.current=undefined;setStatus(label('已发送，已附上当前画面','Sent with the current view','已傳送，已附上目前畫面'));
  }catch(error){setFailed(true);setStatus(previewErrorText(error));}
  finally{if(layer)delete layer.dataset.feedbackCapture;lock.current=false;setPending(false);onBusy(false);input.current?.focus({preventScroll:true});}
 };
 return <div className="fp-feedback-wrap" ref={wrapper}>
  {status&&<div className={`fp-feedback-status ${failed?'is-error':''}`} role={failed?'alert':'status'}>{status}</div>}
  <form className="fp-feedback" onSubmit={event=>{event.preventDefault();void send();}} aria-label={label('预览修改意见','Preview feedback','預覽修改意見')}>
   <span className="fp-feedback-capture" title={label('发送时自动附上当前可见画面','The visible preview is attached when you send','傳送時自動附上目前可見畫面')}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/><rect x="7" y="7" width="10" height="10" rx="2"/></svg></span>
   <textarea ref={input} rows={1} maxLength={12000} value={text} readOnly={pending} aria-label={label('输入修改意见，发送时附带截图','Feedback, sent with a screenshot','輸入修改意見，傳送時附帶截圖')} placeholder={label('哪里需要修改？','What would you like to change?','哪裡需要修改？')} onChange={event=>setDrafts(value=>({...value,[item.id]:event.target.value}))} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();void send();}}}/>
   <button type="submit" disabled={pending||!text.trim()} aria-label={label('发送修改意见和截图','Send feedback and screenshot','傳送修改意見與截圖')} title={label('发送并附上当前画面','Send with the current view','傳送並附上目前畫面')}>{pending?<span className="fp-feedback-spinner"/>:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>}</button>
  </form>
 </div>;
}