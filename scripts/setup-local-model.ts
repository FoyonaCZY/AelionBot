import {resolve,join} from 'node:path';
import {existsSync,mkdirSync,readFileSync,readdirSync,statSync,openSync,closeSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {verifiedDownload} from '../electron/core/download';
const require=createRequire(import.meta.url);
const folder=resolve('runtime/local-model');mkdirSync(folder,{recursive:true});
let last=0;const progress=(_value:number,text:string)=>{if(Date.now()-last>5000){last=Date.now();console.log(text);}};
const zip=join(folder,'llama-b10816-win-cpu.zip');
await verifiedDownload('https://github.com/ggml-org/llama.cpp/releases/download/b10816/llama-b10816-bin-win-cpu-x64.zip',zip,'b25d1044a9d6061129ce6f3439697b04996c63b9bdccf025a24a10d6d4954766',progress,'sha256');
const findServer=(dir:string):string|undefined=>{for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory()){const found=findServer(path);if(found)return found;}else if(name==='llama-server.exe')return path;}return undefined;};
let executable=findServer(folder);
if(!executable){await new Promise<void>((ok,fail)=>{const child=spawn(require('7zip-bin').path7za,['x',zip,`-o${join(folder,'server')}`,'-y'],{windowsHide:true,stdio:'ignore'});child.on('error',fail);child.on('exit',code=>code===0?ok():fail(new Error(`Extraction failed: ${code}`)));});executable=findServer(folder);}
if(!executable)throw new Error('llama-server executable missing');
const weights=join(folder,'Qwen3-1.7B-Q8_0.gguf');
await verifiedDownload('https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/90862c4b9d2787eaed51d12237eafdfe7c5f6077/Qwen3-1.7B-Q8_0.gguf',weights,'061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a',progress,'sha256');
const proof=resolve('.local/proof');mkdirSync(proof,{recursive:true});
const port=38931;
try{const health=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});if(health.ok){console.log('An existing local model service is already healthy; not starting a duplicate.');process.exit(0);}}catch{}
const stdout=openSync(join(proof,'local-model.stdout.log'),'a'),stderr=openSync(join(proof,'local-model.stderr.log'),'a');
const child=spawn(executable,['--model',weights,'--alias','aelion-local','--ctx-size','16384','--threads','6','--parallel','1','--jinja','--chat-template-kwargs','{"enable_thinking":false}','--reasoning-budget','0','--host','127.0.0.1','--port',String(port)],{windowsHide:true,detached:true,stdio:['ignore',stdout,stderr]});
await new Promise<void>((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});closeSync(stdout);closeSync(stderr);child.unref();
const receipt={pid:child.pid,port,model:'Qwen3-1.7B-Q8_0',alias:'aelion-local',modelSha256:'061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a',runtime:'llama.cpp b10816',startedAt:new Date().toISOString()};
writeFileSync(join(proof,'local-model-process.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
for(let i=0;i<60;i++){
  try{const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok){console.log('Local model service healthy');process.exit(0);}}catch{}
  try{process.kill(child.pid!,0);}catch{throw new Error(`Model server exited: ${readFileSync(join(proof,'local-model.stderr.log'),'utf8').slice(-1800)}`);}
  await new Promise(resolve=>setTimeout(resolve,1000));
}
throw new Error('Model server is still starting; inspect its existing process instead of launching a duplicate.');
