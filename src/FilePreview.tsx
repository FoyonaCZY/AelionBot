import {lazy,Suspense,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {ArtifactPreview} from './shared';
import type {PreviewItem} from './FilePreviewContext';
import {FileTypeBadge,fileSize} from './FileAppearance';
import Markdown from './MessageMarkdown';
import {Select} from './Select';
import {PreviewLayoutContext,useImmersivePreview} from './preview-layout';
import {usePreviewViewport} from './use-preview-viewport';
import {csvRows,previewErrorText,previewFormat,previewHtml,previewKind} from './preview-utils';
import './file-preview.css';

const PdfPreview=lazy(()=>import('./PdfPreview'));
export function PreviewIcon({name}:{name:string}){
  const paths:Record<string,React.ReactNode>={
    desktop:<><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,tablet:<><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 17h.01"/></>,phone:<><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M12 18h.01"/></>,code:<><path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/></>,eye:<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></>,external:<><path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/></>,fit:<><rect x="6" y="7" width="12" height="10" rx="1"/><path d="M7 3H3v4m14-4h4v4M3 17v4h4m10 0h4v-4"/></>,
    close:<path d="m6 6 12 12M18 6 6 18"/>,expand:<path d="M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6"/>,dock:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/></>,
    plus:<path d="M5 12h14M12 5v14"/>,minus:<path d="M5 12h14"/>,left:<path d="m14 6-6 6 6 6"/>,right:<path d="m10 6 6 6-6 6"/>,save:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    image:<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/></>,pages:<><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="12" y="4" width="9" height="16" rx="1"/></>,
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]||paths.image}</svg>;
}
export function PreviewInfo({children}:{children:React.ReactNode}){
  const id=useId();
  return <div className="fp-info"><button type="button" popoverTarget={id} aria-label="预览信息" title="预览信息"><PreviewIcon name="info"/></button><div id={id} popover="auto" className="fp-info-popover">{children}</div></div>;
}
function ImagePreview({src,name}:{src:string;name:string}){
  const immersive=useImmersivePreview(),[sizing,setSizing]=useState<'fill'|'fit'>('fit');
  const padding=immersive?0:24;
  const [zoom,setZoom]=useState<number|null>(null),[size,setSize]=useState({width:0,height:0}),[error,setError]=useState(false);
  const viewport=useRef<HTMLDivElement>(null),drag=useRef<{x:number;y:number;left:number;top:number}|undefined>(undefined);
  const room=usePreviewViewport(viewport,true,padding);
  const filled=immersive&&sizing==='fill';
  const fit=size.width?(filled?Math.max(room.width/size.width,room.height/size.height):Math.min(1,room.width/size.width,room.height/size.height)):1,scale=zoom??fit;
  useLayoutEffect(()=>{const el=viewport.current;if(el&&filled&&zoom===null){el.scrollLeft=(el.scrollWidth-el.clientWidth)/2;el.scrollTop=(el.scrollHeight-el.clientHeight)/2;}},[filled,zoom,scale,room.width,room.height]);
  const change=(delta:number)=>setZoom(Math.max(.1,Math.min(4,Math.round((scale+delta)*100)/100)));
  return <><div className="fp-toolbar"><div className="fp-tools"><button onClick={()=>change(-.25)} disabled={scale<=.1} title="缩小" aria-label="缩小图片"><PreviewIcon name="minus"/></button><output>{Math.round(scale*100)}%</output><button onClick={()=>change(.25)} disabled={scale>=4} title="放大" aria-label="放大图片"><PreviewIcon name="plus"/></button>{immersive&&<button aria-pressed={zoom===null&&sizing==='fill'} onClick={()=>{setSizing('fill');setZoom(null);}} title="填满画布" aria-label="填满画布"><PreviewIcon name="expand"/></button>}<button aria-pressed={zoom===null&&(!immersive||sizing==='fit')} onClick={()=>{setSizing('fit');setZoom(null);}} title="完整显示" aria-label="完整显示"><PreviewIcon name="fit"/></button><button aria-pressed={zoom===1} onClick={()=>setZoom(1)} title="原始尺寸" aria-label="原始尺寸">1:1</button></div></div>
    <div className="fp-image-stage" ref={viewport} tabIndex={0} aria-label="图片画布，可滚动或拖动查看" onDoubleClick={()=>setZoom(zoom===null?1:null)} onPointerDown={event=>{if(event.button!==0||!viewport.current)return;drag.current={x:event.clientX,y:event.clientY,left:viewport.current.scrollLeft,top:viewport.current.scrollTop};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const start=drag.current,el=viewport.current;if(start&&el){el.scrollLeft=start.left-(event.clientX-start.x);el.scrollTop=start.top-(event.clientY-start.y);}}} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}}>
      {error?<div className="fp-state">这张图片暂时无法显示，可以保存原文件后查看。</div>:<div className="fp-image-space" style={{minWidth:size.width*scale+padding*2,minHeight:size.height*scale+padding*2}}><img src={src} alt={name} draggable={false} onError={()=>setError(true)} onLoad={event=>setSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})} style={size.width?{width:size.width*scale,height:size.height*scale}:undefined}/></div>}
    </div><PreviewInfo><span>{size.width?`${size.width} × ${size.height}`:'正在读取图片'}</span><span>双击切换原始尺寸 · 填满或放大后可拖动查看边缘</span></PreviewInfo></>;
}
function DocumentPreview({value,name}:{value:ArtifactPreview;name:string}){
  const [source,setSource]=useState(false),[device,setDevice]=useState('fit');
  const html=value.kind==='html',markdown=value.kind==='markdown',csv=previewFormat(name)==='csv';
  const rows=csv?csvRows(value.content||''):[];
  return <><div className="fp-toolbar"><div className="fp-segments" aria-label="查看方式">{(html||markdown)?<><button aria-pressed={!source} onClick={()=>setSource(false)} title="预览" aria-label="预览"><PreviewIcon name="eye"/></button><button aria-pressed={source} onClick={()=>setSource(true)} title="源码" aria-label="源码"><PreviewIcon name="code"/></button></>:<span>{csv?'表格':'文本'}</span>}</div>{html&&!source&&<div className="fp-segments" aria-label="网页显示尺寸">{[['fit','自适应'],['1440','桌面'],['768','平板'],['390','手机']].map(([id,label])=><button key={id} aria-pressed={device===id} onClick={()=>setDevice(id)} title={label} aria-label={label}><PreviewIcon name={id==='fit'?'fit':id==='1440'?'desktop':id==='768'?'tablet':'phone'}/></button>)}</div>}</div>
    {html&&!source?<div className="fp-web-stage"><iframe className="fp-web-frame" title={name} sandbox="" srcDoc={previewHtml(value.content||'')} style={{width:device==='fit'?'100%':Number(device)}}/></div>:<div className="fp-document-stage" tabIndex={0} aria-label="文档内容">{markdown&&!source?<article className="fp-paper markdown"><Markdown>{value.content||''}</Markdown></article>:csv?<div className="fp-csv markdown-table-scroll"><table><thead><tr>{rows[0]?.map((cell,i)=><th key={i}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>:<pre className="fp-source">{value.content}</pre>}</div>}
    <PreviewInfo><span>{html?'网页静态预览':csv?'最多预览 200 行、30 列':markdown?'Markdown':'文本预览'}</span><span>{value.truncated?'内容已截断 · 保存原文件查看完整内容':html?'原文件中的脚本和外部资源未运行':'原文件保持不变'}</span></PreviewInfo></>;
}
function PreviewContent({item,retry}:{item:PreviewItem;retry:number}){
  const [value,setValue]=useState<ArtifactPreview>(),[error,setError]=useState('');
  useEffect(()=>{let active=true;setValue(undefined);setError('');item.load().then(value=>{if(active)setValue(value);}).catch(error=>{if(active)setError(previewErrorText(error));});return()=>{active=false;};},[item,retry]);
  if(error)return <div className="fp-state" role="alert"><PreviewIcon name="image"/><strong>暂时无法预览</strong><p>{error}</p></div>;
  if(!value)return <div className="fp-state" role="status"><span className="fp-loading"/><strong>{previewKind(item.name)==='演示文稿'?'正在准备演示文稿':'正在打开预览'}</strong><p>{previewKind(item.name)==='演示文稿'?'首次打开可能需要一点时间':'内容即将出现在这里'}</p></div>;
  if(value.kind==='image')return <ImagePreview src={value.dataUrl!} name={item.name}/>;
  if(value.kind==='pdf')return <Suspense fallback={<div className="fp-state" role="status">正在打开文档…</div>}><PdfPreview src={value.dataUrl!} name={item.name} slides={previewKind(item.name)==='演示文稿'}/></Suspense>;
  if(value.kind==='unsupported')return <div className="fp-state"><FileTypeBadge name={item.name}/><strong>保存后，继续查看</strong><p>此格式暂不支持直接预览，可保存到本机打开。</p></div>;
  return <DocumentPreview value={value} name={item.name}/>;
}
export function FilePreview({items,initialIndex=0,onClose}:{items:PreviewItem[];initialIndex?:number;onClose:()=>void}){
  const [index,setIndex]=useState(initialIndex),[expanded,setExpanded]=useState(false),[wide,setWide]=useState(()=>matchMedia('(min-width:1200px)').matches),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0);
  const panel=useRef<HTMLElement>(null),previous=useRef<HTMLElement|null>(null),item=items[index],modal=expanded||!wide;
  useEffect(()=>{const media=matchMedia('(min-width:1200px)'),update=()=>setWide(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  useLayoutEffect(()=>{previous.current=document.activeElement as HTMLElement|null;panel.current?.focus({preventScroll:true});return()=>{queueMicrotask(()=>{if(!document.querySelector('.fp-panel')&&previous.current?.isConnected)previous.current.focus({preventScroll:true});});};},[]);
  useLayoutEffect(()=>{if(modal&&!panel.current?.contains(document.activeElement))panel.current?.focus({preventScroll:true});},[modal]);
  useLayoutEffect(()=>{if(!modal)return;const root=document.getElementById('root');if(!root)return;const wasInert=root.inert;root.inert=true;return()=>{root.inert=wasInert;};},[modal]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&(modal||panel.current?.contains(document.activeElement))){if(document.querySelector('.fp-info-popover:popover-open,.fp-file-select:open'))return;event.preventDefault();event.stopImmediatePropagation();if(expanded&&wide)setExpanded(false);else onClose();}};window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);},[modal,expanded,wide,onClose]);
  const act=async(task:()=>Promise<unknown>,success='')=>{setBusy(true);setNotice('');try{const result=await task();if(result!==null)setNotice(success);}catch(error){setNotice(previewErrorText(error));}finally{setBusy(false);}};
  const select=(next:number)=>{setIndex(next);setNotice('');setRetry(0);};
  return createPortal(<PreviewLayoutContext.Provider value={true}><div className={`fp-layer is-immersive ${modal?'is-expanded':'is-docked'}`} onMouseDown={event=>{if(event.target===event.currentTarget&&modal)onClose();}}><section ref={panel} className="fp-panel" data-layout={modal?'expanded':'docked'} role={modal?'dialog':'region'} aria-modal={modal||undefined} aria-label={`预览 ${item.name}`} tabIndex={-1} onKeyDown={event=>{
    if(event.key!=='Tab'||!modal)return;
    const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),iframe,select:not(:disabled),[tabindex="0"],a[href]')).filter(el=>el.getClientRects().length>0);const at=controls.indexOf(document.activeElement as HTMLElement);
    if(event.shiftKey&&at<=0){event.preventDefault();controls.at(-1)?.focus();}else if(!event.shiftKey&&(at<0||at===controls.length-1)){event.preventDefault();controls[0]?.focus();}
  }}>
    <header className="fp-header"><div className="fp-title" title={`${previewKind(item.name)} · ${fileSize(item.size)}`}>{items.length>1?<Select className="fp-file-select" aria-label="选择预览文件" value={String(index)} onChange={event=>select(Number(event.target.value))}>{items.map((file,i)=><option key={file.id} value={String(i)}>{file.name}</option>)}</Select>:<h2 title={item.name}>{item.name}</h2>}</div><div className="fp-tools fp-actions"><button onClick={()=>setRetry(value=>value+1)} disabled={busy} aria-label="重新加载" title="重新加载"><PreviewIcon name="refresh"/></button>{item.openInComputer&&<button onClick={()=>void act(async()=>{await item.openInComputer!();onClose();})} disabled={busy} aria-label="在工作电脑打开" title="在工作电脑打开"><PreviewIcon name="external"/></button>}<button onClick={()=>void act(item.save,'已保存')} disabled={busy} aria-label="保存原文件" title="保存原文件"><PreviewIcon name="save"/></button><span className="fp-action-divider"/>{wide&&<button aria-label={expanded?'收回侧栏':'展开画布'} title={expanded?'收回侧栏':'展开画布'} onClick={()=>setExpanded(!expanded)}><PreviewIcon name={expanded?'dock':'expand'}/></button>}<button aria-label="关闭预览" title="关闭预览" onClick={onClose}><PreviewIcon name="close"/></button></div></header>
    <div className="fp-content"><PreviewContent key={item.id} item={item} retry={retry}/></div>
    {notice&&<div className="fp-notice" role="status">{notice}</div>}
  </section></div></PreviewLayoutContext.Provider>,document.body);
}
