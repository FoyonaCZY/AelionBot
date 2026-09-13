import {WebContentsView,ipcMain,type BrowserWindow,type IpcMainEvent} from 'electron';
import type {FeedbackOverlayLayout,FeedbackOverlayInput} from '../src/preview-feedback-overlay';

/** A trusted transparent sibling above the untrusted page, with a text-only bridge. */
export class PreviewFeedbackOverlay {
 private view?:WebContentsView;private ready=false;private layout?:FeedbackOverlayLayout;
 constructor(private window:BrowserWindow,private preload:string){ipcMain.on('preview-feedback-overlay:input',this.input);window.once('closed',()=>{this.close();ipcMain.removeListener('preview-feedback-overlay:input',this.input);});}
 private input=(event:IpcMainEvent,value:FeedbackOverlayInput)=>{
  const wc=this.view?.webContents,state=this.layout?.state;
  if(!wc||event.sender!==wc||event.senderFrame!==wc.mainFrame||!state||!this.layout?.visible||value?.id!==state.id||!Number.isSafeInteger(value.editVersion)||value.editVersion<state.editVersion||!['change','send','escape'].includes(value.kind)||typeof value.text!=='string'||value.text.length>12000||state.pending&&value.kind!=='escape')return;
  if(value.kind==='escape')this.window.webContents.focus();
  this.window.webContents.send('preview-feedback:input',value);
 };
 update(layout:FeedbackOverlayLayout|null){
  if(!layout||!layout.visible){this.layout=layout||undefined;this.view?.setVisible(false);return false;}
  const {rect,state}=layout;if(![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite)||rect.width<1||rect.height<1||typeof state?.id!=='string'||typeof state.text!=='string'||state.text.length>12000)throw Error('无效悬浮输入框');
  const finished=this.layout?.state.pending&&!state.pending;this.layout=layout;
  if(!this.view){
   const view=new WebContentsView({webPreferences:{preload:this.preload,contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});this.view=view;this.ready=false;
   view.setBackgroundColor('#00000000');view.setVisible(false);this.window.contentView.addChildView(view);
   view.webContents.setWindowOpenHandler(()=>({action:'deny'}));view.webContents.on('will-navigate',event=>event.preventDefault());
   view.webContents.on('before-input-event',(event,key)=>{if((key.control||key.meta)&&key.key.toLowerCase()==='s')event.preventDefault();});
   view.webContents.once('did-finish-load',()=>{if(this.view!==view)return;this.ready=true;if(this.layout)this.update(this.layout);});
   void view.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(OVERLAY_HTML)).catch(()=>{if(this.view===view)this.close();});
  }
  const view=this.view,zoom=this.window.webContents.getZoomFactor(),[w,h]=this.window.getContentSize(),pad=16;
  const x=Math.max(0,Math.round((rect.x-pad)*zoom)),y=Math.max(0,Math.round((rect.y-pad)*zoom));
  view.setBounds({x,y,width:Math.max(1,Math.min(w-x,Math.round((rect.width+pad*2)*zoom))),height:Math.max(1,Math.min(h-y,Math.round((rect.height+pad*2)*zoom)))});
  if(view.webContents.getZoomFactor()!==zoom)view.webContents.setZoomFactor(zoom);
  view.setVisible(this.ready);if(this.ready){view.webContents.send('preview-feedback-overlay:state',state);if(finished)view.webContents.focus();}return true;
 }
 close(){const view=this.view;this.view=undefined;this.layout=undefined;this.ready=false;if(!view)return;if(!this.window.isDestroyed())this.window.contentView.removeChildView(view);if(!view.webContents.isDestroyed())view.webContents.close();}
}
const OVERLAY_HTML=`<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-feedback'; style-src 'unsafe-inline'"><title>Preview feedback</title><style>
*{box-sizing:border-box}html,body{margin:0;background:transparent!important;color:#333942;font:14px/24px system-ui,'Segoe UI','Microsoft YaHei',sans-serif;overflow:hidden;color-scheme:light}body{padding:16px}form{display:flex;align-items:center;gap:12px;min-height:54px;padding:10px 12px 10px 18px;border:1px solid #e5e7eb;border-radius:28px;background:#fff;box-shadow:0 4px 16px #14223818}form:focus-within{border-color:#c6d4e4}textarea{display:block;flex:1;width:100%;height:24px;min-height:24px;max-height:108px;border:0;margin:0;padding:0;resize:none;outline:0;background:transparent;color:inherit;font:inherit;line-height:24px;scrollbar-width:thin}textarea::placeholder{color:#a1a7af}.capture{display:flex;color:#939aa4;flex-shrink:0}button{display:grid;place-items:center;width:32px;height:32px;align-self:flex-end;flex-shrink:0;border:0;border-radius:50%;padding:0;background:#303640;color:#fff}button:disabled{background:#f0f2f5;color:#9aa2ad}button:focus-visible{outline:2px solid #78a2ca;outline-offset:2px}#status{width:fit-content;max-width:100%;margin:0 auto 10px;padding:7px 12px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;color:#626b77;font-size:12px;line-height:1.6;overflow-wrap:anywhere;box-shadow:0 3px 12px #17202b12}#status:empty{display:none}#status.error{color:#a3624d}.spinner{width:13px;height:13px;border:1.5px solid #c7ccd4;border-top-color:#65758b;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none}}
</style></head><body><div id="status" role="status"></div><form><span class="capture"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 0 2-2v-3"/><rect x="7" y="7" width="10" height="10" rx="2"/></svg></span><textarea rows="1" maxlength="12000"></textarea><button type="submit"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button></form><script nonce="feedback">
const input=document.querySelector('textarea'),form=document.querySelector('form'),button=document.querySelector('button'),status=document.getElementById('status');const arrow=button.innerHTML;let pending=false,composing=false,localVersion=0,currentId='';
function size(){input.style.height='0px';input.style.height=Math.min(108,Math.max(24,input.scrollHeight))+'px';}
function send(){if(!pending&&input.value.trim()){pending=true;input.readOnly=true;button.disabled=true;localVersion=window.feedbackOverlay.act('send',input.value);}}
input.addEventListener('input',()=>{size();button.disabled=pending||!input.value.trim();localVersion=window.feedbackOverlay.act('change',input.value);});
input.addEventListener('compositionstart',()=>composing=true);input.addEventListener('compositionend',()=>composing=false);
input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!composing&&event.keyCode!==229){event.preventDefault();send();}});
form.addEventListener('submit',event=>{event.preventDefault();send();});document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();window.feedbackOverlay.act('escape',input.value);}});
window.feedbackOverlay.onState(state=>{if(currentId!==state.id){currentId=state.id;localVersion=0;}if(state.editVersion<localVersion)return;const finished=pending&&!state.pending;pending=state.pending;if(input.value!==state.text)input.value=state.text;input.readOnly=pending;button.disabled=pending||!state.text.trim();button.innerHTML=pending?'<span class="spinner"></span>':arrow;status.textContent=state.status;status.className=state.failed?'error':'';status.setAttribute('role',state.failed?'alert':'status');document.body.style.fontFamily=state.fontFamily;document.body.style.fontSize=state.fontSize;document.body.style.fontWeight=state.fontWeight;const en=state.language==='en',tw=state.language==='zh-TW';input.placeholder=en?'What would you like to change?':tw?'哪裡需要修改？':'哪里需要修改？';input.setAttribute('aria-label',en?'Preview feedback':'预览修改意见');button.setAttribute('aria-label',en?'Send feedback and screenshot':'发送修改意见和截图');size();if(finished)input.focus();});
</script></body></html>`;
