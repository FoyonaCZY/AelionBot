import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {HostComputer} from '../electron/core/host';
import {Interactions,InteractionDenied,respondToInteraction} from '../electron/core/interactions';
import {applyHostPatch,parsePatch,applyHunks,VM_PATCH_SCRIPT} from '../electron/core/multi-patch';
import {WebTools,extractWebPage,publicWebUrl,publicAddress} from '../electron/core/web-tools';
import {discoverTools} from '../electron/core/tool-discovery';
import {CodeOrchestrator} from '../electron/core/code-orchestrator';
import {TerminalSessions} from '../electron/core/terminal-sessions';
import type {InteractionRequest} from '../src/shared';
const signal=()=>new AbortController().signal;
function fixture(t:test.TestContext){
 const parent=realpathSync.native(tmpdir()),dir=mkdtempSync(join(parent,'aelion-foundations-')),seen:InteractionRequest[]=[];
 const interactions=new Interactions(()=>{for(const request of interactions.snapshot())if(request.kind==='host_permission'){seen.push(request);queueMicrotask(()=>{try{interactions.approve(request.id,true);}catch{}});}});
 const host=new HostComputer({dataDir:join(dir,'data'),projectDir:dir,homeDir:dir,env:{...process.env}},interactions);
 t.after(()=>{host.dispose();interactions.dispose();assert.equal(dirname(resolve(dir)),parent);rmSync(dir,{recursive:true,force:true});});return {dir,host,interactions,seen};
}
const patch='*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n keep\n*** Add File: added.txt\n+created\n*** Update File: move.txt\n*** Move to: renamed.txt\n*** Delete File: gone.txt\n*** End Patch';
test('multi-file patches update, add, rename and delete while preserving CRLF/BOM and requesting deletion permission',async t=>{
 const f=fixture(t);writeFileSync(join(f.dir,'a.txt'),'\uFEFFold\r\nkeep\r\n');writeFileSync(join(f.dir,'move.txt'),'move');writeFileSync(join(f.dir,'gone.txt'),'gone');
 const result=await applyHostPatch(f.host,f.interactions,'bot','run',{patch,reason:'Edit project'},signal(),f.dir);
 assert.equal(result.applied,true);assert.equal(readFileSync(join(f.dir,'a.txt'),'utf8'),'\uFEFFnew\r\nkeep\r\n');assert.equal(readFileSync(join(f.dir,'added.txt'),'utf8'),'created\n');assert.equal(readFileSync(join(f.dir,'renamed.txt'),'utf8'),'move');assert.equal(existsSync(join(f.dir,'move.txt')),false);assert.equal(existsSync(join(f.dir,'gone.txt')),false);assert.ok(f.seen.some(request=>request.kind==='host_permission'&&request.details.operation==='delete_file'));
});
test('invalid later hunks leave all files intact and ambiguous/overlapping targets are rejected',async t=>{
 const f=fixture(t);writeFileSync(join(f.dir,'a'),'one\n');writeFileSync(join(f.dir,'b'),'two\n');
 await assert.rejects(applyHostPatch(f.host,f.interactions,'bot','run',{patch:'*** Begin Patch\n*** Update File: a\n@@\n-one\n+changed\n*** Update File: b\n@@\n-missing\n+changed\n*** End Patch',reason:'test'},signal(),f.dir),/不匹配/);assert.equal(readFileSync(join(f.dir,'a'),'utf8'),'one\n');
 assert.throws(()=>applyHunks(Buffer.from('same\nsame\n'),[{before:['same'],after:['x'],eof:false}]),/多处/);
 await assert.rejects(applyHostPatch(f.host,f.interactions,'bot','run',{patch:'*** Begin Patch\n*** Add File: x\n+a\n*** Add File: ./x\n+b\n*** End Patch',reason:'test'},signal(),f.dir),/同一路径/);
});
test('write failure rolls back earlier patch operations without claiming partial success',async t=>{
 const f=fixture(t);writeFileSync(join(f.dir,'a'),'original\n');writeFileSync(join(f.dir,'not-a-directory'),'file');
 await assert.rejects(applyHostPatch(f.host,f.interactions,'bot','run',{patch:'*** Begin Patch\n*** Update File: a\n@@\n-original\n+changed\n*** Add File: not-a-directory/nested\n+x\n*** End Patch',reason:'test'},signal(),f.dir));assert.equal(readFileSync(join(f.dir,'a'),'utf8'),'original\n');
});
test('VM patch script applies the same multi-file grammar and prevents paths outside its workspace',t=>{
 const f=fixture(t),python=process.env.AELION_TEST_PYTHON||'python';writeFileSync(join(f.dir,'a.txt'),'\uFEFFold\r\nkeep\r\n');writeFileSync(join(f.dir,'move.txt'),'move');writeFileSync(join(f.dir,'gone.txt'),'gone');
 const execute=(files:unknown)=>execFileSync(python,['-c','import json,sys\na=json.load(sys.stdin)\n'+VM_PATCH_SCRIPT],{cwd:f.dir,input:JSON.stringify({files}),encoding:'utf8',stdio:['pipe','pipe','pipe']});assert.equal(JSON.parse(execute(parsePatch(patch))).applied,true);assert.equal(readFileSync(join(f.dir,'a.txt'),'utf8'),'\uFEFFnew\r\nkeep\r\n');assert.throws(()=>execute(parsePatch('*** Begin Patch\n*** Add File: ../outside\n+no\n*** End Patch')));
});
test('public web parsing removes executable markup, resolves links and pages a stable per-Bot snapshot',async()=>{
 const parsed=extractWebPage({url:'https://example.com/docs/',contentType:'text/html',body:'<html><head><title>Guide</title></head><body><script>secretScript()</script><main><h1>Heading</h1><p>Hello <b>world</b></p><a href="next">Next</a></main></body></html>'});assert.equal(parsed.title,'Guide');assert.match(parsed.text,/Hello world/);assert.ok(!parsed.text.includes('secretScript'));assert.equal(parsed.links[0].url,'https://example.com/docs/next');
 let loads=0;const web=new WebTools(async url=>{loads++;return {url,contentType:'text/plain',body:'page '.repeat(1000)};});const first=await web.read('a',{url:'https://example.com',maxChars:100},signal());const next=await web.read('a',{id:first.id,offset:first.nextOffset,maxChars:100},signal());assert.equal(loads,1);assert.equal(next.offset,100);await assert.rejects(web.read('b',{id:first.id},signal()),/不存在/);
});
test('web requests reject private addresses, credentialed URLs, non-HTTP schemes and encoded loopback',()=>{
 for(const url of ['http://127.0.0.1','http://2130706433','http://0x7f000001','http://[::1]','http://[::ffff:127.0.0.1]','http://10.1.1.1','http://169.254.169.254','file:///etc/passwd','https://u:p@example.com','http://localhost.'])assert.throws(()=>publicWebUrl(url));assert.equal(publicAddress('192.168.0.1'),false);assert.equal(publicAddress('8.8.8.8'),true);
});
test('search returns actual parsed links and clearly fails if services provide no results',async()=>{
 const web=new WebTools(async url=>({url,contentType:'application/rss+xml',body:'<rss><channel><item><title>Guide</title><link>https://example.com/guide</link><description>Read this</description></item></channel></rss>'}));const found=await web.search('a',{query:'guide'},signal());assert.equal(found.results[0].url,'https://example.com/guide');assert.equal(found.engine,'bing');
 await assert.rejects(new WebTools(async url=>({url,contentType:'text/html',body:'<html>captcha</html>'})).search('a',{query:'guide'},signal()),/暂不可用/);
});
test('tool discovery searches beyond the first MCP page and never enables disabled services',async()=>{
 let checked='';const mcp={views:()=>[{id:'yes',enabled:true},{id:'no',enabled:false}],listTools:async(id:string,_query:string,offset:number,limit:number)=>{checked=id;assert.equal(limit,1000);return {tools:[{name:'find_document',description:'Search invoices',inputSchema:{type:'object'}}]};}};
 const result=await discoverTools({query:'invoices'},[],mcp as any,signal());assert.equal(result.tools[0].name,'find_document');assert.equal(result.tools[0].server,'yes');assert.equal(checked,'yes');
});
test('questions allow background work and validate one human response without accepting cross-Bot access',async()=>{
 const interactions=new Interactions(()=>{}),controller=new AbortController();try{
  const result=await interactions.ask('a','run',[{id:'choice',title:'Which?',options:['A','B']}],controller.signal);assert.equal(interactions.snapshot()[0].kind,'user_input');assert.equal((await interactions.waitQuestion('a',result.id,signal(),0)).status,'waiting');assert.throws(()=>interactions.questionStatus('b',result.id));assert.throws(()=>interactions.answer(result.id,{wrong:'x'}));
  respondToInteraction(interactions,{} as any,{id:result.id,action:'answer',answers:{choice:'Custom'}});assert.equal((await interactions.waitQuestion('a',result.id,signal(),0)).answers?.choice,'Custom');assert.equal(interactions.consumeAnswers('a','run').length,1);assert.equal(interactions.consumeAnswers('a','run').length,0);assert.throws(()=>interactions.answer(result.id,{choice:'B'}));
 }finally{interactions.dispose();}
});
test('cancelled questions disappear and do not accept stale answers',async()=>{
 const interactions=new Interactions(()=>{}),controller=new AbortController();try{const result=await interactions.ask('a','r',[{id:'q',title:'Question'}],controller.signal);controller.abort();await new Promise(resolve=>setImmediate(resolve));assert.equal(interactions.snapshot().length,0);assert.throws(()=>interactions.answer(result.id,{q:'late'}));}finally{interactions.dispose();}
});
test('code orchestration supports real async branches, filters results and has no Node or filesystem access',async()=>{
 const runtime=new CodeOrchestrator(resolve('electron/core'));try{const calls:string[]=[];const result=await runtime.run({code:"const all=await Promise.all([tools.read({n:1}),tools.read({n:2})]);emit(all.map(x=>x.n));return [typeof process,typeof require,typeof fetch];"},['read'],signal(),async(name,args)=>{calls.push(name);return args;}) as any;assert.deepEqual(result.output,[[1,2]]);assert.deepEqual(result.value,['undefined','undefined','undefined']);assert.equal(calls.length,2);}finally{await runtime.dispose();}
});
test('code CPU loops are interrupted and permission denial cannot be swallowed to issue more calls',async()=>{
 const runtime=new CodeOrchestrator(resolve('electron/core'));try{await assert.rejects(runtime.run({code:'while(true){}'},[],signal(),async()=>null),/interrupted/i);let count=0;await assert.rejects(runtime.run({code:"try{await tools.write({});}catch{};await tools.write({});"},['write'],signal(),async()=>{count++;throw new InteractionDenied();}),/拒绝/);assert.equal(count,1);}finally{await runtime.dispose();}
});
test('pipe terminals accept continued input, enforce ownership, and approve every nonempty host input',async t=>{
 const f=fixture(t),sessions=new TerminalSessions({} as any,f.host,f.interactions,resolve('electron/core'));t.after(()=>sessions.dispose());
 const command=process.platform==='win32'?"$x=[Console]::ReadLine(); Write-Output ('ANSWER_'+$x)":"read x; printf 'ANSWER_%s\\n' \"$x\"";
 const opened=await sessions.start('a','r',{command,location:'host',tty:false,reason:'test',yieldTimeMs:0},signal(),f.dir);await assert.rejects(sessions.input('b','r',{id:opened.id,chars:'wrong'},signal()),/不属于/);await sessions.input('a','r',{id:opened.id,chars:'Ada\n',reason:'answer',yieldTimeMs:10},signal());let status=await sessions.read('a',opened.id,signal(),1000);for(let i=0;i<10&&status.status!=='exited';i++)status=await sessions.read('a',opened.id,signal(),1000);assert.match(status.output,/ANSWER_Ada/);assert.equal(status.exitCode,0);assert.equal(f.seen.length,2);
});
test('native PTY accepts an interactive prompt and releases its resources after exit',async t=>{
 const f=fixture(t),sessions=new TerminalSessions({} as any,f.host,f.interactions,resolve('electron/core'));t.after(()=>sessions.dispose());
 const command=process.platform==='win32'?"$x=Read-Host 'Name'; Write-Output ('PTY_'+$x)":"printf 'Name: '; read x; printf 'PTY_%s\\n' \"$x\"";
 const opened=await sessions.start('a','r',{command,location:'host',tty:true,reason:'terminal test',yieldTimeMs:500},signal(),f.dir);await sessions.input('a','r',{id:opened.id,chars:'Ada\r',reason:'answer prompt',yieldTimeMs:250},signal());
 let status=await sessions.read('a',opened.id,signal(),1000);for(let i=0;i<10&&status.status!=='exited';i++)status=await sessions.read('a',opened.id,signal(),1000);assert.equal(status.exitCode,0,JSON.stringify(status));assert.match(status.output,/PTY_Ada/);
});
