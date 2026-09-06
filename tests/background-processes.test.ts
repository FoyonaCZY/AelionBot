import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../electron/core/store';
import {HostComputer} from '../electron/core/host';
import {Interactions} from '../electron/core/interactions';
import {BackgroundProcesses} from '../electron/core/background-processes';
import type {VmController} from '../electron/core/vm';
test('host processes require approval, preserve logs across manager restart and stop through their supervisor',{skip:process.platform!=='win32',timeout:20000},async t=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'aelion-background-'))),store=new Store(dir),bot=store.data.bots[0],other=store.createBot('other','scope'),interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:dir,homeDir:dir,projectDir:dir},interactions),manager=new BackgroundProcesses(store,{} as VmController,host,interactions),signal=new AbortController().signal;
 let id:string|undefined;
 t.after(async()=>{if(id)await manager.stop(bot.id,id,AbortSignal.timeout(6000)).catch(()=>{});interactions.dispose();host.dispose();rmSync(dir,{recursive:true,force:true});});
 const started=manager.start(bot.id,'r',{location:'host',purpose:'service',cwd:dir,reason:'测试后台任务',command:"[Console]::WriteLine('ready'); Start-Sleep -Seconds 60"},signal);assert.equal(interactions.snapshot().length,1);interactions.approve(interactions.snapshot()[0].id,true);id=(await started).id;
 let output='';for(let n=0;n<30&&!output.includes('ready');n++){await new Promise(r=>setTimeout(r,100));output=(await manager.status(bot.id,id,signal)).output;}assert.match(output,/ready/);
 const restored=new BackgroundProcesses(new Store(dir),{} as VmController,host,interactions);assert.match((await restored.status(bot.id,id,signal)).output,/ready/);await assert.rejects(restored.status(other.id,id,signal),/不属于/);
 const stopped=await manager.stop(bot.id,id,signal);assert.equal(stopped.status,'stopped');
});
