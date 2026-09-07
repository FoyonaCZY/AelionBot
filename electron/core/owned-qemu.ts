import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';

const run=promisify(execFile);
// A stored PID is insufficient. Keep an OS process handle open, then verify
// executable, creation time, UUID and both disks before terminating that handle.
interface QemuIdentity {pid:number;id:string;executable:string;systemDisk:string;workDisk:string;}
async function processAction(input:QemuIdentity,stop:boolean):Promise<'owned'|'missing'|'foreign'|'unknown'>{
  if(!Number.isSafeInteger(input.pid)||input.pid<=0||!/^[a-f0-9-]{36}$/i.test(input.id))return 'unknown';
  const data=Buffer.from(JSON.stringify(input),'utf8').toString('base64');
  const script=`$ErrorActionPreference='Stop'
$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json
try { $p=Get-Process -Id $v.pid -ErrorAction Stop; $handle=$p.Handle } catch { exit 2 }
$info=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$v.pid)
if (!$info -or $p.HasExited) { exit 2 }
if ($p.Path -ine $v.executable -or $info.ExecutablePath -ine $v.executable -or [Math]::Abs(($p.StartTime-$info.CreationDate).TotalSeconds) -gt 1) { exit 3 }
$line=$info.CommandLine
if ($line -notmatch ('(?i)(?:^|\\s)-uuid\\s+"?'+[regex]::Escape($v.id)+'"?(?:\\s|$)')) { exit 3 }
foreach ($disk in @($v.systemDisk,$v.workDisk)) { if ($line.IndexOf(('file='+$disk.Replace(',',',,')+','),[StringComparison]::OrdinalIgnoreCase) -lt 0) { exit 3 } }
${stop?'$p.Kill(); if (!$p.WaitForExit(3000)) { exit 4 }':''}
`;
  try{await run(join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:6000});return 'owned';}catch(error){const code=(error as {code?:unknown}).code;return code===2?'missing':code===3?'foreign':'unknown';}
}
export const inspectOwnedQemuWindows=(input:QemuIdentity)=>processAction(input,false);
export async function stopOwnedQemuWindows(input:QemuIdentity){const result=await processAction(input,true);return result==='owned'||result==='missing';}
