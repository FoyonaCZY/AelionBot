import {resolve} from 'node:path';
import {mkdirSync,writeFileSync} from 'node:fs';
import {VmController} from '../electron/core/vm';
const vm=new VmController({dataDir:resolve('.local/app'),runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads')});
const report:Record<string,unknown>={};
for(const command of ['query-status','query-uuid','query-cpus-fast','query-block']){
  try{report[command]=await vm.qmp(command);}catch(error){report[command]={error:(error as Error).message};}
}
mkdirSync(resolve('.local/proof'),{recursive:true});
try{report.screenshot=await vm.qmp('screendump',{filename:resolve('.local/proof/vm-screen.png'),format:'png'});}catch(error){report.screenshot={error:(error as Error).message};}
writeFileSync(resolve('.local/proof/vm-inspection.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(process.argv.includes('--stop-confirmed-boot-failure')){
  const {readFileSync}=await import('node:fs');
  const expected=JSON.parse(readFileSync(resolve('.local/app/vm/machine.json'),'utf8')).id;
  const identity=await vm.qmp('query-uuid');if(identity.UUID!==expected)throw new Error('VM identity mismatch');
  await vm.qmp('quit');console.log('Stopped the inspected pre-boot-failed VM.');
}
vm.dispose();
