import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function fileHash(path: string, algorithm = 'sha512') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export type ResourceFetch=(url:string,init?:RequestInit)=>Promise<Response>;
export interface DownloadOptions {fetch?:ResourceFetch;mirrors?:string[];attempts?:number;connectTimeoutMs?:number;idleTimeoutMs?:number;retryDelayMs?:number;signal?:AbortSignal;}
class DownloadFailure extends Error {constructor(message:string,readonly retry=true,readonly reset=false){super(message);}}
export async function verifiedDownload(url: string, destination: string, expectedHash: string, progress: (fraction: number, detail: string) => void, algorithm:'sha512'|'sha256'='sha512',options:DownloadOptions={}) {
  options.signal?.throwIfAborted();expectedHash=expectedHash.toLowerCase();
  if(!new RegExp(`^[a-f0-9]{${algorithm==='sha512'?128:64}}$`,'i').test(expectedHash))throw Error('镜像校验值无效');
  mkdirSync(dirname(destination), { recursive: true });
  if (existsSync(destination)) {
    progress(0, '正在验证已下载的镜像');
    if (await fileHash(destination,algorithm) === expectedHash) return;
    renameSync(destination,destination+'.invalid-'+Date.now());progress(0,'原镜像校验失败，正在重新下载');
  }
  const partial = `${destination}.part`;
  const sources=[...new Set([url,...(options.mirrors||[])])],attempts=Math.max(1,Math.min(5,options.attempts??3));let lastError='网络连接失败';
  for(const source of sources){if(!['https:','http:'].includes(new URL(source).protocol))throw Error('镜像地址必须使用 HTTP 或 HTTPS');
    for(let attempt=0;attempt<attempts;attempt++){
      options.signal?.throwIfAborted();const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(1_800_000),...(options.signal?[options.signal]:[])]);
      let connectTimer:ReturnType<typeof setTimeout>|undefined,idleTimer:ReturnType<typeof setTimeout>|undefined;
      try{
        const offset=existsSync(partial)?statSync(partial).size:0;
        if(offset&&await fileHash(partial,algorithm)===expectedHash){renameSync(partial,destination);return;}
        progress(0,`${offset?'继续下载':'连接镜像源'} · ${new URL(source).hostname}${attempt?` · 第 ${attempt+1} 次尝试`:''}`);
        connectTimer=setTimeout(()=>controller.abort(Error('镜像源连接超时')),options.connectTimeoutMs??30000);
        const response=await (options.fetch||fetch)(source,{headers:offset?{Range:`bytes=${offset}-`}:{},signal});clearTimeout(connectTimer);
        if(response.status===416&&offset){await response.body?.cancel();throw new DownloadFailure('下载进度已失效，重新下载',true,true);}
        if(!response.ok||!response.body){await response.body?.cancel();throw new DownloadFailure(`HTTP ${response.status}`,response.status>=500||[408,429].includes(response.status));}
        const resumed=response.status===206,range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');
        if(resumed&&(!range||Number(range[1])!==offset||Number(range[2])<offset||Number(range[3])<=Number(range[2]))){await response.body.cancel();throw new DownloadFailure('镜像源返回的续传范围不正确',true,true);}
        let bytes=resumed?offset:0,last=0;const total=resumed?Number(range![3]):Number(response.headers.get('content-length')||0),stream=Readable.fromWeb(response.body as never);
        const idle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>controller.abort(Error('镜像下载长时间没有收到数据')),options.idleTimeoutMs??60000);};idle();
        stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;idle();if(Date.now()-last>700){last=Date.now();progress(total?Math.min(1,bytes/total):0,`下载镜像 ${Math.round(bytes/1048576)}${total?' / '+Math.round(total/1048576):''} MB`);}});
        await pipeline(stream,createWriteStream(partial,{flags:resumed?'a':'w'}),{signal});clearTimeout(idleTimer);
        if(total&&bytes!==total)throw new DownloadFailure('镜像传输未完成');
        progress(1,'正在校验镜像完整性');if(await fileHash(partial,algorithm)!==expectedHash)throw new DownloadFailure('镜像完整性校验失败',false,true);
        renameSync(partial,destination);return;
      }catch(error){
        options.signal?.throwIfAborted();lastError=controller.signal.aborted?String(controller.signal.reason?.message||'连接超时'):(error as Error).message;
        if(['ENOSPC','EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code||''))throw Error('无法保存系统镜像，请检查磁盘空间和下载目录的访问权限。');
        if(error instanceof DownloadFailure&&error.reset&&existsSync(partial))unlinkSync(partial);
        if(error instanceof DownloadFailure&&!error.retry)break;
        if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,(options.retryDelayMs??800)*(attempt+1)));
      }finally{clearTimeout(connectTimer);clearTimeout(idleTimer);}
    }
  }
  throw Error(`系统镜像下载失败：${lastError}。已保留可续传的数据，请检查网络或系统代理后重试。`);
}
