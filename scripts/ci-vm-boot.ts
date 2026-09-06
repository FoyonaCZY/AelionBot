import {existsSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {qemuBinary,qemuDataDir} from '../electron/core/vm-platform';
import type {VmController} from '../electron/core/vm';

export function kernelPanic(log:string){return log.match(/^\s*\[\s*\d+(?:\.\d+)?\]\s+Kernel panic - not syncing:\s*([^\r\n]+)/m)?.[1];}
export function isKnownClockPanic(message:string){return /IO-APIC \+ timer doesn't work/.test(message);}

export function ciVmAccelerator(runtime:string,arch=process.arch):'hvf'|'tcg'{
 if(process.platform!=='darwin')return 'tcg';
 const env:NodeJS.ProcessEnv={...process.env,QEMU_MODULE_DIR:join(runtime,'lib','qemu')};delete env.DYLD_LIBRARY_PATH;delete env.DYLD_FALLBACK_LIBRARY_PATH;delete env.DYLD_INSERT_LIBRARIES;
 const executable=qemuBinary(runtime,`qemu-system-${arch==='arm64'?'aarch64':'x86_64'}`);
 const result=spawnSync(executable,['-L',qemuDataDir(runtime),'-machine',arch==='arm64'?'virt':'q35','-accel','hvf','-cpu','host','-m','256','-smp','1','-nodefaults','-display','none','-S','-monitor','stdio'],{input:'quit\n',encoding:'utf8',timeout:15000,killSignal:'SIGKILL',env});
 if(result.status===0){console.log('HVF capability probe succeeded; using hardware acceleration');return 'hvf';}
 console.log('HVF unavailable on this runner; using TCG: '+String(result.stderr||result.error||result.status).slice(-800));return 'tcg';
}

// Disposable CI guests only. QEMU can fail its initial timer check on hosted Intel Macs.
// Never retry tool calls or application work; this runs before the guest accepts commands.
export async function startCiGuest(vm:VmController,onRetry:(message:string)=>void=console.warn){
 for(let attempt=0;attempt<3;attempt++){
  const started=Date.now(),serial=join(vm.dir,'serial.log');let panic:string|undefined,failure:unknown,identityError:Error|undefined,watching=false,pending=Promise.resolve();
  const inspect=async()=>{
   if(panic||!existsSync(serial)||statSync(serial).mtimeMs<started)return;
   const detected=kernelPanic(readFileSync(serial,'utf8').slice(-64000));if(!detected)return;
   const record=JSON.parse(readFileSync(join(vm.dir,'machine.json'),'utf8'));
   if((await vm.qmp('query-uuid')).UUID!==record.id){identityError=Error('CI guest identity mismatch');return;}
   panic=detected;
   await vm.qmp('quit').catch(()=>{});
  };
  const timer=setInterval(()=>{if(watching||identityError)return;watching=true;pending=inspect().catch(()=>{}).finally(()=>{watching=false;});},1000);
  try{await vm.start();}catch(error){failure=error;}
  finally{clearInterval(timer);await pending;}
  if(identityError)throw identityError;
  if(!failure&&!panic)return;
  const message=panic||String((failure as Error)?.message||failure);
  if(attempt===2||!isKnownClockPanic(message))throw Error(message);
  onRetry(`Retrying known QEMU timer initialization failure (${attempt+2}/3): ${message}`);
 }
}
