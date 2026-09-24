import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LayaFeature,preferredLayaVariant} from '../electron/core/laya-feature';
import {LayaShadow} from '../electron/core/laya-shadow';

test('desktop opt-in ignores a legacy startup environment variable',()=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-decision-optin-'));
  const previous=process.env.AELION_LAYA_RUNTIME;
  try{
    process.env.AELION_LAYA_RUNTIME='mlx';
    const shadow=new LayaShadow(dir,join(dir,'unused.py'),()=>{},{runtime:undefined});
    assert.equal(shadow.enabled,false);
    shadow.warmup();
    assert.equal(shadow.isReady,false);
    shadow.dispose();
  }finally{
    if(previous===undefined)delete process.env.AELION_LAYA_RUNTIME;else process.env.AELION_LAYA_RUNTIME=previous;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('one-click Laya variant follows the operating system',()=>{
  assert.equal(preferredLayaVariant('darwin','arm64'),'mlx');
  assert.equal(preferredLayaVariant('win32','x64'),'standard');
  assert.equal(preferredLayaVariant('linux','x64'),'standard');
  assert.equal(preferredLayaVariant('linux','arm64'),'standard');
  assert.equal(preferredLayaVariant('darwin','x64'),undefined);
});

test('decision models stay absent until chosen, then can switch and pause',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-decision-model-'));
  const python=join(dir,'python');writeFileSync(python,'');
  const previousRuntime=process.env.AELION_LAYA_RUNTIME,previousPython=process.env.AELION_LAYA_PYTHON;
  const calls:string[]=[];
  const fake={isReady:false,configure(runtime?:string){calls.push(runtime||'off');fake.isReady=Boolean(runtime);},waitReady:async()=>{}};
  const shadow=fake as unknown as LayaShadow;
  try{
    const feature=new LayaFeature(dir,shadow,()=>{},true);
    assert.deepEqual(feature.snapshot().installed,[]);
    assert.equal(feature.snapshot().enabled,false);
    assert.deepEqual(calls,[],'without opt-in no model may start');

    process.env.AELION_LAYA_PYTHON=python;process.env.AELION_LAYA_RUNTIME='mlx';
    await feature.install('mlx');
    assert.deepEqual(feature.snapshot().installed,['mlx']);
    assert.equal(feature.snapshot().active,'mlx');
    assert.equal(feature.snapshot().phase,'ready');

    process.env.AELION_LAYA_RUNTIME='standard';
    await feature.install('standard');
    assert.deepEqual(feature.snapshot().installed,['standard','mlx']);
    feature.select('mlx');
    assert.equal(feature.snapshot().active,'mlx');
    feature.setEnabled(false);
    assert.equal(feature.snapshot().enabled,false);
    assert.equal(calls.at(-1),'off');

    const reopened=new LayaFeature(dir,shadow,()=>{},true);
    assert.deepEqual(reopened.snapshot().installed,['standard','mlx']);
    assert.equal(reopened.snapshot().enabled,false);
  }finally{
    if(previousRuntime===undefined)delete process.env.AELION_LAYA_RUNTIME;else process.env.AELION_LAYA_RUNTIME=previousRuntime;
    if(previousPython===undefined)delete process.env.AELION_LAYA_PYTHON;else process.env.AELION_LAYA_PYTHON=previousPython;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('cancel keeps download busy until the pending load has stopped',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-laya-cancel-'));
  const python=join(dir,'python');writeFileSync(python,'');
  const previousRuntime=process.env.AELION_LAYA_RUNTIME,previousPython=process.env.AELION_LAYA_PYTHON;
  let rejectLoad:((error:Error)=>void)|undefined;
  const shadow={isReady:false,configure(){},waitReady:()=>new Promise<void>((_,reject)=>{rejectLoad=reject;})} as unknown as LayaShadow;
  try{
    process.env.AELION_LAYA_RUNTIME='mlx';process.env.AELION_LAYA_PYTHON=python;
    const feature=new LayaFeature(dir,shadow,()=>{},true);
    const installation=feature.install('mlx');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(feature.snapshot().phase,'loading');
    feature.cancel();
    assert.equal(feature.snapshot().phase,'cancelling');
    assert.equal(feature.snapshot().downloading,'mlx');
    await assert.rejects(feature.install('mlx'),/正在下载/);
    rejectLoad?.(new Error('Laya 已停止'));
    await installation;
    assert.equal(feature.snapshot().phase,'not-installed');
    assert.equal(feature.snapshot().downloading,undefined);
  }finally{
    if(previousRuntime===undefined)delete process.env.AELION_LAYA_RUNTIME;else process.env.AELION_LAYA_RUNTIME=previousRuntime;
    if(previousPython===undefined)delete process.env.AELION_LAYA_PYTHON;else process.env.AELION_LAYA_PYTHON=previousPython;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('an old load callback cannot overwrite a newer enabled state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-laya-stale-'));
  const python=join(dir,'python');writeFileSync(python,'');
  mkdirSync(join(dir,'laya-runtime'));
  writeFileSync(join(dir,'laya-runtime','feature.json'),JSON.stringify({installed:{mlx:python},active:'mlx',enabled:true}));
  const waits:Array<{resolve:()=>void;reject:(error:Error)=>void}>=[];
  const fake={isReady:false,configure(){},waitReady:()=>new Promise<void>((resolve,reject)=>waits.push({resolve,reject}))};
  const shadow=fake as unknown as LayaShadow;
  try{
    const feature=new LayaFeature(dir,shadow,()=>{},true);
    assert.equal(waits.length,1);
    feature.setEnabled(false);
    feature.setEnabled(true);
    fake.isReady=true;waits[1].resolve();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(feature.snapshot().phase,'ready');
    waits[0].reject(new Error('old process stopped'));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(feature.snapshot().phase,'ready');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
