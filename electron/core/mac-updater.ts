import {EventEmitter} from 'node:events';
import {MacUpdater,CancellationToken} from 'electron-updater';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {UpdateDriver} from './app-updates';
import {build,version as appVersion} from '../../package.json';
const releaseRepository=`${build.publish.owner}/${build.publish.repo}`;
const semver=(value:string)=>/^v?(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number);
export function newerVersion(candidate:string,current:string){const a=semver(candidate),b=semver(current);if(!a||!b)return false;for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
export function macAutomaticUpdates(resources:string){try{const data=JSON.parse(readFileSync(join(resources,'mac-release.json'),'utf8'));return data.automaticUpdates===true&&data.signatureType==='developer-id'&&data.notarized===true;}catch{return false;}}
export function createMacUpdater(automatic:boolean,arch=process.arch):UpdateDriver{
 if(automatic){
  const updater=new MacUpdater({provider:'github',owner:build.publish.owner,repo:build.publish.repo,private:false});let cancellation:CancellationToken|undefined;
  updater.autoDownload=false;updater.autoInstallOnAppQuit=false;updater.allowDowngrade=false;updater.allowPrerelease=false;updater.logger=null;
  return {on:(event,listener)=>updater.on(event,listener),removeAllListeners:()=>updater.removeAllListeners(),checkForUpdates:()=>updater.checkForUpdates(),downloadUpdate:()=>{cancellation=new CancellationToken();return updater.downloadUpdate(cancellation);},cancelDownload:()=>cancellation?.cancel(),quitAndInstall:()=>updater.quitAndInstall()};
 }
 const events=new EventEmitter();let controller:AbortController|undefined;
 return {manualInstall:true,on:(event,listener)=>events.on(event,listener),removeAllListeners:()=>events.removeAllListeners(),cancelDownload:()=>controller?.abort(),downloadUpdate:async()=>{throw Error('Mac 预览版请从 Release 下载新版本后替换应用');},quitAndInstall:()=>{throw Error('此 Mac 预览版不支持自动替换应用');},checkForUpdates:async()=>{
  controller=new AbortController();const response=await fetch(`https://api.github.com/repos/${releaseRepository}/releases?per_page=20`,{headers:{Accept:'application/vnd.github+json'},redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});if(!response.ok)throw Error(`GitHub HTTP ${response.status}`);
  const text=await response.text();if(text.length>4*1024*1024)throw Error('Release response too large');const releases=JSON.parse(text);if(!Array.isArray(releases))throw Error('Invalid releases');
  const release=releases.filter(r=>!r.draft&&!r.prerelease&&typeof r.tag_name==='string'&&newerVersion(r.tag_name,appVersion)&&r.assets?.some((a:any)=>a.name===`AelionBot-${r.tag_name.replace(/^v/,'')}-mac-${arch}.dmg`&&a.state==='uploaded'&&a.size>0)).sort((a,b)=>newerVersion(a.tag_name,b.tag_name)?-1:1)[0];
  if(release)events.emit('update-available',{version:release.tag_name.replace(/^v/,''),releaseName:release.name,releaseNotes:release.body});else events.emit('update-not-available',{});return {checked:true};
 }};
}
