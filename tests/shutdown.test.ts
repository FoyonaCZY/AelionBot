import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Shutdown} from '../electron/core/shutdown';
import {shutdownOwnedVm} from '../electron/core/vm-shutdown';
import {stopOwnedQemuWindows,inspectOwnedQemuWindows} from '../electron/core/owned-qemu';
import {VmController} from '../electron/core/vm';

test('shutdown drains work once, always closes VM after errors, and persists before exit',async()=>{
  const events:string[]=[];const close=new Shutdown({stop:()=>{events.push('stop');},closeWork:()=>[Promise.reject(Error('MCP failed'))],closeVm:async()=>{events.push('vm');},closeState:()=>{events.push('saved');},exit:()=>{events.push('exit');},report:()=>{events.push('error');}});
  const a=close.run(),b=close.run();assert.equal(a,b);await a;assert.deepEqual(events,['stop','error','vm','saved','exit']);
});
test('hung work cleanup cannot prevent VM shutdown, including broken diagnostic logging',async()=>{
  const events:string[]=[];const close=new Shutdown({stop:()=>{throw Error('stop');},closeWork:()=>[new Promise(()=>{})],closeVm:async()=>{events.push('vm');},closeState:()=>{throw Error('disk');},exit:()=>{events.push('exit');},report:()=>{throw Error('logger');}},20);
  await close.run();assert.deepEqual(events,['vm','exit']);
});
test('owned VM shutdown uses graceful poweroff first and bounded verified fallback',async()=>{
  let alive=true,time=0;const commands:string[]=[],target={id:'expected',pid:1};
  const ops={alive:()=>alive,now:()=>time,sleep:async(ms:number)=>{time+=ms;},qmp:async(command:string)=>{commands.push(command);if(command==='query-uuid')return {UUID:'expected'};if(command==='quit')alive=false;return {};},force:async()=>{throw Error('Unexpected OS kill');}};
  assert.equal((await shutdownOwnedVm(target,ops)).method,'qmp-quit');assert.deepEqual(commands,['query-uuid','system_powerdown','quit']);assert.equal(time,15000);
  alive=true;time=0;commands.length=0;ops.qmp=async(command:string)=>{commands.push(command);if(command==='query-uuid')return {UUID:'expected'};alive=false;return {};};assert.equal((await shutdownOwnedVm(target,ops)).method,'powerdown');assert.equal(time,0);
});
test('foreign UUIDs never receive shutdown commands or OS termination',async()=>{
  let forced=false;await assert.rejects(shutdownOwnedVm({id:'expected',pid:1},{alive:()=>true,qmp:async()=>({UUID:'foreign'}),force:async()=>{forced=true;return true;}}),/身份不匹配/);assert.equal(forced,false);
  await assert.rejects(shutdownOwnedVm({id:'expected',pid:1},{alive:()=>true,qmp:async()=>{throw Error('closed');},force:async()=>false}),/身份未核验/);
});

function fixture(t:test.TestContext){
  const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-shutdown-')),dir=join(root,'vm');mkdirSync(dir);const id=randomUUID();
  const record={id,pid:undefined as number|undefined,qmpPort:0,sshPort:0,vncPort:0,seedPort:0,seedToken:'fixture',hostKeyHash:'fixture',preparedAt:new Date().toISOString()};
  const save=()=>writeFileSync(join(dir,'machine.json'),JSON.stringify(record));save();
  t.after(()=>{assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});return {root,dir,id,record,save};
}
test('QMP power commands verify UUID on their own connection and tolerate quit closing the socket',async t=>{
  const f=fixture(t),commands:string[]=[];let identity:string=f.id;const sockets=new Set<import('node:net').Socket>();
  const server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.write('{"QMP":{}}\n');let text='';socket.on('data',data=>{text+=data;let at;while((at=text.indexOf('\n'))>=0){const command=JSON.parse(text.slice(0,at));text=text.slice(at+1);commands.push(command.execute);if(command.execute==='quit'){socket.end();continue;}socket.write(JSON.stringify({id:command.id,return:command.execute==='query-uuid'?{UUID:identity}:{}})+'\n');}});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});f.record.qmpPort=(server.address() as {port:number}).port;f.save();
  const vm=new VmController({dataDir:f.root,runtimeDir:f.root,cacheDir:f.root});await vm.qmp('system_powerdown');assert.deepEqual(commands,['qmp_capabilities','query-uuid','system_powerdown']);commands.length=0;await vm.qmp('quit');assert.deepEqual(commands,['qmp_capabilities','query-uuid','quit']);
  identity='foreign';commands.length=0;await assert.rejects(vm.qmp('quit'),/身份不匹配/);assert.deepEqual(commands,['qmp_capabilities','query-uuid']);vm.dispose();
});
test('beginning exit prevents a pending startup from launching QEMU and clears dead VM PIDs',async t=>{
  const f=fixture(t),vm=new VmController({dataDir:f.root,runtimeDir:f.root,cacheDir:f.root});writeFileSync(vm.executable,'not executable');
  let release!:()=>void,entered!:()=>void;const enteredPromise=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  (vm as any).refresh=async()=>vm.state;(vm as any).seed=async()=>{entered();await held;};const start=vm.start();await enteredPromise;vm.beginShutdown();await vm.shutdownForExit();release();await assert.rejects(start,/正在退出/);assert.equal(JSON.parse(readFileSync(join(f.dir,'machine.json'),'utf8')).pid,undefined);await assert.rejects(vm.start(),/正在退出/);vm.dispose();
});
test('Windows process fallback cannot kill a process with a different UUID',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t),script=join(f.root,'child.cjs');writeFileSync(script,'setInterval(()=>{},1000);');const child=spawn(process.execPath,[script,'-uuid',f.id,'-drive',`file=${join(f.dir,'system.qcow2')},if=none`,'-drive',`file=${join(f.dir,'work.qcow2')},if=none`],{windowsHide:true,stdio:'ignore'});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{if(child.exitCode===null)child.kill();});
  const input={pid:child.pid!,id:randomUUID(),executable:process.execPath,systemDisk:join(f.dir,'system.qcow2'),workDisk:join(f.dir,'work.qcow2')};assert.equal(await stopOwnedQemuWindows(input),false);assert.equal(child.exitCode,null);
  assert.equal(await inspectOwnedQemuWindows(input),'foreign');assert.equal(await inspectOwnedQemuWindows({...input,id:f.id}),'owned');assert.equal(child.exitCode,null);
  assert.equal(await stopOwnedQemuWindows({...input,id:f.id}),true);await new Promise<void>(resolve=>child.exitCode!==null?resolve():child.once('exit',()=>resolve()));
});

test('a recycled PID is cleared without terminating the unrelated process',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);f.record.pid=process.pid;f.save();writeFileSync(join(f.dir,'system.qcow2'),'');writeFileSync(join(f.dir,'work.qcow2'),'');
  const vm=new VmController({dataDir:f.root,runtimeDir:f.root,cacheDir:f.root});(vm as any).qmp=async()=>{throw Error('connection refused');};await vm.refresh();
  assert.equal(vm.state.status,'stopped');assert.equal(JSON.parse(readFileSync(join(f.dir,'machine.json'),'utf8')).pid,undefined);assert.doesNotThrow(()=>process.kill(process.pid,0));vm.dispose();
});
