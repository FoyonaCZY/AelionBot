import {draftChanged,editedPreview,usePreviewEdits} from './use-preview-edits';
import {CodePreview} from './CodePreview';
import {WorkspaceFileTree} from './WorkspaceFileTree';
import {workspacePreviewItem} from './workspace-preview';
import {sourceLanguage} from './source-language';
import {lazy,Suspense,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {ArtifactPreview} from './shared';
import type {PreviewItem,RegisterPreviewGuard} from './FilePreviewContext';
import {FileTypeBadge,fileSize} from './FileAppearance';
import Markdown from './MessageMarkdown';
import {Select} from './Select';
import {PreviewLayoutContext,useImmersivePreview} from './preview-layout';
import {usePreviewViewport} from './use-preview-viewport';
import {csvRows,previewErrorText,previewFormat,previewHtml,previewKind} from './preview-utils';
import {useI18n} from './i18n';
import './file-preview.css';

const PdfPreview=lazy(()=>import('./PdfPreview'));
const SourceEditor=lazy(()=>import('./SourceEditor'));
export function PreviewIcon({name}:{name:string}){
  const paths:Record<string,React.ReactNode>={
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
  const immersive=useImmersivePreview(),[sizing,setSizing]=useState<'fill'|'fit'>('fit');
  const padding=immersive?0:24;
  const [zoom,setZoom]=useState<number|null>(null),[size,setSize]=useState({width:0,height:0}),[error,setError]=useState(false);
  const viewport=useRef<HTMLDivElement>(null),drag=useRef<{x:number;y:number;left:number;top:number}|undefined>(undefined);
  const room=usePreviewViewport(viewport,true,padding);
  const filled=immersive&&sizing==='fill';
  const fit=size.width?(filled?Math.max(room.width/size.width,room.height/size.height):Math.min(1,room.width/size.width,room.height/size.height)):1,scale=zoom??fit;
  useLayoutEffect(()=>{const el=viewport.current;if(el&&filled&&zoom===null){el.scrollLeft=(el.scrollWidth-el.clientWidth)/2;el.scrollTop=(el.scrollHeight-el.clientHeight)/2;}},[filled,zoom,scale,room.width,room.height]);
  const change=(delta:number)=>setZoom(Math.max(.1,Math.min(4,Math.round((scale+delta)*100)/100)));
  return <><div className="fp-toolbar"><div className="fp-tools"><button onClick={()=>change(-.25)} disabled={scale<=.1} title={t('缩小')} aria-label={t('缩小图片')}><PreviewIcon name="minus"/></button><output>{Math.round(scale*100)}%</output><button onClick={()=>change(.25)} disabled={scale>=4} title={t('放大')} aria-label={t('放大图片')}><PreviewIcon name="plus"/></button>{immersive&&<button aria-pressed={zoom===null&&sizing==='fill'} onClick={()=>{setSizing('fill');setZoom(null);}} title={t('填满画布')} aria-label={t('填满画布')}><PreviewIcon name="expand"/></button>}<button aria-pressed={zoom===null&&(!immersive||sizing==='fit')} onClick={()=>{setSizing('fit');setZoom(null);}} title={t('完整显示')} aria-label={t('完整显示')}><PreviewIcon name="fit"/></button><button aria-pressed={zoom===1} onClick={()=>setZoom(1)} title={t('原始尺寸')} aria-label={t('原始尺寸')}>1:1</button></div></div>
    <div className="fp-image-stage" ref={viewport} tabIndex={0} aria-label={t('图片画布，可滚动或拖动查看')} onDoubleClick={()=>setZoom(zoom===null?1:null)} onPointerDown={event=>{if(event.button!==0||!viewport.current)return;drag.current={x:event.clientX,y:event.clientY,left:viewport.current.scrollLeft,top:viewport.current.scrollTop};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const start=drag.current,el=viewport.current;if(start&&el){el.scrollLeft=start.left-(event.clientX-start.x);el.scrollTop=start.top-(event.clientY-start.y);}}} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}>
      {error?<div className="fp-state">{t('这张图片暂时无法显示，可以保存原文件后查看。')}</div>:<div className="fp-image-space" style={{minWidth:size.width*scale+padding*2,minHeight:size.height*scale+padding*2}}><img src={src} alt={name} draggable={false} onError={()=>setError(true)} onLoad={event=>setSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} style={size.width?{width:size.width*scale,height:size.height*scale}:undefined}/></div>}
    </div></>;
}
function DocumentPreview({value,name}:{value:ArtifactPreview;name:string}){
  const {t}=useI18n();
  const [source,setSource]=useState(false),[device,setDevice]=useState('fit');
  const html=value.kind==='html',markdown=value.kind==='markdown',csv=previewFormat(name)==='csv';
  const rows=csv?csvRows(value.content||''):[];
  return <><div className="fp-toolbar"><div className="fp-segments" aria-label={t('查看方式')}>{(html||markdown)?<><button aria-pressed={!source} onClick={()=>setSource(false)} title={t('预览')} aria-label={t('预览')}><PreviewIcon name="eye"/></button><button aria-pressed={source} onClick={()=>setSource(true)} title={t('源码')} aria-label={t('源码')}><PreviewIcon name="code"/></button></>:<span>{csv?t('表格'):sourceLanguage(name)?t('源码'):t('文本')}</span>}</div>{html&&!source&&<div className="fp-segments" aria-label={t('网页显示尺寸')}>{[['fit','自适应'],['1440','桌面'],['768','平板'],['390','手机']].map(([id,label])=><button key={id} aria-pressed={device===id} onClick={()=>setDevice(id)} title={t(label)} aria-label={t(label)}><PreviewIcon name={id==='fit'?'fit':id==='1440'?'desktop':id==='768'?'tablet':'phone'}/></button>)}</div>}</div>
    {html&&!source?<div className="fp-web-stage"><iframe className="fp-web-frame" title={name} sandbox="" srcDoc={previewHtml(value.content||'')} style={{width:device==='fit'?'100%':Number(device)}}/></div>:<div className={`fp-document-stage ${!csv&&(!markdown||source)?'fp-source-stage':''}`} tabIndex={0} aria-label={t('文档内容')}>{markdown&&!source?<article className="fp-paper markdown"><Markdown>{value.content||''}</Markdown></article>:csv?<div className="fp-csv markdown-table-scroll"><table><thead><tr>{rows[0]?.map((cell,i)=><th key={i}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>:<CodePreview content={value.content||''} name={name}/>}</div>}
    </>;
}
function PreviewContent({item,retry,override}:{item:PreviewItem;retry:number;override?:ArtifactPreview}){
  const {t}=useI18n();
  const [loaded,setValue]=useState<ArtifactPreview>(),[error,setError]=useState('');
  const value=override||loaded;
  const kind=previewKind(item.name);
  useEffect(()=>{let active=true;setValue(undefined);setError('');item.load().then(value=>{if(active)setValue(value);}).catch(error=>{if(active)setError(previewErrorText(error));});return()=>{active=false;};},[item,retry]);
  if(error&&!override)return <div className="fp-state" role="alert"><PreviewIcon name="image"/><strong>{t('暂时无法预览')}</strong><p>{error}</p></div>;
  if(!value)return <div className="fp-state" role="status"><span className="fp-loading"/><strong>{kind==='演示文稿'?t('正在准备演示文稿'):t('正在打开预览')}</strong><p>{kind==='演示文稿'?t('首次打开可能需要一点时间'):t('内容即将出现在这里')}</p></div>;
  if(value.kind==='image')return <ImagePreview src={value.dataUrl!} name={item.name}/>;
  if(value.kind==='pdf')return <Suspense fallback={<div className="fp-state" role="status">{t('正在打开文档…')}</div>}><PdfPreview src={value.dataUrl!} name={item.name} slides={kind==='演示文稿'}/></Suspense>;
  if(value.kind==='unsupported')return <div className="fp-state"><FileTypeBadge name={item.name}/><strong>{t('保存后，继续查看')}</strong><p>{t('此格式暂不支持直接预览，可保存到本机打开。')}</p></div>;
  return <><DocumentPreview value={value} name={item.name}/>{value.truncated&&<div className="fp-truncated" role="status">{t('预览内容已截断，可保存原文件查看全部内容。')}</div>}</>;
}
export function FilePreview({items:initialItems,initialIndex=0,onClose,registerGuard}:{items:PreviewItem[];initialIndex?:number;onClose:()=>void;registerGuard?:RegisterPreviewGuard}){
  const {t}=useI18n();
  const [items,setItems]=useState(()=>initialItems.map(item=>item.editor||!item.workspace?item:{...item,editor:workspacePreviewItem(item.workspace.botId,{name:item.name,path:item.workspace.path,size:item.size}).editor})),[directoryOpen,setDirectoryOpen]=useState(true);
  const [index,setIndex]=useState(initialIndex),[expanded,setExpanded]=useState(false),[wide,setWide]=useState(()=>matchMedia('(min-width:1200px)').matches),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0);
  const edits=usePreviewEdits();
  const panel=useRef<HTMLElement>(null),previous=useRef<HTMLElement|null>(null),item=items[index],modal=expanded||!wide;
  const draft=edits.drafts[item.id],dirty=Boolean(draft&&draftChanged(draft));
  const previewKindLabel=t(previewKind(item.name));
  useEffect(()=>registerGuard?.(proceed=>edits.request(proceed)),[registerGuard,edits.request]);
  useEffect(()=>{const media=matchMedia('(min-width:1200px)'),update=()=>setWide(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  useLayoutEffect(()=>{previous.current=document.activeElement as HTMLElement|null;panel.current?.focus({preventScroll:true});return()=>{queueMicrotask(()=>{if(!document.querySelector('.fp-panel')&&previous.current?.isConnected)previous.current.focus({preventScroll:true});});};},[]);
  useLayoutEffect(()=>{if(modal&&!panel.current?.contains(document.activeElement))panel.current?.focus({preventScroll:true});},[modal]);
  useLayoutEffect(()=>{if(!modal&&!edits.pending)return;const root=document.getElementById('root');if(!root)return;const wasInert=root.inert;root.inert=true;return()=>{root.inert=wasInert;};},[modal,Boolean(edits.pending)]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{
    if(!(modal||panel.current?.contains(document.activeElement)))return;
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.isComposing&&event.key.toLowerCase()==='s'&&draft){event.preventDefault();event.stopImmediatePropagation();if(!edits.pending)void edits.save(item.id);return;}
    if(event.key==='Escape'){if(document.querySelector('.fp-file-select:open'))return;event.preventDefault();event.stopImmediatePropagation();if(edits.pending){if(!edits.saving)edits.cancel();}else if(expanded&&wide)setExpanded(false);else edits.request(onClose);}
  };window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);},[modal,expanded,wide,onClose,edits.pending,edits.saving,draft]);
  const act=async(task:()=>Promise<unknown>,success='')=>{setBusy(true);setNotice('');try{const result=await task();if(result!==null)setNotice(success);}catch(error){setNotice(previewErrorText(error));}finally{setBusy(false);}};
  const select=(next:number)=>{setIndex(next);setNotice('');setRetry(0);};
  return createPortal(<PreviewLayoutContext.Provider value={true}><div className={`fp-layer is-immersive ${modal?'is-expanded':'is-docked'}`} onMouseDown={event=>{if(event.target===event.currentTarget&&modal)edits.request(onClose);}}><section ref={panel} className="fp-panel" data-layout={modal?'expanded':'docked'} role={modal?'dialog':'region'} aria-modal={modal||undefined} aria-label={t('预览 {name}',{name:item.name})} tabIndex={-1} onKeyDown={event=>{
    if(event.key!=='Tab'||!modal||event.defaultPrevented||(event.target as HTMLElement).closest('.cm-editor'))return;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),iframe,select:not(:disabled),[tabindex="0"],a[href]')).filter(el=>el.getClientRects().length>0);const at=controls.indexOf(document.activeElement as HTMLElement);
    if(event.shiftKey&&at<=0){event.preventDefault();controls.at(-1)?.focus();}else if(!event.shiftKey&&(at<0||at===controls.length-1)){event.preventDefault();controls[0]?.focus();}
  }}>
    <header className="fp-header" inert={Boolean(edits.pending)}><div className="fp-title" title={previewKindLabel+' · '+fileSize(draft?.bytes??item.size)}>{items.length>1?<Select className="fp-file-select" aria-label={t('选择预览文件')} value={String(index)} onChange={event=>select(Number(event.target.value))}>{items.map((file,i)=><option key={file.id} value={String(i)}>{file.name}{edits.drafts[file.id]&&draftChanged(edits.drafts[file.id])?' •':''}</option>)}</Select>:<h2 title={item.name}>{item.name}{dirty&&<span className="fp-edit-dirty" aria-label={t('未保存')}/>}</h2>}</div><div className="fp-tools fp-actions">{item.editor&&<button aria-label={draft?.editing?t('查看预览'):t('编辑文件')} title={draft?.editing?t('查看预览'):t('编辑文件')} disabled={draft?.loading||edits.saving} onClick={()=>void edits.edit(item)}><PreviewIcon name={draft?.editing?'eye':'edit'}/></button>}<button aria-label={directoryOpen?t('收起文件目录'):t('显示文件目录')} title={t('文件目录')} aria-pressed={directoryOpen} onClick={()=>setDirectoryOpen(v=>!v)}><PreviewIcon name="pages"/></button><button onClick={()=>edits.request(()=>{edits.drop(item.id);setRetry(value=>value+1);},[item.id])} disabled={busy||edits.saving} aria-label={t('重新加载')} title={t('重新加载')}><PreviewIcon name="refresh"/></button>{item.openInComputer&&<button onClick={()=>edits.request(()=>void act(async()=>{await item.openInComputer!();onClose();}))} disabled={busy} aria-label={t('在工作电脑打开')} title={t('在工作电脑打开')}><PreviewIcon name="external"/></button>}<button onClick={()=>void act(item.save,t('已保存'))} disabled={busy} aria-label={t('导出原文件')} title={t('导出原文件')}><PreviewIcon name="save"/></button><span className="fp-action-divider"/>{wide&&<button aria-label={expanded?t('收回侧栏'):t('展开画布')} title={expanded?t('收回侧栏'):t('展开画布')} onClick={()=>setExpanded(!expanded)}><PreviewIcon name={expanded?'dock':'expand'}/></button>}<button aria-label={t('关闭预览')} title={t('关闭预览')} onClick={()=>edits.request(onClose)}><PreviewIcon name="close"/></button></div></header>
    <div className="fp-workspace" inert={Boolean(edits.pending)}>{directoryOpen&&<aside className="fp-directory" aria-label={t('文件目录')}>{item.workspace?<WorkspaceFileTree botId={item.workspace.botId} activePath={item.workspace.path} onOpen={file=>{const next=workspacePreviewItem(item.workspace!.botId,file),existing=items.findIndex(value=>value.id===next.id);if(existing>=0)select(existing);else{setItems([...items,next]);select(items.length);}if(!matchMedia('(min-width:700px)').matches)setDirectoryOpen(false);}}/>:<><div className="wft-state">{t('本次文件')}</div>{items.map((file,i)=><button key={file.id} className="fp-session-file" aria-current={i===index?'page':undefined} onClick={()=>select(i)}>{file.name}</button>)}</>}</aside>}<div className={`fp-content ${draft?'has-editor-session':''}`}>
      {draft?.editing?(draft.loading?<div className="fp-state" role="status">{t('正在读取完整文件…')}</div>:draft.revision?<Suspense fallback={<div className="fp-state">{t('正在打开编辑器…')}</div>}><SourceEditor key={item.id} name={item.name} content={draft.content} lineSeparator={draft.lineSeparator} readOnly={draft.saving} onChange={text=>edits.change(item.id,text)} onSave={()=>void edits.save(item.id)}/></Suspense>:<div className="fp-state" role="alert">{draft.error}</div>):<PreviewContent key={item.id} item={item} retry={retry} override={draft?editedPreview(item.name,draft):undefined}/>}
      {draft&&!draft.loading&&draft.revision&&<div className="fp-edit-toolbar"><span className="fp-edit-indicator">{draft.saving?t('保存中…'):dirty?t('未保存修改'):t('已保存')}</span><button onClick={()=>void edits.edit(item)}>{draft.editing?t('查看预览'):t('继续编辑')}</button><button disabled={draft.saving} onClick={()=>void edits.save(item.id,true)}>{t('另存为')}</button>{item.editor?.write&&<button className="fp-edit-save" disabled={!dirty||draft.saving} onClick={()=>void edits.save(item.id)}>{t('保存修改')}</button>}</div>}
      {draft?.error&&draft.revision&&<div className="fp-edit-banner" role="alert">{draft.error}</div>}
    </div></div>
    {(notice||edits.notice)&&<div className="fp-notice" role="status">{notice||edits.notice}</div>}
    {edits.pending&&<UnsavedDialog count={edits.pending.ids.length} saving={edits.saving} error={edits.guardError} onCancel={edits.cancel} onDiscard={edits.discardAndContinue} onSave={()=>void edits.saveAndContinue()}/>}
  </section></div></PreviewLayoutContext.Provider>,document.body);
}

function UnsavedDialog({count,saving,error,onCancel,onDiscard,onSave}:{count:number;saving:boolean;error:string;onCancel:()=>void;onDiscard:()=>void;onSave:()=>void}){
  const {t}=useI18n();
  const dialog=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.querySelector<HTMLElement>('button')?.focus();return()=>{if(previous?.isConnected)previous.focus();};},[]);
  return <div className="fp-unsaved-backdrop" onMouseDown={e=>e.stopPropagation()}><section ref={dialog} className="fp-unsaved-dialog" role="alertdialog" aria-modal="true" aria-label={t('未保存的修改')} onKeyDown={e=>{if(e.key!=='Tab')return;const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));if(!buttons.length){e.preventDefault();return;}const first=buttons[0],last=buttons.at(-1)!;if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}e.stopPropagation();}}><h2>{t('要保存修改吗？')}</h2><p>{count===1?t('当前文件有未保存的修改。'):t('{count} 个文件有未保存的修改。',{count})}</p>{error&&<p role="alert">{error}</p>}<footer><button disabled={saving} onClick={onCancel}>{t('继续编辑')}</button><button disabled={saving} onClick={onDiscard}>{t('放弃修改')}</button><button disabled={saving} onClick={onSave}>{saving?t('保存中…'):t('保存并继续')}</button></footer></section></div>;
}
