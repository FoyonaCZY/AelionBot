import type {UpdateState,UpdatePhase} from '../../src/update-types';

export type UpdateDriverEvent='update-available'|'update-not-available'|'download-progress'|'update-downloaded'|'update-cancelled'|'error';
export interface UpdateDriver {
  on(event:UpdateDriverEvent,listener:(value:any)=>void):unknown;
  removeAllListeners():unknown;
  checkForUpdates():Promise<unknown>;
  downloadUpdate():Promise<string[]>;
  cancelDownload():void;
  quitAndInstall():void;
}
interface UpdateHooks {blockedReason:()=>string|undefined;prepareInstall:(version:string)=>Promise<void>;recoverInstall:()=>Promise<void>;}
export function updateError(error:unknown){
  const raw=error instanceof Error?`${(error as Error&{code?:string}).code||''} ${error.message}`:String(error);
  if(/ERR_UPDATER_NO_PUBLISHED_VERSIONS|ERR_UPDATER_LATEST_VERSION_NOT_FOUND|No published versions/i.test(raw))return '仓库还没有可用于更新的正式 Release。';
  if(/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|latest\.yml.*404/i.test(raw))return 'Release 缺少更新清单 latest.yml，请发布完整安装包和更新清单。';
  if(/checksum|sha512|sha256|digest|signature|ERR_UPDATER_INVALID_SIGNATURE/i.test(raw))return '更新包校验未通过，请重新检查并下载更新。';
  if(/403|429|rate.limit/i.test(raw))return 'GitHub 暂时限制了请求，请稍后重试。';
  if(/ENOSPC|磁盘空间|disk.space/i.test(raw))return '磁盘空间不足，请清理后重新下载。';
  if(/timeout|timed.out|ETIMEDOUT/i.test(raw))return '检查或下载更新超时，请稍后重试。';
  if(/network|fetch|ENOTFOUND|ECONN|ERR_INTERNET|ERR_PROXY|ERR_NAME|net::/i.test(raw))return '无法连接 GitHub，请检查网络后重试。';
  if(/404/.test(raw))return '未找到 GitHub Release 或更新资源，请稍后重试。';
  return '更新未能完成，请稍后重试。';
}
function notes(value:unknown):string|undefined{
  if(typeof value==='string')return value.slice(0,12000);
  if(Array.isArray(value))return value.map(item=>typeof item?.note==='string'?item.note:'').filter(Boolean).join('\n\n').slice(0,12000)||undefined;
}
export class AppUpdates {
  private state:UpdateState;private operation?:Promise<unknown>;private cancelled=false;private disposed=false;
  constructor(private driver:UpdateDriver,version:string,repository:string,supported:boolean,private hooks:UpdateHooks,private changed:()=>void){
    this.state={phase:supported?'idle':'unsupported',currentVersion:version,repository};
    driver.on('update-available',info=>{if(this.state.phase!=='checking')return;this.set({phase:'available',latestVersion:info.version,releaseName:typeof info.releaseName==='string'?info.releaseName.slice(0,160):undefined,releaseNotes:notes(info.releaseNotes),checkedAt:new Date().toISOString(),error:undefined});});
    driver.on('update-not-available',()=>{if(this.state.phase==='checking')this.set({phase:'current',latestVersion:undefined,releaseName:undefined,releaseNotes:undefined,checkedAt:new Date().toISOString(),error:undefined});});
    driver.on('download-progress',progress=>{if(this.state.phase!=='downloading'||this.cancelled)return;this.set({progress:{percent:Math.max(0,Math.min(100,Number(progress.percent)||0)),transferred:Math.max(0,Number(progress.transferred)||0),total:Math.max(0,Number(progress.total)||0),bytesPerSecond:Math.max(0,Number(progress.bytesPerSecond)||0)}});});
    driver.on('update-downloaded',info=>{if(this.state.phase==='downloading'&&!this.cancelled&&info.version===this.state.latestVersion)this.set({phase:'downloaded',progress:undefined,error:undefined});});
    driver.on('update-cancelled',()=>{if(this.cancelled)this.set({phase:'available',progress:undefined,error:undefined});});
    driver.on('error',error=>{if(!this.cancelled&&!this.disposed){const installing=this.state.phase==='installing';this.set({phase:'error',progress:undefined,error:updateError(error)});if(installing)void hooks.recoverInstall().catch(()=>{});}});
  }
  snapshot(){return {...structuredClone(this.state),installBlockedReason:this.hooks.blockedReason()};}
  private set(patch:Partial<UpdateState>){if(this.disposed)return;this.state={...this.state,...patch};this.changed();}
  private async perform(phase:UpdatePhase,work:()=>Promise<unknown>){
    if(this.disposed)throw new Error('客户端正在退出');if(this.operation)return this.operation;
    this.cancelled=false;this.set({phase,error:undefined,progress:undefined});
    const pending=Promise.resolve().then(work).catch(error=>{if(!this.disposed)this.set(this.cancelled?{phase:'available',progress:undefined,error:undefined}:{phase:'error',progress:undefined,error:updateError(error)});}).finally(()=>{if(this.operation===pending)this.operation=undefined;});
    this.operation=pending;return pending;
  }
  check(){
    if(this.state.phase==='unsupported')throw new Error('请在 Windows 发行版中检查更新');
    if(this.operation||this.state.phase==='installing')return this.operation;
    this.set({latestVersion:undefined,releaseName:undefined,releaseNotes:undefined});
    return this.perform('checking',async()=>{const result=await this.driver.checkForUpdates();if(!result||this.state.phase==='checking')throw new Error('Updater did not return a result');});
  }
  download(){
    if(this.operation)return this.operation;
    if(!['available','error'].includes(this.state.phase)||!this.state.latestVersion)throw new Error('请先检查是否有新版本');
    return this.perform('downloading',async()=>{await this.driver.downloadUpdate();if(this.cancelled)this.set({phase:'available',progress:undefined});else if(this.state.phase==='downloading')throw new Error('Update download did not complete');});
  }
  cancel(){if(this.state.phase!=='downloading')return;this.cancelled=true;this.set({phase:'cancelling'});this.driver.cancelDownload();}
  async install(){
    if(this.disposed)throw new Error('客户端正在退出');if(this.operation)return;
    if(this.state.phase!=='downloaded'||!this.state.latestVersion)throw new Error('更新包尚未下载完成');const blocked=this.hooks.blockedReason();if(blocked)throw new Error(blocked);
    this.set({phase:'installing',error:undefined});
    try{await this.hooks.prepareInstall(this.state.latestVersion);if(!this.disposed)this.driver.quitAndInstall();}
    catch(error){await this.hooks.recoverInstall().catch(()=>{});this.set({phase:'downloaded',error:error instanceof Error?error.message:'无法准备更新，请稍后重试。'});}
  }
  dispose(){this.disposed=true;this.driver.cancelDownload();this.driver.removeAllListeners();}
}
