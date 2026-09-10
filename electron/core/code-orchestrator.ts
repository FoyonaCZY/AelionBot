import {Worker} from 'node:worker_threads';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {boundedInteger,FileToolError} from './file-text';
import {InteractionDenied} from './interactions';
export class CodeOrchestrator {
 private active=new Set<Worker>();
 constructor(private runtimeDir:string){}
 async run(args:Record<string,unknown>,names:string[],signal:AbortSignal,invoke:(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>){
  if(typeof args.code!=='string'||!args.code.trim()||args.code.length>64000)throw new FileToolError('INVALID_ARGUMENT','代码需要 1–64000 字符的 JavaScript');
  if(this.active.size>=4)throw Error('已有 4 个代码编排正在运行，请等待完成');
  const timeout=boundedInteger(args.timeoutMs,120000,1000,600000,'timeoutMs'),entry=join(this.runtimeDir,'code-worker.cjs');
  const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(timeout)]);combined.throwIfAborted();
  const source=join(this.runtimeDir,'code-worker.ts');
  const workerOptions={workerData:{code:args.code,names},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16}};
  const worker=existsSync(entry)?new Worker(entry,workerOptions):new Worker(`require('tsx/cjs');require(${JSON.stringify(source)})`,{eval:true,...workerOptions});this.active.add(worker);
  const inFlight=new Set<Promise<void>>();let stopped=false,calls=0;const images:unknown[]=[];
  try{return await new Promise<unknown>((resolve,reject)=>{
   const finish=(error?:Error,value?:unknown)=>{if(stopped)return;stopped=true;combined.removeEventListener('abort',abort);error?reject(error):resolve(value);};
   const abort=()=>finish(combined.reason instanceof Error?combined.reason:Error('代码编排已取消'));combined.addEventListener('abort',abort,{once:true});
   worker.on('error',error=>finish(error instanceof Error?error:Error(String(error))));worker.on('exit',code=>{if(!stopped)finish(Error(`代码运行时已退出（${code}）`));});
   worker.on('message',message=>{
    if(stopped)return;
    if(message.type==='done'){void Promise.allSettled(inFlight).then(()=>finish(undefined,{output:message.logs,value:message.value,toolCalls:calls,...(images.length?{images}:{})}));return;}
    if(message.type==='error'){finish(Error(message.error));return;}
    if(message.type!=='call')return;
    if(++calls>100||inFlight.size>=8||!names.includes(message.name)){worker.postMessage({type:'result',id:message.id,result:{ok:false,error:'工具不可用或并行调用超过 8 项，请分批调用'}});return;}
    const task=Promise.resolve().then(async()=>{
     try{combined.throwIfAborted();const value=await invoke(message.name,message.args,combined);if(stopped)return;const resultImages=(value as any)?.result?.images;if(Array.isArray(resultImages))images.push(...resultImages);worker.postMessage({type:'result',id:message.id,result:{ok:true,value}});}
     catch(error){if(error instanceof InteractionDenied){controller.abort(error);finish(error);}else if(!stopped)worker.postMessage({type:'result',id:message.id,result:{ok:false,error:error instanceof Error?error.message:String(error)}});}
    }).finally(()=>inFlight.delete(task));inFlight.add(task);
   });if(combined.aborted)abort();
  });}finally{stopped=true;controller.abort();await worker.terminate();await Promise.allSettled(inFlight);this.active.delete(worker);}
 }
 async dispose(){await Promise.all([...this.active].map(worker=>worker.terminate()));this.active.clear();}
}
