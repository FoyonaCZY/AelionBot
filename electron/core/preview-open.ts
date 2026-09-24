import {createHash} from 'node:crypto';
import {mkdirSync,lstatSync,writeFileSync,realpathSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {attachmentName} from './attachments';
import type {PreviewOpenInput,PreviewOpenTarget} from '../../src/preview-open';
export type PreviewOpenSource={path:string}|{name:string;bytes:Buffer;key:string};
export class PreviewFileOpener{
 constructor(private ops:{cacheDir:string;resolve:(target:PreviewOpenTarget)=>Promise<PreviewOpenSource>;open:(path:string)=>Promise<string>;choose:(path:string)=>Promise<boolean>;reveal:(path:string)=>void;}){}
 async open(input:PreviewOpenInput){
  if(!input||!['default','choose','folder'].includes(input.action)||!input.target||!['workspace','attachment'].includes(input.target.kind))throw Error('无效的打开方式');
  const target=input.target;if(target.kind==='workspace'&&(typeof target.botId!=='string'||typeof target.path!=='string')||target.kind==='attachment'&&typeof target.id!=='string')throw Error('无效文件');
  const source=await this.ops.resolve(target);let path:string;
  if('path' in source){path=source.path;if(!statSync(path).isFile())throw Error('原文件已不存在');}
  else{
   const root=resolve(this.ops.cacheDir);mkdirSync(root,{recursive:true});if(lstatSync(root).isSymbolicLink())throw Error('打开目录不能是符号链接');
   const key=createHash('sha256').update(source.key).update(source.bytes).digest('hex'),folder=join(root,key);mkdirSync(folder,{recursive:true});if(lstatSync(folder).isSymbolicLink()||realpathSync(folder)!==join(realpathSync(root),key))throw Error('打开目录无效');
   path=join(folder,attachmentName(source.name));try{writeFileSync(path,source.bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(lstatSync(path).isSymbolicLink()||!statSync(path).isFile())throw Error('打开文件无效');}
  }
  if(input.action==='folder'){this.ops.reveal(path);return true;}
  if(input.action==='choose')return this.ops.choose(path);
  const error=await this.ops.open(path);if(error)throw Error(error);return true;
 }
}
