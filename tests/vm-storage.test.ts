import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,truncateSync,statSync,renameSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {VmStorage} from '../electron/core/vm-storage';
import {VmController} from '../electron/core/vm';
import {GiB,DEFAULT_VM_STORAGE,vmStorageSettings,storagePressure} from '../src/vm-storage';
function directory(t:test.TestContext){const dir=mkdtempSync(join(tmpdir(),'aelion-storage-'));t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});return dir;}
function fake(t:test.TestContext,failCompare=false){const dir=directory(t);writeFileSync(join(dir,'system.qcow2'),Buffer.alloc(1024,7));const calls:string[][]=[];const storage=new VmStorage(dir,'v2',async args=>{calls.push(args);if(args[0]==='info')return JSON.stringify({format:'qcow2'});if(args[0]==='convert'&&args[1]==='--help')return '-b BACKING_FILE';if(args[0]==='convert')writeFileSync(args.at(-1)!,Buffer.alloc(128,7));if(args[0]==='compare'&&failCompare)throw Error('mismatch');return '';});storage.setSettings({limitGiB:DEFAULT_VM_STORAGE.limitGiB,reclaimAfterUpdate:true});return {dir,storage,calls};}
test('storage defaults are finite, persist, and leave a reserve before protection pauses',t=>{
 const dir=directory(t),s=new VmStorage(dir,'v1',async()=>''),defaults=s.snapshot().settings;assert.deepEqual(defaults,DEFAULT_VM_STORAGE);assert.equal(defaults.reclaimAfterUpdate,false);
 s.setSettings({limitGiB:20,reclaimAfterUpdate:false});assert.equal(new VmStorage(dir,'v2',async()=>'').snapshot().settings.limitGiB,20);assert.equal(s.pending,false);
 for(const n of [0,7,257,NaN,Infinity,12.5])assert.throws(()=>vmStorageSettings({limitGiB:n,reclaimAfterUpdate:true}));
 assert.equal(storagePressure(11*GiB,DEFAULT_VM_STORAGE),'pause');assert.equal(storagePressure(10*GiB,DEFAULT_VM_STORAGE),'warning');
});
test('budget accounting includes base image, work disk, and VM logs',t=>{
 const dir=directory(t);for(const [name,size] of [['base.qcow2',10],['system.qcow2',20],['work.qcow2',30],['serial.log',40]] as const)writeFileSync(join(dir,name),Buffer.alloc(size));
 assert.equal(new VmStorage(dir,'v1',async()=>'').snapshot().usageBytes,100);
});
test('compaction verifies before replacing and marks the current version only on success',async t=>{
 const f=fake(t);assert.equal(f.storage.pending,true);await f.storage.reclaim(()=>{});assert.equal(statSync(join(f.dir,'system.qcow2')).size,128);assert.equal(f.storage.pending,false);assert.equal(f.calls.filter(c=>c[0]==='check').length,2);assert.ok(f.calls.some(c=>c[0]==='compare'));assert.equal(readdirSync(f.dir).some(name=>/previous|compact|transaction/.test(name)),false);
 assert.equal(new VmStorage(f.dir,'v3',async()=>'').pending,true);
});
test('comparison failure or a running VM retains the original and keeps upgrade reclamation pending',async t=>{
 const f=fake(t,true),original=readFileSync(join(f.dir,'system.qcow2'));await assert.rejects(f.storage.reclaim(()=>{}),/mismatch/);assert.deepEqual(readFileSync(join(f.dir,'system.qcow2')),original);assert.equal(f.storage.pending,true);assert.equal(readdirSync(f.dir).some(name=>/previous|compact|transaction/.test(name)),false);
 await assert.rejects(f.storage.reclaim(()=>{throw Error('running');}),/running/);assert.deepEqual(readFileSync(join(f.dir,'system.qcow2')),original);
});
test('interrupted swaps recover the original; committed swaps keep the validated replacement',t=>{
 for(const stage of ['pending','committed']){
  const f=fake(t),id=randomUUID(),candidate='system.compact-'+id+'.qcow2',backup='system.previous-'+id+'.qcow2';renameSync(join(f.dir,'system.qcow2'),join(f.dir,backup));writeFileSync(join(f.dir,'system.qcow2'),'replacement');writeFileSync(join(f.dir,'storage-transaction.json'),JSON.stringify({original:'system.qcow2',candidate,backup,stage}));f.storage.recover();assert.equal(statSync(join(f.dir,'system.qcow2')).size,stage==='pending'?1024:11);assert.equal(existsSync(join(f.dir,backup)),false);
 }
});
test('invalid recovery paths cannot delete files outside the managed transaction',t=>{
 const f=fake(t);writeFileSync(join(f.dir,'storage-transaction.json'),JSON.stringify({original:'system.qcow2',candidate:'../work.qcow2',backup:'work.qcow2',stage:'pending'}));assert.throws(()=>f.storage.recover());assert.equal(statSync(join(f.dir,'system.qcow2')).size,1024);
});
test('capacity protection pauses only its verified VM and resumes after the budget increases',async t=>{
 const f=fake(t),commands:string[]=[],vm=Object.assign(Object.create(VmController.prototype),{storage:f.storage,record:{id:'own',pid:process.pid},stateValue:{status:'ready'},health:{close:()=>{}},qmp:async(name:string)=>{commands.push(name);return name==='query-uuid'?{UUID:'own'}:{};},publishStorage:()=>{},update:()=>{}});
 const snapshot=f.storage.snapshot.bind(f.storage);f.storage.snapshot=()=>({...snapshot(),usageBytes:11*GiB});await vm.checkStorageBudget();assert.equal(f.storage.paused,true);assert.deepEqual(commands,['query-uuid','stop']);await vm.saveStorageSettings({limitGiB:20,reclaimAfterUpdate:true});assert.equal(f.storage.paused,false);assert.ok(commands.includes('cont'));
 f.storage.setPaused(false);f.storage.setSettings(DEFAULT_VM_STORAGE);vm.qmp=async(name:string)=>{commands.push(name);return {UUID:'foreign'};};commands.length=0;await vm.checkStorageBudget();assert.deepEqual(commands,['query-uuid']);assert.equal(f.storage.paused,false);
});
const img=process.env.AELION_TEST_QEMU_IMG||'qemu-img',probe=spawnSync(img,['--version'],{windowsHide:true,timeout:10000});
if(process.env.AELION_TEST_QEMU_IMG)assert.equal(probe.status,0);
test('real qcow2 reclaim preserves guest bytes and backing chain while reducing image length',{skip:probe.status!==0},async t=>{
 const dir=directory(t),run=(args:string[])=>{const r=spawnSync(img,args,{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(r.status,0,r.stderr);return r.stdout;};
 const raw=join(dir,'source.raw'),data=Buffer.alloc(8*1024*1024);data.fill(93,1024,4096);writeFileSync(raw,data);run(['convert','-f','raw','-O','qcow2',raw,join(dir,'base.qcow2')]);run(['create','-f','qcow2','-F','qcow2','-b',join(dir,'base.qcow2'),join(dir,'system.qcow2')]);run(['convert','-f','raw','-O','qcow2',raw,join(dir,'work.qcow2')]);
 truncateSync(join(dir,'system.qcow2'),16*1024*1024);truncateSync(join(dir,'work.qcow2'),16*1024*1024);const storage=VmStorage.forQemu(dir,'v2',img);const freed=await storage.reclaim(()=>{});assert.ok(freed>20*1024*1024);
 run(['compare','-f','raw','-F','qcow2',raw,join(dir,'system.qcow2')]);run(['compare','-f','raw','-F','qcow2',raw,join(dir,'work.qcow2')]);assert.equal(JSON.parse(run(['info','--output=json',join(dir,'system.qcow2')]))['full-backing-filename'],join(dir,'base.qcow2'));
});