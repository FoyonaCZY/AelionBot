import {previewHistoryShortcut,previewTextInput} from './preview-shortcuts';
import {FileAnnotationLayer} from './FileAnnotationLayer';
import {PreviewRuntimeContext,type WebPreviewControls} from './preview-runtime';
import type {AnnotationTool,PreviewAnnotation,PreviewMode} from './preview-editor-types';
import {PreviewPicker} from './PreviewPicker';
import type {PreviewChatInput} from './preview-workbench';
import {usePreviewWorkbench} from './preview-workbench';
import {CsvPreview} from './CsvPreview';
import {PreviewToolbar} from './PreviewToolbar';
import {WebPreview} from './WebPreview';
import {PreviewFeedback,type FeedbackFocusRequest} from './PreviewFeedback';
import type {AttachmentScope} from './attachment-types';
import {draftChanged,editedPreview,usePreviewEdits} from './use-preview-edits';
import {CodePreview} from './CodePreview';
import {WorkspaceFileTree} from './WorkspaceFileTree';
import {workspacePreviewItem} from './workspace-preview';
import {sourceLanguage} from './source-language';
import {lazy,Suspense,useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {ArtifactPreview} from './shared';
import type {PreviewItem,RegisterPreviewGuard} from './FilePreviewContext';
import {FileTypeBadge,fileSize} from './FileAppearance';
import Markdown from './MessageMarkdown';
import {Select} from './Select';
import {PreviewLayoutContext,useImmersivePreview} from './preview-layout';
import {usePreviewViewport} from './use-preview-viewport';
import {previewErrorText,previewFormat,previewHtml,previewKind} from './preview-utils';
import {useI18n} from './i18n';
import './file-preview.css';
import './file-preview-compact.css';
import './preview-workbench.css';
import './preview-editing-tools.css';

const PdfPreview=lazy(()=>import('./PdfPreview'));
const SourceEditor=lazy(()=>import('./SourceEditor'));
export function PreviewIcon({name}:{name:string}){
  const paths:Record<string,React.ReactNode>={
    rect:<rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3"/>,arrow:<path d="M5 19 19 5M8 5h11v11"/>,text:<path d="M4 5h16M12 5v15M8 20h8"/>,comment:<path d="M4 4h16v13H9l-5 4V4m4 5h8m-8 4h5"/>,
    edit:<><path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14z"/></>,
    desktop:<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,tablet:<><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 17h.01"/></>,phone:<><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/></>,code:<><path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/></>,eye:<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></>,external:<><path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/></>,fit:<><rect x="6" y="7" width="12" height="10" rx="1"/><path d="M7 3H3v4m14-4h4v4M3 17v4h4m10 0h4v-4"/></>,
    close:<path d="m6 6 12 12M18 6 6 18"/>,expand:<path d="M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6"/>,dock:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></>,
    plus:<path d="M5 12h14M12 5v14"/>,minus:<path d="M5 12h14"/>,left:<path d="m14 6-6 6 6 6"/>,right:<path d="m10 6 6 6-6 6"/>,save:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    image:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/></>,pages:<><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="12" y="4" width="9" height="16" rx="1"/></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]||paths.image}</svg>;
}
function ImagePreview({src,name}:{src:string;name:string}){
  const {t}=useI18n();
  const immersive=useImmersivePreview(),[sizing,setSizing]=useState<'width'|'fit'>('fit');
  const padding=immersive?0:24;
  const [zoom,setZoom]=useState<number|null>(null),[size,setSize]=useState({width:0,height:0}),[error,setError]=useState(false);
  const viewport=useRef<HTMLDivElement>(null),drag=useRef<{x:number;y:number;left:number;top:number}|undefined>(undefined);
  const room=usePreviewViewport(viewport,true,padding);
  const fit=size.width?(sizing==='width'?room.width/size.width:Math.min(1,room.width/size.width,room.height/size.height)):1,scale=zoom??fit;
  const change=(delta:number)=>setZoom(Math.max(.1,Math.min(4,Math.round((scale+delta)*100)/100)));
  return <><PreviewToolbar><div className="fp-tools"><button onClick={()=>change(-.25)} disabled={scale<=.1} title={t('缩小')} aria-label={t('缩小图片')}><PreviewIcon name="minus"/></button><Select className="fp-zoom-picker" aria-label={t('图片缩放比例')} value={zoom===null?sizing:String(Math.round(scale*100))} onChange={event=>{const value=event.target.value;if(value==='fit'||value==='width'){setSizing(value);setZoom(null);}else setZoom(Number(value)/100);}}><option value="fit">{t('适应窗口')}</option><option value="width">{t('适应宽度')}</option>{zoom!==null&&![25,50,75,100,125,150,200,300,400].includes(Math.round(scale*100))&&<option value={Math.round(scale*100)}>{Math.round(scale*100)}%</option>}{[25,50,75,100,125,150,200,300,400].map(value=><option key={value} value={value}>{value}%</option>)}</Select><button onClick={()=>change(.25)} disabled={scale>=4} title={t('放大')} aria-label={t('放大图片')}><PreviewIcon name="plus"/></button><button aria-pressed={zoom===1} onClick={()=>setZoom(1)} title={t('原始尺寸')} aria-label={t('原始尺寸')}>1:1</button></div></PreviewToolbar>
    <div className="fp-image-stage" ref={viewport} tabIndex={0} aria-label={t('图片画布，可滚动或拖动查看')} onDoubleClick={()=>setZoom(zoom===null?1:null)} onPointerDown={event=>{if(event.button!==0||!viewport.current)return;drag.current={x:event.clientX,y:event.clientY,left:viewport.current.scrollLeft,top:viewport.current.scrollTop};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const start=drag.current,el=viewport.current;if(start&&el){el.scrollLeft=start.left-(event.clientX-start.x);el.scrollTop=start.top-(event.clientY-start.y);}}} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}>
      {error?<div className="fp-state">{t('这张图片暂时无法显示，可以保存原文件后查看。')}</div>:<div className="fp-image-space" style={{minWidth:size.width*scale+padding*2,minHeight:size.height*scale+padding*2}}><img src={src} alt={name} draggable={false} onError={()=>setError(true)} onLoad={event=>setSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} style={size.width?{width:size.width*scale,height:size.height*scale}:undefined}/></div>}
    </div></>;
}
function DocumentPreview({value,name,onRendered}:{value:ArtifactPreview;name:string;onRendered?:()=>void}){
  const {t}=useI18n();
  const [source,setSource]=useState(Boolean(onRendered)),[device,setDevice]=useState('fit');
  const html=value.kind==='html',markdown=value.kind==='markdown',csv=previewFormat(name)==='csv';
  return <><PreviewToolbar><div className="fp-segments" aria-label={t('查看方式')}>{(html||markdown)?<><button aria-pressed={!source} onClick={()=>onRendered?onRendered():setSource(false)} title={t('预览')} aria-label={t('预览')}><PreviewIcon name="eye"/></button><button aria-pressed={source} onClick={()=>setSource(true)} title={t('源码')} aria-label={t('源码')}><PreviewIcon name="code"/></button></>:<span>{csv?t('表格'):sourceLanguage(name)?t('源码'):t('文本')}</span>}</div>{html&&!source&&<div className="fp-segments" aria-label={t('网页显示尺寸')}>{[['fit','自适应'],['1440','桌面'],['768','平板'],['390','手机']].map(([id,label])=><button key={id} aria-pressed={device===id} onClick={()=>setDevice(id)} title={t(label)} aria-label={t(label)}><PreviewIcon name={id==='fit'?'fit':id==='1440'?'desktop':id==='768'?'tablet':'phone'}/></button>)}</div>}</PreviewToolbar>
    {html&&!source?<div className="fp-web-stage"><iframe className="fp-web-frame" title={name} sandbox="" srcDoc={previewHtml(value.content||'')} style={{width:device==='fit'?'100%':Number(device)}}/></div>:<div className={`fp-document-stage ${csv?'fp-csv-stage':(!markdown||source)?'fp-source-stage':''}`} tabIndex={0} aria-label={t('文档内容')}>{markdown&&!source?<article className="fp-paper markdown"><Markdown>{value.content||''}</Markdown></article>:csv?<CsvPreview content={value.content||''}/>:<CodePreview content={value.content||''} name={name}/>}</div>}
    </>;
}
function PreviewContent({item,retry,override}:{item:PreviewItem;retry:number;override?:ArtifactPreview}){
  const {t}=useI18n();
  const [loaded,setValue]=useState<ArtifactPreview>(),[error,setError]=useState(''),[showSource,setShowSource]=useState(false);
  const value=override||loaded;
  const kind=previewKind(item.name);
  useEffect(()=>{let active=true;setValue(undefined);setError('');item.load().then(value=>{if(active)setValue(value);}).catch(error=>{if(active)setError(previewErrorText(error));});return()=>{active=false;};},[item,retry]);
  if(error&&!override)return <div className="fp-state" role="alert"><PreviewIcon name="image"/><strong>{t('暂时无法预览')}</strong><p>{error}</p></div>;
  if(!value)return <div className="fp-state" role="status"><span className="fp-loading"/><strong>{kind==='演示文稿'?t('正在准备演示文稿'):t('正在打开预览')}</strong></div>;
  const native=Boolean(window.aelion.openWebPreview);
  if(value.kind==='web')return native&&value.web?<WebPreview source={value.web}/>:<div className="fp-state" role="alert">{t('请在桌面应用中打开网页预览')}</div>;
  if(native&&value.kind==='html'){
    if(showSource)return <DocumentPreview value={value} name={item.name} onRendered={()=>setShowSource(false)}/>;
    const attachmentId=item.id.startsWith('attachment:')?item.id.slice(11):undefined;
    return <WebPreview fileEditor={item.editor} editorContent={override?.content} source={{kind:'document',format:'html',name:item.name,workspace:item.workspace,attachmentId,...(override||!item.workspace&&!attachmentId?{content:value.content}:{} )}} onSource={item.editor?undefined:()=>setShowSource(true)}/>;
  }
  if(value.kind==='image')return <ImagePreview src={value.dataUrl!} name={item.name}/>;
  if(value.kind==='pdf')return <Suspense fallback={<div className="fp-state" role="status">{t('正在打开文档…')}</div>}><PdfPreview src={value.dataUrl!} name={item.name} slides={kind==='演示文稿'}/></Suspense>;
  if(value.kind==='unsupported')return <div className="fp-state"><FileTypeBadge name={item.name}/><strong>{t('保存后，继续查看')}</strong><p>{t('此格式暂不支持直接预览，可保存到本机打开。')}</p></div>;
  return <><DocumentPreview value={value} name={item.name}/>{value.truncated&&<div className="fp-truncated" role="status">{t('预览内容已截断，可保存原文件查看全部内容。')}</div>}</>;
}
export function FilePreview({items:initialItems,initialIndex=0,initialExpanded=false,feedbackScope,onClose,registerGuard,onSessionChange,initialAnnotations}:{initialAnnotations?:Record<string,PreviewAnnotation[]>;items:PreviewItem[];feedbackScope?:AttachmentScope;initialIndex?:number;initialExpanded?:boolean;onClose:()=>void;registerGuard?:RegisterPreviewGuard;onSessionChange?:(value:{annotationCache?:Record<string,PreviewAnnotation[]>;items:PreviewItem[];index:number;expanded:boolean})=>void}){
  const {t,language}=useI18n(),l=(cn:string,en:string)=>language==='en'?en:t(cn),workbench=usePreviewWorkbench();
  const [items,setItems]=useState(()=>initialItems.map(item=>item.editor||!item.workspace?item:{...item,editor:workspacePreviewItem(item.workspace.botId,{name:item.name,path:item.workspace.path,size:item.size}).editor})),[directoryOpen,setDirectoryOpen]=useState(false);
  const [index,setIndex]=useState(initialIndex),[expanded,setExpanded]=useState(initialExpanded),[wide,setWide]=useState(()=>matchMedia('(min-width:1000px)').matches),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0);
  const [studioHost,setStudioHost]=useState<HTMLElement|null>(null);
  const [chatWidth,setChatWidth]=useState(()=>{try{return Math.max(260,Math.min(420,Number(localStorage.getItem('aelion-preview-chat-width'))||340));}catch{return 340;}});
  const [mode,setMode]=useState<PreviewMode>('browse'),[tool,setTool]=useState<AnnotationTool>('rect'),[web,setWeb]=useState<WebPreviewControls>(),[fileAnnotations,setFileAnnotations]=useState<PreviewAnnotation[]>([]),[domPending,setDomPending]=useState<(()=>void)|undefined>(undefined),[domGuardError,setDomGuardError]=useState(''),[domSaving,setDomSaving]=useState(false);
  const annotationCache=useRef(initialAnnotations||{}),sourceRevision=useRef(0),previousSource=useRef<string|undefined>(undefined);
  const webRef=useRef(web);webRef.current=web;const fileAnnotationSetter=useRef<(value:PreviewAnnotation[])=>void>(()=>{}),feedbackSubmit=useRef<((input:PreviewChatInput)=>Promise<unknown>)|undefined>(undefined);
  const registerFileAnnotations=useCallback((fn:(value:PreviewAnnotation[])=>void)=>{fileAnnotationSetter.current=fn;return()=>{fileAnnotationSetter.current=()=>{};};},[]);
  const registerFeedbackSend=useCallback((fn:(input:PreviewChatInput)=>Promise<unknown>)=>{feedbackSubmit.current=fn;return()=>{if(feedbackSubmit.current===fn)feedbackSubmit.current=undefined;};},[]);
  const edits=usePreviewEdits(Boolean(web?.state.dirty));
  const request=(proceed:()=>void,ids?:string[])=>{if(webRef.current?.busy||domSaving){setNotice(t('正在保存，请稍候'));return;}if(webRef.current?.state.dirty){setDomGuardError('');setDomPending(()=>()=>edits.request(proceed,ids));}else edits.request(proceed,ids);};
  const annotations=web?(mode==='edit'?[]:web.state.annotations):fileAnnotations;
  const [selectedAnnotationId,setSelectedAnnotationId]=useState<string>(),[feedbackFocus,setFeedbackFocus]=useState<FeedbackFocusRequest>({sequence:0});
  const seenAnnotations=useRef(new Set<string>());
  const setAnnotations=async(value:PreviewAnnotation[])=>{if(webRef.current)await webRef.current.command({type:'annotations',annotations:value});else fileAnnotationSetter.current(value);};
  const selectAnnotation=(id:string)=>{setSelectedAnnotationId(id);if(webRef.current)void webRef.current.command({type:'annotation-select',id}).catch(error=>setNotice(error.message));};
  useEffect(()=>{const selected=web?.state.selectedAnnotationId;if(selected)setSelectedAnnotationId(selected);},[web?.state.selectedAnnotationId]);
  useEffect(()=>{
    const added=annotations.filter(mark=>!seenAnnotations.current.has(mark.id));seenAnnotations.current=new Set(annotations.map(mark=>mark.id));
    if(added.length&&mode==='annotate'){
      const mark=added.at(-1)!;setSelectedAnnotationId(mark.id);
      if(tool==='rect'||tool==='element'||tool==='text'){setMode('browse');setFeedbackFocus(value=>({sequence:value.sequence+1,note:tool==='text'}));}
    }else if(selectedAnnotationId&&!annotations.some(mark=>mark.id===selectedAnnotationId))setSelectedAnnotationId(annotations.at(-1)?.id);
  },[annotations,mode,tool]);
  const captureAnnotations=async()=>{const view=webRef.current;if(!view)return {annotations:fileAnnotations};const result=await view.command({type:'feedback-state'});return {annotations:result.state.annotations,view:result.state.viewport};};
  useEffect(()=>{setMode('browse');setFileAnnotations([]);setSelectedAnnotationId(undefined);seenAnnotations.current=new Set();},[index]);
  const [feedbackSending,setFeedbackSending]=useState(false),feedbackLock=useRef(false),afterFeedback=useRef<(()=>void)|undefined>(undefined);
  const panel=useRef<HTMLElement>(null),previous=useRef<HTMLElement|null>(null),detachedStudio=useRef<HTMLElement|null>(null),item=items[index],wantsStudio=Boolean(item.designSessionId)&&!expanded,modal=expanded||(!wide&&!wantsStudio);
  if(!detachedStudio.current){detachedStudio.current=document.createElement('div');detachedStudio.current.setAttribute('data-designer-studio-hold','true');}
  useLayoutEffect(()=>{if(!item.designSessionId){setStudioHost(null);return;}const selector=`[data-designer-canvas="${CSS.escape(item.designSessionId)}"]`;const read=()=>{const node=document.querySelector(selector);setStudioHost(node instanceof HTMLElement?node:null);};read();const observer=new MutationObserver(read);observer.observe(document.body,{subtree:true,childList:true});return()=>observer.disconnect();},[item.designSessionId]);
  const studio=wantsStudio&&Boolean(studioHost);
  const portalTarget=item.designSessionId?(studioHost||detachedStudio.current):document.body;
  useEffect(()=>{if(wantsStudio)return;document.body.style.setProperty('--preview-chat-width',chatWidth+'px');try{localStorage.setItem('aelion-preview-chat-width',String(chatWidth));}catch{}},[chatWidth,wantsStudio]);
  useEffect(()=>{onSessionChange?.({items,index,expanded:modal});workbench?.update({scope:feedbackScope,itemId:item.id,name:item.name,docked:!modal&&!studio,studio,annotations});},[items,index,modal,studio,feedbackScope?.kind,feedbackScope?.id,onSessionChange,workbench?.update,annotations]);
  const draft=edits.drafts[item.id],dirty=Boolean(draft&&draftChanged(draft));
  if(previousSource.current!==draft?.content){previousSource.current=draft?.content;sourceRevision.current++;}
  const sessionState=useRef({items,index,expanded:modal});sessionState.current={items,index,expanded:modal};
  const rememberAnnotations=useCallback((value:Record<string,PreviewAnnotation[]>)=>{annotationCache.current={...annotationCache.current,...value};onSessionChange?.({...sessionState.current,annotationCache:annotationCache.current});},[onSessionChange]);
  const previewKindLabel=t(previewKind(item.name)),directoryBotId=item.workspace?.botId||item.directoryBotId;
  useEffect(()=>registerGuard?.(proceed=>{if(feedbackLock.current)afterFeedback.current=proceed;else request(proceed);}),[registerGuard,edits.request]);
  useEffect(()=>{const media=matchMedia('(min-width:1000px)'),update=()=>setWide(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  useLayoutEffect(()=>{previous.current=document.activeElement as HTMLElement|null;panel.current?.focus({preventScroll:true});return()=>{queueMicrotask(()=>{if(!document.querySelector('.fp-panel')&&previous.current?.isConnected)previous.current.focus({preventScroll:true});});};},[]);
  useLayoutEffect(()=>{if(modal&&!panel.current?.contains(document.activeElement))panel.current?.focus({preventScroll:true});},[modal]);
  useLayoutEffect(()=>{
    if(!modal&&!edits.pending&&!domPending)return;const root=document.getElementById('root'),current=panel.current;if(!root||!current)return;
    const changed=new Map<HTMLElement,boolean>(),disable=(node:HTMLElement)=>{if(changed.has(node))return;changed.set(node,node.inert);node.inert=true;};
    if(root.contains(current)){let branch:HTMLElement|null=current;while(branch&&branch!==root){const parent:HTMLElement|null=branch.parentElement;if(!parent)break;for(const sibling of parent.children)if(sibling!==branch&&sibling instanceof HTMLElement)disable(sibling);branch=parent;}}
    else disable(root);
    return()=>{for(const [node,inert] of changed)node.inert=inert;};
  },[modal,Boolean(edits.pending),Boolean(domPending),studioHost]);
  useEffect(()=>{let live=true;const key=(event:KeyboardEvent)=>{
    if(!(modal||panel.current?.contains(document.activeElement)))return;
    const historyAction=previewHistoryShortcut(event),editor=webRef.current;
    if(historyAction&&editor?.state.mode==='edit'&&!previewTextInput(event)){event.preventDefault();event.stopImmediatePropagation();if(!feedbackLock.current&&!editor.busy&&!domSaving&&!domPending&&!edits.pending)void editor.command({type:historyAction}).catch(error=>setNotice(error.message));return;}
    if(feedbackLock.current&&(event.key==='Escape'||(event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s')){event.preventDefault();event.stopImmediatePropagation();return;}
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.isComposing&&event.key.toLowerCase()==='s'&&editor?.state.mode==='edit'){
      event.preventDefault();event.stopImmediatePropagation();if(event.repeat||domPending||edits.pending||domSaving||feedbackLock.current)return;
      if(previewTextInput(event))(document.activeElement as HTMLElement)?.blur();
      void(async()=>{await new Promise(resolve=>requestAnimationFrame(resolve));for(let i=0;i<160&&live&&webRef.current?.busy;i++)await new Promise(resolve=>setTimeout(resolve,50));const latest=webRef.current;if(!live||latest===undefined||latest.state.mode!=='edit'||latest.busy||feedbackLock.current)return;await latest.save();})();return;
    }
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.isComposing&&event.key.toLowerCase()==='s'&&draft){event.preventDefault();event.stopImmediatePropagation();if(!edits.pending)void edits.save(item.id);return;}
    if(event.key==='Escape'){if(domPending){event.preventDefault();if(!domSaving&&!webRef.current?.busy)setDomPending(undefined);return;}if(document.querySelector('.fp-file-select:open'))return;event.preventDefault();event.stopImmediatePropagation();if(edits.pending){if(!edits.saving)edits.cancel();}else if(mode==='annotate')setMode('browse');else if(expanded&&(wide||item.designSessionId))setExpanded(false);else request(onClose);}
  };window.addEventListener('keydown',key,true);return()=>{live=false;window.removeEventListener('keydown',key,true);};},[modal,expanded,wide,mode,onClose,edits.pending,edits.saving,draft,domPending,domSaving,item.id]);
  const act=async(task:()=>Promise<unknown>,success='')=>{setBusy(true);setNotice('');try{const result=await task();if(result!==null)setNotice(success);}catch(error){setNotice(previewErrorText(error));}finally{setBusy(false);}};
  const select=(next:number)=>{setIndex(next);setNotice('');setRetry(0);};
  return createPortal(<PreviewRuntimeContext.Provider value={{request,initialAnnotations:annotationCache.current['web:'+item.id],rememberAnnotations:value=>rememberAnnotations({['web:'+item.id]:value}),mode,tool,setMode,setTool,web,setWeb,annotations,setFileAnnotations,sendEdits:async changes=>{if(!feedbackSubmit.current)throw Error('请从会话中打开预览后发送修改');await feedbackSubmit.current({text:t('请将预览中的修改应用到项目源码，保留原有功能并验证结果。'),edits:changes});return true;},saved:value=>edits.saved(item,value)}}><PreviewLayoutContext.Provider value={true}><div className={`fp-layer is-immersive ${wantsStudio?'is-studio':modal?'is-expanded':'is-docked'} ${feedbackScope?'has-feedback':''}`} data-device={item.deviceFrame||undefined} onMouseDown={event=>{if(event.target===event.currentTarget&&modal&&!feedbackLock.current)request(onClose);}}><section ref={panel} className="fp-panel" data-layout={wantsStudio?'studio':modal?'expanded':'docked'} role={modal?'dialog':'region'} aria-modal={modal||undefined} aria-label={t('预览 {name}',{name:item.name})} tabIndex={-1} onKeyDown={event=>{
    if(event.key!=='Tab'||!modal||event.defaultPrevented||(event.target as HTMLElement).closest('.cm-editor'))return;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),iframe,select:not(:disabled),[tabindex="0"],a[href]')).filter(el=>el.getClientRects().length>0);const at=controls.indexOf(document.activeElement as HTMLElement);
    if(event.shiftKey&&at<=0){event.preventDefault();controls.at(-1)?.focus();}else if(!event.shiftKey&&(at<0||at===controls.length-1)){event.preventDefault();controls[0]?.focus();}
  }}>
    {!modal&&!wantsStudio&&<button className="fp-resize-handle" aria-label={t('调整对话宽度')} onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))setChatWidth(Math.max(260,Math.min(innerWidth-440,event.clientX)));}} onPointerUp={event=>event.currentTarget.releasePointerCapture(event.pointerId)} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setChatWidth(width=>Math.max(260,Math.min(innerWidth-440,width+(event.key==='ArrowRight'?12:-12))));}}}/>}
    <header className="fp-header" inert={Boolean(edits.pending)||Boolean(domPending)||feedbackSending}><div className="fp-title" title={previewKindLabel+' · '+fileSize(draft?.bytes??item.size)}>{items.length>1?<PreviewPicker className="fp-file-select" label={t('选择预览文件')} value={String(index)} onChange={value=>request(()=>select(Number(value)))} options={items.map((file,i)=>({value:String(i),label:file.name+(edits.drafts[file.id]&&draftChanged(edits.drafts[file.id])?' •':'')}))}/>:<h2 title={item.name}>{item.name}{dirty&&<span className="fp-edit-dirty" aria-label={t('未保存')}/>}</h2>}</div><div className="fp-web-navigation-slot"/><div className="fp-file-controls-slot"/><div className="fp-tools fp-actions">{item.editor&&<button aria-label={draft?.editing?t('查看预览'):web?t('源码'):t('编辑文件')} title={draft?.editing?t('查看预览'):web?t('源码'):t('编辑文件')} disabled={draft?.loading||edits.saving} onClick={()=>request(()=>void edits.edit(item))}><PreviewIcon name={draft?.editing?'eye':web?'code':'edit'}/></button>}<button aria-label={directoryOpen?t('收起文件目录'):t('显示文件目录')} title={t('文件目录')} aria-pressed={directoryOpen} onClick={()=>setDirectoryOpen(v=>!v)}><PreviewIcon name="pages"/></button><button className="fp-reload" onClick={()=>request(()=>{edits.drop(item.id);setRetry(value=>value+1);},[item.id])} disabled={busy||edits.saving} aria-label={t('重新加载')} title={t('重新加载')}><PreviewIcon name="refresh"/></button>{item.openInComputer&&<button onClick={()=>request(()=>void act(async()=>{await item.openInComputer!();onClose();}))} disabled={busy} aria-label={t('在工作电脑打开')} title={t('在工作电脑打开')}><PreviewIcon name="external"/></button>}{item.save&&<button onClick={()=>void act(item.save!,t('已保存'))} disabled={busy} aria-label={t('导出原文件')} title={t('导出原文件')}><PreviewIcon name="save"/></button>}<span className="fp-action-divider"/>{(wide||item.designSessionId)&&<button aria-label={expanded?t('收回侧栏'):t('展开画布')} title={expanded?t('收回侧栏'):t('展开画布')} onClick={()=>setExpanded(!expanded)}><PreviewIcon name={expanded?'dock':'expand'}/></button>}{!studio&&<button aria-label={t('关闭预览')} title={t('关闭预览')} onClick={()=>request(onClose)}><PreviewIcon name="close"/></button>}</div></header>

    <div className="fp-workbench-tools" inert={Boolean(edits.pending)||Boolean(domPending)||feedbackSending}>
      <div className="fp-tool-group">
        <button aria-pressed={mode==='browse'&&!draft?.editing} onClick={()=>{setMode('browse');if(draft?.editing)void edits.edit(item);}}><PreviewIcon name="eye"/>{t('预览')}</button>
        {(web||item.editor)&&<button aria-pressed={mode==='edit'||draft?.editing} onClick={()=>{if(web)setMode('edit');else{setMode('browse');void edits.edit(item);}}}><PreviewIcon name="edit"/>{t('编辑')}</button>}
      </div>
      <div className="fp-tool-group">
        {(['rect',...(web?['element']:[])] as AnnotationTool[]).map(type=><button key={type} aria-pressed={mode==='annotate'&&tool===type} onClick={()=>{setMode('annotate');setTool(type);}}><PreviewIcon name={type==='rect'?'rect':'comment'}/>{type==='rect'?l('圈选提问','Ask about a region'):l('元素提问','Ask about an element')}</button>)}
      </div>
      <div className="fp-tool-group" role="group" aria-label={l('标记工具','Markup tools')}>
        {(['arrow','pen','text'] as const).map(type=><button key={type} aria-pressed={mode==='annotate'&&tool===type} title={l(({arrow:'箭头',pen:'画笔',text:'文字标注'})[type],({arrow:'Arrow',pen:'Pen',text:'Text note'})[type])} aria-label={l(({arrow:'箭头',pen:'画笔',text:'文字标注'})[type],({arrow:'Arrow',pen:'Pen',text:'Text note'})[type])} onClick={()=>{setMode('annotate');setTool(type);}}><PreviewIcon name={({arrow:'arrow',pen:'edit',text:'text'})[type]}/></button>)}
      </div>
      <span className="fp-tools-space"/>
      {mode!=='edit'&&<div className="fp-tool-group"><button disabled={web?!web.state.annotationCanUndo:!annotations.length} title={t('撤销标注')} aria-label={t('撤销标注')} onClick={()=>{if(web)void web.command({type:'annotation-undo'}).catch(error=>setNotice(error.message));else void setAnnotations(annotations.slice(0,-1));}}><PreviewIcon name="left"/></button>{web&&<button disabled={!web.state.annotationCanRedo} title={l('重做标注','Redo annotation')} aria-label={l('重做标注','Redo annotation')} onClick={()=>void web.command({type:'annotation-redo'}).catch(error=>setNotice(error.message))}><PreviewIcon name="right"/></button>}</div>}
      {web&&mode==='edit'&&<div className="fp-tool-group"><button onClick={()=>web.inspect()}><PreviewIcon name="pages"/>{t('结构')}</button><button disabled={web.busy||!web.state.canUndo} title={t('撤销')+' (Ctrl+Z)'} aria-label={t('撤销')} onClick={()=>void web.command({type:'undo'}).catch(e=>setNotice(e.message))}><PreviewIcon name="left"/></button><button disabled={web.busy||!web.state.canRedo} title={t('重做')+' (Ctrl+Shift+Z)'} aria-label={t('重做')} onClick={()=>void web.command({type:'redo'}).catch(e=>setNotice(e.message))}><PreviewIcon name="right"/></button><button className="fp-save-dom" title={web.primaryLabel+' (Ctrl+S)'} disabled={!web.state.dirty||web.busy} onClick={()=>void web.save()}>{web.primaryLabel}</button></div>}
    </div>
    <div className="fp-workspace" inert={Boolean(edits.pending)||Boolean(domPending)||feedbackSending}>{directoryOpen&&<aside className="fp-directory" aria-label={t('文件目录')}>{directoryBotId?<WorkspaceFileTree botId={directoryBotId} activePath={item.workspace?.path||''} onOpen={file=>{const root=item.workspace?.path.match(/^(designers\/[^/]+\/[^/]+)\//)?.[1],next={...workspacePreviewItem(directoryBotId,file),...(root&&file.path.startsWith(root+'/')?{designSessionId:item.designSessionId}:{})},existing=items.findIndex(value=>value.id===next.id);if(existing>=0)select(existing);else{setItems([...items,next]);select(items.length);}if(!matchMedia('(min-width:700px)').matches)setDirectoryOpen(false);}}/>:<><div className="wft-state">{t('本次文件')}</div>{items.map((file,i)=><button key={file.id} className="fp-session-file" aria-current={i===index?'page':undefined} onClick={()=>select(i)}>{file.name}</button>)}</>}</aside>}<div className={`fp-content ${draft?'has-editor-session':''}`}>
      {draft?.editing?(draft.loading?<div className="fp-state" role="status">{t('正在读取完整文件…')}</div>:draft.revision?<Suspense fallback={<div className="fp-state">{t('正在打开编辑器…')}</div>}><SourceEditor key={item.id} name={item.name} content={draft.content} lineSeparator={draft.lineSeparator} readOnly={draft.saving} onChange={text=>edits.change(item.id,text)} onSave={()=>void edits.save(item.id)}/></Suspense>:<div className="fp-state" role="alert">{draft.error}</div>):<PreviewContent key={item.id} item={item} retry={retry} override={draft?editedPreview(item.name,draft):undefined}/>}
      <FileAnnotationLayer initialCache={annotationCache.current} onCacheChange={rememberAnnotations} itemId={item.id} revision={String(retry)+':'+sourceRevision.current} mode={mode} tool={tool} onChange={setFileAnnotations} register={registerFileAnnotations} selectedAnnotationId={selectedAnnotationId} onSelectAnnotation={selectAnnotation}/>
      {draft&&!draft.loading&&draft.revision&&<PreviewToolbar editing><span className="fp-edit-indicator">{draft.saving?t('保存中…'):dirty?t('未保存修改'):t('已保存')}</span><button disabled={draft.saving} onClick={()=>void edits.save(item.id,true)}>{t('另存为')}</button>{item.editor?.write&&<button className="fp-edit-save" disabled={!dirty||draft.saving} onClick={()=>void edits.save(item.id)}>{t('保存修改')}</button>}</PreviewToolbar>}
      {draft?.error&&draft.revision&&<div className="fp-edit-banner" role="alert">{draft.error}</div>}
    </div></div>
    {(notice||edits.notice)&&<div className="fp-notice" role="status">{notice||edits.notice}</div>}
    {feedbackScope&&<div inert={Boolean(edits.pending)}><PreviewFeedback scope={feedbackScope} item={item} panel={panel} unsaved={dirty||Boolean(web?.state.dirty)} annotations={annotations} selectedAnnotationId={selectedAnnotationId} onSelectAnnotation={selectAnnotation} onAnnotationsChange={setAnnotations} focusRequest={feedbackFocus} captureState={captureAnnotations} registerSend={registerFeedbackSend} onBusy={value=>{feedbackLock.current=value;setFeedbackSending(value);if(!value&&afterFeedback.current){const next=afterFeedback.current;afterFeedback.current=undefined;request(next);}}}/></div>}
    {domPending&&<UnsavedDialog saveLabel={web?.saveLabel} count={1} saving={domSaving||Boolean(web?.busy)} error={domGuardError} onCancel={()=>setDomPending(undefined)} onDiscard={()=>{void webRef.current?.discard().then(()=>{const proceed=domPending;setDomPending(undefined);proceed();}).catch(e=>setDomGuardError(e.message));}} onSave={()=>{setDomSaving(true);void webRef.current?.save().then(saved=>{if(saved){const proceed=domPending;setDomPending(undefined);proceed();}else setDomGuardError(t('修改尚未保存，可以继续编辑或发送给 Bot。'));}).catch(e=>setDomGuardError(e.message)).finally(()=>setDomSaving(false));}}/>}
    {edits.pending&&<UnsavedDialog count={edits.pending.ids.length} saving={edits.saving} error={edits.guardError} onCancel={edits.cancel} onDiscard={edits.discardAndContinue} onSave={()=>void edits.saveAndContinue()}/>}
  </section></div></PreviewLayoutContext.Provider></PreviewRuntimeContext.Provider>,portalTarget||document.body);
}

function UnsavedDialog({count,saving,error,onCancel,onDiscard,onSave,saveLabel}:{saveLabel?:string;count:number;saving:boolean;error:string;onCancel:()=>void;onDiscard:()=>void;onSave:()=>void}){
  const {t}=useI18n();
  const dialog=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.querySelector<HTMLElement>('button')?.focus();return()=>{if(previous?.isConnected)previous.focus();};},[]);
  return <div className="fp-unsaved-backdrop" onMouseDown={e=>e.stopPropagation()}><section ref={dialog} className="fp-unsaved-dialog" role="alertdialog" aria-modal="true" aria-label={t('未保存的修改')} onKeyDown={e=>{if(e.key!=='Tab')return;const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));if(!buttons.length){e.preventDefault();return;}const first=buttons[0],last=buttons.at(-1)!;if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}e.stopPropagation();}}><h2>{t('要保存修改吗？')}</h2><p>{count===1?t('当前文件有未保存的修改。'):t('{count} 个文件有未保存的修改。',{count})}</p>{error&&<p role="alert">{error}</p>}<footer><button disabled={saving} onClick={onCancel}>{t('继续编辑')}</button><button disabled={saving} onClick={onDiscard}>{t('放弃修改')}</button><button disabled={saving} onClick={onSave}>{saving?t('保存中…'):saveLabel||t('保存并继续')}</button></footer></section></div>;
}
