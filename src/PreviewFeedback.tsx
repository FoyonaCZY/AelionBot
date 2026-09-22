import {usePreviewWorkbench,type PreviewChatInput} from './preview-workbench';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {AttachmentScope} from './attachment-types';
import type {PreviewItem} from './FilePreviewContext';
import type {PreviewFeedbackInput} from './preview-feedback';
import type {PreviewAnnotation,PreviewViewport} from './preview-editor-types';
import {useI18n} from './i18n';
import {previewErrorText} from './preview-utils';
import './preview-feedback.css';
const paint=()=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('预览窗口暂不可用，请重试')),5000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));});
export interface FeedbackFocusRequest{sequence:number;note?:boolean;}
export function PreviewFeedback({scope,item,panel,unsaved,onBusy,annotations=[],selectedAnnotationId,onSelectAnnotation,onAnnotationsChange,focusRequest,captureState,registerSend}:{
 scope:AttachmentScope;item:PreviewItem;panel:{current:HTMLElement|null};unsaved:boolean;onBusy:(busy:boolean)=>void;
 annotations?:PreviewAnnotation[];selectedAnnotationId?:string;onSelectAnnotation?:(id:string)=>void;
 onAnnotationsChange?:(value:PreviewAnnotation[])=>Promise<unknown>|void;focusRequest?:FeedbackFocusRequest;
 captureState?:()=>Promise<{annotations:PreviewAnnotation[];view?:PreviewViewport}>;
 registerSend?:(sender:(input:PreviewChatInput)=>Promise<unknown>)=>()=>void;
}){
 const workbench=usePreviewWorkbench(),sendRef=useRef<((input:PreviewChatInput)=>Promise<unknown>)|undefined>(undefined);
 const {language}=useI18n(),label=(cn:string,en:string,tw=cn)=>language==='en'?en:language==='zh-TW'?tw:cn;
 const [drafts,setDrafts]=useState<Record<string,string>>({}),[pending,setPending]=useState(false),[status,setStatus]=useState(''),[failed,setFailed]=useState(false);
 const selected=annotations.find(mark=>mark.id===selectedAnnotationId)||annotations.at(-1);
 const [note,setNote]=useState(''),noteRef=useRef<HTMLInputElement>(null),noteSave=useRef<Promise<unknown>>(Promise.resolve());
 const marksRef=useRef(annotations);marksRef.current=annotations;
 const wrapper=useRef<HTMLDivElement>(null),input=useRef<HTMLTextAreaElement>(null),lock=useRef(false),attempt=useRef<{key:string;id:string}|undefined>(undefined);const text=drafts[item.id]||'';
 const cleanNote=(value?:string)=>value==='标注'||value==='Annotation'?'':value||'';
 useEffect(()=>setNote(cleanNote(selected?.text)),[selected?.id,selected?.text]);
 useLayoutEffect(()=>{const node=input.current;if(node){node.style.height='0px';node.style.height=Math.min(108,Math.max(28,node.scrollHeight))+'px';}},[text,item.id]);
 useEffect(()=>{setStatus('');setFailed(false);attempt.current=undefined;},[item.id]);
 useEffect(()=>{if(!focusRequest?.sequence)return;let live=true,frame=0;void Promise.resolve(window.aelion.focusPreviewFeedback?.()).catch(()=>{}).then(()=>{if(live)frame=requestAnimationFrame(()=>{const target=focusRequest.note?noteRef.current:input.current;target?.focus({preventScroll:true});});});return()=>{live=false;cancelAnimationFrame(frame);};},[focusRequest?.sequence]);
 useEffect(()=>{const node=wrapper.current,layer=panel.current?.closest<HTMLElement>('.fp-layer');if(!node||!layer)return;const update=()=>layer.style.setProperty('--fp-feedback-height',node.getBoundingClientRect().height+'px');update();const observer=new ResizeObserver(update);observer.observe(node);return()=>{observer.disconnect();layer.style.removeProperty('--fp-feedback-height');};},[panel]);
 useEffect(()=>{if(!status||failed)return;const timer=setTimeout(()=>setStatus(''),4000);return()=>clearTimeout(timer);},[status,failed]);
 const commitNote=()=>{
  if(!selected||!onAnnotationsChange||note===cleanNote(selected.text))return noteSave.current;
  const id=selected.id,value=note;
  noteSave.current=noteSave.current.catch(()=>{}).then(()=>onAnnotationsChange(marksRef.current.map(mark=>mark.id===id?{...mark,text:value}:mark)));
  return noteSave.current;
 };
 const changeMarks=async(value:PreviewAnnotation[])=>{try{await noteSave.current;await onAnnotationsChange?.(value);}catch(error){setFailed(true);setStatus(previewErrorText(error));}};
 const send=async(submittedText=text,extras?:PreviewChatInput)=>{
  const message=submittedText.trim()?submittedText:note.trim();if(lock.current||!message)return;const host=panel.current;if(!host)return;
  lock.current=true;setPending(true);setStatus('');setFailed(false);const layer=host.closest<HTMLElement>('.fp-layer');
  try{
   if(!window.aelion.sendPreviewFeedback)throw Error(label('此版本暂不支持截图反馈，请更新应用。','Update the app to use screenshot feedback.'));
   if(!layer||!host.isConnected)throw Error(label('预览已关闭，请重新打开后发送。','The preview is closed. Reopen it to send feedback.'));
   await commitNote();
   layer.dataset.feedbackCapture='true';onBusy(true);await paint();const snapshot=await captureState?.();
   const content=host.querySelector<HTMLElement>('.fp-content'),area=content?.querySelector<HTMLElement>('.web-preview-slot')||content?.querySelector<HTMLElement>('.fp-pdf-viewport')||content;
   if(!area||!area.isConnected)throw Error('预览内容已关闭');const bounds=area.getBoundingClientRect(),x=Math.max(0,bounds.left),y=Math.max(0,bounds.top),width=Math.min(innerWidth,bounds.right)-x,height=Math.min(innerHeight,bounds.bottom)-y;
   if(width<1||height<1)throw Error('预览区域不可见');
   const page=Number(content?.querySelector<HTMLElement>('[data-preview-page]')?.dataset.previewPage)||undefined;
   const url=content?.querySelector<HTMLElement>('[data-preview-url]')?.dataset.previewUrl;
   const unbound=content?.querySelector<HTMLElement>('[data-preview-local-document=false]');
   const file={name:(unbound?.dataset.previewName||item.name).slice(0,300),...(url?{url}:{}),...(!unbound&&item.id.startsWith('attachment:')?{attachmentId:item.id.slice('attachment:'.length)}:{}),...(!unbound&&item.workspace?{path:'/work/'+item.workspace.botId+'/'+item.workspace.path.replace(/^\/+/, '')}:{}),...(page?{page}:{}),...(unsaved?{unsaved:true}:{})};
   const partial={scope,text:message,file,language,annotations:snapshot?.annotations||annotations,...(snapshot?.view?{view:snapshot.view}:{}),...(extras?{attachmentIds:extras.attachmentIds,mentions:extras.mentions,replyToMessageId:extras.replyToMessageId,edits:extras.edits}:{}),rect:{x,y,width,height},viewport:{width:innerWidth,height:innerHeight}};
   const key=JSON.stringify({...partial,scroll:[area.scrollLeft,area.scrollTop]});if(attempt.current?.key!==key)attempt.current={key,id:crypto.randomUUID()};
   const request:PreviewFeedbackInput={requestId:attempt.current.id,designSessionId:item.designSessionId,...partial};
   await window.aelion.sendPreviewFeedback(request);
   setDrafts(value=>({...value,[item.id]:''}));attempt.current=undefined;setStatus(label('已发送','Sent'));
   await Promise.resolve(onAnnotationsChange?.([])).catch(()=>{});setNote('');
  }catch(error){setFailed(true);setStatus(previewErrorText(error));if(extras)throw error;}
  finally{if(layer)delete layer.dataset.feedbackCapture;lock.current=false;setPending(false);onBusy(false);input.current?.focus({preventScroll:true});}
 };
 sendRef.current=input=>send(input.text,input);
 useEffect(()=>{const sender=(input:PreviewChatInput)=>sendRef.current!(input),a=workbench?.registerSender(sender),b=registerSend?.(sender);return()=>{a?.();b?.();};},[workbench?.registerSender,registerSend,scope.kind,scope.id,item.id]);
 const name=(mark:PreviewAnnotation,index:number)=>'#'+(index+1)+' '+(mark.elementLabel||label(({rect:'区域',element:'元素',arrow:'箭头',pen:'画笔',text:'文字'})[mark.type],({rect:'Region',element:'Element',arrow:'Arrow',pen:'Pen',text:'Text'})[mark.type]));
 return <div className="fp-feedback-wrap" ref={wrapper}>
  {status&&<div className={`fp-feedback-status ${failed?'is-error':''}`} role={failed?'alert':'status'}>{status}</div>}
  {annotations.length>0&&<div className="fp-feedback-context">
   <div className="fp-annotation-chips" role="group" aria-label={label('已标注的位置','Annotated areas')}>{annotations.map((mark,index)=><button type="button" key={mark.id} disabled={pending} aria-pressed={selected?.id===mark.id} title={mark.elementText||mark.text||name(mark,index)} onClick={()=>{void commitNote().then(()=>onSelectAnnotation?.(mark.id)).catch(error=>{setFailed(true);setStatus(previewErrorText(error));});}}>{name(mark,index)}</button>)}</div>
   <button type="button" className="fp-annotation-remove" disabled={pending} aria-label={label('删除选中标注','Delete selected annotation')} title={label('删除选中标注','Delete selected annotation')} onClick={()=>void changeMarks(annotations.filter(mark=>mark.id!==selected?.id))}>×</button>
   <button type="button" className="fp-annotation-clear" disabled={pending} onClick={()=>void changeMarks([])}>{label('清空','Clear')}</button>
   <input ref={noteRef} className="fp-annotation-caption" value={note} readOnly={pending} maxLength={1000} aria-label={label('标注说明','Annotation note')} placeholder={selected?.type==='text'?label('标注文字','Annotation text'):label('这一处的说明（可选）','Note for this area (optional)')} onChange={event=>setNote(event.target.value)} onBlur={()=>void commitNote().catch(error=>{setFailed(true);setStatus(previewErrorText(error));})} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();void commitNote().then(()=>input.current?.focus()).catch(error=>{setFailed(true);setStatus(previewErrorText(error));});}}}/>
  </div>}
  <form className="fp-feedback" onSubmit={event=>{event.preventDefault();void send();}} aria-label={label('画布提问','Ask about the canvas')}>
   <textarea ref={input} rows={1} maxLength={12000} value={text} readOnly={pending} aria-label={label('输入问题或修改意见','Question or change request')} placeholder={annotations.length?label('针对标注提问或提出修改…','Ask about the annotations or request a change…'):label('输入问题或修改意见…','Ask a question or request a change…')} onChange={event=>setDrafts(value=>({...value,[item.id]:event.target.value}))} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();void send();}}}/>
   <button type="submit" disabled={pending||!text.trim()&&!note.trim()} aria-label={label('发送问题和截图','Send question and screenshot')} title={label('发送问题和截图','Send question and screenshot')}>{pending?<span className="fp-feedback-spinner"/>:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>}</button>
  </form>
 </div>;
}
