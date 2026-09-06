import {resolve,join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {VmController} from '../electron/core/vm';
import {ComputerController} from '../electron/core/computer';
if(process.platform!=='darwin')throw Error('This smoke test requires macOS');
const arch=process.arch,out=resolve('output'),data=resolve('.local',`mac-vm-${arch}`);mkdirSync(out,{recursive:true});
const vm=new VmController({dataDir:data,runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads'),memoryMiB:3072,cpuCount:2,accelerator:'tcg',startupTimeoutMs:600000}),computer=new ComputerController(vm,data,()=>{});
const proof:{arch:string;accelerator:string;steps:unknown[];preparation?:unknown[];passed?:boolean;error?:string}={arch,accelerator:'tcg',steps:[]};
const save=()=>writeFileSync(join(out,`mac-${arch}-vm-smoke.json`),JSON.stringify(proof,null,2));
const step=async(name:string,fn:()=>Promise<any>)=>{console.log(name);const started=Date.now(),result=await fn();proof.steps.push({name,milliseconds:Date.now()-started,result});save();return result;};
const preparationProgress=async()=>{
 const result=await vm.execute('date -Is; df -h / /work; free -m; ps -eo pid,ppid,stat,etimes,pcpu,pmem,comm --sort=-pcpu | head -n 16; stat -c "Desktop log: %s bytes; changed %y" /var/log/aelion-desktop.log; tail -n 8 /var/log/aelion-desktop.log','mac-smoke',AbortSignal.timeout(15000));
 console.log('Guest preparation diagnostics:\n'+result.stdout);
 proof.preparation=[...(proof.preparation||[]).slice(-9),{at:new Date().toISOString(),...result}];save();
};
let latest='';vm.on('state',state=>{if(state.detail!==latest){latest=state.detail;console.log(state.status+': '+state.detail);}});
try{
 await step('verify pinned guest image',()=>vm.prepare());await step('boot guest using bundled QEMU (TCG on hosted CI)',()=>vm.start());
 const identity=await step('verify guest architecture and user',()=>vm.execute('uname -m; id -u; pwd','mac-smoke'));if(identity.exitCode!==0||!identity.stdout.includes(arch==='arm64'?'aarch64':'x86_64')||!identity.stdout.includes('/work/mac-smoke'))throw Error('Guest architecture/workspace mismatch');
 // Hosted Mac runners use TCG: the first measured ARM package install took 33 minutes.
 // Allow the browser and the same restart/repair sequence used by ComputerSetup to finish.
 const deadline=Date.now()+55*60000;let reboots=0,nextProgress=Date.now()+60000;
 while(Date.now()<deadline){await vm.refresh();if(vm.state.needsReboot&&!vm.state.maintenance){if(++reboots>2)throw Error('Desktop did not settle after reboot');await vm.restart();await vm.repairTools();}if(vm.state.desktopReady&&vm.state.appsReady&&!vm.state.maintenance)break;if(vm.state.lastError&&!vm.state.maintenance)throw Error(vm.state.lastError);if(Date.now()>=nextProgress){nextProgress=Date.now()+60000;try{await preparationProgress();}catch(error){console.log('Guest preparation probe failed: '+(error as Error).message);}}await new Promise(r=>setTimeout(r,5000));}
 if(!vm.state.appsReady||!vm.state.desktopReady)throw Error('Guest desktop preparation timed out');
 const browser=await step('verify native browser installation',()=>vm.execute('aelion-browser --version && command -v xdotool libreoffice','mac-smoke'));if(browser.exitCode!==0||!/(Chromium|Google Chrome)/.test(browser.stdout))throw Error('Browser/desktop tools unavailable');
 const first=await step('create isolated Bot desktop',()=>computer.execute('mac-smoke',{action:'screenshot'},AbortSignal.timeout(120000)));if(first.screenshot.width<800)throw Error('Desktop screenshot invalid');
 const windowVisible=async(pattern:string)=>{const result=await vm.executeDesktop(`timeout 90 sh -c 'until xdotool search --onlyvisible --class "${pattern}"; do sleep 2; done'`,'mac-smoke',AbortSignal.timeout(120000));if(result.exitCode!==0)throw Error('Application window unavailable: '+pattern);const id=result.stdout.trim().split('\n')[0];if(!/^\d+$/.test(id))throw Error('Invalid application window');const focused=await vm.executeDesktop(`xdotool windowactivate --sync ${id} && sleep 5`,'mac-smoke',AbortSignal.timeout(20000));if(focused.exitCode!==0)throw Error('Application did not receive focus');return id;};
 await step('launch browser in the Bot desktop',async()=>{await computer.execute('mac-smoke',{action:'open_app',app:'browser'},AbortSignal.timeout(120000));return windowVisible('chromium|google-chrome');});
 const loaded=await vm.executeDesktop('timeout 90 sh -c \'until xdotool search --onlyvisible --name "Aelion 工作电脑"; do sleep 1; done\'','mac-smoke',AbortSignal.timeout(120000));if(loaded.exitCode!==0)throw Error('Browser did not load the local start page');
 const browserScreen=await computer.execute('mac-smoke',{action:'screenshot'},AbortSignal.timeout(120000));writeFileSync(join(out,`mac-${arch}-guest.png`),readFileSync(join(computer.imageDir,browserScreen.screenshot.id+'.png')));
 await step('launch Writer in the Bot desktop',async()=>{await computer.execute('mac-smoke',{action:'open_app',app:'writer'},AbortSignal.timeout(120000));return windowVisible('libreoffice-writer');});
 await step('verify Writer document editing',async()=>{
  const text=`Aelion ${arch} desktop verification`,signal=AbortSignal.timeout(120000);
  let screen=await computer.execute('mac-smoke',{action:'screenshot'},signal);
  screen=await computer.execute('mac-smoke',{action:'key',key:'ESC',observationId:screen.screenshot.id},signal);
  screen=await computer.execute('mac-smoke',{action:'type',text,observationId:screen.screenshot.id},signal);
  screen=await computer.execute('mac-smoke',{action:'key',key:'CTRL+A',observationId:screen.screenshot.id},signal);
  const cleared=await vm.executeDesktop('printf not-copied | xclip -selection clipboard','mac-smoke',signal);if(cleared.exitCode!==0)throw Error('Clipboard fixture failed');
  screen=await computer.execute('mac-smoke',{action:'key',key:'CTRL+C',observationId:screen.screenshot.id},signal);
  const copied=await vm.executeDesktop('timeout 5 xclip -selection clipboard -o','mac-smoke',signal);if(copied.exitCode!==0||copied.stdout.trim()!==text)throw Error('Writer did not edit and copy the document');
  writeFileSync(join(out,`mac-${arch}-office.png`),readFileSync(join(computer.imageDir,screen.screenshot.id+'.png')));
  await computer.execute('mac-smoke',{action:'key',key:'CTRL+Z',observationId:screen.screenshot.id},signal);
  return true;
 });
 const nonce=randomUUID(),written=await vm.executePython('import json,sys,pathlib; a=json.load(sys.stdin); pathlib.Path("proof.txt").write_text(a["nonce"]); print("written")',Buffer.from(JSON.stringify({nonce})),'mac-smoke');if(written.exitCode!==0)throw Error('Guest write failed');
 await step('stop and restart guest',async()=>{computer.release('mac-smoke');await vm.stop();await vm.start();return true;});
 const persisted=await vm.execute('cat proof.txt','mac-smoke');if(persisted.exitCode!==0||!persisted.stdout.includes(nonce))throw Error('Work file did not persist');proof.passed=true;save();
}catch(error){proof.error=(error as Error).message;save();let token='';try{token=JSON.parse(readFileSync(join(vm.dir,'machine.json'),'utf8')).seedToken||'';}catch{}
 const redact=(value:string)=>{const safe=value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]');return token?safe.replaceAll(token,'[redacted seed]'):safe;};
 const logs=Object.fromEntries(['qemu.log','serial.log'].filter(name=>existsSync(join(vm.dir,name))).map(name=>[name,redact(readFileSync(join(vm.dir,name),'utf8').slice(-1000000))]));
 try{logs['bot-desktop.log']=redact((await vm.execute('tail -n 120 /work/mac-smoke/.desktop/desktop.log','mac-smoke',AbortSignal.timeout(15000))).stdout);console.error(logs['bot-desktop.log']);}catch{}
 writeFileSync(join(out,`mac-${arch}-vm-diagnostics.json`),JSON.stringify(logs,null,2));
 try{await preparationProgress();console.error(redact((await vm.desktopDiagnostics()).stdout));}catch{}throw error;}
finally{computer.release('mac-smoke');await vm.stop().catch(()=>{});vm.dispose();}
