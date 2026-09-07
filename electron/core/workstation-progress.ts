import type {InstallationProgress} from '../../src/shared';
const stages:Record<string,string>={system:'正在更新系统软件源',desktop:'正在安装桌面和办公软件',office:'正在安装办公软件',browser:'正在下载并安装浏览器',runtime:'正在准备 Bot 独立桌面',finishing:'正在配置语言和桌面'};
export function installationProgress(output:string):InstallationProgress|undefined {
  const raw=output.match(/(?:^|\n)INSTALL_PROGRESS:([^\r\n]{1,2048})(?:\r?\n|$)/)?.[1];if(!raw)return;
  try{const value=JSON.parse(raw),stage=output.match(/(?:^|\n)STAGE:([a-z]+)(?:\r?\n|$)/)?.[1];
    if(!value||!['desktop','office','browser','runtime'].includes(value.stage)||value.stage!==stage||!['updating','downloading','installing','retrying','complete','failed'].includes(value.phase)||typeof value.updatedAt!=='number'||!Number.isFinite(value.updatedAt))return;
    return {stage:value.stage,phase:value.phase,updatedAt:value.updatedAt,...(typeof value.percent==='number'&&Number.isFinite(value.percent)&&value.percent>=0&&value.percent<=100?{percent:value.percent}:{}),...(['current','tuna','ustc','debian'].includes(value.source)?{source:value.source}:{}),...(typeof value.package==='string'&&/^[a-zA-Z0-9.+:_-]{1,120}$/.test(value.package)?{package:value.package}:{}),...(['sources-unavailable','package-configure','download-timeout','command-timeout'].includes(value.error)?{error:value.error}:{})};
  }catch{return;}
}
export function workstationProgress(output:string){
  const info=installationProgress(output);
  if(info){const subject=info.stage==='office'?'办公软件':info.stage==='browser'?'浏览器':info.stage==='runtime'?'独立桌面组件':'桌面组件';
    const text=info.phase==='retrying'?'连接不稳定，正在更换安装源':info.phase==='updating'?'正在更新安装源':info.phase==='downloading'?`正在下载${subject}`:info.phase==='installing'?`正在安装${subject}`:info.phase==='complete'?`${subject}已安装`:`${subject}安装未完成`;
    return text+(info.percent===undefined?'':` · ${Math.floor(info.percent)}%`)+(info.package?` · ${info.package}`:'');
  }
  const stage=output.match(/(?:^|\n)STAGE:([a-z]+)(?:\r?\n|$)/)?.[1]||'';return Object.hasOwn(stages,stage)?stages[stage]:'正在安装桌面、浏览器和办公软件';
}
export function workstationFailure(output:string){
  const info=installationProgress(output);if(info?.error==='sources-unavailable')return '安装源连接未完成，已下载的软件包保留。请重试，程序会自动尝试其他安装源。';
  if(info?.error==='package-configure')return '软件包配置未完成，已下载文件保留。请检查磁盘空间后重试修复工作环境。';
  const stage=output.match(/(?:^|\n)STAGE:([a-z]+)(?:\r?\n|$)/)?.[1];return stage==='system'?'软件源更新失败，请检查网络后重试。':stage==='desktop'||stage==='office'?'桌面和办公软件安装未完成，请检查网络与磁盘空间后修复工作环境。':stage==='browser'?'浏览器安装未完成，请重试，程序会自动检查可用安装源。':'桌面配置未完成，请查看工作电脑诊断后修复工作环境。';
}
