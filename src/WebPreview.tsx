import {WebElementInspector} from './WebElementInspector';
import {usePreviewRuntime} from './preview-runtime';
import type {EditorCommand,PreviewEditorState} from './preview-editor-types';
import type {PreviewItem} from './FilePreviewContext';
import type {EditableText} from './editable-text';
import {createPortal} from 'react-dom';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {PreviewIcon} from './FilePreview';
import {feedbackWebUrl,type WebPreviewSource,type WebPreviewState} from './web-preview';
import {useI18n} from './i18n';
import './web-preview.css';

/** The slot is a native browser surface. Keep app controls outside its rectangle. */
export function WebPreview({source,onSource,fileEditor,editorContent}:{source:WebPreviewSource;onSource?:()=>void;fileEditor?:PreviewItem['editor'];editorContent?:string}){
 const {language}=useI18n(),label=(cn:string,en:string)=>language==='en'?en:cn;
 const runtime=usePreviewRuntime(),runtimeRef=useRef(runtime);runtimeRef.current=runtime;
 const [editorState,setEditorState]=useState<PreviewEditorState>(),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[inspecting,setInspecting]=useState(false),[frozen,setFrozen]=useState<string>();
 const saveLock=useRef(false),restoredMarks=useRef(false),restoringMarks=useRef(false);const [inspectorTab,setInspectorTab]=useState<'style'|'attrs'|'html'|'tree'>('style');
 const stateRef=useRef(editorState),base=useRef<EditableText|undefined>(undefined);stateRef.current=editorState;
 const id=useRef(crypto.randomUUID()),slot=useRef<HTMLDivElement>(null);
 const [state,setState]=useState<WebPreviewState>(),[error,setError]=useState(''),[address,setAddress]=useState('');
 const sourceKey=JSON.stringify(source),isUrl=source.kind==='url'||Boolean(state?.url.match(/^https?:/)),pageEditor=state?.localDocument===false?undefined:fileEditor;
 const [navigationHost,setNavigationHost]=useState<HTMLElement|null>(null);
 useLayoutEffect(()=>{setNavigationHost(slot.current?.closest('.fp-panel')?.querySelector<HTMLElement>('.fp-web-navigation-slot')||null);},[]);
 useEffect(()=>{
  let disposed=false,ready=false,frame=0;const currentId=crypto.randomUUID();id.current=currentId;
  setError('');setState(undefined);setEditorState(undefined);setReady(false);setInspecting(false);setFrozen(undefined);base.current=undefined;restoredMarks.current=false;restoringMarks.current=false;
  const update=(next:WebPreviewState)=>{if(!disposed&&next.id===currentId){if(next.loading)base.current=undefined;setState(next);}};
  const offSave=window.aelion.onPreviewSave?.(value=>{if(value===currentId&&!disposed&&runtimeRef.current?.mode==='edit'&&!runtimeRef.current.web?.busy)void runtimeRef.current.web?.save();});
  const offEditor=window.aelion.onPreviewEditor?.(event=>{if(event.id===currentId&&!disposed){setEditorState(event.state);if(event.state.error)setError(event.state.error);}});
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
  void window.aelion.openWebPreview({id:currentId,source:JSON.parse(sourceKey)}).then(next=>{if(!disposed){ready=true;setReady(true);update(next);layout();}}).catch(reason=>{if(!disposed)setError(String(reason.message||reason));});
  return()=>{disposed=true;offSave?.();offEditor?.();cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();overlays.disconnect();off();escape();window.removeEventListener('resize',layout);document.removeEventListener('visibilitychange',layout);void window.aelion.closeWebPreview(currentId).catch(()=>{});};
 },[sourceKey]);
 useEffect(()=>{setAddress(state?.url||(source.kind==='url'?source.url:source.name));},[state?.url,sourceKey]);
 const action=async(action:'back'|'forward'|'reload'|'navigate',url?:string)=>{setError('');try{setState(await window.aelion.webPreviewAction({id:id.current,action,url}));}catch(reason){setError(String((reason as Error).message));}};

 const command=useCallback(async(value:EditorCommand)=>{const targetId=stateRef.current?.selected?.id;const result=await window.aelion.previewEditorCommand({id:id.current,command:{...value,...(['style','css','attributes','text','html'].includes(value.type)?{targetId}:{})}});setEditorState(result.state);return result;},[]);
 const readBase=async()=>{if(!pageEditor)return undefined;if(!base.current){const value=await pageEditor.read();base.current={...value,...(editorContent!==undefined?{content:editorContent}:{})};}return base.current;};
 const sendChanges=async()=>{if(saveLock.current)return false;saveLock.current=true;setBusy(true);try{await command({type:'lock',locked:true});const result=await command({type:'export'});if(!result.edits?.length)return true;const sent=await runtimeRef.current?.sendEdits(result.edits);if(sent)await command({type:'commit'});return Boolean(sent);}catch(error){setError((error as Error).message);return false;}finally{await command({type:'lock',locked:false}).catch(()=>{});setBusy(false);saveLock.current=false;}};
 const save=async()=>{if(!pageEditor)return sendChanges();if(saveLock.current)return false;saveLock.current=true;setBusy(true);try{await command({type:'lock',locked:true});const original=await readBase();if(!original)throw Error('源文件不可用');const result=await command({type:'export'});if(!result.edits?.length)return true;const content=await window.aelion.patchPreviewHtml({content:original.content,edits:result.edits});if(pageEditor.write){const saved=await pageEditor.write({content,revision:original.revision});base.current=saved;await command({type:'commit'});runtimeRef.current?.saved(saved);}else{const path=await window.aelion.exportEditedText({name:source.kind==='document'?source.name:'page.html',content});if(!path)return false;base.current={...original,content};await command({type:'commit'});}setError('');return true;}catch(error){setError((error as Error).message);return false;}finally{await command({type:'lock',locked:false}).catch(()=>{});setBusy(false);saveLock.current=false;}};
 useEffect(()=>{if(!ready||state?.loading||!runtime)return;let disposed=false;void(async()=>{if(runtime.mode==='edit'){await readBase();if(disposed)return;}else setInspecting(false);await command({type:'mode',mode:runtime.mode,tool:runtime.tool});})().catch(error=>setError(error.message));return()=>{disposed=true;};},[ready,state?.loading,runtime?.mode,runtime?.tool,command]);
 useEffect(()=>{if(!ready||state?.loading||!editorState||!runtime)return;runtime.setWeb({state:editorState,command,save,discard:async()=>{if(saveLock.current)throw Error('正在保存，请稍候');try{await command({type:'cancel'});}catch{await command({type:'reset'});restoredMarks.current=false;restoringMarks.current=false;await window.aelion.webPreviewAction({id:id.current,action:'reload'});}runtimeRef.current?.setMode('browse');},sendChanges,busy,canWrite:Boolean(pageEditor?.write),inspect:()=>{setInspectorTab('tree');setInspecting(true);if(runtimeRef.current?.mode==='edit'&&stateRef.current?.mode!=='edit')void readBase().then(()=>command({type:'mode',mode:'edit'})).catch(e=>setError(e.message));},primaryLabel:pageEditor?(pageEditor.write?label('保存修改','Save changes'):label('另存为','Save copy')):label('发送修改','Send changes'),saveLabel:pageEditor?(pageEditor.write?label('保存并继续','Save and continue'):label('另存为并继续','Save copy and continue')):label('发送修改并继续','Send changes and continue')});return()=>runtime.setWeb(undefined);},[ready,state?.loading,state?.localDocument,editorState,command,fileEditor,busy]);
 useEffect(()=>{let sequence=0;const listener=(event:Event)=>{const detail=(event as CustomEvent).detail,request=++sequence;if(!ready||!window.aelion.freezeWebPreview){detail.done();return;}void window.aelion.freezeWebPreview({id:id.current,frozen:detail.open}).then(async image=>{if(request===sequence)setFrozen(image||undefined);await new Promise(resolve=>requestAnimationFrame(resolve));detail.done();}).catch(()=>detail.done());};window.addEventListener('aelion-preview-menu',listener);return()=>{sequence++;window.removeEventListener('aelion-preview-menu',listener);};},[ready]);

 useEffect(()=>{if(runtime?.mode==='edit'&&editorState?.selected){if(!inspecting)setInspectorTab('style');setInspecting(true);}},[editorState?.selected?.id,runtime?.mode]);
 useEffect(()=>{if(!ready||state?.loading||!editorState||restoredMarks.current||restoringMarks.current)return;let live=true;restoringMarks.current=true;const initial=runtimeRef.current?.initialAnnotations||[];void command({type:'annotations',annotations:initial}).then(result=>{if(!live)return;restoringMarks.current=false;restoredMarks.current=true;runtimeRef.current?.rememberAnnotations(result.state.annotations);setEditorState(result.state);}).catch(error=>{if(live){restoringMarks.current=false;setError(error.message);}});return()=>{live=false;};},[ready,state?.loading,Boolean(editorState)]);
 useEffect(()=>{if(restoredMarks.current&&!restoringMarks.current&&editorState)runtimeRef.current?.rememberAnnotations(editorState.annotations);},[editorState?.annotations]);
 useEffect(()=>{if(error&&(editorState?.dirty||runtime?.mode==='edit'))setInspecting(true);},[error,editorState?.dirty,runtime?.mode]);
 const navigation=(<form className="web-preview-nav" onSubmit={event=>{event.preventDefault();if(isUrl)void action('navigate',address);}}>
   <button type="button" disabled={!state?.canBack} onClick={()=>void action('back')} aria-label={label('后退','Back')}><PreviewIcon name="left"/></button>
   <button type="button" disabled={!state?.canForward} onClick={()=>void action('forward')} aria-label={label('前进','Forward')}><PreviewIcon name="right"/></button>
   <button type="button" disabled={!state} onClick={()=>void action('reload')} aria-label={label('刷新网页','Reload page')}><PreviewIcon name="refresh"/></button>
   {isUrl?<input aria-label={label('网页地址','Web address')} value={address} onChange={event=>setAddress(event.target.value)} spellCheck={false} onFocus={event=>event.target.select()}/>:<span className="web-preview-document">{state?.url||(source.kind==='document'?source.name:'')}</span>}
   {error&&state&&<output className="web-preview-error" role="alert" title={error}>{error}</output>}
   {state?.loading&&<span className="web-preview-loading" role="status" aria-label={label('正在加载','Loading')}/>}
   {onSource&&<button type="button" onClick={()=>runtime?runtime.request(onSource):onSource()} aria-label={label('查看源码','View source')}><PreviewIcon name="code"/></button>}
  </form>);
 return <div className="web-preview" data-preview-local-document={state?.localDocument===false?'false':undefined} data-preview-name={state?.localDocument===false?state.title||state.url:undefined} data-preview-url={/^https?:/.test(state?.url||'')?feedbackWebUrl(state!.url):source.kind==='url'?feedbackWebUrl(source.url):undefined}>
  {navigationHost?createPortal(navigation,navigationHost):navigation}
  <div className="web-preview-surface"><div ref={slot} className="web-preview-slot" tabIndex={0} aria-label={label('网页预览','Web preview')}>
   {frozen&&<img className="web-preview-frozen" src={frozen} alt=""/>}
   {(error||state?.error)?<div className="fp-state" role="alert"><strong>{label('暂时无法打开网页','Unable to open page')}</strong><p>{error||state?.error}</p></div>:!state&&<div className="fp-state" role="status"><span className="fp-loading"/><strong>{label('正在连接','Connecting')}</strong></div>}
  </div>{inspecting&&<WebElementInspector errorMessage={error} onSendChanges={editorState?.dirty?()=>void sendChanges():undefined} initialTab={inspectorTab} selected={editorState?.selected} command={async value=>{setBusy(true);try{return await command(value);}finally{setBusy(false);}}} busy={busy} onClose={()=>setInspecting(false)}/>}</div>
 </div>;
}
