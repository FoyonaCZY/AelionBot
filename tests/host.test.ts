import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {HostComputer,redactHost} from '../electron/core/host';
import {Interactions,InteractionDenied} from '../electron/core/interactions';

function fixture(t:test.TestContext){
  const tempRoot=realpathSync.native(tmpdir()),root=realpathSync.native(mkdtempSync(join(tempRoot,'aelion-host-test-')));
  const interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:root,homeDir:root,projectDir:root,env:{...process.env,AELION_TEST_TOKEN:'fixture-private-token-123456'}},interactions);
  t.after(()=>{interactions.dispose();host.dispose();assert.equal(dirname(resolve(root)),tempRoot);assert.ok(basename(root).startsWith('aelion-host-test-'));rmSync(root,{recursive:true,force:true});});
  return {root,host,interactions};
}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('every host file operation waits for a fresh single-use decision',async t=>{
  const {root,host,interactions}=fixture(t),path=join(root,'result.txt'),signal=new AbortController().signal;
  const denied=host.writeFile('bot-a','run-a',{path,content:'first',reason:'测试写入'},signal);
  const deniedCheck=assert.rejects(denied,InteractionDenied);const first=interactions.snapshot()[0];assert.equal(existsSync(path),false);
  interactions.approve(first.id,false);await deniedCheck;assert.equal(existsSync(path),false);assert.throws(()=>interactions.approve(first.id,true),/已结束/);
  const allowed=host.writeFile('bot-a','run-a',{path,content:'second',reason:'测试写入'},signal);const second=interactions.snapshot()[0];assert.notEqual(second.id,first.id);assert.equal(existsSync(path),false);
  interactions.approve(second.id,true);await allowed;assert.equal(readFileSync(path,'utf8'),'second');
  const reading=host.readFile('bot-a','run-a',{path,reason:'测试读取'},signal);assert.equal(interactions.snapshot()[0].kind,'host_permission');
  writeFileSync(path,'changed before approval');interactions.approve(interactions.snapshot()[0].id,true);
  assert.equal((await reading).content,'changed before approval');assert.equal(interactions.snapshot().length,0);
});

test('permission details cannot be rewritten through request snapshots or caller mutation',async t=>{
  const {root,host,interactions}=fixture(t),path=join(root,'approved.txt');
  const args={path,content:'approved bytes',reason:'保存这份文件'};
  const writing=host.writeFile('bot-a','run-a',args,new AbortController().signal);
  args.content='changed caller';args.path=join(root,'wrong.txt');const request=interactions.snapshot()[0];
  assert.equal(request.kind,'host_permission');if(request.kind==='host_permission')request.details.content='changed UI';
  interactions.approve(request.id,true);await writing;
  assert.equal(readFileSync(path,'utf8'),'approved bytes');assert.equal(existsSync(args.path),false);
});

test('cancelled and stale write approvals never overwrite a file',async t=>{
  const {root,host,interactions}=fixture(t),path=join(root,'existing.txt');writeFileSync(path,'original');
  const cancelled=new AbortController();const first=host.writeFile('bot-a','run-a',{path,content:'replace',overwrite:true,reason:'替换'},cancelled.signal);
  const firstCheck=assert.rejects(first,/取消/);cancelled.abort();await firstCheck;assert.equal(interactions.snapshot().length,0);assert.equal(readFileSync(path,'utf8'),'original');
  const second=host.writeFile('bot-a','run-b',{path,content:'replace',overwrite:true,reason:'替换'},new AbortController().signal);const secondCheck=assert.rejects(second,/发生变化/);
  writeFileSync(path,'user changed the file while deciding');interactions.approve(interactions.snapshot()[0].id,true);await secondCheck;
  assert.equal(readFileSync(path,'utf8'),'user changed the file while deciding');
  const thirdSignal=new AbortController();const third=host.writeFile('bot-a','run-c',{path,content:'replace',overwrite:true,reason:'替换'},thirdSignal.signal);const thirdCheck=assert.rejects(third,/取消/);
  interactions.approve(interactions.snapshot()[0].id,true);thirdSignal.abort();await thirdCheck;assert.equal(readFileSync(path,'utf8'),'user changed the file while deciding');
});

