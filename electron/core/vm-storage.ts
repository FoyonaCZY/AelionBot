import {existsSync,readFileSync,readdirSync,lstatSync,renameSync,unlinkSync,statfsSync,openSync,fsyncSync,closeSync,chmodSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {atomicJson} from './store';
import {DEFAULT_VM_STORAGE,vmStorageSettings,type VmStorageSettings,type VmStorageState} from '../../src/vm-storage';
const runFile=promisify(execFile);
interface Saved {settings:VmStorageSettings;paused?:boolean;lastVersion?:string;lastReclaimedBytes?:number;lastReclaimedAt?:string;}
export class VmStorage {
 private saved:Saved;private busy=false;private error?:string;
 constructor(private dir:string,private version:string,private execute:(args:string[])=>Promise<string>){
  const file=join(dir,'storage.json');this.saved=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{settings:{...DEFAULT_VM_STORAGE}};this.saved.settings=vmStorageSettings(this.saved.settings);
 }
 static forQemu(dir:string,version:string,img:string){return new VmStorage(dir,version,async args=>(await runFile(img,args,{windowsHide:true,maxBuffer:2*1024*1024,timeout:30*60*1000})).stdout);}
 private save(){atomicJson(join(this.dir,'storage.json'),this.saved);}
 setSettings(value:unknown){this.saved.settings=vmStorageSettings(value);this.save();}
 setPaused(value:boolean){this.saved.paused=value;this.save();}
 markVersion(version:string){this.saved.lastVersion=version;this.save();}
 get paused(){return Boolean(this.saved.paused);}
 get reclaiming(){return this.busy;}
 get pending(){return this.saved.settings.reclaimAfterUpdate&&this.saved.lastVersion!==this.version;}
 snapshot():VmStorageState{
  const totals={baseBytes:0,systemBytes:0,workBytes:0,otherBytes:0};
  // Conservative accounting includes every VM file, including base image and logs.
  const walk=(directory:string):number=>readdirSync(directory,{withFileTypes:true}).reduce((total,item)=>{const path=join(directory,item.name),stat=lstatSync(path);if(stat.isSymbolicLink())return total;return total+(stat.isDirectory()?walk(path):stat.size);},0);
  for(const item of readdirSync(this.dir,{withFileTypes:true})){const path=join(this.dir,item.name),stat=lstatSync(path);if(stat.isSymbolicLink())continue;const bytes=stat.isDirectory()?walk(path):stat.size;const field=item.name==='base.qcow2'?'baseBytes':item.name==='system.qcow2'?'systemBytes':item.name==='work.qcow2'?'workBytes':'otherBytes';totals[field]+=bytes;}
  return {settings:{...this.saved.settings},...totals,usageBytes:Object.values(totals).reduce((a,b)=>a+b,0),paused:this.paused,reclaiming:this.busy,reclaimPending:this.pending,lastReclaimedBytes:this.saved.lastReclaimedBytes,lastReclaimedAt:this.saved.lastReclaimedAt,error:this.error};
 }
 private path(name:string){if(!/^(system|work)\.qcow2$|^(system|work)\.(compact|previous)-[a-f0-9-]{36}\.qcow2$/.test(name))throw Error('无效回收文件路径');const path=resolve(this.dir,name);if(basename(path)!==name||existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error('回收目标不能是链接');return path;}
 recover(){
  const file=join(this.dir,'storage-transaction.json');if(!existsSync(file))return;
  const value=JSON.parse(readFileSync(file,'utf8'));
  if(!/^(system|work)\.qcow2$/.test(value.original)||!['pending','committed'].includes(value.stage))throw Error('回收记录无效');
  const disk=value.original.split('.')[0],match=new RegExp('^'+disk+'\\.compact-([a-f0-9-]{36})\\.qcow2$').exec(value.candidate);
  if(!match||value.backup!==disk+'.previous-'+match[1]+'.qcow2')throw Error('回收记录路径不匹配');
  const original=this.path(value.original),candidate=this.path(value.candidate),backup=this.path(value.backup);
  if(existsSync(backup)){
   if(value.stage==='committed'&&existsSync(original))unlinkSync(backup);
   else{if(existsSync(original))unlinkSync(original);renameSync(backup,original);}
  }
  if(!existsSync(original))throw Error('原磁盘缺失，已保留回收文件，请勿启动工作电脑');
  if(existsSync(candidate))unlinkSync(candidate);unlinkSync(file);
 }
 async reclaim(assertOffline:()=>void){
  if(this.busy)throw Error('正在回收空间');this.busy=true;this.error=undefined;
  try{
   assertOffline();this.recover();const before=this.snapshot().usageBytes;
   const help=await this.execute(['convert','--help']),backingFlag=/\-b BACKING/.test(help)?'-b':'-B';
   for(const disk of ['system','work']){
    assertOffline();const name=disk+'.qcow2',original=this.path(name);if(!existsSync(original))continue;
    const info=JSON.parse(await this.execute(['info','--output=json',original]));
    if(info.format!=='qcow2'||info.snapshots?.length||info.encrypted||info['format-specific']?.data?.bitmaps?.length)throw Error('此磁盘包含特殊格式、快照或位图，不能自动回收');
    const base=join(this.dir,'base.qcow2');
    if(info['backing-filename']&&resolve(info['full-backing-filename']||resolve(this.dir,info['backing-filename']))!==resolve(base))throw Error('磁盘引用了未知基础镜像');
    if(existsSync(base)&&lstatSync(base).isSymbolicLink())throw Error('基础镜像不能是链接');
    const free=statfsSync(this.dir);if(free.bavail*free.bsize<lstatSync(original).size+128*1024*1024)throw Error('磁盘可用空间不足以创建并校验回收副本，原文件未修改');
    const id=randomUUID(),candidateName=disk+'.compact-'+id+'.qcow2',backupName=disk+'.previous-'+id+'.qcow2',candidate=this.path(candidateName),backup=this.path(backupName);
    await this.execute(['check','-f','qcow2',original]);
    const transaction={original:name,candidate:candidateName,backup:backupName};
    atomicJson(join(this.dir,'storage-transaction.json'),{...transaction,stage:'pending'});
    try{
     await this.execute(['convert','-f','qcow2','-O','qcow2','-t','writethrough','-S','4096',...(info['backing-filename']?[backingFlag,base,'-F','qcow2']:[]),original,candidate]);
     await this.execute(['check','-f','qcow2',candidate]);await this.execute(['compare','-f','qcow2','-F','qcow2',original,candidate]);assertOffline();
     if(lstatSync(candidate).size>=lstatSync(original).size){unlinkSync(candidate);unlinkSync(join(this.dir,'storage-transaction.json'));continue;}
     chmodSync(candidate,lstatSync(original).mode&0o777);const fd=openSync(candidate,'r+');try{fsyncSync(fd);}finally{closeSync(fd);}
     renameSync(original,backup);renameSync(candidate,original);
     atomicJson(join(this.dir,'storage-transaction.json'),{...transaction,stage:'committed'});
     unlinkSync(backup);unlinkSync(join(this.dir,'storage-transaction.json'));
    }catch(error){assertOffline();this.recover();if(existsSync(candidate))unlinkSync(candidate);throw error;}
   }
   const after=this.snapshot().usageBytes;this.saved.lastReclaimedBytes=Math.max(0,before-after);this.saved.lastReclaimedAt=new Date().toISOString();this.saved.lastVersion=this.version;this.save();return this.saved.lastReclaimedBytes;
  }catch(error){this.error=(error as Error).message;throw error;}finally{this.busy=false;}
 }
}