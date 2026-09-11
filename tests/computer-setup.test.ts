import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import type {VmState} from '../src/shared';
import {WORKSTATION_VERSION} from '../src/shared';
import {computerDesktopReady,computerSetupActionLabel,computerSetupActions,computerSetupDismissalKey,computerSetupState,shouldOfferComputerSetup} from '../src/computer-setup-state';
import {VmController} from '../electron/core/vm';
import {workstationProgress} from '../electron/core/workstation-progress';

const vm=(patch:Partial<VmState>={}):VmState=>({status:'unprepared',detail:'',imageVersion:'fixture',...patch});
test('first launch offers setup, but dismissal and an existing computer do not reopen it',()=>{
  assert.equal(shouldOfferComputerSetup(vm(),false),true);
  assert.equal(shouldOfferComputerSetup(vm(),true),false);
  for(const status of ['preparing','starting','ready','stopped','error'] as const)assert.equal(shouldOfferComputerSetup(vm({status}),false),false);
  assert.doesNotMatch(computerSetupDismissalKey('/data',vm()),/:ws-/);
});
test('saved guests without the current workstation version look outdated before they start',t=>{
  const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-ws-'));mkdirSync(join(root,'vm'));
  t.after(()=>{assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});
  const record={id:'guest',sshPort:0,qmpPort:0,vncPort:0,seedPort:0,seedToken:'token',hostKeyHash:'hash',preparedAt:new Date().toISOString()};
  writeFileSync(join(root,'vm','machine.json'),JSON.stringify(record));
  const stale=new VmController({dataDir:root,runtimeDir:root,cacheDir:root});t.after(()=>stale.dispose());
  assert.equal(stale.state.status,'stopped');assert.equal(stale.state.appsReady,false);assert.equal(shouldOfferComputerSetup(stale.state,false),true);
  writeFileSync(join(root,'vm','machine.json'),JSON.stringify({...record,workstationVersion:WORKSTATION_VERSION}));
  const current=new VmController({dataDir:root,runtimeDir:root,cacheDir:root});t.after(()=>current.dispose());
  assert.equal(current.state.appsReady,true);assert.equal(shouldOfferComputerSetup(current.state,false),false);
});
test('an existing computer missing the current workstation apps reuses the setup dialog',()=>{
  const outdated=vm({status:'stopped',appsReady:false});
  assert.equal(shouldOfferComputerSetup(outdated,false),true);
  assert.equal(shouldOfferComputerSetup(outdated,true),false);
  assert.equal(shouldOfferComputerSetup(vm({status:'stopped',appsReady:true}),false),false);
  assert.equal(computerSetupState(outdated).kind,'upgrade');
  assert.deepEqual(computerSetupActions(outdated),['start','repair-tools']);
  assert.equal(computerSetupActionLabel(outdated),'更新工作环境');
  assert.equal(computerSetupDismissalKey('/data',outdated),`aelion-computer-setup:/data:ws-${WORKSTATION_VERSION}`);
  assert.equal(shouldOfferComputerSetup(vm({status:'ready',appsReady:false}),false),true);
  assert.equal(computerSetupState(vm({status:'ready',appsReady:false})).kind,'incomplete');
});
test('SSH readiness during first installation never starts the Bot desktop too early',()=>{
  const state=vm({status:'ready',maintenance:true,appsReady:false});
  assert.equal(computerDesktopReady(state),false);
  assert.equal(computerSetupState(state).kind,'installing');
  state.maintenance=false;state.needsReboot=true;
  assert.equal(computerDesktopReady(state),false);
  state.appsReady=true;assert.equal(computerDesktopReady(state),false);
  state.needsReboot=false;assert.equal(computerDesktopReady(state),true);
  state.status='stopped';assert.equal(computerDesktopReady(state),false);
});
test('first-time restart also completes the post-reboot desktop configuration',()=>{
  const state=vm({status:'ready',needsReboot:true});
  assert.deepEqual(computerSetupActions(state),['restart','repair-tools']);
  state.maintenance=true;assert.deepEqual(computerSetupActions(state),[]);
  assert.deepEqual(computerSetupActions(vm({status:'starting'})),[]);
  assert.deepEqual(computerSetupActions(vm({status:'ready',appsReady:true})),[]);
});
test('failed downloads and failed application installs resume at their respective stages',()=>{
  assert.deepEqual(computerSetupActions(vm({status:'error',lastError:'下载失败'})),['start']);
  const state=vm({status:'ready',lastError:'应用环境准备失败'});
  assert.equal(computerSetupState(state).kind,'error');
  assert.deepEqual(computerSetupActions(state),['repair-tools']);
});
test('guest progress uses known stages and supports older guests without a progress marker',()=>{
  assert.equal(workstationProgress('READY\nSTAGE:browser\n'),'正在下载并安装浏览器');
  assert.equal(workstationProgress('READY\nSTAGE:desktop\n'),'正在安装桌面和办公软件');
  const fallback=workstationProgress('READY');
  for(const value of ['constructor','unknown','<script>'])assert.equal(workstationProgress(`STAGE:${value}\n`),fallback);
  assert.equal(workstationProgress('prefixSTAGE:browser'),fallback);
});
