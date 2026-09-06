import {join,posix,win32} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
export const platformName=(platform=process.platform)=>platform==='darwin'?'macOS':platform==='win32'?'Windows':'Linux';
export const shellName=(platform=process.platform)=>platform==='win32'?'PowerShell':platform==='darwin'?'zsh':'bash';
export function hostPathKey(path:string,platform=process.platform){return platform==='win32'?win32.normalize(path).replace(/\\+$/,'').toLowerCase():posix.normalize(path).replace(/\/+$/,'')||'/';}
export function hostEnvironment(input:NodeJS.ProcessEnv=process.env,platform=process.platform){
 const env:NodeJS.ProcessEnv={...input,GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0',NO_COLOR:'1',PAGER:'',GH_PAGER:''};
 if(platform==='darwin')env.PATH=[...new Set(['/opt/homebrew/bin','/usr/local/bin',...(input.PATH||'/usr/bin:/bin:/usr/sbin:/sbin').split(':')])].join(':');return env;
}
export function hostShell(command:string,env:NodeJS.ProcessEnv=process.env,platform=process.platform){
 if(platform!=='win32')return {executable:platform==='darwin'?'/bin/zsh':'/bin/bash',args:['-l','-c',command],detached:true};
 const script=`$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$OutputEncoding=[Console]::OutputEncoding\n$global:LASTEXITCODE=0\ntry {\n. {\n${command}\n}\nexit $LASTEXITCODE\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
 return {executable:join(env.SystemRoot||env.SYSTEMROOT||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],detached:false};
}
export function stopHostProcess(child:ChildProcess,env:NodeJS.ProcessEnv=process.env,platform=process.platform){
 if(!child.pid)return;
 if(platform==='win32'){const killer=spawn(join(env.SystemRoot||env.SYSTEMROOT||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());killer.on('close',code=>{if(code!==0&&child.exitCode===null)child.kill();});return;}
 // detached children own this process group; never use a PID restored from storage here.
 try{process.kill(-child.pid,'SIGTERM');}catch{try{child.kill('SIGTERM');}catch{}}
 const timer=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{}},1500);timer.unref();child.once('close',()=>clearTimeout(timer));
}
