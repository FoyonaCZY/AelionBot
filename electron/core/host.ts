import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,statSync,writeFileSync,renameSync,unlinkSync,linkSync,chmodSync,copyFileSync,constants,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {Interactions} from './interactions';
import {atomicJson} from './store';
import type {HostWorkspaceSettings,ScreenReference} from '../../src/shared';
import {hostEnvironment,hostShell,shellName,stopHostProcess} from './host-platform';
import {boundedInteger,decodeText,editText,expectedHash,filesystemError,FileToolError,textPage,TEXT_FILE_LIMIT} from './file-text';
import {redactHost} from './host-redaction';
import {FileSearch} from './file-search';
import type {FileSearchRequest} from './file-search-types';
import {BoundedOutput} from './bounded-output';
export {redactHost} from './host-redaction';

export interface HostOptions {imagePreview?:(bytes:Buffer,id:string)=>ScreenReference|undefined;beforeWrite?:(botId:string,runId:string,path:string)=>unknown;afterWrite?:(record:unknown,path:string,expected?:string|null)=>void;dataDir:string;projectDir:string;homeDir:string;runtimeDir?:string;env?:NodeJS.ProcessEnv;secrets?:()=>string[];}
const forbidden=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
function text(value:unknown,name:string,max:number){if(typeof value!=='string'||!value.trim()||value.length>max||forbidden.test(value))throw new Error(`无效参数：${name}`);return value;}
function aborted(signal:AbortSignal){if(signal.aborted)throw new Error('任务已取消，未执行本机操作');}
export class HostComputer {
  private executions=new Map<number,()=>void>();
  private workspaceOverride?:string;
  private readonly settingsFile:string;
  private readonly defaultWorkspaceDir:string;
  private readonly searches:FileSearch;
  constructor(readonly options:HostOptions,private interactions:Interactions){
    this.searches=new FileSearch(options.runtimeDir);
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
    if(!isAbsolute(expanded)||/[\r\n\t\0]/.test(expanded)||process.platform==='win32'&&(/[<>"|?*]/.test(expanded)||expanded.replace(/^[a-z]:/i,'').includes(':')))throw new Error('请输入有效的绝对目录路径，也可以使用 ~ 表示用户目录');
    return resolve(expanded);
  }
  workspace(botId:string){if(!/^[a-zA-Z0-9_-]{1,80}$/.test(botId))throw new Error('无效 Bot 工作目录');return this.workspaceSettings().workspaceDir;}
  context(botId:string,workspace?:string){return {platform:process.platform,shell:shellName(),homeDir:this.options.homeDir,projectDir:this.options.projectDir,workspace:workspace||this.workspace(botId)};}
  private secrets(){const env=this.options.env||process.env;return [...Object.entries(env).filter(([name])=>/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)$/i.test(name)).map(([,value])=>value||''),...(this.options.secrets?.()||[])];}
  redact(value:string,preserveLines=false){return redactHost(value,this.secrets(),preserveLines);}
  private path(value:unknown){const path=text(value,'path',1500);if(!isAbsolute(path)||/[\r\n\t]/.test(path))throw new Error('本机路径必须是绝对路径');return resolve(path);}
  private canonical(path:string):string {if(existsSync(path))return realpathSync.native(path);const parent=dirname(path);if(parent===path)throw new Error('本机路径不可用');return join(this.canonical(parent),path.slice(parent.length).replace(/^[\\/]+/,''));}
  private stamp(path:string){if(!existsSync(path))return 'missing';const stat=statSync(path);return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;}
  async execute(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const command=text(args.command,'command',6000),reason=text(args.reason,'reason',1000);
    const defaultCwd=workspace||this.workspace(botId),cwd=this.canonical(args.cwd===undefined||args.cwd===''?defaultCwd:this.resolveFilePath(args.cwd,defaultCwd));
    if(args.cwd!==undefined&&(!existsSync(cwd)||!statSync(cwd).isDirectory()))throw new Error('本机工作目录不存在');
    const timeout=args.timeoutMs===undefined?120000:Number(args.timeoutMs);if(!Number.isInteger(timeout)||timeout<100||timeout>120000)throw new Error('超时必须在 100–120000 毫秒之间');
    await this.interactions.permission(botId,runId,{operation:'command',reason,command,cwd},signal);aborted(signal);
    if(this.canonical(cwd)!==cwd)throw new Error('工作目录在确认后发生变化，请重新确认');
    if(args.cwd===undefined)mkdirSync(cwd,{recursive:true});
    const env=hostEnvironment(this.options.env||process.env),shell=hostShell(command,env);
    const started=Date.now();
    return await new Promise<{stdout:string;stderr:string;exitCode:number;durationMs:number;cwd:string;location:'host';timedOut:boolean;cancelled:boolean;truncated:boolean;stdoutBytes:number;stderrBytes:number;omittedBytes:number}>((resolveResult,reject)=>{
      const child=spawn(shell.executable,shell.args,{cwd,env,detached:shell.detached,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let timedOut=false,cancelled=false,finished=false;const stdout=new BoundedOutput(),stderr=new BoundedOutput();
      child.stdout.on('data',(chunk:Buffer)=>stdout.push(chunk));child.stderr.on('data',(chunk:Buffer)=>stderr.push(chunk));
      const stop=()=>{if(finished||cancelled||!child.pid)return;cancelled=true;stopHostProcess(child,env);};
      const timer=setTimeout(()=>{if(!cancelled){timedOut=true;stop();}},timeout);const onAbort=()=>stop();
      signal.addEventListener('abort',onAbort,{once:true});if(child.pid)this.executions.set(child.pid,stop);if(signal.aborted)stop();
      const cleanup=()=>{finished=true;clearTimeout(timer);signal.removeEventListener('abort',onAbort);if(child.pid)this.executions.delete(child.pid);};
      child.once('error',error=>{cleanup();reject(new Error(`无法启动本机 ${shellName()}：${this.redact(error.message)}`));});
      child.once('close',code=>{if(finished)return;cleanup();const secrets=this.secrets(),out=stdout.result(text=>this.redact(text),secrets),err=stderr.result(text=>this.redact(text),secrets);resolveResult({stdout:out.text,stderr:err.text+(timedOut?'\n本机命令超时；操作可能已部分执行，请先核对结果。':cancelled?'\n本机命令已停止；操作可能已部分执行。':''),exitCode:cancelled?-1:code??-1,durationMs:Date.now()-started,cwd,location:'host',timedOut,cancelled:cancelled&&!timedOut,truncated:out.truncated||err.truncated,stdoutBytes:out.totalBytes,stderrBytes:err.totalBytes,omittedBytes:out.omittedBytes+err.omittedBytes});});
    });
  }
  async readFile(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const path=this.canonical(this.resolveFilePath(args.path,workspace)),reason=text(args.reason,'reason',1000);
    const range={offset:args.offset,startLine:args.startLine,lineCount:args.lineCount,maxChars:args.maxChars,withLineNumbers:args.withLineNumbers};textPage('',range);
    await this.interactions.permission(botId,runId,{operation:'read_file',reason,path},signal);aborted(signal);
    try{
      if(this.canonical(path)!==path)throw new Error('文件位置发生变化，请重新确认');
      const stat=statSync(path);if(!stat.isFile())throw new FileToolError('IS_DIRECTORY','这是目录，请使用 host_list_directory');if(stat.size>TEXT_FILE_LIMIT)throw new FileToolError('FILE_TOO_LARGE','文本文件超过 2 MB，请使用命令按需处理');
      const decoded=decodeText(readFileSync(path)),safe=this.redact(decoded.text,true);
      return {path,location:'host',...textPage(safe,range),redacted:safe!==decoded.text,sha256:decoded.sha256,bytes:decoded.bytes,bom:decoded.bom};
    }catch(error){throw filesystemError(error,path);}
  }
  async viewImage(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const path=this.canonical(this.resolveFilePath(args.path,workspace)),reason=text(args.reason,'reason',1000),stamp=this.stamp(path);
    if(!this.options.imagePreview)throw new FileToolError('IMAGE_UNAVAILABLE','图像预览服务尚未就绪');
    await this.interactions.permission(botId,runId,{operation:'read_file',reason,path,tool:'view_image'},signal);aborted(signal);
    if(this.canonical(path)!==path||this.stamp(path)!==stamp)throw new FileToolError('FILE_CHANGED','图像在确认期间发生变化，请重新读取');
    const info=statSync(path);if(!info.isFile()||info.size>10*1024*1024)throw new FileToolError('IMAGE_TOO_LARGE','图片必须是 10 MB 以内的普通文件');
    const fd=openSync(path,'r');let bytes:Buffer;
    try{const opened=fstatSync(fd);if(!opened.isFile()||opened.size>10*1024*1024)throw new FileToolError('IMAGE_TOO_LARGE','图片超过 10 MB');const buffer=Buffer.alloc(Math.min(opened.size+1,10*1024*1024+1));let total=0;while(total<buffer.length){const size=readSync(fd,buffer,total,buffer.length-total,null);if(!size)break;total+=size;}if(total>opened.size)throw new FileToolError('FILE_CHANGED','图片在读取期间发生变化');bytes=buffer.subarray(0,total);}finally{closeSync(fd);}
    aborted(signal);const image=this.options.imagePreview(bytes,randomUUID());if(!image)throw new FileToolError('IMAGE_UNSUPPORTED','无法解析图片，请使用 PNG、JPEG、WebP 等常见图片格式');
    return {path,location:'host',images:[image],bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  async writeFile(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const path=this.canonical(this.resolveFilePath(args.path,workspace)),reason=text(args.reason,'reason',1000);
    if(typeof args.content!=='string'||args.content.length>256000)throw new Error('写入内容过长或无效');
    if(args.overwrite!==undefined&&typeof args.overwrite!=='boolean')throw new Error('overwrite 必须是布尔值');
    const content=args.content,overwrite=args.overwrite===true,stamp=this.stamp(path),expected=expectedHash(args.expectedSha256);
    if(stamp!=='missing'&&!overwrite)throw new Error('文件已存在；确认内容后使用 overwrite=true');
    await this.interactions.permission(botId,runId,{operation:'write_file',reason,path,content,overwrite},signal);aborted(signal);
    if(this.canonical(path)!==path||this.stamp(path)!==stamp)throw new Error('文件在确认期间发生变化，请重新确认');
    if(expected&&(stamp==='missing'||createHash('sha256').update(readFileSync(path)).digest('hex')!==expected))throw new FileToolError('FILE_CHANGED','文件自上次读取后已变化，请重新读取后再修改');
    if(overwrite&&stamp!=='missing'&&content.includes('[redacted')&&statSync(path).size<=2*1024*1024){const original=readFileSync(path,'utf8');if(this.redact(original)!==original)throw new Error('不能把凭据占位符写回原文件，请用本机命令定点修改非敏感字段');}
    return this.commitFile(botId,runId,path,content,stamp,signal);
  }
  async patchFile(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const path=this.canonical(this.resolveFilePath(args.path,workspace)),reason=text(args.reason,'reason',1000),expected=expectedHash(args.expectedSha256,true)!;
    if(typeof args.oldText!=='string'||!args.oldText.length||args.oldText.length>256000||typeof args.newText!=='string'||args.newText.length>256000)throw new FileToolError('INVALID_ARGUMENT','oldText 不能为空，oldText 和 newText 最长为 256000 字符');
    if(args.replaceAll!==undefined&&typeof args.replaceAll!=='boolean')throw new FileToolError('INVALID_ARGUMENT','replaceAll 必须是布尔值');
    const edit={oldText:args.oldText,newText:args.newText,expectedSha256:expected,replaceAll:args.replaceAll},stamp=this.stamp(path);
    const preview=`--- 原内容${edit.replaceAll?'（全部匹配）':''}\n${edit.oldText}\n+++ 替换为\n${edit.newText}`;
    await this.interactions.permission(botId,runId,{operation:'write_file',reason,path,content:preview,overwrite:true},signal);aborted(signal);
    try{
      if(this.canonical(path)!==path||this.stamp(path)!==stamp)throw new FileToolError('FILE_CHANGED','文件在确认期间发生变化，请重新读取');
      const stat=statSync(path);if(!stat.isFile())throw new FileToolError('IS_DIRECTORY','不能对目录进行文本替换');if(stat.size>TEXT_FILE_LIMIT)throw new FileToolError('FILE_TOO_LARGE','文本文件超过 2 MB，请使用命令按需处理');
      const original=readFileSync(path);if((edit.oldText.includes('[redacted')||edit.newText.includes('[redacted'))&&this.redact(original.toString('utf8'))!==original.toString('utf8'))throw Error('不能用凭据占位符替换原文件，请只修改未脱敏的片段');
      const result=editText(original,edit);return {...this.commitFile(botId,runId,path,result.content,stamp,signal),replacements:result.replacements};
    }catch(error){throw filesystemError(error,path);}
  }
  private commitFile(botId:string,runId:string,path:string,content:string,stamp:string,signal:AbortSignal){
    mkdirSync(dirname(path),{recursive:true});const mode=stamp==='missing'?undefined:statSync(path).mode;
    const checkpoint=this.options.beforeWrite?.(botId,runId,path);
    const temporary=join(dirname(path),`.aelion-${randomUUID()}.tmp`);
    try{
      writeFileSync(temporary,content,{encoding:'utf8',flag:'wx',...(mode!==undefined?{mode}:{})});if(mode!==undefined&&process.platform!=='win32')chmodSync(temporary,mode);aborted(signal);if(this.canonical(path)!==path||this.stamp(path)!==stamp)throw new Error('文件在写入前发生变化，未覆盖');
      if(stamp==='missing')try{linkSync(temporary,path);}catch(error){if(!['EPERM','ENOTSUP','EOPNOTSUPP','EINVAL','EXDEV'].includes((error as NodeJS.ErrnoException).code||''))throw error;try{copyFileSync(temporary,path,constants.COPYFILE_EXCL);}catch(caught){if((caught as NodeJS.ErrnoException).code!=='EEXIST'&&existsSync(path))Object.assign(caught as object,{outcomeUnknown:true});throw caught;}}
      else renameSync(temporary,path);
    }finally{try{unlinkSync(temporary);}catch{}}
    this.options.afterWrite?.(checkpoint,path,content);
    return {path,location:'host',bytes:Buffer.byteLength(content,'utf8'),written:true,sha256:createHash('sha256').update(content,'utf8').digest('hex')};
  }
  async listDirectory(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
    const path=this.canonical(this.resolveFilePath(args.path||workspace||this.workspace(botId),workspace)),reason=text(args.reason,'reason',1000);
    const offset=boundedInteger(args.offset,0,0,Number.MAX_SAFE_INTEGER,'offset'),limit=boundedInteger(args.limit,250,1,1000,'limit');
    await this.interactions.permission(botId,runId,{operation:'read_file',reason,path},signal);aborted(signal);
    if(this.canonical(path)!==path)throw Error('目录位置发生变化，请重新确认');
    try{const items=readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)),nextOffset=Math.min(items.length,offset+limit);
      return {path,location:'host',items:items.slice(offset,nextOffset).map(item=>({name:item.name,kind:item.isDirectory()?'directory':item.isSymbolicLink()?'link':'file'})),total:items.length,nextOffset,truncated:nextOffset<items.length,eof:nextOffset>=items.length};
    }catch(error){throw filesystemError(error,path);}
  }
  async searchFiles(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string,kind:'find'|'search'='search'){
    const path=this.canonical(this.resolveFilePath(args.path===undefined||args.path===''?workspace||this.workspace(botId):args.path,workspace)),reason=text(args.reason,'reason',1000);
    const glob=text((kind==='find'?args.pattern:args.glob)??'**/*','glob',500).replaceAll('\\','/');
    if(/^[a-z]:|^\//i.test(glob)||glob.split('/').includes('..'))throw new FileToolError('INVALID_ARGUMENT','glob 必须相对于检索目录，不能包含绝对路径或 ..');
    const query=kind==='search'?args.query:undefined;if(kind==='search'&&(typeof query!=='string'||!query.length||query.length>1000||/[\r\n]/.test(query)||forbidden.test(query)))throw new FileToolError('INVALID_ARGUMENT','query 需要 1–1000 字符的单行文本或 JavaScript 正则');
    for(const key of ['regex','caseSensitive','respectIgnore'])if(args[key]!==undefined&&typeof args[key]!=='boolean')throw new FileToolError('INVALID_ARGUMENT',`${key} 必须是布尔值`);
    const outputMode=kind==='find'?'files':args.outputMode??'content';if(!['content','files','count'].includes(String(outputMode)))throw new FileToolError('INVALID_ARGUMENT','outputMode 需要 content、files 或 count');
    const request:FileSearchRequest={kind,root:path,dataDir:this.options.dataDir,homeDir:this.options.homeDir,glob,query:query as string|undefined,regex:args.regex===true,caseSensitive:args.caseSensitive!==false,respectIgnore:args.respectIgnore!==false,outputMode:outputMode as FileSearchRequest['outputMode'],contextLines:boundedInteger(args.contextLines,1,0,5,'contextLines'),offset:boundedInteger(args.offset,0,0,20000,'offset'),limit:boundedInteger(args.limit,100,1,200,'limit'),secrets:[]};
    await this.interactions.permission(botId,runId,{operation:'read_file',reason,path,tool:kind==='find'?'host_find_files':'host_search_files',arguments:{glob,query,regex:request.regex,outputMode}},signal);aborted(signal);
    try{
      if(this.canonical(path)!==path)throw new FileToolError('PATH_CHANGED','检索路径在确认后变化，请重新确认');
      const stat=statSync(path);if(stat.isFile()&&kind==='search'){request.root=dirname(path);request.file=path;}else if(!stat.isDirectory())throw new FileToolError('NOT_DIRECTORY','文件查找需要目录；单个文件请使用 host_file_read 或 host_search_files');
      request.secrets=this.secrets();return {location:'host',...await this.searches.run(request,signal)};
    }catch(error){throw filesystemError(error,path);}
  }
  dispose(){this.searches.dispose();for(const stop of this.executions.values())stop();}
}
