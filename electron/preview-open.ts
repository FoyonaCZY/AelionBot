import {dialog,type BrowserWindow} from 'electron';
import {execFile,spawn} from 'node:child_process';
import {windowsOpenWithCommand} from './core/open-with-windows';
export async function choosePreviewApplication(window:BrowserWindow,path:string):Promise<boolean>{
 if(process.platform==='win32'){
  const handle=window.getNativeWindowHandle(),owner=(handle.length===8?handle.readBigUInt64LE():BigInt(handle.readUInt32LE())).toString(),command=windowsOpenWithCommand(path,owner);
  return new Promise((resolve,reject)=>execFile(command.file,command.args,command.options,(error,stdout)=>error?reject(Error('无法打开系统应用选择器：'+error.message)):resolve(!stdout.includes('cancelled'))));
 }
 const result=await dialog.showOpenDialog(window,{title:'选择用于打开文件的应用',defaultPath:process.platform==='darwin'?'/Applications':'/usr/bin',properties:['openFile'],...(process.platform==='darwin'?{filters:[{name:'应用',extensions:['app']}]}:{})});
 if(result.canceled||!result.filePaths[0])return false;
 const app=result.filePaths[0];return new Promise((resolve,reject)=>{const child=process.platform==='darwin'?spawn('/usr/bin/open',['-a',app,path],{detached:true,stdio:'ignore'}):spawn(app,[path],{detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve(true);});});
}
