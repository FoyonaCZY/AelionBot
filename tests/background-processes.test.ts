import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../electron/core/store';
import {HostComputer} from '../electron/core/host';
import {Interactions} from '../electron/core/interactions';
import {BackgroundProcesses} from '../electron/core/background-processes';
import type {VmController} from '../electron/core/vm';
test('host processes require approval, preserve logs across manager restart and stop through their supervisor',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'aelion-background-'))),store=new Store(dir),bot=store.data.bots[0],other=store.createBot('other','scope'),interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:dir,homeDir:dir,projectDir:dir},interactions),manager=new BackgroundProcesses(store,{} as VmController,host,interactions),signal=new AbortController().signal;
 let id:string|undefined;
 t.after(async()=>{if(id)await manager.stop(bot.id,id,AbortSignal.timeout(6000)).catch(()=>{});interactions.dispose();host.dispose();rmSync(dir,{recursive:true,force:true});});
 const started=manager.start(bot.id,'r',{location:'host',purpose:'service',cwd:dir,reason:'测试后台任务',command:"[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); Start-Sleep -Seconds 60"},signal);assert.equal(interactions.snapshot().length,1);interactions.approve(interactions.snapshot()[0].id,true);id=(await started).id;
 let output='',status='starting';for(let n=0;n<150&&!output.includes('ready')&&['starting','running'].includes(status);n++){if(n)await new Promise(r=>setTimeout(r,100));const snapshot=await manager.status(bot.id,id,signal);output=snapshot.output;status=snapshot.status;}assert.match(output,/ready/);
 const restored=new BackgroundProcesses(new Store(dir),{} as VmController,host,interactions);assert.match((await restored.status(bot.id,id,signal)).output,/ready/);await assert.rejects(restored.status(other.id,id,signal),/不属于/);
 const stopped=await manager.stop(bot.id,id,signal);assert.equal(stopped.status,'stopped');
});
test('VM background services can be dropped when the work computer is off',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-background-off-')),store=new Store(dir),bot=store.data.bots[0];
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const vm={state:{status:'stopped'},execute:async()=>{throw new Error('工作电脑尚未就绪或正在维护');}} as unknown as VmController;
 const manager=new BackgroundProcesses(store,vm),id=randomUUID();
 store.data.processes!.push({id,botId:bot.id,runId:'r',location:'vm',purpose:'service',command:'python3 -m http.server',cwd:'/work/'+bot.id,createdAt:new Date().toISOString(),status:'running'});
 const stopped=await manager.stop(bot.id,id,new AbortController().signal);
 assert.equal(stopped.status,'stopped');assert.equal(store.data.processes!.find(item=>item.id===id)?.status,'stopped');
});
