import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {AppUpdates,updateError,UPDATE_CHECK_INTERVAL_MS,UPDATE_CHECK_START_DELAY_MS,type UpdateDriver} from '../electron/core/app-updates';
import {assertUpdateDataOutsideApp,loadUpdateLaunchContext,saveUpdateLaunchContext} from '../electron/core/update-launch-context';

const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
class Driver extends EventEmitter implements UpdateDriver {
  checks=0;downloads=0;installs=0;cancels=0;info={version:'0.4.1',releaseNotes:'更新说明'};
  check:()=>Promise<unknown>=async()=>{this.emit('update-available',this.info);return {updateInfo:this.info};};
  download=async()=>{this.emit('download-progress',{percent:50,total:200,transferred:100,bytesPerSecond:20});this.emit('update-downloaded',this.info);return ['setup.exe'];};
  async checkForUpdates(){this.checks++;return this.check();}
  async downloadUpdate(){this.downloads++;return this.download();}
  cancelDownload(){this.cancels++;}
  quitAndInstall(){this.installs++;}
}
function fixture(t:test.TestContext,supported=true){const driver=new Driver(),events:string[]=[],control={blocked:undefined as string|undefined,prepare:async(_version:string)=>{events.push('prepared');},recover:async()=>{events.push('recovered');}};const service=new AppUpdates(driver,'0.4.0','owner/repo',supported,{blockedReason:()=>control.blocked,prepareInstall:version=>control.prepare(version),recoverInstall:()=>control.recover()},()=>events.push(service.snapshot().phase));t.after(()=>service.dispose());return {driver,service,events,control};}
async function advance(t:test.TestContext,ms:number){t.mock.timers.tick(ms);await new Promise<void>(resolve=>setImmediate(resolve));}

test('automatic checks start after launch, repeat every five minutes, and stop on exit',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
  f.driver.check=async()=>{f.driver.emit('update-not-available',{});return {checked:true};};
  f.service.startAutomaticChecks();f.service.startAutomaticChecks();
  await advance(t,UPDATE_CHECK_START_DELAY_MS-1);assert.equal(f.driver.checks,0);
  await advance(t,1);assert.equal(f.driver.checks,1);assert.equal(f.service.snapshot().phase,'current');
  await advance(t,UPDATE_CHECK_INTERVAL_MS-1);assert.equal(f.driver.checks,1);
  await advance(t,1);assert.equal(f.driver.checks,2);
  f.service.dispose();await advance(t,UPDATE_CHECK_INTERVAL_MS);assert.equal(f.driver.checks,2);
  assert.equal(f.driver.downloads,0);assert.equal(f.driver.installs,0);
});

test('automatic checks retry a network failure and do not overlap manual checks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);
  f.driver.check=async()=>{throw Error('network unavailable');};f.service.startAutomaticChecks();
  await advance(t,UPDATE_CHECK_START_DELAY_MS);assert.equal(f.driver.checks,1);assert.equal(f.service.snapshot().phase,'error');
  const held=deferred<unknown>();f.driver.check=()=>held.promise;const manual=f.service.check();await Promise.resolve();
  await advance(t,UPDATE_CHECK_INTERVAL_MS);assert.equal(f.driver.checks,2);assert.equal(f.service.snapshot().phase,'checking');
  f.driver.emit('update-not-available',{});held.resolve({checked:true});await manual;
  f.driver.check=async()=>{f.driver.emit('update-available',f.driver.info);return {updateInfo:f.driver.info};};
  await advance(t,UPDATE_CHECK_INTERVAL_MS);assert.equal(f.driver.checks,3);assert.equal(f.service.snapshot().latestVersion,'0.4.1');
  await advance(t,UPDATE_CHECK_INTERVAL_MS);assert.equal(f.driver.checks,3);assert.equal(f.driver.downloads,0);
});

