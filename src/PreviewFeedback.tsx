import {usePreviewWorkbench,type PreviewChatInput} from './preview-workbench';
import {usePreviewFeedbackOverlay} from './use-preview-feedback-overlay';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {AttachmentScope} from './attachment-types';
import type {PreviewItem} from './FilePreviewContext';
import type {PreviewFeedbackInput} from './preview-feedback';
import {useI18n} from './i18n';
import {previewErrorText} from './preview-utils';
import './preview-feedback.css';
const paint=()=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('预览窗口暂不可用，请重试')),5000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));});
export function PreviewFeedback({scope,item,panel,unsaved,onBusy,annotations=[],registerSend}:{scope:AttachmentScope;item:PreviewItem;panel:{current:HTMLElement|null};unsaved:boolean;onBusy:(busy:boolean)=>void;annotations?:import('./preview-editor-types').PreviewAnnotation[];registerSend?:(sender:(input:PreviewChatInput)=>Promise<unknown>)=>()=>void}){
 const workbench=usePreviewWorkbench(),sendRef=useRef<((input:PreviewChatInput)=>Promise<unknown>)|undefined>(undefined);
 const {language}=useI18n(),label=(cn:string,en:string,tw=cn)=>language==='en'?en:language==='zh-TW'?tw:cn;
 const [drafts,setDrafts]=useState<Record<string,string>>({}),[pending,setPending]=useState(false),[status,setStatus]=useState(''),[failed,setFailed]=useState(false);
 const overlayVersion=useRef(0);
 const wrapper=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),lock=useRef(false),attempt=useRef<{key:string;id:string}|undefined>(undefined);const text=drafts[item.id]||'';
 useLayoutEffect(()=>{const node=input.current;if(node){node.style.height='0px';node.style.height=Math.min(108,Math.max(24,node.scrollHeight))+'px';}},[text,item.id]);
 useEffect(()=>{setStatus('');},[item.id]);
 useEffect(()=>{const node=wrapper.current,layer=panel.current?.closest<HTMLElement>('.fp-layer');if(!node||!layer)return;const update=()=>layer.style.setProperty('--fp-feedback-height',node.getBoundingClientRect().height+'px');update();const observer=new ResizeObserver(update);observer.observe(node);return()=>{observer.disconnect();layer.style.removeProperty('--fp-feedback-height');};},[panel]);
 useEffect(()=>{if(!status||failed)return;const timer=setTimeout(()=>setStatus(''),4000);return()=>clearTimeout(timer);},[status,failed]);
 const send=async(submittedText=text,extras?:PreviewChatInput)=>{
  const text=submittedText;
  if(lock.current||!text.trim())return;const host=panel.current;if(!host)return;
  lock.current=true;setPending(true);onBusy(true);setStatus('');setFailed(false);const layer=host.closest<HTMLElement>('.fp-layer');
  try{
   if(!window.aelion.sendPreviewFeedback)throw Error(label('此版本暂不支持截图反馈，请更新应用。','Update the app to use screenshot feedback.','此版本尚不支援截圖回饋，請更新應用程式。'));
   if(!layer||!host.isConnected)throw Error(label('预览已关闭，请重新打开后发送。','The preview is closed. Reopen it to send feedback.','預覽已關閉，請重新開啟後傳送。'));
   layer.dataset.feedbackCapture='true';await paint();
   const content=host.querySelector<HTMLElement>('.fp-content'),area=content?.querySelector<HTMLElement>('.web-preview-slot')||content?.querySelector<HTMLElement>('.fp-pdf-viewport')||content;
   if(!area||!area.isConnected)throw Error('预览内容已关闭');const bounds=area.getBoundingClientRect(),x=Math.max(0,bounds.left),y=Math.max(0,bounds.top),width=Math.min(innerWidth,bounds.right)-x,height=Math.min(innerHeight,bounds.bottom)-y;
   if(width<1||height<1)throw Error('预览区域不可见');
   const page=Number(content?.querySelector<HTMLElement>('[data-preview-page]')?.dataset.previewPage)||undefined;
   const url=content?.querySelector<HTMLElement>('[data-preview-url]')?.dataset.previewUrl;
   const unbound=content?.querySelector<HTMLElement>('[data-preview-local-document=false]');
   const file={name:(unbound?.dataset.previewName||item.name).slice(0,300),...(url?{url}:{}),...(!unbound&&item.id.startsWith('attachment:')?{attachmentId:item.id.slice('attachment:'.length)}:{}),...(!unbound&&item.workspace?{path:'/work/'+item.workspace.botId+'/'+item.workspace.path.replace(/^\/+/, '')}:{}),...(page?{page}:{}),...(unsaved?{unsaved:true}:{})};
   const partial={scope,text,file,language,annotations,...(extras?{attachmentIds:extras.attachmentIds,mentions:extras.mentions,replyToMessageId:extras.replyToMessageId,edits:extras.edits}:{}),rect:{x,y,width,height},viewport:{width:innerWidth,height:innerHeight}};
   const key=JSON.stringify({...partial,scroll:[area.scrollLeft,area.scrollTop]});if(attempt.current?.key!==key)attempt.current={key,id:crypto.randomUUID()};
   const request:PreviewFeedbackInput={requestId:attempt.current.id,designSessionId:item.designSessionId,...partial};
   await window.aelion.sendPreviewFeedback(request);
   setDrafts(value=>({...value,[item.id]:''}));attempt.current=undefined;setStatus(label('已发送，已附上当前画面','Sent with the current view','已傳送，已附上目前畫面'));
  }catch(error){setFailed(true);setStatus(previewErrorText(error));if(extras)throw error;}
  finally{if(layer)delete layer.dataset.feedbackCapture;lock.current=false;setPending(false);onBusy(false);if(wrapper.current?.dataset.nativeFeedback!=='true')input.current?.focus({preventScroll:true});}
 };
 sendRef.current=input=>send(input.text,input);
 useEffect(()=>{const sender=(input:PreviewChatInput)=>sendRef.current!(input),a=workbench?.registerSender(sender),b=registerSend?.(sender);return()=>{a?.();b?.();};},[workbench?.registerSender,registerSend,scope.kind,scope.id,item.id]);
 usePreviewFeedbackOverlay(wrapper,panel,{id:item.id,editVersion:overlayVersion.current,text,pending,status,failed,language},value=>{
  if(value.kind==='escape'){panel.current?.focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return;}
  if(lock.current)return;overlayVersion.current=value.editVersion;setDrafts(drafts=>({...drafts,[item.id]:value.text}));if(value.kind==='send')void send(value.text);
 });
 return <div className="fp-feedback-wrap" ref={wrapper}>
  {status&&<div className={`fp-feedback-status ${failed?'is-error':''}`} role={failed?'alert':'status'}>{status}</div>}
  <form className="fp-feedback" onSubmit={event=>{event.preventDefault();void send();}} aria-label={label('预览修改意见','Preview feedback','預覽修改意見')}>

   <textarea ref={input} rows={1} maxLength={12000} value={text} readOnly={pending} aria-label={label('输入修改意见，发送时附带截图','Feedback, sent with a screenshot','輸入修改意見，傳送時附帶截圖')} placeholder={label('对这一处提修改，会附上截图…','Change this area — sent with a screenshot…','對這一處提修改，會附上截圖…')} onChange={event=>setDrafts(value=>({...value,[item.id]:event.target.value}))} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();void send();}}}/>
   <button type="submit" disabled={pending||!text.trim()} aria-label={label('发送修改意见和截图','Send feedback and screenshot','傳送修改意見與截圖')} title={label('发送并附上当前画面','Send with the current view','傳送並附上目前畫面')}>{pending?<span className="fp-feedback-spinner"/>:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>}</button>
  </form>
 </div>;
}