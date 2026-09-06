import {execFile} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

// Render the vector source with the app's own Chromium, without extra image tools.
if(!process.versions.electron){
  const {default:electron}=await import('electron');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout,stderr}=await promisify(execFile)(electron,[fileURLToPath(import.meta.url),`--user-data-dir=${fileURLToPath(new URL('../.local/icon-renderer',import.meta.url))}`],{env,windowsHide:true,timeout:30000});
  process.stdout.write(stdout);process.stderr.write(stderr);
}else{
  const {app,BrowserWindow}=await import('electron');
  const sizes=[16,20,24,32,40,48,64,128,256,512];
  app.disableHardwareAcceleration();
  app.whenReady().then(async()=>{
    const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await window.loadURL('data:text/html,<meta charset="utf-8">');
    const svg=readFileSync(new URL('../assets/icon.svg',import.meta.url),'utf8');
    const rendered=await window.webContents.executeJavaScript(`(async()=>{
      const source=new Image();
      source.src=${JSON.stringify('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'))};
      await source.decode();
      return ${JSON.stringify(sizes)}.map(size=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
        canvas.getContext('2d').drawImage(source,0,0,size,size);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    })()`);
    const images=rendered.map(data=>Buffer.from(data,'base64'));
    writeFileSync(new URL('../assets/icon.png',import.meta.url),images.at(-1));
    // ICO directory followed by PNG frames for Windows display scales.
    const frames=images.slice(0,-1),header=Buffer.alloc(6+16*frames.length);
    header.writeUInt16LE(1,2);header.writeUInt16LE(frames.length,4);
    let offset=header.length;
    frames.forEach((frame,index)=>{
      const entry=6+16*index,size=sizes[index];
      header[entry]=header[entry+1]=size===256?0:size;
      header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);
      header.writeUInt32LE(frame.length,entry+8);header.writeUInt32LE(offset,entry+12);
      offset+=frame.length;
    });
    writeFileSync(new URL('../assets/icon.ico',import.meta.url),Buffer.concat([header,...frames]));
    console.log('Generated assets/icon.png (512px) and assets/icon.ico (16–256px).');
    window.destroy();app.quit();
  }).catch(error=>{console.error(error);app.exit(1);});
}
