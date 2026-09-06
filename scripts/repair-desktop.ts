import {resolve} from 'node:path';
import {VmController} from '../electron/core/vm';
const vm=new VmController({dataDir:resolve('.local/app'),runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads')});
try{
  await vm.refresh();await vm.repairTools();console.log('Desktop maintenance job started inside the existing guest.');
}finally{vm.dispose();}
