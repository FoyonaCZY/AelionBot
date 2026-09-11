import {createHash} from 'node:crypto';
import {createReadStream,existsSync,mkdirSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {VmController} from '../electron/core/vm';
import {WORKSTATION_VERSION} from '../electron/core/desktop-profile';
import {qemuBinary} from '../electron/core/vm-platform';
import {startCiGuest} from './ci-vm-boot';

const runFile=promisify(execFile);
export async function provisionGuestImage(){
 const accelerator=(process.env.AELION_ACCELERATOR as 'hvf'|'whpx'|'tcg'|undefined)||(process.platform==='darwin'?'hvf':process.platform==='win32'?'whpx':'tcg');
 if(accelerator==='tcg'&&process.env.AELION_PROVISION_TCG!=='1')throw Error('Provisioning a guest image requires HVF, WHPX, or KVM. Set AELION_PROVISION_TCG=1 only for local experiments.');
 const root=resolve(import.meta.dirname,'..'),arch=process.arch==='arm64'?'arm64':'x64';
 const out=resolve(process.argv[2]||join(root,'runtime','downloads'));mkdirSync(out,{recursive:true});
 const runtime=resolve('runtime/qemu');
 const vm=new VmController({dataDir:resolve('.local',`provision-guest-${arch}`),runtimeDir:runtime,cacheDir:resolve('runtime/downloads'),memoryMiB:4096,cpuCount:4,accelerator,startupTimeoutMs:600000});
 vm.on('state',state=>console.log(state.status+': '+state.detail));
 const deadline=Date.now()+25*60000;
 try{
  await vm.prepare();await startCiGuest(vm);
  let reboots=0;
  while(Date.now()<deadline){
   await vm.refresh();
   if(vm.state.needsReboot&&!vm.state.maintenance){
    if(++reboots>2)throw Error('Desktop did not settle after reboot');
    await vm.stop();await startCiGuest(vm);await vm.repairTools();
   }
   if(vm.state.desktopReady&&vm.state.appsReady&&!vm.state.maintenance)break;
   if(vm.state.lastError&&!vm.state.maintenance)throw Error(vm.state.lastError);
   await new Promise(r=>setTimeout(r,5000));
  }
  if(!vm.state.appsReady||!vm.state.desktopReady)throw Error('Guest desktop preparation timed out');
  const proof=await vm.execute('command -v aelion-browser >/dev/null && command -v thunar >/dev/null && command -v libreoffice >/dev/null; uname -r','provision');
  if(proof.exitCode!==0)throw Error('Provisioned guest is missing desktop tools');
  await vm.sealProvisionedGuest();
  await vm.stop();
  const source=join(vm.dir,'system.qcow2');
  if(!existsSync(source))throw Error('Provisioned system disk missing');
  const filename=`debian-12-workstation-${arch}-v${WORKSTATION_VERSION}.qcow2`;
  const destination=join(out,filename);
  const img=qemuBinary(runtime,process.platform==='win32'?'qemu-img.exe':'qemu-img');
  await runFile(img,['convert','-p','-O','qcow2','-c',source,destination],{windowsHide:true});
  const hash=createHash('sha512');
  for await(const chunk of createReadStream(destination))hash.update(chunk);
  const metadata={id:`debian12-workstation-${arch}-v${WORKSTATION_VERSION}`,version:`workstation-${WORKSTATION_VERSION}`,filename,url:'',sha512:hash.digest('hex'),provisionedWorkstation:WORKSTATION_VERSION,arch,accelerator,bytes:statSync(destination).size};
  writeFileSync(join(out,filename+'.json'),JSON.stringify(metadata,null,2));
  console.log(JSON.stringify({...metadata,path:destination},null,2));
  console.log('Host this qcow2 separately from the app installer, then point runtime/guest-image.json at it. Do not copy it into electron-builder extraResources.');
  return metadata;
 }finally{await vm.stop().catch(()=>{});vm.dispose();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await provisionGuestImage();
