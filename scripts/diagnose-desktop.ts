import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {VmController} from '../electron/core/vm';
const vm=new VmController({dataDir:resolve('.local/app'),runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads')});
const report=await vm.desktopDiagnostics();
writeFileSync(resolve('.local/proof/desktop-diagnostics.json'),JSON.stringify(report,null,2));
console.log(report.stdout);console.log(report.stderr);
await vm.qmp('screendump',{filename:resolve('.local/proof/guest-desktop.png'),format:'png'});
vm.dispose();
