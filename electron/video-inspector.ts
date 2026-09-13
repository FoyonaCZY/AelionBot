import {BrowserWindow} from 'electron';
import {pathToFileURL} from 'node:url';
import {videoSampleTimes,videoFrameRequest,videoFrameLayout,type VideoFrameRequest,type VideoSheet} from '../src/video-frames';

export class VideoInspector {
 private windows=new Set<BrowserWindow>();private closed=false;
 constructor(private pagePath:string){}
 dispose(){this.closed=true;for(const window of this.windows)if(!window.isDestroyed())window.destroy();this.windows.clear();}
 async render(path:string,request:VideoFrameRequest,signal:AbortSignal):Promise<VideoSheet>{
  signal.throwIfAborted();if(this.closed)throw Error('视频检查器已关闭');videoFrameRequest(request);
  const window=new BrowserWindow({show:false,width:320,height:240,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,partition:'aelion-video-inspection'}});this.windows.add(window);
  const close=()=>{if(!window.isDestroyed())window.destroy();};signal.addEventListener('abort',close,{once:true});
  const timeout=setTimeout(close,60000);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  try{
   await window.loadFile(this.pagePath);signal.throwIfAborted();
   const duration=await window.webContents.executeJavaScript(`(async()=>{const video=document.createElement('video');video.muted=true;video.preload='auto';document.body.append(video);window.inspectionVideo=video;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('读取视频元数据超时')),10000);video.onloadeddata=()=>{clearTimeout(timer);resolve()};video.onerror=()=>{clearTimeout(timer);reject(Error('当前解码器无法读取此视频，请使用 MP4 或 WebM'))};video.src=${JSON.stringify(pathToFileURL(path).href)};video.load()});return video.duration})()`);
   const timestamps=videoSampleTimes(duration,request),layout=videoFrameLayout(timestamps.length,request.frameWidth);
   const result=await window.webContents.executeJavaScript(`(async()=>{
    const video=window.inspectionVideo,times=${JSON.stringify(timestamps)},{columns,rows,tileWidth,tileHeight}=${JSON.stringify(layout)},pictureHeight=tileHeight-22;
    const canvas=document.createElement('canvas');canvas.width=columns*tileWidth;canvas.height=rows*tileHeight;const ctx=canvas.getContext('2d');ctx.fillStyle='#16191f';ctx.fillRect(0,0,canvas.width,canvas.height);
    const labels=[];
    for(let i=0;i<times.length;i++){
     if(Math.abs(video.currentTime-times[i])>.001)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('视频定位超时')),8000);video.onseeked=()=>{clearTimeout(timer);resolve()};video.onerror=()=>{clearTimeout(timer);reject(Error('视频帧解码失败'))};video.currentTime=times[i]});
     const x=(i%columns)*tileWidth,y=Math.floor(i/columns)*tileHeight,scale=Math.min(tileWidth/video.videoWidth,pictureHeight/video.videoHeight),w=video.videoWidth*scale,h=video.videoHeight*scale;
     ctx.drawImage(video,x+(tileWidth-w)/2,y+(pictureHeight-h)/2,w,h);const ms=Math.round(times[i]*1000),hours=Math.floor(ms/3600000),minutes=Math.floor(ms/60000)%60,seconds=Math.floor(ms/1000)%60;const label=[hours,minutes,seconds].map(n=>String(n).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');ctx.fillStyle='#ffffff';ctx.font='13px sans-serif';ctx.fillText((i+1)+'  '+label,x+9,y+tileHeight-7);labels.push(times[i]);
    }
    return {dataUrl:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height,duration:video.duration,videoWidth:video.videoWidth,videoHeight:video.videoHeight,timestamps:labels};
   })()`);
   signal.throwIfAborted();return result;
  }catch(error){signal.throwIfAborted();throw Error(window.isDestroyed()?'视频抽帧超时或检查器已关闭':(error as Error).message);}
  finally{clearTimeout(timeout);signal.removeEventListener('abort',close);close();this.windows.delete(window);}
 }
}
