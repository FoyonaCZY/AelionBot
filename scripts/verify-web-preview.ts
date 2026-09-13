import {app,BrowserWindow,protocol,WebContentsView} from 'electron';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {WebPreviewBrowser} from '../electron/web-preview';
import {writeFileSync} from 'node:fs';
protocol.registerSchemesAsPrivileged([{scheme:'aelion-preview',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setPath('userData',process.argv[2]);
const timer=setTimeout(()=>{console.error('Native preview check timed out');app.exit(1);},30000);
async function run(){
await app.whenReady();console.log('phase: app ready');
const window=new BrowserWindow({show:false,width:900,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
await window.loadURL('data:text/html,<title>Test host</title>');
console.log('phase: host ready');const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<title>Page '+req.url+'</title><h1>Native preview</h1><script>document.body.dataset.script="ready"</script>');});server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
let released=0,resolveForward:((value:any)=>void)|undefined;
const vm={forwardPreviewPort:async(bot:string,target:number)=>{assert.equal(bot,'fixture');assert.equal(target,5173);return {localPort:port,close:()=>released++};}};
const browser=new WebPreviewBrowser(window,vm as any,{read:async(_bot:string,path:string)=>Buffer.from(path.endsWith('.js')?'document.title="Relative script loaded"':'<script src="assets/app.js"></script><h1>你好</h1>')} as any,{} as any,process.argv[2]+'/preview-feedback-preload.cjs');
const loaded=async()=>{const view=window.contentView.children.find(value=>value instanceof WebContentsView) as WebContentsView;assert.ok(view);if(view.webContents.isLoading())await once(view.webContents,'did-stop-loading');return view;};
try{
 let id=randomUUID();await browser.open(id,{kind:'url',url:'http://localhost:5173/app?q=1',location:'vm',botId:'fixture'});console.log('phase: url opening');let view=await loaded();console.log('phase: url loaded');browser.bounds(id,{x:10,y:120,width:700,height:450},true);
 assert.equal(await view.webContents.executeJavaScript('document.body.dataset.script'),'ready');assert.equal(await view.webContents.executeJavaScript('typeof window.aelion+":"+typeof require'),'undefined:undefined');
 const navigated=await browser.action(id,'navigate','http://localhost:5173/second');assert.match(navigated.url,/localhost:5173\/second/);assert.equal(navigated.canBack,true);

 const inputs:any[]=[];const originalSend=window.webContents.send.bind(window.webContents);window.webContents.send=(channel:string,...args:any[])=>{if(channel==='preview-feedback:input')inputs.push(args[0]);originalSend(channel,...args);};
 const floating={state:{id:'sample',editVersion:0,text:'',pending:false,status:'',failed:false,language:'zh-CN',fontFamily:'sans-serif',fontSize:'14px',fontWeight:'400'},rect:{x:100,y:480,width:500,height:54},visible:true};
 assert.equal(browser.feedback(floating),true);const overlay=window.contentView.children.at(-1) as WebContentsView;assert.notEqual(overlay,view);if(overlay.webContents.isLoading())await once(overlay.webContents,'did-finish-load');
 assert.equal(await overlay.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'),'rgba(0, 0, 0, 0)');
 assert.equal(await overlay.webContents.executeJavaScript('typeof window.aelion+":"+typeof require'),'undefined:undefined');
 await overlay.webContents.executeJavaScript('document.querySelector("textarea").value="调整这里的排版";document.querySelector("textarea").dispatchEvent(new Event("input",{bubbles:true}));');
 await new Promise(resolve=>setTimeout(resolve,40));assert.equal(inputs.at(-1)?.text,'调整这里的排版');assert.equal(inputs.at(-1)?.kind,'change');const version=inputs.at(-1).editVersion;
 browser.feedback(floating);assert.equal(await overlay.webContents.executeJavaScript('document.querySelector("textarea").value'),'调整这里的排版','old snapshots must not erase typing');
 browser.feedback({...floating,state:{...floating.state,text:'调整这里的排版',editVersion:version}});
 await overlay.webContents.executeJavaScript('document.querySelector("form").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}));');await new Promise(resolve=>setTimeout(resolve,40));assert.equal(inputs.at(-1)?.kind,'send');
 browser.feedback(null);assert.equal(overlay.getVisible(),false);browser.feedback({...floating,state:{...floating.state,editVersion:inputs.at(-1).editVersion,text:'',pending:false}});assert.equal(overlay.getVisible(),true);
 console.log('PASS: transparent overlay, text-only bridge, Chinese input, stale-state protection and send');
 console.log('phase: navigation verified');try{const png=await browser.capture({x:10,y:120,width:700,height:450});assert.ok(png&&png.length>100);writeFileSync(process.argv[2]+'/web.png',png);}catch(error){if(!String(error).includes('UnknownVizError'))throw error;console.log('SKIP: hidden native surface has no compositor screenshot');}
 await assert.rejects(browser.capture({x:0,y:0,width:700,height:450}));browser.close(id);assert.equal(released,1);assert.equal(window.contentView.children.length,0);
 console.log('phase: capture bounds verified');id=randomUUID();await browser.open(id,{kind:'document',format:'html',name:'index.html',workspace:{botId:'fixture',path:'site/index.html'}});view=await loaded();assert.equal(view.webContents.getTitle(),'Relative script loaded');assert.equal(await view.webContents.executeJavaScript('document.querySelector("h1").textContent'),'你好');
 browser.close(id);
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+value+'\nendobj\n';});const xref=Buffer.byteLength(pdf);pdf+='xref\n0 5\n0000000000 65535 f \n'+offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
 id=randomUUID();await browser.open(id,{kind:'document',format:'pdf',name:'sample.pdf',dataUrl:'data:application/pdf;base64,'+Buffer.from(pdf).toString('base64')});view=await loaded();assert.match(view.webContents.getURL(),/document.pdf/);assert.equal(await view.webContents.executeJavaScript('document.contentType'), 'application/pdf');browser.close(id);
 // Closing while the SSH connection is pending must never create a ghost browser view.
 vm.forwardPreviewPort=async()=>new Promise(resolve=>resolveForward=resolve);
 id=randomUUID();const opening=browser.open(id,{kind:'url',url:'http://localhost:5173',location:'vm',botId:'fixture'});browser.close(id);resolveForward!({localPort:port,close:()=>released++});await assert.rejects(opening,/已关闭/);assert.equal(window.contentView.children.length,0);assert.equal(released,2);
 console.log('PASS: native navigation, script isolation, HTML assets, PDF viewer, capture bounds, tunnel cleanup and pending cancellation');
}catch(error){console.error(error);process.exitCode=1;}finally{clearTimeout(timer);browser.close();server.close();window.destroy();app.exit(process.exitCode?1:0);}

}
void run().catch(error=>{console.error(error);app.exit(1);});
