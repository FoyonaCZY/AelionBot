import {BrowserWindow,nativeImage} from 'electron';
import {randomUUID} from 'node:crypto';
import {DESIGN_PDF_READY_SCRIPT} from './core/design-pdf';
import {CANVAS_SVG_SCRIPT} from './core/canvas-svg';
import {CANVAS_SCENE_SCRIPT,type CanvasScene,type SceneNode} from './core/canvas-scene';
import {buildSketchDocument,type SketchRaster} from './core/sketch-export';
import {canvasExportViewport} from '../src/canvas-export';
export async function renderCanvasExport(html:string,format:'pdf'|'png'|'svg'|'sketch',viewport?:{width:number;height:number},licenses?:Record<string,Buffer>){
 const size=canvasExportViewport(viewport),window=new BrowserWindow({show:false,...size,webPreferences:{sandbox:true,offscreen:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:'canvas-export-'+randomUUID()}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
 const evaluate=(code:string)=>window.webContents.executeJavaScriptInIsolatedWorld(999,[{code}]);
 const exportSession=window.webContents.session,documentUrl='https://canvas-export.invalid/'+randomUUID()+'/index.html';
 // Embedded images/fonts can exceed Chromium's navigation limit when placed in a data URL.
 // This short URL serves only this document, from memory, in an isolated session.
 exportSession.protocol.handle('https',request=>request.url===documentUrl&&request.method==='GET'?new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}):new Response(null,{status:404}));
 exportSession.setPermissionCheckHandler(()=>false);exportSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{
  try{await window.loadURL(documentUrl);}catch(error){const code=(error as {code?:string}).code;throw Error('无法加载导出页面'+(code&&/^ERR_[A-Z_]+$/.test(code)?'（'+code+'）':'')+'，请重试');}
  await evaluate(DESIGN_PDF_READY_SCRIPT);
  if(format==='pdf'){const bytes=Buffer.from(await window.webContents.printToPDF({printBackground:true,preferCSSPageSize:true}));if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('PDF 导出失败');return {bytes,warnings:[] as string[]};}
  if(format==='svg'){const result=await evaluate(CANVAS_SVG_SCRIPT) as {svg:string;warnings:string[]};return {bytes:Buffer.from(result.svg),warnings:result.warnings};}
  await evaluate('document.getAnimations().forEach(animation=>animation.pause());document.querySelectorAll("video").forEach(video=>video.pause())');
  const scene=format==='sketch'?await evaluate(CANVAS_SCENE_SCRIPT) as CanvasScene:undefined;
  const bounds=await evaluate('({width:Math.ceil(Math.max(innerWidth,document.documentElement.scrollWidth,document.body?.scrollWidth||0)),height:Math.ceil(Math.max(innerHeight,document.documentElement.scrollHeight,document.body?.scrollHeight||0))})') as {width:number;height:number};
  if(bounds.width>16000||bounds.height>16000||bounds.width*bounds.height>32000000)throw Error('页面过大，PNG 最多支持 3200 万像素，请使用 PDF 导出');
  window.webContents.debugger.attach('1.3');
  const result=await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,fromSurface:true,clip:{x:0,y:0,...bounds,scale:1}});
  const bytes=Buffer.from(result.data,'base64');if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('PNG 导出失败');
  if(scene){
   const raster=nativeImage.createFromBuffer(bytes),pixels=raster.getSize(),sx=pixels.width/scene.width,sy=pixels.height/scene.height,rasters=new Map<string,SketchRaster>();
   const collect=(nodes:SceneNode[])=>{for(const node of nodes){if(node.kind==='raster'||node.kind==='text'||node.kind==='path'){
     const pad=node.kind==='text'?2:0,x=Math.max(0,Math.floor((node.x-pad)*sx)),y=Math.max(0,Math.floor((node.y-pad)*sy)),right=Math.min(pixels.width,Math.ceil((node.x+node.width+pad)*sx)),bottom=Math.min(pixels.height,Math.ceil((node.y+node.height+pad)*sy));
     if(right>x&&bottom>y)rasters.set(node.id,{bytes:raster.crop({x,y,width:right-x,height:bottom-y}).toPNG(),frame:{x:x/sx,y:y/sy,width:(right-x)/sx,height:(bottom-y)/sy}});
    }if(node.children)collect(node.children);}};collect(scene.nodes);
   const preview=raster.resize({width:Math.max(1,Math.round(pixels.width*Math.min(1,2048/pixels.width,2048/pixels.height))),quality:'best'}).toPNG();
   return buildSketchDocument(scene,{reference:bytes,preview,rasters,licenses});
  }
  return {bytes,warnings:[] as string[]};
 })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('导出超时，请检查页面内容后重试')),45000);})]);}
 finally{if(timer)clearTimeout(timer);if(!window.isDestroyed())window.destroy();exportSession.protocol.unhandle('https');}
}
