import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {VmController} from '../electron/core/vm';

const image=readFileSync(resolve('assets/wallpaper-light.png'));
const hash=createHash('sha256').update(image).digest('hex');
const result=(stdout='',exitCode=0)=>({stdout,stderr:'',exitCode,durationMs:1});
function fixture(execRaw:(...args:any[])=>Promise<unknown>){
  return Object.assign(Object.create(VmController.prototype),{
    options:{wallpaperPath:resolve('assets/wallpaper-light.png')},
    stateValue:{status:'ready',appsReady:true,maintenance:false},
    wallpaperRetryAt:0,execRaw,
  });
}

test('wallpaper update transfers binary stdin once across concurrent refreshes',async()=>{
  const calls:any[][]=[];
  const vm=fixture(async(...args)=>{calls.push(args);return result();});
  await Promise.all([vm.ensureWallpaper(),vm.ensureWallpaper()]);
  await vm.ensureWallpaper();
  assert.equal(calls.length,2);
  assert.equal(calls[1][1],'root');
  assert.match(calls[1][0],/^flock -n \/var\/lib\/aelion\/desktop.lock /);
  assert.ok(calls[1][0].length<16000);
  assert.deepEqual(calls[1][5],image);
});

test('current wallpaper is kept and stopped or installing computers are skipped',async()=>{
  let calls=0;
  const vm=fixture(async()=>{calls++;return result(`${hash}  /usr/local/share/aelion/wallpaper.png\n`);});
  for(const state of [{status:'stopped',appsReady:true},{status:'ready',appsReady:false},{status:'ready',appsReady:true,maintenance:true}]){
    vm.stateValue=state;await vm.ensureWallpaper();
  }
  assert.equal(calls,0);
  vm.stateValue={status:'ready',appsReady:true,maintenance:false};
  await vm.ensureWallpaper();
  assert.equal(calls,1);
});

test('a failed cosmetic update stays retryable without changing VM health',async t=>{
  t.mock.method(console,'warn',()=>{});
  let calls=0,fail=true;
  const vm=fixture(async()=>{calls++;if(fail)throw new Error('busy');return result(`${hash}  wallpaper.png`);});
  const state={...vm.stateValue};
  await Promise.all([vm.ensureWallpaper(),vm.ensureWallpaper()]);
  assert.deepEqual(vm.stateValue,state);
  assert.equal(vm.wallpaperTask,undefined);
  await vm.ensureWallpaper();
  assert.equal(calls,1);
  fail=false;vm.wallpaperRetryAt=0;
  await vm.ensureWallpaper();
  assert.equal(calls,2);
});
