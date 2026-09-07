import {randomUUID} from 'node:crypto';
import {appendFileSync,lstatSync,renameSync} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {isAbsolute,join,relative} from 'node:path';
import {zipSync,strToU8} from 'fflate';
import type {Snapshot} from '../../src/shared';
import type {DiagnosticPreview} from '../../src/diagnostic-types';
import {diagnosticRedactor} from './diagnostic-redaction';

interface Environment {appVersion:string;platform:string;arch:string;osRelease:string;electron:string;chrome:string;node:string;packaged:boolean;cpuCount:number;memoryGiB:number;}
interface Options {dataDir:string;paths:()=>string[];secrets:()=>string[];snapshot:()=>Snapshot;environment:Environment;now?:()=>number;}
interface Tail {text:string;truncated:boolean;status:'ok'|'missing'|'unavailable';}
const LOG_BYTES=128*1024,REPORT_TTL=30*60*1000;
const pick=<T extends object,K extends keyof T>(value:T,keys:readonly K[]):Pick<T,K>=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]])) as Pick<T,K>;
const errorText=(error:unknown)=>error instanceof Error?error.stack||error.message:String(error);

export async function diagnosticTail(root:string,name:string,maxBytes=LOG_BYTES):Promise<Tail>{
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
    const path=join(root,name),before=await lstat(path),actual=await realpath(path),base=await realpath(root),inside=relative(base,actual);
    if(!before.isFile()||before.isSymbolicLink()||inside==='..'||inside.startsWith('../')||inside.startsWith('..\\')||isAbsolute(inside))return {text:'',truncated:false,status:'unavailable'};
    file=await open(path,'r');const info=await file.stat();if(!info.isFile()||info.ino!==before.ino||info.dev!==before.dev)return {text:'',truncated:false,status:'unavailable'};
    const size=Math.min(info.size,maxBytes),buffer=Buffer.alloc(size),offset=info.size-size;let read=0;
    while(read<size){const result=await file.read(buffer,read,size-read,offset+read);if(!result.bytesRead)break;read+=result.bytesRead;}
    let text=buffer.subarray(0,read).toString('utf8');if(offset>0){const newline=text.indexOf('\n');text=newline<0?'':text.slice(newline+1);}
    return {text,truncated:offset>0,status:'ok'};
  }catch(error){return {text:'',truncated:false,status:(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unavailable'};}
  finally{await file?.close().catch(()=>{});}
}

export class Diagnostics {
  private reports=new Map<string,{preview:DiagnosticPreview;archive:Uint8Array;expires:number}>();
  private pending?:Promise<DiagnosticPreview>;private disposed=false;
  constructor(private options:Options){}
  private now(){return this.options.now?.()??Date.now();}
  private scrub(){return diagnosticRedactor(this.options.secrets(),this.options.paths());}
  record(source:string,error:unknown){
    if(this.disposed)return;
    try{
      const path=join(this.options.dataDir,'diagnostic-events.jsonl');
      let info:ReturnType<typeof lstatSync>|undefined;try{info=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(info){if(!info.isFile()||info.isSymbolicLink())return;if(info.size>256*1024)renameSync(path,path+'.1');}
      appendFileSync(path,JSON.stringify({time:new Date(this.now()).toISOString(),source,message:this.scrub()(errorText(error)).slice(0,4000)})+'\n',{mode:0o600});
    }catch{/* Diagnostics must not break the operation being recorded. */}
  }
  prepare():Promise<DiagnosticPreview>{
    if(this.disposed)return Promise.reject(Error('客户端正在退出'));
    if(this.pending)return this.pending;
    const pending=this.collect().finally(()=>{if(this.pending===pending)this.pending=undefined;});this.pending=pending;return pending;
  }
  private async collect(){
    const state=this.options.snapshot(),scrub=this.scrub(),id=randomUUID(),createdAt=new Date(this.now()).toISOString();
    const clean=(value:unknown):any=>typeof value==='string'?scrub(value).slice(0,4000):Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)])):value;
    const botLabel=(id?:string)=>id?`Bot ${state.bots.findIndex(bot=>bot.id===id)+1}`:undefined;
    const model=(value:Snapshot['model'])=>pick(value,['model','protocol','contextTokens','hasKey','reasoningEffort','thinkingBudget','fallbackModel']);
    const runs=state.runs.slice(-50).map(run=>({
      ...pick(run,['id','status','startedAt','endedAt','modelCalls','toolCalls','error','resumedFromRunId','inputUpdated','groupUpdated']),
      bot:botLabel(run.botId),source:run.groupOrigin?'group':run.peerOrigin?'peer':'main',
      model:model(state.botModels?.[run.botId]||state.model),
      context:run.contextIssue?pick(run.contextIssue,['capacity','estimatedTokens','inputBudget','reason']):undefined,
      executions:run.executions?.slice(-20).map(entry=>pick(entry,['id','callId','tool','status','startedAt','endedAt','error','resultId']))
    }));
    const logNames=['events.jsonl','diagnostic-events.jsonl','diagnostic-events.jsonl.1','vm/qemu.log','vm/serial.log'];
    const tails=await Promise.all(logNames.map(name=>diagnosticTail(this.options.dataDir,name)));
    const eventLines=tails[0].text.split(/\r?\n/).filter(Boolean).slice(-200).flatMap(line=>{
      try{const event=JSON.parse(line);if(!event||typeof event.type!=='string')return [];const payload=event.payload&&typeof event.payload==='object'?event.payload:{},scalars=(value:object)=>Object.fromEntries(Object.entries(value).filter(([,value])=>['string','number','boolean'].includes(typeof value)));return [clean({...scalars(pick(event,['id','time','type'])),payload:scalars(pick(payload,['id','runId','botId','invocationId','tool','status','resultId','kind','decision','mode','previous','error']))})];}catch{return [];}
    });
    const report=clean({
      schemaVersion:1,id,createdAt,environment:this.options.environment,
      counts:{bots:state.bots.length,messages:state.messages.length,runs:state.runs.length,attachments:state.messages.reduce((count,message)=>count+(message.attachments?.length||0),0),groups:state.groups?.rooms.length||0,skills:state.skills.length,scheduledTasks:state.scheduledTasks?.length||0},
      runtime:state.runtime?pick(state.runtime,['maxTurns','maxMinutes','maxTokens','modelRetries','requestTimeoutMs','maxOutputTokens','parallelReads','progressSeconds','fileCheckpoints']):undefined,
      model:model(state.model),providers:state.providers?.map(provider=>({...pick(provider,['protocol','hasKey','modelsCheckedAt','modelsError']),modelCount:provider.models.length})),
      vm:pick(state.vm,['status','detail','lastError','imageVersion','desktopReady','appsReady','maintenance','needsReboot','diskBytes','progress']),
      desktops:Object.entries(state.computer.desktops).map(([id,desktop])=>({bot:botLabel(id),...pick(desktop,['status','manualControl','error'])})),
      updates:state.updates?pick(state.updates,['phase','currentVersion','latestVersion','checkedAt','error','manualInstall']):undefined,
      integrations:state.integrations?.servers.map((server,index)=>({server:index+1,...pick(server,['transport','enabled','status','issue','toolCount'])})),
      runs,modelUsage:state.modelUsage?.slice(-100).map(record=>({...pick(record,['id','runId','purpose','model','time','estimatedTokens','error']),usage:record.usage?pick(record.usage,['version','inputTokens','outputTokens','totalTokens','cachedTokens','cacheWriteTokens','reasoningTokens','latencyMs','attempts']):undefined})),
      logSources:logNames.map((name,index)=>({name,status:tails[index].status,truncated:tails[index].truncated})),
      excluded:['chat content','attachments and screenshots','tool arguments and outputs','configuration files and credentials','environment variables','VM disk and private keys']
    });
    const latestError=report.runs.slice().reverse().find((run:any)=>run.error);
    const env=report.environment;
    const summary=[`AelionBot ${env.appVersion}`,`系统：${env.platform} ${env.arch} / ${env.osRelease}`,`Electron：${env.electron} · Node：${env.node}`,`模型：${report.model.model||'未配置'} (${report.model.protocol||'chat'}) · 上下文：${report.model.contextTokens}`,`工作电脑：${report.vm.status} · 镜像：${report.vm.imageVersion}`,`最近任务：${report.runs.length} 项，其中 ${report.runs.filter((run:any)=>run.status==='failed'||run.status==='interrupted').length} 项失败或中断`,latestError?`最近错误：${latestError.error.slice(0,600)}`:report.vm.lastError?`电脑错误：${report.vm.lastError.slice(0,600)}`:'',`报告时间：${createdAt}`,`报告编号：${id}`].filter(Boolean).join('\n');
    const files:Record<string,Uint8Array>={
      'README.md':strToU8('# AelionBot 诊断报告\n\n'+summary+'\n\n包含环境、近期执行状态、错误和有大小限制的日志末尾。聊天正文、附件、截图、工具参数及输出、配置文件和虚拟机磁盘不在包中。\n'),
      'diagnostics.json':strToU8(JSON.stringify(report,null,2)),
      'events.jsonl':strToU8(eventLines.map(event=>JSON.stringify(event)).join('\n'))
    };
    for(let index=1;index<logNames.length;index++)if(tails[index].status==='ok'){
      const text=logNames[index].startsWith('diagnostic-events')?tails[index].text.split(/\r?\n/).filter(Boolean).flatMap(line=>{try{const row=JSON.parse(line);if(typeof row.time!=='string'||typeof row.source!=='string'||typeof row.message!=='string')return [];return [JSON.stringify(clean(pick(row,['time','source','message'])))];}catch{return [];}}).join('\n'):scrub(tails[index].text);
      files['logs/'+logNames[index].replace('vm/','')]=strToU8(text);
    }
    const archive=zipSync(files,{level:6}),fileName=`AelionBot-diagnostics-${createdAt.slice(0,10)}-${id.slice(0,8)}.zip`;
    const preview:DiagnosticPreview={id,createdAt,fileName,summary,archiveBytes:archive.length,files:Object.entries(files).map(([name,bytes])=>({name,bytes:bytes.length,...(logNames.some((log,index)=>name===(index===0?log:'logs/'+log.replace('vm/',''))&&tails[index].truncated)?{truncated:true}:{})}))};
    if(this.disposed)throw Error('客户端正在退出');
    for(const [key,entry] of this.reports)if(entry.expires<=this.now())this.reports.delete(key);
    while(this.reports.size>=3)this.reports.delete(this.reports.keys().next().value!);
    this.reports.set(id,{preview,archive,expires:this.now()+REPORT_TTL});return structuredClone(preview);
  }
  archive(id:unknown){const report=this.get(id);return {fileName:report.preview.fileName,bytes:report.archive};}
  issueUrl(id:unknown,repository:string){
    if(!/^[\w.-]+\/[\w.-]+$/.test(repository))throw Error('反馈仓库配置无效');
    const report=this.get(id),url=new URL(`https://github.com/${repository}/issues/new`);
    url.searchParams.set('title',`[问题反馈] AelionBot ${this.options.environment.appVersion}`);
    let summary=report.preview.summary.replace(/`/g,'ˋ').replace(/@/g,'[at]'),shortened=false;
    do{
      url.searchParams.set('body',`## 问题描述\n\n请描述实际结果与预期结果。\n\n## 复现步骤\n\n1. \n2. \n\n## 诊断摘要\n\n\`\`\`text\n${summary}\n\`\`\`\n${shortened?'\n摘要已截短，完整信息见诊断包。\n':''}\n## 诊断包\n\n可将导出的 ${report.preview.fileName} 拖到这里上传，也可以补充截图。`);
      if(url.href.length<=7500)break;summary=summary.slice(0,Math.max(0,summary.length-100));shortened=true;
    }while(summary.length);
    return url.href;
  }
  private get(id:unknown){
    if(this.disposed)throw Error('客户端正在退出');const report=typeof id==='string'?this.reports.get(id):undefined;
    if(!report||report.expires<=this.now())throw Error('诊断信息已过期，请刷新诊断后重试');return report;
  }
  dispose(){this.disposed=true;this.reports.clear();}
}
