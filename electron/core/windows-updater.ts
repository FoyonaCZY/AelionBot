import {NsisUpdater,CancellationToken} from 'electron-updater';
import {dirname} from 'node:path';
import {existsSync} from 'node:fs';
import type {UpdateDriver,UpdateDriverEvent} from './app-updates';
import {build} from '../../package.json';

export const UPDATE_REPOSITORY=`${build.publish.owner}/${build.publish.repo}`;
export function createWindowsUpdater(executable:string):UpdateDriver{
  const updater=new NsisUpdater({provider:'github',owner:build.publish.owner,repo:build.publish.repo,private:false});
  updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowPrerelease=false;updater.allowDowngrade=false;updater.disableWebInstaller=true;updater.logger=null;
  updater.installDirectory=dirname(executable);let cancellation:CancellationToken|undefined,installer:string|undefined;const listeners:Array<{event:UpdateDriverEvent;listener:(value:any)=>void}>=[];
  return {
    on:(event,listener)=>{listeners.push({event,listener});return updater.on(event,listener);},removeAllListeners:()=>{for(const {event,listener} of listeners)updater.removeListener(event,listener);listeners.length=0;},checkForUpdates:()=>updater.checkForUpdates(),
    downloadUpdate:async()=>{installer=undefined;cancellation=new CancellationToken();const files=await updater.downloadUpdate(cancellation);installer=files.find(file=>file.toLowerCase().endsWith('.exe'));return files;},
    cancelDownload:()=>cancellation?.cancel(),
    quitAndInstall:()=>{if(!installer||!existsSync(installer))throw new Error('更新安装包不存在，请重新下载。');updater.quitAndInstall(true,true);}
  };
}
