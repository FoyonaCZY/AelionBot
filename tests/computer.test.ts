import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {ComputerController,absolutePoint,keyCodes} from '../electron/core/computer';
import {imageContext} from '../electron/core/model';
import {artifactPath} from '../electron/core/artifacts';
import type {VmController} from '../electron/core/vm';
import type {WireMessage} from '../src/shared';
import {EventEmitter} from 'node:events';

test('desktop coordinates and key chords stay inside the guest input protocol',()=>{
  assert.deepEqual(absolutePoint(1279,799,1280,800).map(event=>event.data.value),[32767,32767]);
  assert.deepEqual(absolutePoint(0,0,1280,800).map(event=>event.data.value),[0,0]);
  assert.throws(()=>absolutePoint(1280,799,1280,800));assert.throws(()=>absolutePoint(NaN,0,1280,800));
  assert.deepEqual(keyCodes('CTRL+SHIFT+V'),['ctrl','shift','v']);assert.deepEqual(keyCodes('ENTER'),['ret']);
  assert.throws(()=>keyCodes('ctrl+$(malicious)'));assert.throws(()=>keyCodes('CTRL+CTRL+A'));
});
test('independent desktops retain their own observations, input routing and manual takeover',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-computer-test-'));
  t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('aelion-computer-test-'));rmSync(dir,{recursive:true,force:true});});
  const events:Array<{botId:string;command:string}>=[];
  const vm={state:{status:'ready',desktopReady:true,appsReady:true},ensureBotDesktop:async(botId:string)=>({vncUrl:'ws://local/'+botId}),executeDesktop:async(command:string,botId:string)=>{events.push({botId,command});return {exitCode:0,stdout:'',stderr:''};},desktopScreenshot:async(botId:string)=>{events.push({botId,command:'screenshot'});const png=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(1280,16);png.writeUInt32BE(800,20);return png;}} as unknown as VmController;
  const computer=new ComputerController(vm,dir,()=>{}),signal=new AbortController().signal;
  await assert.rejects(()=>computer.execute('a',{action:'click',x:1,y:2},signal),/先截取/);
  const [first,second]=await Promise.all(['a','b'].map(botId=>computer.execute(botId,{action:'screenshot'},signal)));
  assert.notEqual(computer.stateFor('a').vncUrl,computer.stateFor('b').vncUrl);
  await assert.rejects(()=>computer.execute('b',{action:'click',observationId:first.screenshot.id,x:1,y:2},signal),/先截取/);
  await assert.rejects(()=>computer.execute('a',{action:'click',observationId:'old',x:1,y:2},signal),/先截取/);
  await Promise.all([computer.execute('a',{action:'click',observationId:first.screenshot.id,x:10,y:20},signal),computer.execute('b',{action:'click',observationId:second.screenshot.id,x:500,y:600},signal)]);
  assert.ok(events.some(item=>item.botId==='a'&&item.command==='xdotool mousemove 10 20'));assert.ok(events.some(item=>item.botId==='b'&&item.command==='xdotool mousemove 500 600'));
  await assert.rejects(()=>computer.execute('a',{action:'key',key:'ENTER',observationId:first.screenshot.id},signal),/先截取/);
  computer.release('a');computer.setManual('a',true);
  await assert.rejects(()=>computer.execute('a',{action:'screenshot'},signal),/用户正在接管/);
  await computer.execute('b',{action:'screenshot'},signal);assert.equal(computer.stateFor('b').ownerBotId,'b');
  computer.setManual('a',false);await assert.rejects(()=>computer.execute('a',{action:'key',key:'ENTER',observationId:first.screenshot.id},signal),/先截取/);
});
test('protocol conversion preserves earlier observations when another image is appended',()=>{
  const messages:WireMessage[]=['one','two','three'].map(id=>({role:'user',content:'observation',images:[{id,width:1280,height:800}]}));
  const before=JSON.stringify(messages);const loaded:string[]=[];
  const request=imageContext(messages,id=>{loaded.push(id);return `data:image/png;base64,${id}`;});
  assert.deepEqual(loaded,['one','two','three']);assert.match(JSON.stringify(request[0]),/image_url/);
  assert.match(JSON.stringify(request[2]),/image_url/);assert.equal(JSON.stringify(messages),before);
});

test('only the same desktop is locked by an in-flight action and a VM restart invalidates observations',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-desktop-lock-'));t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});let capturing=false;
  const vm=Object.assign(new EventEmitter(),{state:{status:'ready',pid:10,desktopReady:true,appsReady:true},ensureBotDesktop:async(botId:string)=>({vncUrl:'ws://local/'+botId}),desktopScreenshot:async(botId:string)=>{if(botId==='first'){capturing=true;await blocked;}const png=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(1280,16);png.writeUInt32BE(800,20);return png;}}) as unknown as VmController;
  const computer=new ComputerController(vm,dir,()=>{}),signal=new AbortController().signal;
  const first=computer.execute('first',{action:'screenshot'},signal);for(let i=0;i<100&&!capturing;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(capturing,true);
  await assert.rejects(()=>computer.execute('first',{action:'screenshot'},signal),/前一次/);
  assert.throws(()=>computer.setManual('first',true),/正在完成/);
  const second=await computer.execute('second',{action:'screenshot'},signal);release();await first;
  vm.emit('state',{status:'stopped'});assert.equal(Object.keys(computer.state.desktops).length,0);
  await assert.rejects(()=>computer.execute('second',{action:'key',key:'ENTER',observationId:second.screenshot.id},signal),/先截取/);
});
test('open_app can launch Impress as well as Writer and Calc',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'aelion-computer-office-'));t.after(()=>{assert.equal(dirname(resolve(dir)),resolve(tmpdir()));rmSync(dir,{recursive:true,force:true});});
  const events:string[]=[];
  const vm={state:{status:'ready',desktopReady:true,appsReady:true},ensureBotDesktop:async()=>({vncUrl:'ws://local/bot'}),executeDesktop:async(command:string)=>{events.push(command);return {exitCode:0,stdout:'',stderr:''};},desktopScreenshot:async()=>{const png=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(1280,16);png.writeUInt32BE(800,20);return png;}} as unknown as VmController;
  const computer=new ComputerController(vm,dir,()=>{}),signal=new AbortController().signal;
  await computer.execute('bot',{action:'open_app',app:'impress'},signal);
  await computer.execute('bot',{action:'open_app',app:'writer'},signal);
  await computer.execute('bot',{action:'open_app',app:'calc'},signal);
  assert.ok(events.some(command=>command.includes("libreoffice' '--impress'")||command.includes('libreoffice --impress')));
  assert.ok(events.some(command=>command.includes('--writer')));
  assert.ok(events.some(command=>command.includes('--calc')));
});
test('artifact preview/export reject host paths and traversal',()=>{
  assert.equal(artifactPath('Downloads/report.pdf'),'Downloads/report.pdf');
  for(const value of ['/etc/passwd','../secret','a/../../secret','C:\\data','file:///etc/passwd','a\0b'])assert.throws(()=>artifactPath(value));
});
