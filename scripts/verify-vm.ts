import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { VmController } from '../electron/core/vm';

const proofDir=resolve('.local/proof');mkdirSync(proofDir,{recursive:true});
const events:unknown[]=[];
const proof:{startedAt:string;steps:unknown[];status:string;endedAt?:string;error?:string}={startedAt:new Date().toISOString(),steps:[],status:'running'};
const save=()=>writeFileSync(resolve(proofDir,'vm-verification.json'),JSON.stringify(proof,null,2));
const vm=new VmController({dataDir:resolve('.local/app'),runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads')});
vm.on('state',state=>{const event={at:new Date().toISOString(),...state};delete event.vncUrl;events.push(event);console.log(JSON.stringify({status:state.status,detail:state.detail,pid:state.pid}));});
const step=async(name:string,operation:()=>Promise<unknown>)=>{const started=Date.now();const result=await operation();proof.steps.push({name,durationMs:Date.now()-started,result});save();console.log(`PASS ${name}`);return result;};
try {
  await step('prepare fixed guest from verified image',()=>vm.prepare());
  await step('start guest with WHPX and SSH host-key verification',()=>vm.start());
  const identity=await step('execute inside Linux as non-root',()=>vm.execute('uname -s; id -u; pwd','verification')) as {stdout:string;exitCode:number};
  if(identity.exitCode!==0||!identity.stdout.includes('Linux')||!identity.stdout.includes('/work/verification'))throw new Error('Guest identity check failed');
  const nonce=randomUUID();
  const write=await step('create persistent file in separate work disk',()=>vm.execute(`python3 -c 'import json,os; f=open("proof.json","w"); json.dump({"nonce":"${nonce}","source":"real-guest"},f); f.flush(); os.fsync(f.fileno()); f.close(); print(open("proof.json").read())'`,'verification')) as {exitCode:number};
  if(write.exitCode!==0)throw new Error('Guest file write failed');
  await step('prepare twice retains the same guest',async()=>{const before=await vm.qmp('query-uuid');await vm.prepare();const after=await vm.qmp('query-uuid');if(before.UUID!==after.UUID)throw new Error('Duplicate guest created');return after;});
  await step('graceful stop',()=>vm.stop());
  await step('restart existing guest',()=>vm.start());
  const read=await step('file survives stop and restart',()=>vm.execute('cat proof.json','verification')) as {stdout:string;exitCode:number};
  if(read.exitCode!==0||!read.stdout.includes(nonce))throw new Error('Persistent file did not survive');
  if(!process.argv.includes('--leave-running'))await step('final graceful shutdown',()=>vm.stop());
  proof.status='passed';proof.endedAt=new Date().toISOString();save();
}catch(error){proof.status='failed';proof.error=(error as Error).message;proof.endedAt=new Date().toISOString();save();console.error(proof.error);process.exitCode=1;}
finally{writeFileSync(resolve(proofDir,'vm-events.json'),JSON.stringify(events,null,2));vm.dispose();}
