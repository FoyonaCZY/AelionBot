import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {verifiedDownload} from '../electron/core/download';
const hash=(bytes:Buffer)=>createHash('sha512').update(bytes).digest('hex');
async function fixture(t:test.TestContext,handler:(request:IncomingMessage,response:ServerResponse)=>void){
  const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-download-')),server=createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});
  return {root,destination:join(root,'image.qcow2'),url:`http://127.0.0.1:${(server.address() as any).port}/image`,options:{retryDelayMs:0,attempts:2,connectTimeoutMs:1000,idleTimeoutMs:1000}};
}
function serve(bytes:Buffer,request:IncomingMessage,response:ServerResponse){const offset=Number(/bytes=(\d+)-/.exec(request.headers.range||'')?.[1]||0);response.writeHead(offset?206:200,{'Content-Length':bytes.length-offset,...(offset?{'Content-Range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})});response.end(bytes.subarray(offset));}
test('an interrupted image transfer resumes its actual stored bytes and verifies the final hash',async t=>{
  const body=randomBytes(128*1024);let requests=0,resume=0;
  const f=await fixture(t,(request,response)=>{requests++;if(requests===1){response.writeHead(200,{'Content-Length':body.length});response.write(body.subarray(0,32768));setTimeout(()=>response.destroy(),30);}else{resume=Number(/bytes=(\d+)-/.exec(request.headers.range||'')?.[1]||0);serve(body,request,response);}});
  await verifiedDownload(f.url,f.destination,hash(body),()=>{},'sha512',f.options);assert.equal(requests,2);assert.ok(resume>0);assert.deepEqual(readFileSync(f.destination),body);assert.equal(existsSync(f.destination+'.part'),false);
});
test('a server ignoring ranges restarts safely instead of appending a complete image twice',async t=>{
  const body=Buffer.from('verified complete image');const f=await fixture(t,(_request,response)=>{response.writeHead(200,{'Content-Length':body.length});response.end(body);});writeFileSync(f.destination+'.part',body.subarray(0,5));await verifiedDownload(f.url,f.destination,hash(body),()=>{},'sha512',f.options);assert.deepEqual(readFileSync(f.destination),body);
});
test('invalid range responses are discarded before a clean retry',async t=>{
  const body=Buffer.from('image with validated range');let calls=0;const f=await fixture(t,(request,response)=>{calls++;if(request.headers.range){response.writeHead(206,{'Content-Range':`bytes 0-${body.length-1}/${body.length}`});response.end(body);}else serve(body,request,response);});writeFileSync(f.destination+'.part',body.subarray(0,5));await verifiedDownload(f.url,f.destination,hash(body),()=>{},'sha512',f.options);assert.equal(calls,2);assert.deepEqual(readFileSync(f.destination),body);
});
test('an injected system-network fetch and a verified fallback source recover from an unavailable origin',async t=>{
  const body=Buffer.from('trusted mirrored image'),seen:string[]=[];const f=await fixture(t,(request,response)=>{if(request.url==='/image'){response.writeHead(503);response.end();}else serve(body,request,response);});
  await verifiedDownload(f.url,f.destination,hash(body),()=>{},'sha512',{...f.options,attempts:1,mirrors:[f.url+'/mirror'],fetch:async(url,options)=>{seen.push(url);return fetch(url,options);}});assert.deepEqual(seen,[f.url,f.url+'/mirror']);assert.deepEqual(readFileSync(f.destination),body);
});
test('corrupt cached and downloaded content never becomes the usable image',async t=>{
  const body=Buffer.from('expected image'),f=await fixture(t,(_request,response)=>response.end('corrupt'));writeFileSync(f.destination,'old corrupt cache');await assert.rejects(verifiedDownload(f.url,f.destination,hash(body),()=>{},'sha512',{...f.options,attempts:1}),/校验失败/);assert.equal(existsSync(f.destination),false);assert.equal(existsSync(f.destination+'.part'),false);assert.ok(readdirSync(f.root).some(name=>name.startsWith('image.qcow2.invalid-')));
});
test('a stalled response fails promptly while keeping resumable bytes',async t=>{
  const body=Buffer.from('a complete image');let stalled=true;const f=await fixture(t,(request,response)=>{if(stalled){response.writeHead(200,{'Content-Length':body.length});response.write('a');}else serve(body,request,response);});
  await assert.rejects(verifiedDownload(f.url,f.destination,hash(body),()=>{},'sha512',{...f.options,attempts:1,idleTimeoutMs:40}),/没有收到数据/);assert.equal(readFileSync(f.destination+'.part').toString(),'a');stalled=false;await verifiedDownload(f.url,f.destination,hash(body),()=>{},'sha512',f.options);assert.deepEqual(readFileSync(f.destination),body);
});
