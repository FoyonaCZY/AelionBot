import {existsSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import type {VmController} from '../electron/core/vm';

export function kernelPanic(log:string){return log.match(/^\s*\[\s*\d+(?:\.\d+)?\]\s+Kernel panic - not syncing:\s*([^\r\n]+)/m)?.[1];}
export function isKnownClockPanic(message:string){return /IO-APIC \+ timer doesn't work/.test(message);}

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
