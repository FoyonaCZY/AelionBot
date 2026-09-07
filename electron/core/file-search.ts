import {Worker} from 'node:worker_threads';
import {join} from 'node:path';
import {FileToolError} from './file-text';
import type {FileSearchRequest,FileSearchResult} from './file-search-types';

interface Pending {request:FileSearchRequest;signal:AbortSignal;resolve:(result:FileSearchResult)=>void;reject:(error:unknown)=>void;abort:()=>void;}
export class FileSearch {
  private queue:Pending[]=[];private active=new Map<Pending,()=>void>();private disposed=false;
  constructor(private runtimeDir:string|undefined,private timeoutMs=5000,private concurrency=4){}
  run(request:FileSearchRequest,signal:AbortSignal):Promise<FileSearchResult>{
    if(!this.runtimeDir)return Promise.reject(new FileToolError('SEARCH_UNAVAILABLE','文件检索运行时未准备好，请更新客户端'));
    if(this.disposed)return Promise.reject(Error('本机检索已停止'));if(signal.aborted)return Promise.reject(signal.reason);
    return new Promise((resolve,reject)=>{
      const pending:Pending={request:structuredClone(request),signal,resolve,reject,abort:()=>{const index=this.queue.indexOf(pending);if(index>=0){this.queue.splice(index,1);signal.removeEventListener('abort',pending.abort);reject(signal.reason);}else this.active.get(pending)?.();}};
      signal.addEventListener('abort',pending.abort,{once:true});this.queue.push(pending);this.pump();
    });
  }
  private pump(){
    while(!this.disposed&&this.active.size<this.concurrency&&this.queue.length){
      const pending=this.queue.shift()!;let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,finished=false;
      const finish=(error?:unknown,result?:FileSearchResult)=>{if(finished)return;finished=true;if(timer)clearTimeout(timer);pending.signal.removeEventListener('abort',pending.abort);this.active.delete(pending);void worker?.terminate().catch(()=>{});if(error!==undefined)pending.reject(error);else pending.resolve(result!);this.pump();};
      this.active.set(pending,()=>finish(pending.signal.reason||Error('本机检索已停止')));
      try{
        worker=new Worker(join(this.runtimeDir!,'file-search-worker.cjs'),{workerData:pending.request,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16}});
        worker.on('message',message=>{if(message?.ok===true)finish(undefined,message.result);else finish(new FileToolError(typeof message?.errorCode==='string'?message.errorCode:'SEARCH_FAILED',String(message?.error||'文件检索失败')));});
        worker.once('error',()=>finish(new FileToolError('SEARCH_FAILED','文件检索进程异常，请缩小范围后重试')));
        worker.once('exit',()=>{if(!finished)finish(new FileToolError('SEARCH_FAILED','文件检索未返回完整结果，请重试'));});
        timer=setTimeout(()=>finish(new FileToolError('SEARCH_TIMEOUT','文件检索超时，请缩小 path、glob，或改用 regex=false')),this.timeoutMs);timer.unref();
        if(pending.signal.aborted)this.active.get(pending)?.();
      }catch(error){finish(error);}
    }
  }
  dispose(){this.disposed=true;for(const pending of this.queue){pending.signal.removeEventListener('abort',pending.abort);pending.reject(Error('本机检索已停止'));}this.queue=[];for(const stop of [...this.active.values()])stop();}
}
