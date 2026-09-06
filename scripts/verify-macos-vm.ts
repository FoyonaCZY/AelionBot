import {resolve,join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {VmController} from '../electron/core/vm';
import {ComputerController} from '../electron/core/computer';
if(process.platform!=='darwin')throw Error('This smoke test requires macOS');
const arch=process.arch,out=resolve('output'),data=resolve('.local',`mac-vm-${arch}`);mkdirSync(out,{recursive:true});
const vm=new VmController({dataDir:data,runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads'),memoryMiB:3072,cpuCount:2,accelerator:'tcg',startupTimeoutMs:600000}),computer=new ComputerController(vm,data,()=>{});
const proof:{arch:string;accelerator:string;steps:unknown[];passed?:boolean;error?:string}={arch,accelerator:'tcg',steps:[]};
const save=()=>writeFileSync(join(out,`mac-${arch}-vm-smoke.json`),JSON.stringify(proof,null,2));
const step=async(name:string,fn:()=>Promise<any>)=>{console.log(name);const started=Date.now(),result=await fn();proof.steps.push({name,milliseconds:Date.now()-started,result});save();return result;};
let latest='';vm.on('state',state=>{if(state.detail!==latest){latest=state.detail;console.log(state.status+': '+state.detail);}});
try{
 await step('verify pinned guest image',()=>vm.prepare());await step('boot guest using bundled QEMU (TCG on hosted CI)',()=>vm.start());
 const identity=await step('verify guest architecture and user',()=>vm.execute('uname -m; id -u; pwd','mac-smoke'));if(identity.exitCode!==0||!identity.stdout.includes(arch==='arm64'?'aarch64':'x86_64')||!identity.stdout.includes('/work/mac-smoke'))throw Error('Guest architecture/workspace mismatch');
 const deadline=Date.now()+35*60000;let reboots=0;
 while(Date.now()<deadline){await vm.refresh();if(vm.state.needsReboot){if(++reboots>2)throw Error('Desktop did not settle after reboot');await vm.restart();}if(vm.state.desktopReady&&vm.state.appsReady&&!vm.state.maintenance)break;if(vm.state.lastError&&!vm.state.maintenance)throw Error(vm.state.lastError);await new Promise(r=>setTimeout(r,5000));}
 if(!vm.state.appsReady||!vm.state.desktopReady)throw Error('Guest desktop preparation timed out');
 const browser=await step('verify native browser installation',()=>vm.execute('aelion-browser --version; command -v xdotool libreoffice','mac-smoke'));if(browser.exitCode!==0)throw Error('Browser/desktop tools unavailable');
 const first=await step('create isolated Bot desktop',()=>computer.execute('mac-smoke',{action:'screenshot'},AbortSignal.timeout(120000)));if(first.screenshot.width<800)throw Error('Desktop screenshot invalid');
 const opened=await step('launch browser in the Bot desktop',()=>computer.execute('mac-smoke',{action:'open_app',app:'browser'},AbortSignal.timeout(120000)));writeFileSync(join(out,`mac-${arch}-guest.png`),readFileSync(join(computer.imageDir,opened.screenshot.id+'.png')));
 const nonce=randomUUID(),written=await vm.executePython('import json,sys,pathlib; a=json.load(sys.stdin); pathlib.Path("proof.txt").write_text(a["nonce"]); print("written")',Buffer.from(JSON.stringify({nonce})),'mac-smoke');if(written.exitCode!==0)throw Error('Guest write failed');
 await step('stop and restart guest',async()=>{computer.release('mac-smoke');await vm.stop();await vm.start();return true;});
 const persisted=await vm.execute('cat proof.txt','mac-smoke');if(persisted.exitCode!==0||!persisted.stdout.includes(nonce))throw Error('Work file did not persist');proof.passed=true;save();
}catch(error){proof.error=(error as Error).message;save();let token='';try{token=JSON.parse(readFileSync(join(vm.dir,'machine.json'),'utf8')).seedToken||'';}catch{}
 const redact=(value:string)=>{const safe=value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[redacted private key]');return token?safe.replaceAll(token,'[redacted seed]'):safe;};
 const logs=Object.fromEntries(['qemu.log','serial.log'].filter(name=>existsSync(join(vm.dir,name))).map(name=>[name,redact(readFileSync(join(vm.dir,name),'utf8').slice(-1000000))]));writeFileSync(join(out,`mac-${arch}-vm-diagnostics.json`),JSON.stringify(logs,null,2));
 try{console.error(redact((await vm.execute('tail -n 50 /var/log/aelion-desktop.log','mac-smoke')).stdout));}catch{}throw error;}
finally{computer.release('mac-smoke');await vm.stop().catch(()=>{});vm.dispose();}