test('automatic polling preserves available, failed, downloading and ready updates',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t);f.service.startAutomaticChecks();
  await advance(t,UPDATE_CHECK_START_DELAY_MS);assert.equal(f.service.snapshot().phase,'available');
  const held=deferred<string[]>();f.driver.download=()=>held.promise;const downloading=f.service.download();await Promise.resolve();
  f.driver.emit('download-progress',{percent:47,total:100,transferred:47});await advance(t,UPDATE_CHECK_INTERVAL_MS);
  assert.equal(f.service.snapshot().phase,'downloading');assert.equal(f.service.snapshot().progress?.percent,47);assert.equal(f.driver.checks,1);
  held.reject(Error('network unavailable'));await downloading;await advance(t,UPDATE_CHECK_INTERVAL_MS);
  assert.equal(f.service.snapshot().phase,'error');assert.equal(f.service.snapshot().latestVersion,'0.4.1');assert.equal(f.driver.checks,1);
  f.driver.download=async()=>{f.driver.emit('update-downloaded',f.driver.info);return ['setup.exe'];};await f.service.download();
  await advance(t,UPDATE_CHECK_INTERVAL_MS);assert.equal(f.service.snapshot().phase,'downloaded');assert.equal(f.driver.checks,1);assert.equal(f.driver.installs,0);
  const preparing=deferred<void>();f.control.prepare=()=>preparing.promise;const installing=f.service.install();
  await advance(t,UPDATE_CHECK_INTERVAL_MS);assert.equal(f.service.snapshot().phase,'installing');assert.equal(f.driver.checks,1);
  preparing.resolve();await installing;assert.equal(f.driver.installs,1);
});

test('application exit during an automatic check never schedules another check',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t),held=deferred<unknown>();f.driver.check=()=>held.promise;f.service.startAutomaticChecks();
  await advance(t,UPDATE_CHECK_START_DELAY_MS);assert.equal(f.driver.checks,1);f.service.dispose();const events=f.events.length;
  f.driver.emit('update-available',f.driver.info);held.resolve({checked:true});await advance(t,UPDATE_CHECK_INTERVAL_MS*2);
  assert.equal(f.events.length,events);assert.equal(f.driver.checks,1);
});

test('development builds never start automatic update checks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,false);f.service.startAutomaticChecks();
  await advance(t,UPDATE_CHECK_START_DELAY_MS+UPDATE_CHECK_INTERVAL_MS);assert.equal(f.driver.checks,0);assert.equal(f.service.snapshot().phase,'unsupported');
});

