import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {appearanceVariables,DEFAULT_APPEARANCE,normalizeAppearance,resolvedTheme} from '../src/appearance';
import {Store} from '../electron/core/store';

test('old profiles get appearance defaults and corrupted values stay bounded',()=>{
  assert.deepEqual(normalizeAppearance(undefined),DEFAULT_APPEARANCE);
  const v=normalizeAppearance({theme:'invalid',font:'invalid',zoom:500,messageSize:-1,codeSize:NaN,lineHeight:9,weight:599,textScale:0});
  assert.equal(v.theme,'system');assert.equal(v.font,'bundled');assert.equal(v.zoom,200);assert.equal(v.messageSize,12);assert.equal(v.codeSize,13);assert.equal(v.lineHeight,2.2);assert.equal(v.weight,600);assert.equal(v.textScale,85);
});
test('custom family names cannot inject CSS and always retain bundled fallbacks',()=>{
  const invalid=normalizeAppearance({font:'custom',customFont:"Arial'; color:red; /*"});
  assert.equal(invalid.customFont,'');assert.match(appearanceVariables(invalid)['--font-ui'],/^'Inter Variable'/);
  const v=normalizeAppearance({font:'custom',customFont:' 微软雅黑 ',codeFont:'custom',customCodeFont:'Cascadia Code'});
  assert.match(appearanceVariables(v)['--font-ui'],/^'微软雅黑','Inter Variable'/);
  assert.match(appearanceVariables(v)['--font-code'],/^'Cascadia Code','JetBrains Mono Variable'/);
});
test('text sizes, weight hierarchy and UI zoom are independent',()=>{
  const v=normalizeAppearance({...DEFAULT_APPEARANCE,textScale:120,weight:500,messageSize:18,codeSize:14,zoom:150});
  const css=appearanceVariables(v);
  assert.equal(css['--text-control'],'16.8px');assert.equal(css['--text-body'],'21.6px');
  assert.equal(css['--weight-body'],'500');assert.equal(css['--weight-label'],'600');assert.equal(css['--weight-heading'],'700');
  assert.deepEqual(appearanceVariables({...v,zoom:75}),css);
});
test('explicit themes override the system and system mode follows it',()=>{
  assert.equal(resolvedTheme('system',true),'dark');assert.equal(resolvedTheme('system',false),'light');
  assert.equal(resolvedTheme('light',true),'light');assert.equal(resolvedTheme('dark',false),'dark');
});
for(const incremental of [false,true])test(`appearance survives reopening the ${incremental?'SQLite':'JSON'} profile`,()=>{
  const folder=mkdtempSync(join(tmpdir(),'aelion-appearance-'));
  let store:Store|undefined;
  try{store=new Store(folder,{incremental});store.data.appearance={...DEFAULT_APPEARANCE,theme:'dark',zoom:125,font:'custom',customFont:'Microsoft YaHei'};store.save();store.close();store=undefined;
    store=new Store(folder,{incremental});assert.equal(store.data.appearance?.theme,'dark');assert.equal(store.data.appearance?.zoom,125);assert.equal(store.data.appearance?.customFont,'Microsoft YaHei');
  }finally{store?.close();assert.equal(dirname(resolve(folder)),resolve(tmpdir()));rmSync(folder,{recursive:true,force:true});}
});
