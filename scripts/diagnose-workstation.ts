import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { VmController } from '../electron/core/vm';
const vm=new VmController({dataDir:resolve('.local/app'),runtimeDir:resolve('runtime/qemu'),cacheDir:resolve('runtime/downloads')});
try{
  await vm.refresh();
  const result=await vm.execute(`printf 'APPLICATIONS\n'; command -v google-chrome chromium thunar xdg-open exo-open xclip xdotool || true; dpkg-query -W -f='\${binary:Package} \${Status} \${Version}\n' chromium thunar gvfs google-chrome-stable 2>/dev/null || true; printf '\nDESKTOP DEFAULTS\n'; cat /home/aelion/.config/xfce4/helpers.rc 2>/dev/null; printf '\nBROWSER VERSION\n'; chromium --version 2>&1; printf '\nGUI START PROBE\n'; DISPLAY=:0 XAUTHORITY=/home/aelion/.Xauthority timeout 8 chromium --no-first-run --no-default-browser-check about:blank 2>&1; printf '\nPROCESSES\n'; pgrep -af 'chromium|thunar'`,'diagnostics');
  writeFileSync(resolve('.local/proof/workstation-before.json'),JSON.stringify(result,null,2));console.log(result.stdout);console.log(result.stderr);
}finally{vm.dispose();}
