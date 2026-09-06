import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {VmController} from '../electron/core/vm';
const vm=new VmController({dataDir:resolve('.local/app'),runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads')});
try{
  await vm.refresh();const state=vm.state;
  const applications=await vm.execute("google-chrome-stable --version; /usr/local/bin/aelion-session thunar --version | head -n 1; libreoffice --version; /usr/local/bin/aelion-session xfconf-query -c xsettings -p /Net/ThemeName; /usr/local/bin/aelion-session xfconf-query -c xsettings -p /Net/IconThemeName; /usr/local/bin/aelion-session xdg-mime query default text/plain",'diagnostics');
  const proof={checkedAt:new Date().toISOString(),status:state.status,desktopReady:state.desktopReady,appsReady:state.appsReady,maintenance:state.maintenance,applications};
  writeFileSync(resolve('.local/proof/workstation-readiness.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
}finally{vm.dispose();}
