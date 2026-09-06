import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {kernelPanic,isKnownClockPanic,startCiGuest} from '../scripts/ci-vm-boot';
import type {VmController} from '../electron/core/vm';
test('CI boot recovery recognizes the upstream timer panic and excludes unrelated failures',()=>{
 const timer="[    1.201609] Kernel panic - not syncing: IO-APIC + timer doesn't work! Boot with apic=debug\r\n";
 assert.equal(isKnownClockPanic(kernelPanic(timer)!),true);
 assert.equal(isKnownClockPanic(kernelPanic('[  4.2] Kernel panic - not syncing: VFS: Unable to mount root fs')!),false);
 assert.equal(kernelPanic('normal application output: Kernel panic - not syncing: example'),undefined);
 assert.equal(kernelPanic('[    2.1] systemd[1]: Started OpenSSH server'),undefined);
});
test('CI boot only retries the known panic, bounds attempts and verifies ownership',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-boot-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(join(dir,'machine.json'),JSON.stringify({id:'owned'}));
 let starts=0,quits=0,rejectStart:(error:Error)=>void=()=>{};
 const serial=join(dir,'serial.log'),panic=(message:string)=>{writeFileSync(serial,'[ 1.2] Kernel panic - not syncing: '+message+'\n');const future=new Date(Date.now()+100);utimesSync(serial,future,future);};
 const vm={dir,start:async()=>{starts++;if(starts===2)return;panic("IO-APIC + timer doesn't work!");return new Promise<void>((_resolve,reject)=>{rejectStart=reject;});},qmp:async(command:string)=>{if(command==='query-uuid')return {UUID:'owned'};if(command==='quit'){quits++;rejectStart(Error('QEMU exited'));}}} as unknown as VmController;
 const retries:string[]=[];await startCiGuest(vm,message=>retries.push(message));assert.equal(starts,2);assert.equal(quits,1);assert.equal(retries.length,1);
 starts=0;vm.start=async()=>{starts++;panic('VFS: Unable to mount root fs');return new Promise<void>((_resolve,reject)=>{rejectStart=reject;});};
 await assert.rejects(()=>startCiGuest(vm),/Unable to mount/);assert.equal(starts,1);
 starts=0;vm.start=async()=>{starts++;panic("IO-APIC + timer doesn't work!");return new Promise<void>((_resolve,reject)=>{rejectStart=reject;});};
 await assert.rejects(()=>startCiGuest(vm,()=>{}),/IO-APIC/);assert.equal(starts,3);
 quits=0;vm.qmp=async()=>({UUID:'unowned'});vm.start=async()=>{panic("IO-APIC + timer doesn't work!");await new Promise(r=>setTimeout(r,1300));};
 await assert.rejects(()=>startCiGuest(vm),/identity mismatch/);assert.equal(quits,0);
});
