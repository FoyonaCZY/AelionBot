import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {StringDecoder} from 'node:string_decoder';
import {Interactions} from './interactions';
import {atomicJson} from './store';
import type {HostWorkspaceSettings} from '../../src/shared';

export interface HostOptions {beforeWrite?:(botId:string,runId:string,path:string)=>unknown;afterWrite?:(record:unknown,path:string,expected?:string)=>void;dataDir:string;projectDir:string;homeDir:string;env?:NodeJS.ProcessEnv;secrets?:()=>string[];}
const forbidden=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
function text(value:unknown,name:string,max:number){if(typeof value!=='string'||!value.trim()||value.length>max||forbidden.test(value))throw new Error(`无效参数：${name}`);return value;}
function aborted(signal:AbortSignal){if(signal.aborted)throw new Error('任务已取消，未执行本机操作');}
export function redactHost(value:string,secrets:string[]=[]){
  let result=stripVTControlCharacters(value).replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{12,})\b/g,'[redacted]').replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,'[redacted private key]');
  for(const secret of secrets.filter(secret=>secret.length>=6).sort((a,b)=>b.length-a.length))result=result.split(secret).join('[redacted]');
  return result.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,'$1[redacted]').replace(/(https?:\/\/[^\s/:]+:)[^\s@]+(@)/gi,'$1[redacted]$2').replace(/((?:"|')?[\w.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\r\n,}]+)/gi,'$1"[redacted]"');
}
export class HostComputer {
  private executions=new Map<number,()=>void>();
  private workspaceOverride?:string;
  private readonly settingsFile:string;
  private readonly defaultWorkspaceDir:string;
  constructor(readonly options:HostOptions,private interactions:Interactions){
    this.settingsFile=join(options.dataDir,'host-settings.json');
    this.defaultWorkspaceDir=resolve(options.homeDir,'Documents','Aelion');
    if(existsSync(this.settingsFile)){
      const saved=JSON.parse(readFileSync(this.settingsFile,'utf8').replace(/^\uFEFF/,''));
      if(saved.version!==1)throw new Error('不支持的本机目录设置版本');
      if(saved.workspaceDir!==undefined)this.workspaceOverride=this.workspacePath(saved.workspaceDir);
    }
  }
  workspaceSettings():HostWorkspaceSettings{return {workspaceDir:this.workspaceOverride||this.defaultWorkspaceDir,defaultWorkspaceDir:this.defaultWorkspaceDir};}
  setWorkspaceDir(value:string){
    const path=this.workspacePath(value);let ancestor=path;
    while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw new Error('工作目录所在位置不可用');ancestor=parent;}
    if(!statSync(ancestor).isDirectory())throw new Error('工作目录必须是文件夹');
    const override=path===this.defaultWorkspaceDir?undefined:path;
    atomicJson(this.settingsFile,{version:1,...(override?{workspaceDir:override}:{})});this.workspaceOverride=override;
  }
  validateWorkspace(value:unknown){const path=this.workspacePath(value);if(!existsSync(path)||!statSync(path).isDirectory())throw new Error('工作目录不存在或不是文件夹');return realpathSync.native(path);}
  resolveFilePath(value:unknown,workspace?:string){const path=text(value,'path',1500);return this.path(isAbsolute(path)?path:resolve(workspace||this.workspaceSettings().workspaceDir,path));}
  private workspacePath(value:unknown){
    const input=text(value,'工作目录',1500).trim();
    const expanded=input==='~'?this.options.homeDir:/^~[\\/]/.test(input)?join(this.options.homeDir,input.slice(2)):input;
    if(!isAbsolute(expanded)||/[\r\n\t<>"|?*]/.test(expanded)||expanded.replace(/^[a-z]:/i,'').includes(':'))throw new Error('请输入有效的绝对目录路径，也可以使用 ~ 表示用户目录');
    return resolve(expanded);
  }
  workspace(botId:string){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId))throw new Error('无效 Bot 工作目录');return this.workspaceSettings().workspaceDir;}
  context(botId:string,workspace?:string){return {platform:process.platform,shell:'PowerShell',homeDir:this.options.homeDir,projectDir:this.options.projectDir,workspace:workspace||this.workspace(botId)};}
  redact(value:string){const env=this.options.env||process.env;return redactHost(value,[...Object.entries(env).filter(([name])=>/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)$/i.test(name)).map(([,value])=>value||''),...(this.options.secrets?.()||[])]);}
  private path(value:unknown){const path=text(value,'path',1500);if(!isAbsolute(path)||/[\r\n\t]/.test(path))throw new Error('本机路径必须是绝对路径');return resolve(path);}
  private canonical(path:string):string {if(existsSync(path))return realpathSync.native(path);const parent=dirname(path);if(parent===path)throw new Error('本机路径不可用');return join(this.canonical(parent),path.slice(parent.length).replace(/^[\\/]+/,''));}
  private stamp(path:string){if(!existsSync(path))return 'missing';const stat=statSync(path);return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;}
  async execute(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    if(process.platform!=='win32')throw new Error('本机命令目前支持 Windows PowerShell');
    const command=text(args.command,'command',6000),reason=text(args.reason,'reason',1000);
    const defaultCwd=workspace||this.workspace(botId),cwd=this.canonical(args.cwd===undefined?defaultCwd:this.path(args.cwd));
    if(args.cwd!==undefined&&(!existsSync(cwd)||!statSync(cwd).isDirectory()))throw new Error('本机工作目录不存在');
    const timeout=args.timeoutMs===undefined?120000:Number(args.timeoutMs);if(!Number.isInteger(timeout)||timeout<100||timeout>120000)throw new Error('超时必须在 100–120000 毫秒之间');
    await this.interactions.permission(botId,runId,{operation:'command',reason,command,cwd},signal);aborted(signal);
    if(this.canonical(cwd)!==cwd)throw new Error('工作目录在确认后发生变化，请重新确认');
    if(args.cwd===undefined)mkdirSync(cwd,{recursive:true});
    const script=`$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$OutputEncoding=[Console]::OutputEncoding\n$global:LASTEXITCODE=0\ntry {\n. {\n${command}\n}\nexit $LASTEXITCODE\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    const env:NodeJS.ProcessEnv={...(this.options.env||process.env),GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0',NO_COLOR:'1',PAGER:'',GH_PAGER:''};
    const systemRoot=env.SystemRoot||env.SYSTEMROOT||'C:\\Windows';
    const shell=join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
    const started=Date.now();
    return await new Promise<{stdout:string;stderr:string;exitCode:number;durationMs:number;cwd:string;location:'host';timedOut:boolean;cancelled:boolean;truncated:boolean}>((resolveResult,reject)=>{
      const child=spawn(shell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='',bytes=0,truncated=false,timedOut=false,cancelled=false,finished=false;
      const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
      const append=(chunk:Buffer,kind:'stdout'|'stderr')=>{const room=Math.max(0,1024*1024-bytes);if(chunk.length>room)truncated=true;const part=decoders[kind].write(chunk.subarray(0,room));bytes+=Math.min(room,chunk.length);if(kind==='stdout')stdout+=part;else stderr+=part;};
      child.stdout.on('data',(chunk:Buffer)=>append(chunk,'stdout'));child.stderr.on('data',(chunk:Buffer)=>append(chunk,'stderr'));
      const stop=()=>{if(finished||cancelled||!child.pid)return;cancelled=true;const killer=spawn(join(systemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>{if(!finished)child.kill();});killer.on('close',code=>{if(code!==0&&!finished)child.kill();});};
      const timer=setTimeout(()=>{if(!cancelled){timedOut=true;stop();}},timeout);const onAbort=()=>stop();
      signal.addEventListener('abort',onAbort,{once:true});if(child.pid)this.executions.set(child.pid,stop);if(signal.aborted)stop();
      const cleanup=()=>{finished=true;clearTimeout(timer);signal.removeEventListener('abort',onAbort);if(child.pid)this.executions.delete(child.pid);};
      child.once('error',error=>{cleanup();reject(new Error(`无法启动本机 PowerShell：${this.redact(error.message)}`));});
      child.once('close',code=>{if(finished)return;cleanup();stdout+=decoders.stdout.end();stderr+=decoders.stderr.end();resolveResult({stdout:this.redact(stdout),stderr:this.redact(stderr)+(timedOut?'\n本机命令超时；操作可能已部分执行，请先核对结果。':cancelled?'\n本机命令已停止；操作可能已部分执行。':''),exitCode:cancelled?-1:code??-1,durationMs:Date.now()-started,cwd,location:'host',timedOut,cancelled:cancelled&&!timedOut,truncated});});
    });
  }
  async readFile(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const path=this.canonical(this.resolveFilePath(args.path,workspace)),reason=text(args.reason,'reason',1000);
    const offset=args.offset===undefined?0:Number(args.offset);if(!Number.isInteger(offset)||offset<0)throw new Error('读取位置无效');
    await this.interactions.permission(botId,runId,{operation:'read_file',reason,path},signal);aborted(signal);
    if(this.canonical(path)!==path)throw new Error('文件位置发生变化，请重新确认');
    const stat=statSync(path);if(!stat.isFile()||stat.size>2*1024*1024)throw new Error('只支持读取 2 MB 以内的文本文件；大文件请使用本机命令按需处理');
    const bytes=readFileSync(path);if(bytes.includes(0))throw new Error('文件不是 UTF-8 文本');
    const full=bytes.toString('utf8'),safe=this.redact(full),content=safe.slice(offset,offset+12000);
    return {path,location:'host',content,offset,nextOffset:offset+content.length,truncated:offset+content.length<safe.length,redacted:safe!==full,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  async writeFile(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const path=this.canonical(this.resolveFilePath(args.path,workspace)),reason=text(args.reason,'reason',1000);
    if(typeof args.content!=='string'||args.content.length>256000)throw new Error('写入内容过长或无效');
    if(args.overwrite!==undefined&&typeof args.overwrite!=='boolean')throw new Error('overwrite 必须是布尔值');
    const content=args.content,overwrite=args.overwrite===true,stamp=this.stamp(path);
    if(stamp!=='missing'&&!overwrite)throw new Error('文件已存在；确认内容后使用 overwrite=true');
    await this.interactions.permission(botId,runId,{operation:'write_file',reason,path,content,overwrite},signal);aborted(signal);
    if(this.canonical(path)!==path||this.stamp(path)!==stamp)throw new Error('文件在确认期间发生变化，请重新确认');
    if(overwrite&&stamp!=='missing'&&content.includes('[redacted')&&statSync(path).size<=2*1024*1024){const original=readFileSync(path,'utf8');if(this.redact(original)!==original)throw new Error('不能把凭据占位符写回原文件，请用本机命令定点修改非敏感字段');}
    mkdirSync(dirname(path),{recursive:true});
    const checkpoint=this.options.beforeWrite?.(botId,runId,path);
    const temporary=join(dirname(path),`.aelion-${randomUUID()}.tmp`);
    try{writeFileSync(temporary,content,{encoding:'utf8',flag:'wx'});aborted(signal);if(this.stamp(path)!==stamp)throw new Error('文件在写入前发生变化，未覆盖');renameSync(temporary,path);}finally{try{unlinkSync(temporary);}catch{}}
    this.options.afterWrite?.(checkpoint,path,content);
    return {path,location:'host',bytes:Buffer.byteLength(content,'utf8'),written:true};
  }
  async listDirectory(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const path=this.canonical(this.resolveFilePath(args.path||workspace||this.workspace(botId),workspace)),reason=text(args.reason,'reason',1000);
    await this.interactions.permission(botId,runId,{operation:'read_file',reason,path},signal);aborted(signal);
    if(this.canonical(path)!==path)throw Error('目录位置发生变化，请重新确认');
    const items=readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));
    return {path,location:'host',items:items.slice(0,250).map(item=>({name:item.name,kind:item.isDirectory()?'directory':item.isSymbolicLink()?'link':'file'})),truncated:items.length>250};
  }
  dispose(){for(const stop of this.executions.values())stop();}
}
