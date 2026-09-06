const stages:Record<string,string>={system:'正在更新系统软件源',desktop:'正在安装桌面和办公软件',browser:'正在下载并安装浏览器',finishing:'正在配置语言和桌面'};
export function workstationProgress(output:string){const stage=output.match(/(?:^|\n)STAGE:([a-z]+)(?:\r?\n|$)/)?.[1]||'';return Object.hasOwn(stages,stage)?stages[stage]:'正在安装桌面、浏览器和办公软件';}
