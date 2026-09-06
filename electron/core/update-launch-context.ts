import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {join,resolve,isAbsolute,relative} from 'node:path';
import {atomicJson} from './store';

export interface UpdateLaunchContext {version:1;executable:string;dataDir:string;projectDir:string;configDir:string;resumeComputer:boolean;targetVersion:string;}
const same=(a:string,b:string)=>resolve(a).toLowerCase()===resolve(b).toLowerCase();
export function assertUpdateDataOutsideApp(dataDir:string,appDir:string){
  const child=relative(resolve(appDir).toLowerCase(),resolve(dataDir).toLowerCase());
  if(child===''||child!=='..'&&!child.startsWith('../')&&!child.startsWith('..\\')&&!isAbsolute(child))throw new Error('工作数据位于程序目录内，请先将数据移到程序目录外再更新。');
}
export function loadUpdateLaunchContext(profileDir:string,executable:string):UpdateLaunchContext|undefined{
  const file=join(profileDir,'update-launch-context.json');if(!existsSync(file))return;
  const value=JSON.parse(readFileSync(file,'utf8')) as UpdateLaunchContext;
  if(value.version!==1||typeof value.executable!=='string'||!same(value.executable,executable))return;
  if(![value.dataDir,value.projectDir,value.configDir].every(path=>typeof path==='string'&&isAbsolute(path))||typeof value.resumeComputer!=='boolean')throw new Error('更新后的启动配置无效，请使用原来的启动方式打开应用。');
  if(!existsSync(value.dataDir))throw new Error('更新前的数据目录已移动，请使用原来的启动方式打开应用。');
  return value;
}
export function saveUpdateLaunchContext(profileDir:string,value:UpdateLaunchContext){mkdirSync(profileDir,{recursive:true});atomicJson(join(profileDir,'update-launch-context.json'),value);}
