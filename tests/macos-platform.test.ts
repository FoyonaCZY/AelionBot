import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {hostPathKey,hostShell,hostEnvironment} from '../electron/core/host-platform';
import {CommandPermissions} from '../electron/core/command-permissions';
import {HostComputer} from '../electron/core/host';
import {Interactions,InteractionDenied} from '../electron/core/interactions';
import {BackgroundProcesses} from '../electron/core/background-processes';
import {vmPlatform,vmMachineArgs} from '../electron/core/vm-platform';
import type {VmController} from '../electron/core/vm';
import type {HostPermissionDetails} from '../src/shared';
import {DESKTOP_SCRIPT} from '../electron/core/desktop-profile';
const temporary=(t:test.TestContext)=>{const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'aelion-macos-test-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
test('native host shell preserves code as one argument and POSIX paths keep their case',()=>{
 const command="printf '%s' '中文; $literal'";
 assert.deepEqual(hostShell(command,{},'darwin'),{executable:'/bin/zsh',args:['-l','-c',command],detached:true});
 assert.notEqual(hostPathKey('/work/A','darwin'),hostPathKey('/work/a','darwin'));
 assert.equal(hostPathKey('C:\\Work\\A','win32'),hostPathKey('c:/work/a/','win32'));
 assert.ok(hostEnvironment({PATH:'/usr/bin:/bin'},'darwin').PATH?.startsWith('/opt/homebrew/bin:/usr/local/bin:'));
});
test('Mac command grants are bound to shell platform, exact case, and reject shell substitution as a prefix',t=>{
 const file=join(temporary(t),'rules.json'),rules=new CommandPermissions(file,v=>v,'darwin'),details=(command:string,cwd='/Users/example/Project'):HostPermissionDetails=>({operation:'command',command,cwd,reason:'check'});
 const saved=rules.allow(details('git status --short'));assert.equal(saved.pattern,'git status *');assert.ok(rules.match(details('git status --porcelain')));
 assert.equal(rules.match(details('GIT status')),undefined);assert.equal(rules.match(details('git status','/Users/example/project')),undefined);
 for(const command of ['git status; touch proof','git status $(whoami)','git status `whoami`','git status\\;touch proof','git status | sh'])assert.equal(rules.match(details(command)),undefined);
 assert.equal(new CommandPermissions(file,v=>v,'win32').list().length,0);assert.ok(new CommandPermissions(file,v=>v,'darwin').match(details('git status')));
});
test('Mac virtual machines choose native images, hardware accelerator and ARM firmware',t=>{
 const runtime=temporary(t);mkdirSync(join(runtime,'share','qemu'),{recursive:true});for(const name of ['edk2-aarch64-code.fd','edk2-arm-vars.fd'])writeFileSync(join(runtime,'share','qemu',name),'fixture');
 const arm=vmPlatform('darwin','arm64'),intel=vmPlatform('darwin','x64');assert.equal(arm.accelerator,'hvf');assert.ok(arm.image.filename.includes('arm64'));assert.ok(intel.image.filename.includes('amd64'));
 const args=vmMachineArgs(arm,runtime,join(runtime,'vars.fd'));assert.ok(args.includes('host'));assert.ok(args.includes('virt'));assert.ok(args.some(a=>a.includes('edk2-aarch64-code.fd')));assert.ok(!args.includes('whpx'));assert.ok(!args.includes('q35'));
 assert.ok(vmMachineArgs(arm,runtime,join(runtime,'vars.fd'),'tcg').includes('cortex-a72'));assert.ok(DESKTOP_SCRIPT.includes('linux-image-$arch'));assert.ok(DESKTOP_SCRIPT.includes('apt-get install -y --no-install-recommends chromium'));
});
test('POSIX execution awaits permission and keeps nonzero exit codes and Unicode',{skip:process.platform==='win32'},async t=>{
 const root=temporary(t),interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:root,homeDir:root,projectDir:root},interactions);t.after(()=>{interactions.dispose();host.dispose();});
 const refused=host.execute('bot','r',{command:'touch must-not-exist',cwd:root,reason:'test'},new AbortController().signal),refusedCheck=assert.rejects(refused,InteractionDenied);interactions.approve(interactions.snapshot()[0].id,false);await refusedCheck;
 const pending=host.execute('bot','r',{command:"printf '中文'; exit 7",cwd:root,reason:'test'},new AbortController().signal);assert.equal(interactions.snapshot().length,1);interactions.approve(interactions.snapshot()[0].id,true);const result=await pending;assert.equal(result.stdout,'中文');assert.equal(result.exitCode,7);
});
test('POSIX foreground cancellation terminates the owned process group',{skip:process.platform==='win32'},async t=>{
 const root=temporary(t),interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:root,homeDir:root,projectDir:root},interactions),controller=new AbortController();t.after(()=>{interactions.dispose();host.dispose();});
 const pending=host.execute('bot','r',{command:'sleep 60 & wait',cwd:root,reason:'cancel test'},controller.signal);interactions.approve(interactions.snapshot()[0].id,true);await new Promise(r=>setTimeout(r,100));controller.abort();const result=await pending;assert.equal(result.cancelled,true);assert.ok(result.durationMs<5000);
});
test('POSIX background supervisor streams logs and stops its own service',{skip:process.platform==='win32'},async t=>{
 const root=temporary(t),{Store}=await import('../electron/core/store'),store=new Store(root),bot=store.data.bots[0],interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:root,homeDir:root,projectDir:root},interactions),manager=new BackgroundProcesses(store,{} as VmController,host,interactions),signal=new AbortController().signal;let id='';
 t.after(async()=>{if(id)await manager.stop(bot.id,id,AbortSignal.timeout(6000)).catch(()=>{});interactions.dispose();host.dispose();});
 const starting=manager.start(bot.id,'r',{location:'host',purpose:'service',command:"printf 'ready'; sleep 60",cwd:root,reason:'test'},signal);interactions.approve(interactions.snapshot()[0].id,true);id=(await starting).id;
 let output='';for(let n=0;n<30&&!output.includes('ready');n++){await new Promise(r=>setTimeout(r,100));output=(await manager.status(bot.id,id,signal)).output;}assert.match(output,/ready/);assert.equal((await manager.stop(bot.id,id,signal)).status,'stopped');
});
