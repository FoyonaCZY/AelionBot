import {ipcMain,type BrowserWindow} from 'electron';

export function installComputerView(window:BrowserWindow){
  let previousFullscreen:boolean|undefined;
  const restore=()=>{
    if(previousFullscreen===undefined)return;
    const fullscreen=previousFullscreen;previousFullscreen=undefined;
    if(!window.isDestroyed())window.setFullScreen(fullscreen);
  };
  ipcMain.handle('computer:fullscreen',(event,enabled:unknown)=>{
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('不受信任的调用来源');
    if(typeof enabled!=='boolean')throw new Error('无效全屏状态');
    if(!enabled){restore();return;}
    if(previousFullscreen!==undefined)return;
    previousFullscreen=window.isFullScreen();
    window.setFullScreen(true);
  });
  window.webContents.on('did-navigate',restore);
  window.webContents.on('render-process-gone',restore);
  window.once('closed',()=>ipcMain.removeHandler('computer:fullscreen'));
}
