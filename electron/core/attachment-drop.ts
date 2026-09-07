import {randomUUID} from 'node:crypto';
import {lstat,open,opendir,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative,sep} from 'node:path';
import {Zip,ZipDeflate,ZipPassThrough} from 'fflate';
import {Attachments,attachmentName} from './attachments';
import {ATTACHMENT_LIMITS,type AttachmentScope,type DroppedAttachment} from '../../src/attachment-types';

export async function directoryAttachment(path:string,expected?:{dev:number;ino:number}){
  const root=await realpath(path),chunks:Uint8Array[]=[];let sourceBytes=0,zipBytes=0,entries=0,issue:Error|undefined,finished=false;
  const rootStat=await lstat(root);if(!rootStat.isDirectory()||expected&&(root!==path||rootStat.dev!==expected.dev||rootStat.ino!==expected.ino))throw Error('拖入的文件夹已变化，请重新拖入');
  const archive=new Zip((error,data,final)=>{if(error){issue=error;return;}zipBytes+=data.length;if(zipBytes>ATTACHMENT_LIMITS.fileBytes)throw Error('文件夹压缩后超过 25 MB，请缩小附件范围');chunks.push(data);finished=final;});
  const walk=async(folder:string,prefix:string,depth:number)=>{
    if(depth>32)throw Error('文件夹层级过深，请缩小附件范围');
    const directory=new ZipPassThrough(prefix+'/');archive.add(directory);directory.push(new Uint8Array(),true);
    const stream=await opendir(folder);
    for await(const entry of stream){
      if(++entries>2000)throw Error('文件夹包含超过 2000 个项目，请缩小附件范围');
      if(/[\\:\u0000-\u001f]/.test(entry.name)||entry.name==='.'||entry.name==='..')throw Error('文件夹包含不支持的文件名');
      const child=join(folder,entry.name),before=await lstat(child),actual=await realpath(child),within=relative(root,actual);
      if(before.isSymbolicLink()||within==='..'||within.startsWith('..'+sep)||isAbsolute(within))throw Error('文件夹包含符号链接，请移除链接后重试');
      if(before.isDirectory()){await walk(child,prefix+'/'+entry.name,depth+1);continue;}
      if(!before.isFile())throw Error('文件夹包含特殊文件，请移除后重试');
      sourceBytes+=before.size;if(sourceBytes>ATTACHMENT_LIMITS.totalBytes)throw Error('文件夹原始内容超过 100 MB，请缩小附件范围');
      const file=await open(child,'r');
      try{
        const current=await file.stat();if(current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||!current.isFile())throw Error('文件夹内容已变化，请重新拖入');
        const zipped=new ZipDeflate(prefix+'/'+entry.name,{level:1});archive.add(zipped);
        let bytes=0;for await(const chunk of file.createReadStream({autoClose:false,highWaterMark:64*1024})){bytes+=chunk.length;if(bytes>before.size)throw Error('文件夹内容已变化，请重新拖入');zipped.push(new Uint8Array(chunk),false);if(issue)throw issue;}
        const after=await file.stat();if(bytes!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('文件夹内容已变化，请重新拖入');zipped.push(new Uint8Array(),true);
      }finally{await file.close();}
    }
  };
  try{await walk(root,attachmentName(root),0);archive.end();if(issue)throw issue;if(!finished)throw Error('文件夹压缩未完成');return {name:attachmentName(root)+'.zip',bytes:Buffer.concat(chunks)};}catch(error){archive.terminate();throw error;}
}

interface Staged extends DroppedAttachment {path:string;scope:AttachmentScope;dev:number;ino:number;expires:number;busy?:boolean;}
export class AttachmentDrops {
  private entries=new Map<string,Staged>();
  constructor(private attachments:Attachments,private workspace:(scope:AttachmentScope,path:string)=>string|null){}
  async prepare(scope:AttachmentScope,paths:string[]):Promise<DroppedAttachment[]>{
    this.attachments.scope(scope);for(const [id,entry] of this.entries)if(entry.expires<Date.now())this.entries.delete(id);
    if(!Array.isArray(paths)||paths.length>10||paths.some(path=>typeof path!=='string'||!isAbsolute(path)))throw Error('一次最多拖入 10 个文件或文件夹');
    if(this.entries.size+paths.length>200)throw Error('待处理的附件过多，请稍后重试');
    const prepared=await Promise.all([...new Set(paths)].map(async value=>{const path=await realpath(value),stat=await lstat(path);if(!stat.isFile()&&!stat.isDirectory())throw Error('请选择普通文件或文件夹');return {id:randomUUID(),name:attachmentName(path),kind:stat.isDirectory()?'directory' as const:'file' as const,path,scope:{...scope},dev:stat.dev,ino:stat.ino,expires:Date.now()+10*60000};}));
    for(const entry of prepared)this.entries.set(entry.id,entry);return prepared.map(({id,name,kind})=>({id,name,kind}));
  }
  async apply(scope:AttachmentScope,ids:string[],action:'attach'|'workspace'){
    this.attachments.scope(scope);if(!['attach','workspace'].includes(action)||!Array.isArray(ids)||!ids.length||ids.length>10||new Set(ids).size!==ids.length)throw Error('附件操作无效');
    const entries=ids.map(id=>{const entry=this.entries.get(id);if(!entry||entry.busy||entry.expires<Date.now()||entry.scope.kind!==scope.kind||entry.scope.id!==scope.id)throw Error('拖入内容已过期或不属于当前会话，请重新拖入');return entry;});
    if(action==='workspace'&&(entries.length!==1||entries[0].kind!=='directory'))throw Error('请选择一个文件夹作为工作目录');
    for(const entry of entries)entry.busy=true;
    try{
      for(const entry of entries){const current=await lstat(entry.path);if(current.isSymbolicLink()||current.dev!==entry.dev||current.ino!==entry.ino)throw Error('拖入内容已变化，请重新拖入');}
      const files:Array<{name:string;bytes:Buffer}>=[];let total=0;
      if(action==='attach')for(const entry of entries){const file=entry.kind==='directory'?await directoryAttachment(entry.path,entry):{name:entry.name,bytes:await this.readFile(entry)};total+=file.bytes.length;if(total>ATTACHMENT_LIMITS.totalBytes)throw Error('附件总大小不能超过 100 MB');files.push(file);}
      const result=action==='workspace'?{attachments:[],workspaceDir:this.workspace(scope,entries[0].path)}:{attachments:this.attachments.importFiles(scope,files)};
      for(const entry of entries)this.entries.delete(entry.id);return result;
    }finally{for(const entry of entries)entry.busy=false;}
  }
  private async readFile(entry:Staged){const file=await open(entry.path,'r');try{const stat=await file.stat();if(stat.dev!==entry.dev||stat.ino!==entry.ino)throw Error('拖入文件已变化，请重新拖入');if(!stat.isFile()||stat.size>ATTACHMENT_LIMITS.fileBytes)throw Error('单个附件不能超过 25 MB');const chunks:Buffer[]=[];let size=0;for await(const chunk of file.createReadStream({autoClose:false,highWaterMark:64*1024})){size+=chunk.length;if(size>ATTACHMENT_LIMITS.fileBytes)throw Error('单个附件不能超过 25 MB');chunks.push(chunk);}const after=await file.stat();if(size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('拖入文件已变化，请重新拖入');return Buffer.concat(chunks);}finally{await file.close();}}
}
