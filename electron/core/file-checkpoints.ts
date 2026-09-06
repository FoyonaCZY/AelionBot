import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync,statSync,unlinkSync} from 'node:fs';
import {join,dirname,resolve,isAbsolute} from 'node:path';
import type {Store} from './store';
import {VmController,shQuote} from './vm';
import type {Interactions} from './interactions';
import {RunPolicy} from './runtime-policy';
import {vmPython} from './vm-python';
export interface FileCheckpoint {id:string;botId:string;runId:string;location:'host'|'vm';path:string;beforeHash:string|null;afterHash?:string|null;createdAt:string;restoredAt?:string;}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const safeId=(id:string)=>/^[a-zA-Z0-9_-]{1,80}$/.test(id);
export class FileCheckpoints {
 constructor(private store:Store,private vm:VmController,private interactions?:Interactions){store.data.fileCheckpoints||=[];}
 private backup(record:FileCheckpoint){return join(this.store.dir,'file-checkpoints',record.id+'.bin');}
 private capture(botId:string,runId:string,location:FileCheckpoint['location'],path:string,bytes:Buffer|null){
  this.store.bot(botId);if(bytes&&bytes.length>2*1024*1024)throw Error('检查点只支持 2 MB 内的单个文件');const record:FileCheckpoint={id:randomUUID(),botId,runId,location,path,beforeHash:bytes?hash(bytes):null,createdAt:new Date().toISOString()};
  if(bytes){const file=this.backup(record);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,bytes,{mode:0o600,flag:'wx'});}this.store.data.fileCheckpoints!.push(record);this.store.save();return record;
 }
 hostBefore(botId:string,runId:string,path:string){if(!new RunPolicy(this.store).settings().fileCheckpoints)return;if(!isAbsolute(path)||existsSync(path)&&realpathSync.native(path)!==path)throw Error('检查点文件路径已变化');if(existsSync(path)&&(!statSync(path).isFile()||statSync(path).size>2*1024*1024))throw Error('文件超过检查点大小限制');return this.capture(botId,runId,'host',path,existsSync(path)?readFileSync(path):null);}
 hostAfter(record:unknown,path:string,expected?:string){if(!record)return;const item=record as FileCheckpoint;if(item.path!==path)throw Error('检查点目标不一致');item.afterHash=expected===undefined?(existsSync(path)?hash(readFileSync(path)):null):hash(Buffer.from(expected,'utf8'));this.store.save();}
 private async vmRead(botId:string,path:string,signal:AbortSignal){
  if(!safeId(botId))throw Error('无效 Bot');const payload=Buffer.from(JSON.stringify({path})).toString('base64');
  const result=await this.vm.execute(`python3 -c ${shQuote(`import pathlib,base64,json; a=json.loads(base64.b64decode('${payload}')); root=pathlib.Path.cwd().resolve(); p=(root/a['path']).resolve(); assert p.is_relative_to(root), 'path escapes workspace'; assert not p.exists() or p.is_file() and p.stat().st_size<=2097152, 'checkpoint size limit'; print(json.dumps({'path':str(p),'content':base64.b64encode(p.read_bytes()).decode() if p.exists() else None}))`)}`,botId,signal,3*1024*1024);
  if(result.exitCode!==0)throw Error(result.stderr||'读取检查点失败');const data=JSON.parse(result.stdout);return {path:data.path as string,bytes:data.content===null?null:Buffer.from(data.content,'base64')};
 }
 async vmBefore(botId:string,runId:string,path:string,signal:AbortSignal){if(!new RunPolicy(this.store).settings().fileCheckpoints)return;const read=await this.vmRead(botId,path,signal);return this.capture(botId,runId,'vm',read.path,read.bytes);}
 async vmAfter(record:FileCheckpoint|undefined,signal:AbortSignal,expected?:string){if(!record)return;const current=await this.vmRead(record.botId,record.path,signal);record.afterHash=expected===undefined?(current.bytes?hash(current.bytes):null):hash(Buffer.from(expected,'utf8'));this.store.save();if(expected!==undefined&&(!current.bytes||hash(current.bytes)!==record.afterHash))throw Error('文件在写入后发生变化，检查点不会覆盖之后的修改');}
 list(botId:string){return this.store.data.fileCheckpoints!.filter(c=>c.botId===botId).slice(-100);}
 async restore(botId:string,id:string,signal:AbortSignal,runId:string){
  const record=this.store.data.fileCheckpoints!.find(c=>c.botId===botId&&c.id===id);if(!record||!/^[a-f0-9-]{36}$/.test(id))throw Error('检查点不存在或无权访问');if(record.restoredAt||record.afterHash===undefined)throw Error('检查点未封存或已经恢复，请先核对实际文件');
  const bytes=record.beforeHash===null?null:readFileSync(this.backup(record));if(bytes&&hash(bytes)!==record.beforeHash)throw Error('检查点副本已变化');
  if(record.location==='host'){
   const matches=()=>{const exists=existsSync(record.path);if(exists&&realpathSync.native(record.path)!==record.path)throw Error('文件路径已变化');return exists?hash(readFileSync(record.path)):null;};
   if(matches()!==record.afterHash)throw Error('文件在任务之后被修改，不能用旧检查点覆盖');if(!this.interactions)throw Error('恢复本机文件需要用户确认');
   await this.interactions.permission(botId,runId,{operation:'write_file',reason:bytes?'恢复这个文件的检查点':'撤销这个任务新建的文件',path:record.path,content:bytes?.toString('utf8')||'',overwrite:true},signal);signal.throwIfAborted();if(matches()!==record.afterHash)throw Error('文件在确认期间发生变化');
   if(bytes)writeFileSync(record.path,bytes);else if(existsSync(record.path))unlinkSync(record.path);
  }else {
   const script=`import pathlib,json,base64,hashlib; root=pathlib.Path.cwd().resolve(); p=(root/a['path']).resolve(); assert p.is_relative_to(root), 'path escapes workspace'; current=hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None; assert current==a['expected'], 'file changed after task'; `+(bytes?`p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(base64.b64decode(a['content'])); `:`p.unlink(missing_ok=True); `)+`print(json.dumps({'restored':True}))`;
   const result=await vmPython(this.vm,botId,{path:record.path,content:bytes?.toString('base64')??null,expected:record.afterHash},script,signal);if(result.exitCode!==0)throw Error(result.stderr||'恢复失败');
  }
  record.restoredAt=new Date().toISOString();this.store.save();return {restored:true,path:record.path,checkpointId:id};
 }
}
