import {join} from 'node:path';
// Pass filenames through the environment, never interpolate them into script code.
export const WINDOWS_OPEN_WITH_SCRIPT=String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AelionOpenWith {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Info { [MarshalAs(UnmanagedType.LPWStr)] public string File; [MarshalAs(UnmanagedType.LPWStr)] public string Class; public uint Flags; }
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, PreserveSig=true)] public static extern int SHOpenWithDialog(IntPtr owner, ref Info info);
}
'@
$info=New-Object AelionOpenWith+Info
$info.File=$env:AELION_OPEN_FILE
$info.Flags=4
$result=[AelionOpenWith]::SHOpenWithDialog([IntPtr]::new([long]$env:AELION_OPEN_OWNER),[ref]$info)
if($result -eq -2147023673 -or $result -eq 1){Write-Output 'cancelled';exit 0}
if($result -lt 0){throw ('Open With failed: '+$result)}
`;
export function windowsOpenWithCommand(path:string,owner='0'){
 return {file:join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),args:['-NoProfile','-NonInteractive','-STA','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(WINDOWS_OPEN_WITH_SCRIPT,'utf16le').toString('base64')],options:{windowsHide:true,env:{...process.env,AELION_OPEN_FILE:path,AELION_OPEN_OWNER:owner},maxBuffer:64*1024}};
}
