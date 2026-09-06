import {resolve} from 'node:path';
import {VmController} from '../electron/core/vm';
const vm=new VmController({dataDir:resolve('.local/app'),runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads')});
console.log(await vm.displayDiagnostics());
console.log(await vm.qmp('query-mice'));
vm.dispose();
