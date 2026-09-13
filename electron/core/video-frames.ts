import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,statSync,lstatSync,readdirSync,mkdirSync,unlinkSync,renameSync} from 'node:fs';
import {basename,join,extname} from 'node:path';
import type {HostComputer} from './host';
import type {Attachments} from './attachments';
import {atomicJson} from './store';
import {videoFrameRequest,type VideoSheet,type VideoFrameRequest} from '../../src/video-frames';
interface CacheEntry {id:string;bytes:number;createdAt:number;sheet:Omit<VideoSheet,'dataUrl'>;}
const MAX_BYTES=128*1024*1024,MAX_FILES=128;
export class VideoFrames {
 private tail:Promise<unknown>=Promise.resolve();private queued=0;
 constructor(private host:HostComputer,private attachments:Attachments,private imageDir:string,private render:(path:string,request:VideoFrameRequest,signal:AbortSignal)=>Promise<VideoSheet>,private retained:()=>Set<string>=()=>new Set()){}
 async inspect(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
  signal.throwIfAborted();if(this.queued>=8)throw Error('视频抽帧队列已满，请稍后重试');this.queued++;
  const pending=this.tail.catch(()=>{}).then(()=>this.run(botId,runId,args,signal,workspace));this.tail=pending;
  void pending.finally(()=>{this.queued--;}).catch(()=>{});
  return new Promise<Awaited<ReturnType<VideoFrames['run']>>>((resolve,reject)=>{const abort=()=>reject(signal.reason||Error('视频抽帧已取消'));signal.addEventListener('abort',abort,{once:true});pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));if(signal.aborted)abort();});
 }
 private async run(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
  signal.throwIfAborted();if(Boolean(args.path)===Boolean(args.attachmentId))throw Error('请提供 path 或 attachmentId，不能同时提供');
  if(typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>1000)throw Error('请说明读取视频的原因');
  const request=videoFrameRequest(args as VideoFrameRequest);
  const source=args.attachmentId?this.attachments.videoReference(botId,String(args.attachmentId)):undefined;
  const path=source?.path||await this.host.videoFile(botId,runId,args,signal,workspace),name=source?.name||basename(path);
  if(!/\.(mp4|webm|mov|m4v|mkv|avi|ogv)$/i.test(name))throw Error('请选择视频文件；推荐 MP4 或 WebM');
  const original=statSync(path);if(!original.isFile()||original.size>4*1024**3)throw Error('视频文件无效或超过 4 GB');
  const signature=()=>{const stat=statSync(path);return [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');},stamp=signature();
  const key=createHash('sha256').update(JSON.stringify([botId,path,stamp,request,'video-sheet-v1'])).digest('hex'),id=key.slice(0,8)+'-'+key.slice(8,12)+'-'+key.slice(12,16)+'-'+key.slice(16,20)+'-'+key.slice(20,32);
  mkdirSync(this.imageDir,{recursive:true});const indexPath=join(this.imageDir,'video-frames-cache.json');let index:CacheEntry[]=[];
  try{const raw=JSON.parse(readFileSync(indexPath,'utf8'));if(Array.isArray(raw))index=raw.filter(e=>/^[a-f0-9-]{36}$/.test(e?.id)&&Number.isFinite(e.bytes)&&e.bytes>=0).slice(0,MAX_FILES);}catch{}
  const cached=index.find(e=>e.id===id),imagePath=join(this.imageDir,id+'.png');
  const output=(sheet:Omit<VideoSheet,'dataUrl'>,cached:boolean)=>({name,durationSeconds:sheet.duration,videoWidth:sheet.videoWidth,videoHeight:sheet.videoHeight,timestamps:sheet.timestamps,frameCount:sheet.timestamps.length,cached,images:[{id,width:sheet.width,height:sheet.height}],note:'这是所列时间点附近的抽样帧，不代表已看完视频。拼图不包含声音；需细看时指定更小的时间范围或 timestamps 再抽帧。'});
  if(cached&&existsSync(imagePath)&&!lstatSync(imagePath).isSymbolicLink()&&statSync(imagePath).size===cached.bytes){signal.throwIfAborted();if(signature()!==stamp)throw Error('视频文件发生变化');return output(cached.sheet,true);}
  const retained=this.retained();let usedBytes=0,fileCount=0;
  for(const entry of readdirSync(this.imageDir)){if(!/^[a-f0-9-]{36}\.png(?:\.tmp)?$/.test(entry))continue;const file=join(this.imageDir,entry),stat=lstatSync(file),fileId=entry.split('.')[0];if(stat.isSymbolicLink())throw Error('视频缓存目录包含无效链接');if(!stat.isFile())continue;if((entry.endsWith('.tmp')||!retained.has(fileId))&&Date.now()-stat.mtimeMs>3600000){unlinkSync(file);continue;}usedBytes+=stat.size;fileCount++;}
  index=index.filter(e=>existsSync(join(this.imageDir,e.id+'.png')));
  if(fileCount>=MAX_FILES||usedBytes>=MAX_BYTES)throw Error('视频拼图缓存已达到上限，请清理不再需要的会话后重试');
  const rendered=await this.render(path,request,signal);signal.throwIfAborted();if(signature()!==stamp)throw Error('抽帧期间原视频发生变化，请重新读取');
  if(!rendered.dataUrl.startsWith('data:image/png;base64,'))throw Error('视频检查器未返回有效拼图');
  const bytes=Buffer.from(rendered.dataUrl.slice('data:image/png;base64,'.length),'base64');if(bytes.length>8*1024*1024||usedBytes+bytes.length>MAX_BYTES)throw Error('视频拼图超过缓存预算');
  const {dataUrl,...sheet}=rendered;const temp=imagePath+'.tmp';try{writeFileSync(temp,bytes,{flag:'wx'});renameSync(temp,imagePath);}finally{if(existsSync(temp))unlinkSync(temp);}index=index.filter(entry=>entry.id!==id);index.push({id,bytes:bytes.length,createdAt:Date.now(),sheet});
  try{atomicJson(indexPath,index);}catch(error){unlinkSync(imagePath);throw error;}
  return output(sheet,false);
 }
}
