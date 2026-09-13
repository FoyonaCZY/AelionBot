import {PreviewFeedbackOverlay} from './preview-feedback-overlay';
import type {FeedbackOverlayLayout} from '../src/preview-feedback-overlay';
import {WebContentsView,session,type BrowserWindow,type Session} from 'electron';
import {randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import type {VmController} from './core/vm';
import type {ArtifactService} from './core/artifacts';
import type {Attachments} from './core/attachments';
import {webPreviewUrl,vmPreviewPort,type WebPreviewSource,type WebPreviewState} from '../src/web-preview';
import {mime,webResourcePath,webFileResponse} from './core/web-preview-resources';
interface Active {botId?:string;document:boolean;id:string;view:WebContentsView;session:Session;state:WebPreviewState;closeTunnel?:()=>void;origin?:string;guestOrigin?:string;token:string;bounds:{x:number;y:number;width:number;height:number};visible:boolean;}
export class WebPreviewBrowser {
 private feedbackOverlay?:PreviewFeedbackOverlay;private feedbackLayout?:FeedbackOverlayLayout;
 private active?:Active;private pendingId?:string;private epoch=0;private cleanup:Promise<unknown>=Promise.resolve();
 constructor(private window:BrowserWindow,private vm:VmController,private artifacts:ArtifactService,private attachments:Attachments,feedbackPreload?:string){if(feedbackPreload)this.feedbackOverlay=new PreviewFeedbackOverlay(window,feedbackPreload);window.once('closed',()=>this.close());window.webContents.on('render-process-gone',()=>this.close());window.webContents.on('did-start-loading',()=>this.close());}
 feedback(layout:FeedbackOverlayLayout|null){this.feedbackLayout=layout||undefined;return this.feedbackOverlay?.update(layout?{...layout,visible:layout.visible&&Boolean(this.active?.visible&&!this.active?.state.error)}:null)||false;}
 private emit(active:Active){if(this.active!==active)return;active.view.setVisible(active.visible&&!active.state.error);if(this.feedbackLayout)this.feedback(this.feedbackLayout);if(!this.window.isDestroyed())this.window.webContents.send('web-preview:event',active.state);}
 private allowed(active:Active,value:string){try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password||url.protocol==='aelion-preview:'&&url.hostname===active.token||url.href==='about:blank';}catch{return false;}}
 async open(id:string,source:WebPreviewSource){
  if(!/^[a-f0-9-]{36}$/.test(id))throw Error('无效网页预览 ID');this.close();this.pendingId=id;const epoch=this.epoch,token=randomUUID();let url='',closeTunnel:(()=>void)|undefined,origin:string|undefined,guestOrigin:string|undefined;
  try{
  if(source.kind==='url'){
   const parsed=webPreviewUrl(source.url);url=parsed.href;
   if(source.location==='vm'){if(!source.botId)throw Error('VM 网页缺少 Bot');const guest=vmPreviewPort(source.url);const tunnel=await this.vm.forwardPreviewPort(source.botId,guest.port);let released=false;closeTunnel=()=>{if(!released){released=true;tunnel.close();}};origin='http://127.0.0.1:'+tunnel.localPort;guestOrigin=guest.url.origin;url=origin+guest.url.pathname+guest.url.search+guest.url.hash;}
  }else if(source.kind==='document'){
   if(!['html','pdf'].includes(source.format)||typeof source.name!=='string'||source.content&&source.content.length>2*1024*1024||source.dataUrl&&source.dataUrl.length>40*1024*1024)throw Error('文档预览数据无效');
   url='aelion-preview://'+token+'/'+(source.format==='pdf'?'document.pdf#view=Fit':'index.html');
  }else throw Error('未知网页预览来源');
  if(epoch!==this.epoch||this.window.isDestroyed()){closeTunnel?.();throw Error('预览已关闭');}
  await this.cleanup;if(epoch!==this.epoch||this.window.isDestroyed()){closeTunnel?.();throw Error('预览已关闭');}
  const ses=session.fromPartition('aelion-web-preview');ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);
  ses.removeAllListeners('will-download');ses.on('will-download',event=>event.preventDefault());
  ses.webRequest.onBeforeRequest((details,callback)=>{let protocol='';try{protocol=new URL(details.url).protocol;}catch{}callback({cancel:['file:','devtools:'].includes(protocol)});});
  const view=new WebContentsView({webPreferences:{session:ses,nodeIntegration:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,plugins:true}});
  const active:Active={botId:source.kind==='url'&&source.location==='vm'?source.botId:undefined,document:source.kind==='document',id,view,session:ses,token,closeTunnel,origin,guestOrigin,bounds:{x:0,y:0,width:1,height:1},visible:false,state:{id,url:source.kind==='url'?source.url:source.name,title:source.kind==='document'?source.name:'',loading:true,canBack:false,canForward:false}};this.active=active;this.pendingId=undefined;this.window.contentView.addChildView(view);view.setVisible(false);
  if(source.kind==='document'){
   const document=source;const rootName=document.format==='pdf'?'document.pdf':'index.html';
   const rootBytes=async()=>{if(document.content!==undefined)return Buffer.from(document.content);if(document.attachmentId&&document.format==='html')return this.attachments.bytes(document.attachmentId);if(document.workspace&&document.format==='html')return this.artifacts.read(document.workspace.botId,document.workspace.path,2*1024*1024);if(document.dataUrl?.startsWith('data:application/pdf;base64,'))return Buffer.from(document.dataUrl.slice('data:application/pdf;base64,'.length),'base64');throw Error('文档内容不可用');};
   await ses.protocol.handle('aelion-preview',async request=>{try{const target=new URL(request.url);if(target.hostname!==token||!['GET','HEAD'].includes(request.method))return new Response(null,{status:403});const path=webResourcePath(target.pathname);let bytes:Buffer,type:string;
    if(path===rootName){bytes=await rootBytes();type=document.format==='pdf'?'application/pdf':'text/html';}
    else{if(!document.workspace||document.format!=='html')return new Response(null,{status:404});const file=posix.join(posix.dirname(document.workspace.path),path);bytes=await this.artifacts.read(document.workspace.botId,file,15*1024*1024);type=mime[path.split('.').at(-1)!.toLowerCase()];}
    if(request.method==='HEAD')return new Response(null,{headers:{'Content-Type':type,'Content-Length':String(bytes.length)}});return webFileResponse(bytes,type,request.headers.get('range'));
   }catch{return new Response('Preview resource unavailable',{status:404});}});
  }
  if(this.active!==active)return active.state;
  const update=()=>{if(this.active!==active)return;const current=view.webContents.getURL();active.state={...active.state,url:origin&&guestOrigin&&(current===origin||current.startsWith(origin+'/'))?guestOrigin+current.slice(origin.length):source.kind==='document'&&current.startsWith('aelion-preview:')?source.name:current||active.state.url,title:view.webContents.getTitle()||active.state.title,canBack:view.webContents.navigationHistory.canGoBack(),canForward:view.webContents.navigationHistory.canGoForward()};this.emit(active);};
  view.webContents.setWindowOpenHandler(({url})=>{if(this.allowed(active,url))void view.webContents.loadURL(url).catch(()=>{});return {action:'deny'};});
  view.webContents.on('will-navigate',(event,url)=>{if(!this.allowed(active,url))event.preventDefault();});
  view.webContents.on('will-redirect',(event,url)=>{if(!this.allowed(active,url))event.preventDefault();});
  view.webContents.on('did-start-loading',()=>{active.state.loading=true;active.state.error=undefined;update();});
  view.webContents.on('did-stop-loading',()=>{active.state.loading=false;update();});view.webContents.on('did-navigate',update);view.webContents.on('did-navigate-in-page',update);view.webContents.on('page-title-updated',update);
  view.webContents.on('did-fail-load',(_e,code,message,_url,main)=>{if(code===-3||!main)return;active.state.error=message;active.state.loading=false;this.emit(active);});
  view.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.key==='Escape'){event.preventDefault();this.window.webContents.focus();this.window.webContents.send('web-preview:escape',id);}});
  void view.webContents.loadURL(url).catch(error=>{if(this.active===active){active.state.error=error.message;active.state.loading=false;this.emit(active);}});return active.state;
  }catch(error){if(epoch===this.epoch)this.close(id);closeTunnel?.();throw error;}
 }
 bounds(id:string,rect:{x:number;y:number;width:number;height:number},visible:boolean){const active=this.active;if(!active||active.id!==id)return;const zoom=this.window.webContents.getZoomFactor(),[w,h]=this.window.getContentSize();if(![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))throw Error('网页范围无效');const x=Math.max(0,Math.round(rect.x*zoom)),y=Math.max(0,Math.round(rect.y*zoom)),width=Math.max(1,Math.min(w-x,Math.round(rect.width*zoom))),height=Math.max(1,Math.min(h-y,Math.round(rect.height*zoom)));active.bounds={x,y,width,height};active.visible=visible&&x<w&&y<h&&rect.width>1&&rect.height>1;active.view.setBounds(active.bounds);this.emit(active);}
 async action(id:string,action:string,url?:string){const active=this.active;if(!active||active.id!==id)throw Error('网页预览已关闭');const wc=active.view.webContents;if(action==='back'&&wc.navigationHistory.canGoBack())wc.navigationHistory.goBack();else if(action==='forward'&&wc.navigationHistory.canGoForward())wc.navigationHistory.goForward();else if(action==='reload'){active.state.error=undefined;wc.reload();}else if(action==='navigate'){let target=webPreviewUrl(url).href;if(active.botId&&['localhost','127.0.0.1','[::1]','0.0.0.0'].includes(new URL(target).hostname)&&new URL(target).origin!==active.guestOrigin){const zoom=this.window.webContents.getZoomFactor(),b=active.bounds,next=await this.open(id,{kind:'url',url:target,location:'vm',botId:active.botId});this.bounds(id,{x:b.x/zoom,y:b.y/zoom,width:b.width/zoom,height:b.height/zoom},active.visible);return next;}if(active.guestOrigin&&active.origin&&new URL(target).origin===active.guestOrigin){const parsed=new URL(target);target=active.origin+parsed.pathname+parsed.search+parsed.hash;}await wc.loadURL(target);}return active.state;}
 async capture(rect:{x:number;y:number;width:number;height:number}){const active=this.active;if(!active)return;if(!active.visible||active.state.error)throw Error('网页暂不可见，请等待加载完成后重试');const zoom=this.window.webContents.getZoomFactor(),b=active.bounds;if(Math.abs(rect.x*zoom-b.x)>3||Math.abs(rect.y*zoom-b.y)>3||Math.abs(rect.width*zoom-b.width)>3||Math.abs(rect.height*zoom-b.height)>3)throw Error('网页尺寸已变化，请重新发送');let timer:ReturnType<typeof setTimeout>|undefined;let image=await Promise.race([active.view.webContents.capturePage(undefined,{stayHidden:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('网页截图超时，请重试')),10000);})]).finally(()=>{if(timer)clearTimeout(timer);});if(this.active!==active||image.isEmpty())throw Error('网页截图失败');const size=image.getSize();if(Math.max(size.width,size.height)>2560)image=image.resize(size.width>=size.height?{width:2560,quality:'best'}:{height:2560,quality:'best'});return image.toPNG();}
 close(id?:string){if(id&&this.active?.id!==id&&this.pendingId!==id)return;this.pendingId=undefined;this.epoch++;const active=this.active;this.active=undefined;this.feedbackOverlay?.close();this.feedbackLayout=undefined;if(!active)return;active.closeTunnel?.();if(!this.window.isDestroyed())this.window.contentView.removeChildView(active.view);if(!active.view.webContents.isDestroyed())active.view.webContents.close();if(active.document)active.session.protocol.unhandle('aelion-preview');this.cleanup=this.cleanup.then(()=>active.session.clearStorageData()).catch(()=>{});}
}