import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync,statSync} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import type {BackgroundProcess} from '../../src/process-types';
import type {Store} from './store';
import {VmController,shQuote} from './vm';
import type {HostComputer} from './host';
import type {Interactions} from './interactions';
import {backoff} from './model';
import {vmPython} from './vm-python';
const LIMIT=2*1024*1024;
// The supervisor owns the child handle; stopping uses a per-job flag, never an unverified persisted PID.
export const HOST_SUPERVISOR=String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const dir=__dirname,cfg=JSON.parse(fs.readFileSync(path.join(dir,'input.json'),'utf8'));let total=0,stopped=false;
const state=value=>{const file=path.join(dir,'status.json');fs.writeFileSync(file+'.tmp',JSON.stringify({...value,heartbeat:Date.now()}));fs.renameSync(file+'.tmp',file);};
const script="$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$global:LASTEXITCODE=0\ntry { . {\n"+cfg.command+"\n}; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
const child=cp.spawn(cfg.shell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:cfg.cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:undefined,GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0'}});
const log=bytes=>{if(total<2097152){const part=bytes.subarray(0,2097152-total);fs.appendFileSync(path.join(dir,'output.log'),part);total+=part.length;}};
child.stdout.on('data',log);child.stderr.on('data',log);state({status:'running'});
const timer=setInterval(()=>{state({status:'running'});if(!stopped&&fs.existsSync(path.join(dir,'stop'))){stopped=true;const killer=cp.spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}},1000);
const finish=(code,error)=>{clearInterval(timer);state({status:stopped?'stopped':error||code!==0?'failed':'completed',exitCode:code,endedAt:new Date().toISOString(),error});};
child.on('error',e=>finish(null,e.message));child.on('close',code=>finish(code));
`;
export const VM_SUPERVISOR=String.raw`
import json,sys,pathlib,subprocess,time,os,signal,threading
root=pathlib.Path(sys.argv[1]); cfg=json.loads((root/'input.json').read_text()); count=0; stopped=False
def save(value):
    value['heartbeat']=int(time.time()*1000); p=root/'status.tmp'; p.write_text(json.dumps(value)); p.replace(root/'status.json')
child=subprocess.Popen(['/bin/bash','-lc',cfg['command']],cwd=cfg['cwd'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
def output():
    global count
    with (root/'output.log').open('ab') as log:
        while True:
            data=child.stdout.read1(4096)
            if not data: break
            if count<2097152:
                data=data[:2097152-count]; log.write(data); log.flush(); count+=len(data)
thread=threading.Thread(target=output,daemon=True);thread.start()
while child.poll() is None:
    save({'status':'running'})
    if (root/'stop').exists() and not stopped:
        stopped=True
        try: os.killpg(child.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        try: child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
    time.sleep(.3)
thread.join(timeout=3);save({'status':'stopped' if stopped else 'completed' if child.returncode==0 else 'failed','exitCode':child.returncode,'endedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})
`;
export class BackgroundProcesses {
 constructor(private store:Store,private vm:VmController,private host?:HostComputer,private interactions?:Interactions){store.data.processes||=[];}
 private get(botId:string,id:string){const record=this.store.data.processes!.find(p=>p.botId===botId&&p.id===id);if(!record||!/^[a-f0-9-]{36}$/.test(id))throw Error('进程不存在或不属于当前 Bot');return record;}
 private dir(record:BackgroundProcess){return join(this.store.dir,'processes',record.botId,record.id);}
 private async vmScript(record:BackgroundProcess,script:string,signal:AbortSignal,input?:unknown){const result=input===undefined?await this.vm.execute('python3 -c '+shQuote(script),record.botId,signal):await vmPython(this.vm,record.botId,input,script,signal);if(result.exitCode!==0)throw Error(result.stderr||result.stdout||'后台进程操作失败');try{return JSON.parse(result.stdout);}catch{throw Error('后台进程返回无效状态');}}
 async start(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
  const command=typeof args.command==='string'?args.command.trim():'',location=args.location==='host'?'host':'vm',purpose=args.purpose==='service'?'service':'task';if(!command||command.length>32000)throw Error('进程命令为空或过长');
  if(this.store.data.processes!.filter(p=>p.botId===botId&&['starting','running','unknown'].includes(p.status)).length>=8)throw Error('当前 Bot 最多保留 8 个未结束进程，请先检查并停止旧进程');
  let cwd=`/work/${botId}`;
  if(location==='host'){
   if(!this.host||!this.interactions)throw Error('本机命令未启用');if(command.length>6000)throw Error('本机命令最长 6000 字符');
   const requested=args.cwd||workspace||this.host.workspace(botId);if(typeof requested!=='string'||!isAbsolute(requested)||!existsSync(requested)||!statSync(requested).isDirectory())throw Error('本机后台任务需要存在的绝对工作目录');cwd=realpathSync.native(requested);
   if(typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>1000)throw Error('本机后台任务需要操作原因');
   await this.interactions.permission(botId,runId,{operation:'command',reason:args.reason,command,cwd},signal);signal.throwIfAborted();if(realpathSync.native(requested)!==cwd)throw Error('工作目录在确认后变化');
  }
  const record:BackgroundProcess={id:randomUUID(),botId,runId,location,purpose,command:this.host?.redact(command)||command,cwd,createdAt:new Date().toISOString(),status:'starting'};this.store.data.processes!.push(record);this.store.save();
  try{
   if(location==='host'){
    const dir=this.dir(record);mkdirSync(dir,{recursive:true});const shell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    writeFileSync(join(dir,'input.json'),JSON.stringify({command,cwd,shell}),{mode:0o600});writeFileSync(join(dir,'runner.cjs'),HOST_SUPERVISOR,{mode:0o600});
    signal.throwIfAborted();const child=spawn(process.execPath,[join(dir,'runner.cjs')],{windowsHide:true,detached:true,stdio:'ignore',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
   }else{
    const launched=await this.vmScript(record,`import pathlib,json,subprocess,sys; root=pathlib.Path.cwd().resolve(); d=root/'.aelion-processes'/a['id']; d.mkdir(parents=True,exist_ok=False); (d/'input.json').write_text(json.dumps(a)); (d/'runner.py').write_text(a['runner']); p=subprocess.Popen([sys.executable,str(d/'runner.py'),str(d)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True); print(json.dumps({'started':True,'bootId':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}))`,signal,{id:record.id,cwd,command,runner:VM_SUPERVISOR});
    if(!/^[a-f0-9-]{36}$/.test(launched.bootId))throw Error('无法核对工作电脑启动标识');record.vmBootId=launched.bootId;
   }
   record.status='running';this.store.save();return {...record,started:true,note:'启动成功不代表任务完成；请用 process_wait 核对退出状态与日志。'};
  }catch(error){record.status='unknown';this.store.save();throw Object.assign(new Error((error as Error).message),{outcomeUnknown:true});}
 }
 async status(botId:string,id:string,signal:AbortSignal,offset=0){
  const record=this.get(botId,id);if(!Number.isInteger(offset)||offset<0||offset>LIMIT)throw Error('日志位置无效');let data:any;
  if(record.location==='host'){
   const dir=this.dir(record);try{data=JSON.parse(readFileSync(join(dir,'status.json'),'utf8'));}catch{data={status:Date.now()-Date.parse(record.createdAt)<10000?'starting':'unknown'};}
   const log=existsSync(join(dir,'output.log'))?readFileSync(join(dir,'output.log')):Buffer.alloc(0);data={...data,output:log.subarray(offset,offset+12000).toString('utf8'),nextOffset:Math.min(log.length,offset+12000),truncated:log.length>=LIMIT};
  }else data=await this.vmScript(record,`import pathlib,json,time; d=pathlib.Path.cwd()/'.aelion-processes'/'${id}'; p=d/'status.json'; s=json.loads(p.read_text()) if p.exists() else {'status':'starting'}; boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(); s['status']='stopped' if ${JSON.stringify(record.vmBootId||'')} and boot!=${JSON.stringify(record.vmBootId||'')} else s['status']; s['ageMs']=time.time()*1000-s.get('heartbeat',time.time()*1000); p=d/'output.log'; b=p.read_bytes() if p.exists() else b''; s.update(output=b[${offset}:${offset+12000}].decode('utf-8','replace'),nextOffset=min(len(b),${offset+12000}),truncated=len(b)>=${LIMIT}); print(json.dumps(s))`,signal);
  if(data.status==='running'&&Number(data.ageMs??Date.now()-Number(data.heartbeat))>10000||data.status==='starting'&&Date.now()-Date.parse(record.createdAt)>10000)data.status='unknown';record.status=['starting','running','completed','failed','stopped','unknown'].includes(data.status)?data.status:'unknown';record.exitCode=data.exitCode;record.endedAt=data.endedAt;this.store.save();return {...record,...data,output:this.host?.redact(data.output||'')||data.output||''};
 }
 async wait(botId:string,id:string,signal:AbortSignal,milliseconds=10000,offset=0){const until=Date.now()+Math.min(30000,Math.max(0,milliseconds));let result;do{result=await this.status(botId,id,signal,offset);if(!['starting','running'].includes(result.status)||Date.now()>=until)return result;await backoff(Math.min(500,until-Date.now()),signal);}while(true);}
 async stop(botId:string,id:string,signal:AbortSignal){const record=this.get(botId,id),current=await this.status(botId,id,signal);if(['completed','failed','stopped'].includes(current.status))return current;
  if(record.location==='host'){const dir=this.dir(record);if(!existsSync(dir))throw Error('进程工作目录已不存在');writeFileSync(join(dir,'stop'),'stop');}
  else await this.vmScript(record,`import pathlib,json; d=pathlib.Path.cwd()/'.aelion-processes'/'${id}'; assert d.is_dir(); (d/'stop').write_text('stop'); print(json.dumps({'stopRequested':True}))`,signal);
  return this.wait(botId,id,signal,5000);
 }
 list(botId:string,runId?:string){return this.store.data.processes!.filter(p=>p.botId===botId&&(!runId||p.runId===runId));}
}
