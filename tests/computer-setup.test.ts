import test from 'node:test';
import assert from 'node:assert/strict';
import type {VmState} from '../src/shared';
import {computerDesktopReady,computerSetupActions,computerSetupState,shouldOfferComputerSetup} from '../src/computer-setup-state';
import {workstationProgress} from '../electron/core/workstation-progress';

const vm=(patch:Partial<VmState>={}):VmState=>({status:'unprepared',detail:'',imageVersion:'fixture',...patch});
test('first launch offers setup, but dismissal and an existing computer do not reopen it',()=>{
  assert.equal(shouldOfferComputerSetup(vm(),false),true);
  assert.equal(shouldOfferComputerSetup(vm(),true),false);
  for(const status of ['preparing','starting','ready','stopped','error'] as const)assert.equal(shouldOfferComputerSetup(vm({status}),false),false);
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
