import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect,type Socket} from 'node:net';
import {once} from 'node:events';
import ssh2 from 'ssh2';
const {Client,Server:SSHServer}=ssh2;
import {generateKeyPairSync} from 'node:crypto';
import {PreviewTunnel} from '../electron/core/preview-tunnel';
import {webResourcePath,webFileResponse} from '../electron/core/web-preview-resources';
import {webPreviewUrl,vmPreviewPort,feedbackWebUrl} from '../src/web-preview';
import {previewFeedbackMessage,previewFeedbackDisplay} from '../src/preview-feedback';

test('web addresses reject executable schemes and credentials; VM forwarding accepts only explicit local high ports',()=>{
 for(const value of ['file:///tmp/a','javascript:alert(1)','data:text/html,hi','https://user:pass@example.com'])assert.throws(()=>webPreviewUrl(value));
 assert.equal(webPreviewUrl('https://example.com/a?q=1#part').pathname,'/a');
 for(const value of ['http://localhost','http://localhost:22','https://localhost:5173','http://example.com:5173'])assert.throws(()=>vmPreviewPort(value));
 for(const host of ['localhost','127.0.0.1','[::1]','0.0.0.0'])assert.equal(vmPreviewPort(`http://${host}:5173/path`).port,5173);
});
test('local web assets reject traversal, hidden files and unsupported file types',()=>{
 assert.equal(webResourcePath('/assets/app%20main.js'),'assets/app main.js');
 for(const path of ['/../a.js','/%2e%2e/a.js','/.env','/%5csecret.js','/file%00.js','/key.pem','/%broken'])assert.throws(()=>webResourcePath(path));
});
test('PDF ranges return the correct bytes, suffixes and unsatisfiable responses',async()=>{
 const bytes=Buffer.from('0123456789');
 assert.equal(await webFileResponse(bytes,'application/pdf',null).text(),'0123456789');
 const range=webFileResponse(bytes,'application/pdf','bytes=2-4');assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-4/10');assert.equal(await range.text(),'234');
 assert.equal(await webFileResponse(bytes,'application/pdf','bytes=-3').text(),'789');
 for(const range of ['bytes=10-20','bytes=7-3','bytes=0-1,5-7','bytes=-0'])assert.equal(webFileResponse(bytes,'application/pdf',range).status,416);
});
test('web feedback keeps the URL as model context and shows only the user prompt',()=>{
 const url=feedbackWebUrl('http://localhost:5173/report?token=secret&q=report#section');assert.ok(!url.includes('secret'));assert.ok(url.includes('q=report'));
 const content=previewFeedbackMessage({text:'Change the heading',file:{name:'Report',url},language:'en'});
 assert.ok(content.includes('URL: http://localhost:5173/report'));assert.equal(previewFeedbackDisplay({content,previewPrompt:'Change the heading',role:'user'}).content,'Change the heading');
});
test('loopback tunnel carries HTTP and upgraded bidirectional streams and closes active connections',async t=>{
 const sockets=new Set<Socket>();const upstream=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let started=false;socket.on('data',data=>{if(started){socket.write(data);return;}started=true;if(data.toString().includes('Upgrade: websocket'))socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');else socket.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello');});});
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const target=(upstream.address() as {port:number}).port;
 const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
 const ssh=new SSHServer({hostKeys:[key.privateKey]},connection=>{connection.on('authentication',context=>context.accept());connection.on('ready',()=>connection.on('tcpip',(accept,_reject,info)=>{assert.equal(info.destIP,'127.0.0.1');assert.equal(info.destPort,target);const channel=accept(),socket=connect(target,'127.0.0.1');channel.on('error',()=>socket.destroy());socket.on('error',()=>channel.destroy());channel.on('close',()=>socket.destroy());socket.pipe(channel).pipe(socket);}));});
 ssh.listen(0,'127.0.0.1');await once(ssh,'listening');const client=new Client();client.connect({host:'127.0.0.1',port:(ssh.address() as {port:number}).port,username:'fixture'});await once(client,'ready');
 const tunnel=new PreviewTunnel(port=>new Promise((resolve,reject)=>client.forwardOut('127.0.0.1',0,'127.0.0.1',port,(error,channel)=>error?reject(error):resolve(channel))),target);
 t.after(()=>{tunnel.close();client.end();ssh.close();for(const socket of sockets)socket.destroy();upstream.close();});
 const port=await tunnel.start();assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(),'hello');
 const ws=connect(port,'127.0.0.1');await once(ws,'connect');ws.write('GET /hmr HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n\r\n');assert.match(String((await once(ws,'data'))[0]),/101 Switching/);
 ws.write('hot-update');assert.equal(String((await once(ws,'data'))[0]),'hot-update');
 const closed=once(ws,'close');tunnel.close();await closed;await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});
