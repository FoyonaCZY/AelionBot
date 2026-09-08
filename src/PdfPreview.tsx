import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {getDocument,GlobalWorkerOptions,TextLayer,type PDFDocumentProxy,type RenderTask} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import {PreviewIcon} from './FilePreview';
import {previewErrorText} from './preview-utils';
import './pdf-text-layer.css';
import {useImmersivePreview} from './preview-layout';
import {usePreviewViewport} from './use-preview-viewport';

GlobalWorkerOptions.workerSrc=workerUrl;
function PdfPage({pdf,page,width,aspectRatio,thumbnail=false}:{pdf:PDFDocumentProxy;page:number;width:number;aspectRatio?:number;thumbnail?:boolean}){
  const canvas=useRef<HTMLCanvasElement>(null),text=useRef<HTMLDivElement>(null),[error,setError]=useState(''),[ratio,setRatio]=useState(16/9);
  useEffect(()=>{
    let active=true,render:RenderTask|undefined,layer:TextLayer|undefined;setError('');
    void pdf.getPage(page).then(async value=>{
      if(!active||!canvas.current)return;
      const original=value.getViewport({scale:1}),viewport=value.getViewport({scale:width/original.width});
      setRatio(original.width/original.height);
      // Keep the last complete bitmap visible while the next one renders. The
      // canvas never determines layout: its wrapper owns the page dimensions.
      const output=Math.min(devicePixelRatio||1,2,Math.sqrt(16_000_000/(viewport.width*viewport.height))),buffer=document.createElement('canvas');
      buffer.width=Math.max(1,Math.ceil(viewport.width*output));buffer.height=Math.max(1,Math.ceil(viewport.height*output));
      render=value.render({canvas:buffer,viewport,transform:[output,0,0,output,0,0]});await render.promise;
      if(!active||!canvas.current)return;
      const el=canvas.current;el.width=buffer.width;el.height=buffer.height;el.getContext('2d')!.drawImage(buffer,0,0);
      if(!thumbnail){
        const content=await value.getTextContent();if(!active||!text.current)return;
        text.current.replaceChildren();text.current.style.setProperty('--total-scale-factor',String(viewport.scale));
        layer=new TextLayer({textContentSource:content,container:text.current,viewport});await layer.render();
      }
    }).catch(error=>{if(active&&error?.name!=='RenderingCancelledException')setError(previewErrorText(error));});
    return()=>{active=false;render?.cancel();layer?.cancel();};
  },[pdf,page,width,thumbnail]);
  return <div className="fp-pdf-page" style={{width,aspectRatio:aspectRatio??ratio}}>{error?<p role="alert">此页显示失败：{error}</p>:<><canvas ref={canvas} aria-label={`第 ${page} 页`}/>{!thumbnail&&<div ref={text} className="textLayer"/>}</>}</div>;
}
function Thumbnail({pdf,page,current,onSelect}:{pdf:PDFDocumentProxy;page:number;current:boolean;onSelect:()=>void}){
  const ref=useRef<HTMLButtonElement>(null),[visible,setVisible]=useState(false);
  useEffect(()=>{const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setVisible(true);observer.disconnect();}},{rootMargin:'150px'});observer.observe(ref.current!);return()=>observer.disconnect();},[]);
  useEffect(()=>{if(current)ref.current?.scrollIntoView({block:'nearest'});},[current]);
  return <button ref={ref} className="fp-thumbnail" aria-label={`跳转到第 ${page} 页`} aria-current={current?'page':undefined} onClick={onSelect}>{visible?<PdfPage pdf={pdf} page={page} width={112} thumbnail/>:<span className="fp-thumb-placeholder"/>}<span>{page}</span></button>;
}
export default function PdfPreview({src,name,slides}:{src:string;name:string;slides:boolean}){
  const immersive=useImmersivePreview(),[sizing,setSizing]=useState<'fill'|'fit'>('fit');
  const padding=immersive?0:24;
  const [pdf,setPdf]=useState<PDFDocumentProxy>(),[error,setError]=useState(''),[page,setPage]=useState(1),[input,setInput]=useState('1'),[outline,setOutline]=useState(false),[zoom,setZoom]=useState<number|null>(null),[pageSize,setPageSize]=useState({width:960,height:540});
  const viewport=useRef<HTMLDivElement>(null),room=usePreviewViewport(viewport,Boolean(pdf),padding);
  const stage=useRef<HTMLDivElement>(null),drag=useRef<{x:number;y:number;left:number;top:number}|undefined>(undefined);
  useEffect(()=>{
    let active=true;setError('');
    const data=Uint8Array.from(atob(src.slice(src.indexOf(',')+1)),c=>c.charCodeAt(0));
    const assets=import.meta.env.DEV?'/node_modules/pdfjs-dist/':new URL('./pdf-assets/',document.baseURI).href;
    const task=getDocument({data,cMapUrl:assets+'cmaps/',cMapPacked:true,standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/'});
    task.onPassword=()=>{if(active)setError('此文档需要密码，请保存原文件后打开。');};
    task.promise.then(value=>{if(active)setPdf(value);}).catch(error=>{if(active)setError(previewErrorText(error));});
    return()=>{active=false;void task.destroy();};
  },[src]);
  useEffect(()=>{let active=true;if(pdf)void pdf.getPage(page).then(value=>{if(active){const view=value.getViewport({scale:1});setPageSize({width:view.width,height:view.height});}}).catch(error=>{if(active)setError(previewErrorText(error));});return()=>{active=false;};},[pdf,page]);
  const go=(value:number)=>{if(!pdf)return;const next=Math.max(1,Math.min(pdf.numPages,Math.trunc(value)||1));setPage(next);setInput(String(next));stage.current?.scrollTo(0,0);};
  const filled=immersive&&sizing==='fill',ratioX=room.width/pageSize.width,ratioY=room.height/pageSize.height;
  const fit=filled?(slides?Math.max(ratioX,ratioY):ratioX):Math.min(ratioX,ratioY),scale=zoom??fit,width=Math.max(1,pageSize.width*scale);
  useLayoutEffect(()=>{const el=stage.current;if(el&&filled&&zoom===null){el.scrollLeft=(el.scrollWidth-el.clientWidth)/2;el.scrollTop=slides?(el.scrollHeight-el.clientHeight)/2:0;}},[filled,zoom,width,page,slides,room.width,room.height]);
  if(error)return <div className="fp-state" role="alert"><strong>文档暂时无法显示</strong><p>{error}</p></div>;
  if(!pdf)return <div className="fp-state" role="status"><span className="fp-loading"/><p>正在读取页面…</p></div>;
  return <><div className="fp-toolbar"><div className="fp-tools"><button aria-label="页面缩略图" title="页面缩略图" aria-pressed={outline} onClick={()=>setOutline(!outline)}><PreviewIcon name="pages"/></button><button aria-label="上一页" title="上一页" disabled={page===1} onClick={()=>go(page-1)}><PreviewIcon name="left"/></button><input className="fp-page-input" aria-label="页码" inputMode="numeric" value={input} onChange={event=>setInput(event.target.value)} onBlur={()=>go(Number(input))} onKeyDown={event=>{if(event.key==='Enter')go(Number(input));}}/><span className="fp-page-total">/ {pdf.numPages}</span><button aria-label="下一页" title="下一页" disabled={page===pdf.numPages} onClick={()=>go(page+1)}><PreviewIcon name="right"/></button></div><div className="fp-tools"><button aria-label="缩小页面" title="缩小" disabled={scale<=.25} onClick={()=>setZoom(Math.max(.25,scale-.25))}><PreviewIcon name="minus"/></button><output>{Math.round(scale*100)}%</output><button aria-label="放大页面" title="放大" disabled={scale>=3} onClick={()=>setZoom(Math.min(3,scale+.25))}><PreviewIcon name="plus"/></button>{immersive&&<button aria-pressed={zoom===null&&sizing==='fill'} onClick={()=>{setSizing('fill');setZoom(null);}} title={slides?'填满画布':'适应宽度'} aria-label={slides?'填满画布':'适应宽度'}><PreviewIcon name="expand"/></button>}<button aria-pressed={zoom===null&&(!immersive||sizing==='fit')} onClick={()=>{setSizing('fit');setZoom(null);}} title="完整显示" aria-label="完整显示"><PreviewIcon name="fit"/></button></div></div>
    <div className="fp-pdf-layout">{outline&&<nav className="fp-thumbnails" aria-label="页面缩略图">{Array.from({length:pdf.numPages},(_,i)=><Thumbnail key={i+1} pdf={pdf} page={i+1} current={page===i+1} onSelect={()=>go(i+1)}/>)}</nav>}<div ref={viewport} className="fp-pdf-viewport"><div ref={stage} className={`fp-pdf-stage ${slides&&filled?'can-pan':''}`} tabIndex={0} onPointerDown={event=>{if(!slides||!filled||event.button!==0)return;event.preventDefault();drag.current={x:event.clientX,y:event.clientY,left:event.currentTarget.scrollLeft,top:event.currentTarget.scrollTop};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={event=>{const start=drag.current;if(start){event.currentTarget.scrollLeft=start.left-(event.clientX-start.x);event.currentTarget.scrollTop=start.top-(event.clientY-start.y);}}} onPointerUp={()=>{drag.current=undefined;}} onPointerCancel={()=>{drag.current=undefined;}} aria-label={`${name}，使用左右方向键翻页`} onKeyDown={event=>{if(event.key==='ArrowRight'||event.key==='PageDown'){event.preventDefault();go(page+1);}if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();go(page-1);}}}><div className="fp-pdf-space" style={{minWidth:width+padding*2,minHeight:Math.max(room.height,pageSize.height*scale)+padding*2}}><PdfPage pdf={pdf} page={page} width={width} aspectRatio={pageSize.width/pageSize.height}/></div></div></div></div>
    </>;
}
