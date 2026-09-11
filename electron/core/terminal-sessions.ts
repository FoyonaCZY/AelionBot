import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {join,posix} from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import type {HostComputer} from './host';
import type {Interactions} from './interactions';
import type {VmController} from './vm';
import {hostEnvironment,hostShell,stopHostProcess} from './host-platform';
import {boundedInteger,FileToolError,textPage} from './file-text';
import {backoff} from './model';
export interface TerminalDriver {write:(text:string)=>void;kill:()=>void;resize?:(cols:number,rows:number)=>void;onData:(fn:(text:string)=>void)=>unknown;onExit:(fn:(code:number)=>void)=>unknown;}
interface Session {id:string;botId:string;runId:string;location:'host'|'vm';command:string;cwd:string;tty:boolean;purpose:'task'|'service';driver:TerminalDriver;output:string;baseOffset:number;exitCode?:number;closed:boolean;}
export class TerminalSessions {
 private sessions=new Map<string,Session>();
 constructor(private vm:VmController,private host:HostComputer|undefined,private interactions:Interactions|undefined,private runtimeDir:string){}
 private get(botId:string,id:string){const session=this.sessions.get(id);if(!session||session.botId!==botId)throw new FileToolError('TERMINAL_NOT_FOUND','终端不存在、已重启或不属于当前 Bot');return session;}
 async start(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal,workspace?:string){
  if(typeof args.command!=='string'||!args.command.trim()||args.command.length>6000)throw Error('终端命令需要 1–6000 字符');
  if(this.list(botId).filter(session=>session.exitCode===undefined).length>=6)throw Error('当前 Bot 最多保留 6 个运行终端');
  if([...this.sessions.values()].filter(session=>!session.closed).length>=12)throw Error('应用最多同时保留 12 个运行终端，请先停止不再使用的终端');
  const location=args.location==='vm'?'vm':'host',tty=args.tty!==false,cols=boundedInteger(args.cols,100,20,300,'cols'),rows=boundedInteger(args.rows,30,5,100,'rows');let cwd=workspace||'',driver:TerminalDriver;
  if(location==='host'){
   if(!this.host||!this.interactions)throw Error('本机终端不可用');if(typeof args.reason!=='string'||!args.reason.trim())throw Error('请说明执行原因');
   cwd=this.host.resolveFilePath(args.cwd||workspace||this.host.workspace(botId),workspace);if(!existsSync(cwd)||!statSync(cwd).isDirectory())throw Error('终端工作目录不存在');cwd=realpathSync.native(cwd);
   await this.interactions.permission(botId,runId,{operation:'command',reason:args.reason,command:args.command,cwd,tool:'terminal_start',arguments:{tty}},signal);signal.throwIfAborted();if(realpathSync.native(cwd)!==cwd)throw Error('目录在审批期间发生变化');
   const env=hostEnvironment(this.host.options.env||process.env),shell=hostShell(args.command,env),shellArgs=shell.args.filter(arg=>arg!=='-NonInteractive');
   if(tty){
    // node-pty rewrites its Mac spawn-helper path itself. Loading its JS from
    // app.asar.unpacked on Mac would rewrite that path a second time.
    const load=createRequire(join(this.runtimeDir,'terminal-loader.cjs')),resolved=load.resolve('node-pty'),file=process.platform==='win32'?resolved.replace(/app\.asar([\\/])/,'app.asar.unpacked$1'):resolved,pty=load(file) as typeof import('node-pty');
    const child=pty.spawn(shell.executable,shellArgs,{name:'xterm-256color',cwd,cols,rows,env:Object.fromEntries(Object.entries(env).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),useConpty:true});
    // node-pty 1.1.0 leaves its ConPTY reader worker alive on natural exit.
    // Release owned handles directly: public kill() enumerates an already exited
    // console, starting an unnecessary helper and printing AttachConsole errors.
    let released=false,stopping=false;const release=()=>{if(released)return;released=true;if(process.platform==='win32'){const agent=(child as any)._agent;agent?._conoutSocketWorker?.dispose();agent?._inSocket?.destroy();try{agent?._ptyNative?.kill(agent._pty,agent._useConptyDll);}catch{}agent?._outSocket?.destroy();}};
    driver={write:value=>child.write(value),resize:(cols,rows)=>child.resize(cols,rows),onData:fn=>child.onData(fn),onExit:fn=>child.onExit(event=>{release();fn(event.exitCode??-1);}),kill:()=>{if(stopping||released)return;stopping=true;if(process.platform==='win32'){const task=spawn(join(env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});task.on('error',release);task.on('close',release);}else{try{process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}const timer=setTimeout(()=>{if(!released)try{process.kill(-child.pid,'SIGKILL');}catch{}},1500);timer.unref();}}};
   }else{
    const child=spawn(shell.executable,shellArgs,{cwd,env,windowsHide:true,detached:shell.detached,stdio:['pipe','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    driver={write:value=>{child.stdin.write(value);},onData:fn=>{child.stdout.on('data',bytes=>fn(bytes.toString('utf8')));child.stderr.on('data',bytes=>fn(bytes.toString('utf8')));},onExit:fn=>{child.on('close',code=>fn(code??-1));},kill:()=>stopHostProcess(child,env)};
   }
  }else{
   cwd=posix.resolve(`/work/${botId}`,typeof args.cwd==='string'?args.cwd:'.');if(cwd!==`/work/${botId}`&&!cwd.startsWith(`/work/${botId}/`))throw Error('VM 终端目录必须在当前 Bot 工作目录内');
   driver=await this.vm.openTerminal(botId,args.command,cwd,signal,tty?{cols,rows}:undefined);
  }
  const session:Session={id:randomUUID(),botId,runId,location,cwd,command:args.command,tty,purpose:args.purpose==='service'?'service':'task',driver,output:'',baseOffset:0,closed:false};this.sessions.set(session.id,session);
  driver.onData(text=>{session.output+=text;if(session.output.length>2*1024*1024){const remove=session.output.length-1024*1024;session.output=session.output.slice(remove);session.baseOffset+=remove;}});driver.onExit(code=>{session.exitCode=code;session.closed=true;});
  if(signal.aborted){driver.kill();signal.throwIfAborted();}
  for(const [id,value] of this.sessions)if(value.closed&&this.sessions.size>64)this.sessions.delete(id);
  return this.read(botId,session.id,signal,boundedInteger(args.yieldTimeMs,1000,0,30000,'yieldTimeMs'),0);
 }
 async input(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal){
  const session=this.get(botId,String(args.id));if(session.closed)throw Error('终端已退出');
  if(typeof args.chars!=='string'||args.chars.length>16000)throw Error('输入必须是最多 16000 字符的文本');const chars=args.chars;
  if(chars&&session.location==='host'){
   if(!this.interactions||typeof args.reason!=='string'||!args.reason.trim())throw Error('本机终端输入需要说明原因');
   await this.interactions.permission(botId,runId,{operation:'command',reason:args.reason,cwd:session.cwd,command:session.command+'\n# 继续向终端发送输入\n'+JSON.stringify(chars),tool:'terminal_input',arguments:{sessionId:session.id,input:chars,initialCommand:session.command}},signal);
  }
  signal.throwIfAborted();if(session.closed)throw Error('终端已退出，未发送输入');if(chars)session.driver.write(chars);
  if(args.cols!==undefined||args.rows!==undefined)session.driver.resize?.(boundedInteger(args.cols,100,20,300,'cols'),boundedInteger(args.rows,30,5,100,'rows'));
  return this.read(botId,session.id,signal,boundedInteger(args.yieldTimeMs,250,0,30000,'yieldTimeMs'),boundedInteger(args.offset,0,0,Number.MAX_SAFE_INTEGER,'offset'));
 }
 async read(botId:string,id:string,signal:AbortSignal,waitMs=1000,offset=0){
  const session=this.get(botId,id),until=Date.now()+waitMs,start=session.baseOffset+session.output.length;
  while(!session.closed&&Date.now()<until&&session.baseOffset+session.output.length===start){await backoff(Math.min(100,until-Date.now()),signal);}signal.throwIfAborted();
  const safe=this.host?.redact(session.output)||session.output,page=textPage(safe,{offset:Math.max(0,offset-session.baseOffset),maxChars:16000});
  return {id:session.id,location:session.location,cwd:session.cwd,tty:session.tty,purpose:session.purpose,status:session.closed?'exited':'running',exitCode:session.exitCode,output:stripVTControlCharacters(page.content),offset:session.baseOffset+page.offset,nextOffset:session.baseOffset+page.nextOffset,hasMore:!page.eof,truncated:offset<session.baseOffset};
 }
 async stop(botId:string,id:string,signal:AbortSignal){const session=this.get(botId,id);if(!session.closed)session.driver.kill();const until=Date.now()+3000;while(!session.closed&&Date.now()<until)await backoff(100,signal);const result=await this.read(botId,id,signal,0,0);return {...result,stopped:result.status==='exited',processExitCode:result.exitCode,exitCode:result.status==='exited'?0:undefined};}
 list(botId:string,runId?:string){return [...this.sessions.values()].filter(session=>session.botId===botId&&(!runId||session.runId===runId)).map(({id,runId,purpose,exitCode,location})=>({id,runId,purpose,exitCode,location}));}
 cancelRun(botId:string,runId:string){for(const session of this.sessions.values())if(session.botId===botId&&session.runId===runId&&!session.closed)session.driver.kill();}
 async forgetBot(botId:string,signal:AbortSignal){for(const session of [...this.sessions.values()])if(session.botId===botId){if(!session.closed)await this.stop(botId,session.id,signal);if(!session.closed)throw Error('终端尚未确认退出，请稍后再删除 Bot');this.sessions.delete(session.id);}}
 dispose(){for(const session of this.sessions.values())if(!session.closed)session.driver.kill();this.sessions.clear();}
}
