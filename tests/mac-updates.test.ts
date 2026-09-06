import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMacUpdater,macAutomaticUpdates,newerVersion} from '../electron/core/mac-updater';
import {AppUpdates} from '../electron/core/app-updates';
test('Mac preview chooses a release containing the matching architecture and never installs automatically',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const asset=(version:string,arch:string)=>({name:`AelionBot-${version}-mac-${arch}.dmg`,state:'uploaded',size:100});
 globalThis.fetch=async()=>new Response(JSON.stringify([{tag_name:'v9.0.0',draft:false,prerelease:false,assets:[asset('9.0.0','x64')]},{tag_name:'v8.0.0',draft:false,prerelease:true,assets:[asset('8.0.0','arm64')]},{tag_name:'v7.0.0',draft:false,prerelease:false,assets:[asset('7.0.0','arm64')]}]),{status:200});
 const driver=createMacUpdater(false,'arm64'),updates=new AppUpdates(driver,'0.6.0','example/project',true,{blockedReason:()=>undefined,prepareInstall:async()=>{},recoverInstall:async()=>{}},()=>{});
 await updates.check();assert.equal(updates.snapshot().latestVersion,'7.0.0');assert.equal(updates.snapshot().manualInstall,true);assert.throws(()=>updates.download(),/预览版/);updates.dispose();
});
test('automatic Mac updates require an explicitly notarized Developer ID build',t=>{
 const dir=mkdtempSync(join(tmpdir(),'aelion-mac-updates-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));assert.equal(macAutomaticUpdates(dir),false);
 writeFileSync(join(dir,'mac-release.json'),JSON.stringify({signatureType:'adhoc',notarized:false,automaticUpdates:true}));assert.equal(macAutomaticUpdates(dir),false);
 writeFileSync(join(dir,'mac-release.json'),JSON.stringify({signatureType:'developer-id',notarized:true,automaticUpdates:true}));assert.equal(macAutomaticUpdates(dir),true);
 assert.equal(newerVersion('v1.10.0','1.9.0'),true);assert.equal(newerVersion('v1.0.0-beta.1','0.6.0'),false);assert.equal(newerVersion('0.5.0','0.6.0'),false);
});
