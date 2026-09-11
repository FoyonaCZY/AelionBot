import {resolve,join} from 'node:path';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import { _electron as electron } from 'playwright';
if(process.platform!=='darwin')throw Error('Mac app smoke test requires macOS');
const root=resolve(import.meta.dirname,'..'),dir=join(tmpdir(),'aelion-mac-smoke-'+randomUUID());mkdirSync(dir,{recursive:true});
const executable=join(root,'release','github',process.arch==='arm64'?'mac-arm64':'mac','AelionBot.app','Contents','MacOS','AelionBot');
let app;
try{
 app=await electron.launch({executablePath:executable,env:{...process.env,AELION_DATA_DIR:join(dir,'data'),AELION_PROJECT_DIR:dir,AELION_CONFIG_HOME:join(dir,'config')},timeout:60000});
 const page=await app.firstWindow();await page.locator('.app-shell').waitFor({timeout:30000});
 const snapshot=await page.evaluate(()=>window.aelion.snapshot());if(snapshot.platform!=='darwin'||snapshot.updates?.manualInstall!==true&&!process.env.CSC_LINK&&!process.env.CSC_NAME)throw Error('Mac platform/update state was not detected');
 const terminal=await app.evaluate(async({app})=>{
  const {createRequire}=await import('node:module'),{join}=await import('node:path');const load=createRequire(join(app.getAppPath(),'dist-electron','terminal-loader.cjs'));
  const pty=load(load.resolve('node-pty').replace('app.asar/','app.asar.unpacked/'));
  return new Promise((resolve,reject)=>{let output='';const child=pty.spawn('/bin/sh',['-c','printf AELION_PACKAGED_PTY_OK'],{cwd:app.getPath('temp'),env:{...process.env},name:'xterm-256color'});const timer=setTimeout(()=>{child.kill();reject(Error('Packaged PTY timed out'));},10000);child.onData(text=>output+=text);child.onExit(event=>{clearTimeout(timer);if(event.exitCode!==0||!output.includes('AELION_PACKAGED_PTY_OK'))reject(Error('Packaged PTY failed'));else resolve(true);});});
 });if(!terminal)throw Error('Packaged terminal verification failed');
 const close=page.getByRole('button',{name:'关闭对话框',exact:true});if(await close.isVisible().catch(()=>false))await close.click();
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'关于',exact:true}).click();await page.getByRole('button',{name:'检查更新',exact:true}).waitFor();
 const out=join(root,'output');mkdirSync(out,{recursive:true});await page.screenshot({path:join(out,`mac-${process.arch}-about.png`)});
 writeFileSync(join(out,`mac-${process.arch}-app-smoke.json`),JSON.stringify({passed:true,arch:process.arch,platform:snapshot.platform,version:snapshot.updates.currentVersion,manualInstall:snapshot.updates.manualInstall},null,2));
 console.log(JSON.stringify({appSmoke:true,arch:process.arch}));
}finally{if(app)await app.close();rmSync(dir,{recursive:true,force:true});}