test('partial reads cannot reveal token fragments and masked credentials are not overwritten',async t=>{
  const {root,host,interactions}=fixture(t),path=join(root,'settings.txt'),secret='ghp_abcdefghijklmnopqrstuvwxyz123456789';writeFileSync(path,`api_key: ${secret}\nsetting: old`);
  const read=host.readFile('bot-a','run-a',{path,offset:12,reason:'读取片段'},new AbortController().signal);interactions.approve(interactions.snapshot()[0].id,true);
  const result=await read;assert.equal(result.redacted,true);assert.ok(!result.content.includes('abcdefghijklmnopqrstuvwxyz'));
  const write=host.writeFile('bot-a','run-a',{path,content:'api_key: [redacted]\nsetting: new',overwrite:true,reason:'更新配置'},new AbortController().signal);const rejected=assert.rejects(write,/占位符/);interactions.approve(interactions.snapshot()[0].id,true);await rejected;assert.ok(readFileSync(path,'utf8').includes(secret));
});

test('unapproved commands do not start a process or even create their default workspace',{skip:process.platform!=='win32'},async t=>{
  const {host,interactions}=fixture(t),controller=new AbortController();
  const pending=host.execute('bot-a','run-a',{command:"Write-Output 'not run'",reason:'检查'},controller.signal);const rejected=assert.rejects(pending,/取消/);
  assert.equal(existsSync(host.workspace('bot-a')),false);controller.abort();await rejected;assert.equal(interactions.snapshot().length,0);assert.equal(existsSync(host.workspace('bot-a')),false);
});

test('approved PowerShell preserves Unicode, native exit codes and environment while redacting secrets',{skip:process.platform!=='win32'},async t=>{
  const {root,host,interactions}=fixture(t);
  const running=host.execute('bot-a','run-a',{command:"Write-Output '本机执行成功'; Write-Output $env:AELION_TEST_TOKEN; cmd /c exit 7",cwd:root,reason:'验证执行器'},new AbortController().signal);
  interactions.approve(interactions.snapshot()[0].id,true);const result=await running;
  assert.equal(result.exitCode,7);assert.match(result.stdout,/本机执行成功/);assert.match(result.stdout,/\[redacted\]/);assert.ok(!result.stdout.includes('fixture-private-token-123456'));assert.equal(result.location,'host');assert.equal(result.cwd,root);
});

test('host commands have a bounded timeout after permission is granted',{skip:process.platform!=='win32'},async t=>{
  const {root,host,interactions}=fixture(t);
  const running=host.execute('bot-a','run-a',{command:'Start-Sleep -Seconds 20',cwd:root,reason:'验证超时',timeoutMs:700},new AbortController().signal);
  await delay(800);assert.equal(interactions.snapshot().length,1);
  interactions.approve(interactions.snapshot()[0].id,true);const result=await running;
  assert.equal(result.timedOut,true);assert.equal(result.exitCode,-1);assert.ok(result.durationMs<8000);assert.match(result.stderr,/超时/);
});

test('redaction removes common tokens, private keys and credential fields without hiding commit hashes',()=>{
  const hash='0123456789abcdef0123456789abcdef01234567';
  const result=redactHost(`ghp_abcdefghijklmnopqrstuvwxyz123456\npassword: private-password\nhttps://user:secret@example.com/repo\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----\ncommit ${hash}`);
  assert.ok(!result.includes('private-password'));assert.ok(!result.includes('user:secret'));assert.ok(!result.includes('abcdefghijklmnopqrstuvwxyz'));assert.ok(!result.includes('BEGIN PRIVATE KEY'));assert.ok(result.includes(hash));
});

test('cancelling a granted host command terminates its child process tree',{skip:process.platform!=='win32'},async t=>{
  const {root,host,interactions}=fixture(t),marker=join(root,'child.json'),controller=new AbortController();
  const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;
  const code=`require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`;
  const script=join(root,'child.cjs');writeFileSync(script,code);
  const command=`& ${quote(process.execPath)} ${quote(script)}`;
  const running=host.execute('bot-a','run-a',{command,cwd:root,reason:'验证子进程停止'},controller.signal);
  interactions.approve(interactions.snapshot()[0].id,true);
  let pid:number|undefined;
  try{
    for(let i=0;i<60&&!existsSync(marker);i++)await delay(100);assert.ok(existsSync(marker));pid=JSON.parse(readFileSync(marker,'utf8')).pid;
    controller.abort();const result=await running;assert.equal(result.cancelled,true);assert.equal(result.exitCode,-1);
    let alive=true;for(let i=0;i<30&&alive;i++){try{process.kill(pid!,0);await delay(100);}catch{alive=false;}}
    assert.equal(alive,false,'The child process survived cancellation');
  }finally{controller.abort();await running.catch(()=>{});if(pid)try{process.kill(pid);}catch{}}
});
