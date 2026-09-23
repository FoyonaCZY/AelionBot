import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Store} from './store';
import {FileToolError,textPage} from './file-text';

export function readToolResult(store:Store,botId:string,args:Record<string,unknown>,scope?:{kind:'group';id:string}|{kind:'private'}){
  const id=args.id;if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new FileToolError('INVALID_RESULT_ID','无效结果 ID');
  const allowed=(runId:string|undefined)=>{const run=store.data.runs.find(item=>item.id===runId&&item.botId===botId);if(!scope)return true;return scope.kind==='group'?run?.groupOrigin?.groupId===scope.id:Boolean(run&&!run.groupOrigin);};
  const ownExecution=store.data.runs.some(run=>run.botId===botId&&allowed(run.id)&&run.executions?.some(entry=>entry.resultId===id));
  const ownMessage=[...store.data.messages,...store.data.peerMessages,...store.data.groupRunMessages].some(message=>message.botId===botId&&message.role==='tool'&&allowed(message.runId)&&(()=>{try{return JSON.parse(message.content).resultId===id;}catch{return false;}})());
  if(!ownExecution&&!ownMessage)throw new FileToolError('RESULT_ACCESS_DENIED','无权读取该结果');
  const path=join(store.dir,'results',id+'.json');let text:string;
  try{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())throw new FileToolError('INVALID_RESULT_FILE','结果文件类型无效');text=readFileSync(path,'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new FileToolError('RESULT_NOT_FOUND','结果记录已不存在，请重新执行对应读取');throw error;}
  const {content,...page}=textPage(text,{offset:args.offset,maxChars:args.maxChars});return {text:content,...page};
}