test('manual checking, verified download and prepared installation are separate actions',async t=>{
  const f=fixture(t);await f.service.check();assert.equal(f.service.snapshot().phase,'available');assert.equal(f.driver.downloads,0);await f.service.download();assert.equal(f.service.snapshot().phase,'downloaded');assert.equal(f.driver.installs,0);await f.service.install();assert.equal(f.driver.installs,1);assert.ok(f.events.indexOf('prepared')>f.events.indexOf('installing'));assert.ok(f.events.includes('downloading'));
});
test('checking coalesces clicks and a new failed check discards a stale update candidate',async t=>{
  const f=fixture(t),held=deferred<{updateInfo:{version:string}}>();f.driver.check=()=>held.promise;const first=f.service.check(),second=f.service.check();await Promise.resolve();assert.equal(f.driver.checks,1);f.driver.emit('update-available',f.driver.info);held.resolve({updateInfo:f.driver.info});await Promise.all([first,second]);
  f.driver.check=async()=>{throw Error('HTTP 404');};await f.service.check();assert.equal(f.service.snapshot().phase,'error');assert.equal(f.service.snapshot().latestVersion,undefined);assert.throws(()=>f.service.download(),/先检查/);
});
test('current version and checksum failures are reported accurately and never invoke installation',async t=>{
  const f=fixture(t);f.driver.check=async()=>{f.driver.emit('update-not-available',f.driver.info);return {updateInfo:f.driver.info};};await f.service.check();assert.equal(f.service.snapshot().phase,'current');assert.equal(f.driver.installs,0);
  f.driver.check=async()=>{f.driver.emit('update-available',f.driver.info);return {updateInfo:f.driver.info};};await f.service.check();f.driver.download=async()=>{throw Error('ERR_UPDATER_CHECKSUM_MISMATCH');};await f.service.download();assert.match(f.service.snapshot().error||'',/校验/);await assert.rejects(()=>f.service.install(),/尚未/);assert.equal(f.driver.installs,0);
});
test('cancelled downloads ignore late completion and can be downloaded again',async t=>{
  const f=fixture(t),held=deferred<string[]>();await f.service.check();f.driver.download=()=>held.promise;const pending=f.service.download();await Promise.resolve();f.service.cancel();f.driver.emit('update-downloaded',f.driver.info);assert.notEqual(f.service.snapshot().phase,'downloaded');held.reject(Error('cancelled'));await pending;assert.equal(f.service.snapshot().phase,'available');assert.equal(f.driver.cancels,1);
  f.driver.download=async()=>{f.driver.emit('update-downloaded',f.driver.info);return ['setup.exe'];};await f.service.download();assert.equal(f.service.snapshot().phase,'downloaded');
});
test('active work and failed shutdown preparation keep the downloaded update unapplied',async t=>{
  const f=fixture(t);await f.service.check();await f.service.download();f.control.blocked='请先结束任务';await assert.rejects(()=>f.service.install(),/先结束/);assert.equal(f.driver.installs,0);f.control.blocked=undefined;f.control.prepare=async()=>{throw Error('无法安全关闭工作电脑');};await f.service.install();assert.equal(f.service.snapshot().phase,'downloaded');assert.match(f.service.snapshot().error||'',/安全关闭/);assert.equal(f.driver.installs,0);assert.ok(f.events.includes('recovered'));
});
test('application exit during preparation prevents a late install call',async t=>{
  const f=fixture(t),held=deferred<void>();await f.service.check();await f.service.download();f.control.prepare=()=>held.promise;const pending=f.service.install();f.service.dispose();held.resolve();await pending;assert.equal(f.driver.installs,0);
});
test('update errors do not expose HTTP bodies or temporary signed URLs',()=>{
  assert.equal(updateError(Error('HTTP 404 secret-response-body')), '未找到 GitHub Release 或更新资源，请稍后重试。');assert.match(updateError(Error('ERR_UPDATER_NO_PUBLISHED_VERSIONS')),/还没有/);assert.match(updateError(Error('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')),/latest.yml/);assert.ok(!updateError(Error('https://example.test?token=private')).includes('private'));
});
test('update launch context preserves the custom data location and is bound to the installation',t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-update-context-')),profile=join(dir,'profile'),data=join(dir,'data'),app=join(dir,'app');mkdirSync(data);mkdirSync(app);t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  const context={version:1 as const,executable:join(app,'AelionBot.exe'),dataDir:data,projectDir:dir,configDir:join(dir,'config'),resumeComputer:true,targetVersion:'0.4.1'};saveUpdateLaunchContext(profile,context);assert.deepEqual(loadUpdateLaunchContext(profile,context.executable),context);assert.equal(loadUpdateLaunchContext(profile,join(dir,'other','AelionBot.exe')),undefined);
  assert.doesNotThrow(()=>assertUpdateDataOutsideApp(data,app));assert.throws(()=>assertUpdateDataOutsideApp(app,app),/程序目录/);assert.throws(()=>assertUpdateDataOutsideApp(join(app,'data'),app),/程序目录/);assert.throws(()=>assertUpdateDataOutsideApp(join(app,'..notes'),app),/程序目录/);assert.doesNotThrow(()=>assertUpdateDataOutsideApp(join(dir,'app-data'),app));
  writeFileSync(join(profile,'update-launch-context.json'),JSON.stringify({...context,dataDir:join(dir,'missing')}));assert.throws(()=>loadUpdateLaunchContext(profile,context.executable),/已移动/);
});
