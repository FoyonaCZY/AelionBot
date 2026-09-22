import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,statSync,lstatSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute,join,basename} from 'node:path';
import type {Store} from './store';
import type {DesignStore} from './design-store';
import type {DesignSession} from '../../src/designer-types';
import type {WorkspaceDirectory} from '../../src/workspace-files';
import type {TextEdit} from '../../src/editable-text';
import {editableText,editedBytes} from './preview-editing';

const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+String.fromCharCode(92))&&!rel.startsWith('../');};
function canonical(path:string):string{if(existsSync(path))return realpathSync.native(path);const parent=dirname(path);if(parent===path)throw Error('本机设计目录不可用');return join(canonical(parent),basename(path));}
function relativeFile(value:string){if(typeof value!=='string'||value.length>1500||value.includes('\0')||/[\r\n]/.test(value))throw Error('无效设计文件路径');return value.replaceAll('\\','/');}
export function createDesignerDirectory(base:string,botId:string,taskId:string){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId)||!/^[a-f0-9-]{36}$/.test(taskId))throw Error('无效设计工作区');const root=canonical(resolve(base)),folder=join(root,'designers',botId,taskId);if(!inside(root,canonical(folder)))throw Error('设计目录链接越过默认工作目录');mkdirSync(folder,{recursive:true});return realpathSync.native(folder);}
/** Virtual paths keep existing file trees and preview routes; all bytes live on the host. */
export class DesignerFiles {
 constructor(private store:Store,private designs:DesignStore){}
 hostPath(botId:string,path:string){return this.absolute(this.find(botId,path),path);}
 preserve(session:DesignSession,path:string,bytes:Buffer){const target=this.absolute(session,path);if(existsSync(target)){if(!readFileSync(target).equals(bytes))throw Error('已有文件被修改，未覆盖：'+path);return {path:this.virtual(session,path),absolutePath:target,bytes:bytes.length,reused:true};}return this.write(session,path,bytes,null);}
 owns(botId:string,path:string){return this.designs.data.sessions.some(s=>s.botId===botId&&s.location==='host'&&(path===s.workspacePath||path.startsWith(s.workspacePath+'/')));}
 private find(botId:string,path:string){this.store.bot(botId);const session=this.designs.data.sessions.find(s=>s.botId===botId&&s.location==='host'&&(path===s.workspacePath||path.startsWith(s.workspacePath+'/')));if(!session)throw Error('设计文件不属于当前 Bot 的本机任务');return session;}
 absolute(session:DesignSession,input:string,allowRoot=false){
  if(session.location!=='host'||!session.workspaceDir)throw Error('这是旧版 VM 任务，请新建本机设计任务；原文件与记录仍保留');
  const root=resolve(session.workspaceDir),value=relativeFile(input);if(value.startsWith('designers/')&&value!==session.workspacePath&&!value.startsWith(session.workspacePath+'/'))throw Error('不能访问其他设计任务的路径');if(value.replace(/^[a-z]:/i,'').includes(':'))throw Error('不支持文件数据流路径');const path=isAbsolute(value)?resolve(value):resolve(root,value===session.workspacePath?'':value.startsWith(session.workspacePath+'/')?value.slice(session.workspacePath.length+1):value);
  if(!inside(root,path)||!inside(root,canonical(path))||!allowRoot&&path===root)throw Error('文件必须位于当前设计任务目录');
  if(canonical(root)!==root)throw Error('设计任务目录链接已改变，请核对工作目录');return path;
 }
 virtual(session:DesignSession,input:string){return session.workspacePath+'/'+relative(session.workspaceDir!,this.absolute(session,input)).replaceAll('\\','/');}
 async read(botId:string,path:string,maxBytes=25*1024*1024){const session=this.find(botId,path),file=this.absolute(session,path);const stat=statSync(file);if(!stat.isFile()||stat.size>maxBytes)throw Error('设计文件不存在或超过读取限制');const bytes=readFileSync(file);if(bytes.length>maxBytes)throw Error('设计文件超过读取限制');return bytes;}
 write(session:DesignSession,input:string,bytes:Buffer,expected?:string|null){
  const path=this.absolute(session,input);mkdirSync(dirname(path),{recursive:true});this.absolute(session,path);const current=existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null;if(expected!==undefined&&current!==expected)throw Error('文件已被修改，未覆盖原文件');
  const temp=path+'.aelion-'+randomUUID()+'.tmp';try{writeFileSync(temp,bytes,{flag:'wx'});this.absolute(session,path);const next=existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null;if(next!==current)throw Error('文件在保存期间被修改，未覆盖');renameSync(temp,path);}finally{if(existsSync(temp))unlinkSync(temp);}return {path:this.virtual(session,path),absolutePath:path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
 }
 async readEditable(botId:string,path:string){return editableText(await this.read(botId,path,8*1024*1024),path);}
 async saveEditable(botId:string,path:string,edit:TextEdit){const session=this.find(botId,path),source=await this.read(botId,path,8*1024*1024),current=editableText(source,path);if(current.revision!==edit.revision)throw Error('文件已被其他操作修改，未覆盖原文件。请保留草稿或重新加载后再编辑。');const bytes=editedBytes(edit.content,source);this.write(session,path,bytes,createHash('sha256').update(source).digest('hex'));return editableText(bytes,path);}
 async directory(botId:string,path=''):Promise<WorkspaceDirectory>{
  this.store.bot(botId);if(!path)return {path:'',entries:this.designs.data.sessions.filter(s=>s.botId===botId&&s.location==='host').map(s=>({name:s.title,path:s.workspacePath,kind:'directory' as const,size:0,modifiedAt:s.updatedAt})),truncated:false};
  const session=this.find(botId,path),folder=this.absolute(session,path,true);if(!statSync(folder).isDirectory())throw Error('设计目录不存在');const entries=[];
  for(const entry of readdirSync(folder,{withFileTypes:true})){if(entry.isSymbolicLink()||entry.name.startsWith('.')||['node_modules','__pycache__'].includes(entry.name))continue;const file=this.absolute(session,join(folder,entry.name)),stat=statSync(file);if(!stat.isFile()&&!stat.isDirectory())continue;entries.push({name:entry.name,path:this.virtual(session,file),kind:stat.isDirectory()?'directory' as const:'file' as const,size:stat.isFile()?stat.size:0,modifiedAt:stat.mtime.toISOString()});if(entries.length>500)break;}
  entries.sort((a,b)=>Number(a.kind==='file')-Number(b.kind==='file')||a.name.localeCompare(b.name));return {path,entries:entries.slice(0,500),truncated:entries.length>500};
 }
 async list(botId:string,sessionId?:string){const files:Array<{name:string;path:string;size:number;modifiedAt:string}>=[];const visit=async(path:string,depth:number)=>{if(depth>5||files.length>=300)return;const page=await this.directory(botId,path);for(const e of [...page.entries].sort((a,b)=>Number(a.kind==='directory')-Number(b.kind==='directory'))){if(e.kind==='directory')await visit(e.path,depth+1);else files.push({name:e.name,path:e.path,size:e.size,modifiedAt:e.modifiedAt});if(files.length>=300)break;}};for(const session of this.designs.data.sessions.filter(s=>s.botId===botId&&s.location==='host'&&(!sessionId||s.id===sessionId)))if(existsSync(session.workspaceDir!))await visit(session.workspacePath,0);return files;}
}
