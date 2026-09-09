import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {Diagnostics,diagnosticTail} from '../electron/core/diagnostics';
import {diagnosticRedactor} from '../electron/core/diagnostic-redaction';
import {DEFAULT_RUNTIME} from '../src/runtime-types';
import {PromptCacheDiagnostics} from '../electron/core/prompt-cache';
import type {Snapshot} from '../src/shared';

function fixture(t:test.TestContext){
 const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-diagnostics-')),data=join(root,'data'),home=join(root,'home');mkdirSync(data);mkdirSync(home);mkdirSync(join(data,'vm'));
 const stamp='2026-09-07T10:00:00.000Z',secret='fixture-provider-secret-918237',chat='PRIVATE CHAT SHOULD NOT BE EXPORTED',args='PRIVATE TOOL ARGUMENTS',output='PRIVATE TOOL OUTPUT',bot={id:'bot',name:'PRIVATE BOT NAME',role:chat,color:'#2288ff',createdAt:stamp,memories:[chat]};
 const state:Snapshot={bots:[bot],messages:[{id:'message',botId:'bot',role:'user',content:chat,time:stamp,attachments:[{id:'attachment',name:'PRIVATE FILE NAME',size:40,mime:'text/plain'}]}],runs:[{id:'run',botId:'bot',status:'failed',startedAt:stamp,endedAt:stamp,modelCalls:3,toolCalls:2,error:`HTTP 503 ${secret} ${join(home,'private.txt')} user@example.test`,contextIssue:{capacity:32000,estimatedTokens:40000,inputBudget:26000,modelKey:chat},executions:[{id:'execution',callId:'call',botId:'bot',runId:'run',tool:'host_execute',target:args,targetKey:output,status:'failed',startedAt:stamp,error:'ECONNRESET'}]}],model:{baseUrl:`https://private-service.invalid/${secret}`,model:'fixture-model',hasKey:true,contextTokens:32000},vm:{status:'error',detail:'QEMU failed',lastError:'connection refused',imageVersion:'20260901'},skills:[{id:'skill',name:'PRIVATE SKILL',description:chat,body:chat}],artifacts:[{id:'a',botId:'bot',runId:'run',path:join(home,'secret.md'),name:output,size:40,modifiedAt:stamp}],computer:{desktops:{}},dataDir:data,runtime:{...DEFAULT_RUNTIME},modelUsage:[{id:'usage',runId:'run',purpose:'foreground',model:'fixture-model',time:stamp,usage:{inputTokens:1200,outputTokens:40,cachedTokens:800},error:`api_key=${secret}`}],updates:{phase:'error',currentVersion:'0.7.4',repository:'owner/repo',error:'无法连接 GitHub'}};
 let now=Date.parse(stamp);const service=new Diagnostics({dataDir:data,paths:()=>[root,home],secrets:()=>[secret],snapshot:()=>state,now:()=>now,environment:{appVersion:'0.7.4',platform:'win32',arch:'x64',osRelease:'10.0.26100',electron:'44.2.0',chrome:'152',node:'24',packaged:true,cpuCount:8,memoryGiB:16}});
 t.after(()=>{service.dispose();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});return {root,data,home,state,service,secret,chat,args,output,advance:(ms:number)=>{now+=ms;}};
}

test('diagnostic bundles preserve useful failures while excluding chat, file, config and tool content',async t=>{
 const f=fixture(t),before=JSON.stringify(f.state),events=[{id:'event',time:'now',type:'tool.intent',payload:{runId:'run',tool:'host_execute',args:f.args,output:f.output,content:f.chat}},{id:'malformed',time:'now',type:'tool.result',payload:{status:{content:f.chat},error:{secret:f.secret}}}];
 writeFileSync(join(f.data,'events.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\nnot valid json\n');
 writeFileSync(join(f.data,'vm/qemu.log'),`Connection failed\nAuthorization: Basic dXNlcjpwYXNz\n${f.secret}\n${f.home}\n`);writeFileSync(join(f.data,'vm/serial.log'),`Boot failed\npassword: fixture-password\nhttps://host.invalid/path?token=fixture-token\n`);
 f.service.record('ipc.model:test',Error(`HTTP 401 ${f.secret} ${f.home}`));
 f.service.record('renderer.error',Error('Authorization: Basic dXNlcjpwYXNz\nUseful error after authorization'));
 const preview=await f.service.prepare(),files=unzipSync(f.service.archive(preview.id).bytes),all=Object.values(files).map(bytes=>strFromU8(bytes)).join('\n');
 for(const sensitive of [f.secret,f.chat,f.args,f.output,'PRIVATE BOT NAME','PRIVATE FILE NAME','PRIVATE SKILL',f.home,'fixture-password','fixture-token','dXNlcjpwYXNz','private-service.invalid'])assert.equal(all.includes(sensitive),false,sensitive);
 const report=JSON.parse(strFromU8(files['diagnostics.json']));assert.equal(report.runs[0].id,'run');assert.equal(report.runs[0].modelCalls,3);assert.equal(report.runs[0].context.estimatedTokens,40000);assert.equal(report.runs[0].executions[0].error,'ECONNRESET');assert.equal(report.modelUsage[0].usage.inputTokens,1200);assert.equal(report.modelUsage[0].usage.cachedTokens,800);assert.match(report.runs[0].error,/HTTP 503/);
 assert.equal(JSON.stringify(f.state),before);assert.ok(files['logs/qemu.log']);assert.ok(files['logs/serial.log']);assert.ok(files['logs/diagnostic-events.jsonl']);assert.equal(preview.archiveBytes,f.service.archive(preview.id).bytes.length);
 const appEvents=strFromU8(files['logs/diagnostic-events.jsonl']).split('\n').map(line=>JSON.parse(line));assert.equal(appEvents.length,2);assert.ok(appEvents[1].message.includes('Useful error after authorization'));
 assert.equal(readFileSync(join(f.data,'events.jsonl'),'utf8').includes(f.args),true);
});

test('redaction handles encoded secrets, partial private keys, URLs, emails and Windows path variants',()=>{
 const secret='test-secret/value+data',scrub=diagnosticRedactor([secret],['C:\\Users\\Test Person\\Project']);
 const pemHeader='-----BEGIN '+'PRIVATE KEY-----';
 const value=`${secret} ${encodeURIComponent(secret)}\nC:/USERS/TEST PERSON/PROJECT/file.ts\nC:\\Users\\Example\\private.txt\n/home/another-user/private.txt\nhttps://user:password@private.invalid/path?x=1\nCookie: session=private-cookie\nuser@example.test\n${pemHeader}\nprivate-key-fragment`;
 const result=scrub(value);for(const part of [secret,encodeURIComponent(secret),'TEST PERSON','Example','another-user','private.invalid','private-cookie','user@example.test','private-key-fragment'])assert.equal(result.includes(part),false,part);
 assert.match(result,/redacted/);
});

test('large logs are tailed with complete lines, missing logs are tolerated and reports stay bounded',async t=>{
 const f=fixture(t);writeFileSync(join(f.data,'vm/qemu.log'),'old private data\n'+'line\n'.repeat(40000)+'LATEST FAILURE\n');
 const tail=await diagnosticTail(f.data,'vm/qemu.log');assert.equal(tail.truncated,true);assert.ok(Buffer.byteLength(tail.text)<=128*1024);assert.ok(tail.text.endsWith('LATEST FAILURE\n'));assert.ok(!tail.text.includes('old private data'));
 const preview=await f.service.prepare();assert.ok(preview.files.find(file=>file.name==='logs/qemu.log')?.truncated);assert.ok(!preview.files.some(file=>file.name==='logs/serial.log'));assert.ok(preview.archiveBytes<200000);
 assert.equal((await diagnosticTail(f.data,'missing.log')).status,'missing');
});

test('diagnostic logs never read a path outside the data directory',async t=>{
 const f=fixture(t);writeFileSync(join(f.root,'outside.log'),'PRIVATE OUTSIDE FILE');assert.equal((await diagnosticTail(f.data,'../outside.log')).status,'unavailable');
 symlinkSync(f.home,join(f.data,'linked'),process.platform==='win32'?'junction':'dir');writeFileSync(join(f.home,'secret.log'),'PRIVATE HOME FILE');assert.equal((await diagnosticTail(f.data,'linked/secret.log')).status,'unavailable');
});

test('issue links stay on GitHub, prefill a safe compact draft, and include the report identity',async t=>{
 const f=fixture(t);f.state.runs[0].error+='\n```\n@someone https://private.invalid/secret';f.state.model.model='很长的模型名称'.repeat(1000);
 const preview=await f.service.prepare(),url=new URL(f.service.issueUrl(preview.id,'example/AelionBot'));assert.equal(url.origin,'https://github.com');assert.equal(url.pathname,'/example/AelionBot/issues/new');assert.ok(url.href.length<=7500);assert.match(url.searchParams.get('body')!,/复现步骤/);assert.ok(url.searchParams.get('body')!.includes(preview.fileName));assert.ok(!url.searchParams.get('body')!.includes(f.secret));assert.ok(!url.searchParams.get('body')!.includes('@someone'));
 assert.throws(()=>f.service.issueUrl(preview.id,'evil.invalid/repo?redirect=other'),/仓库/);
});

test('export includes cache fingerprints but never raw request bodies',async t=>{
 const f=fixture(t),tracker=new PromptCacheDiagnostics();
 f.state.modelUsage![0].transportErrorCodes=['UND_ERR_SOCKET'];
 f.state.modelUsage![0].requestCache=tracker.record('test-scope',{model:'fixture',input:[{role:'user',content:f.chat}],tools:[{name:'test',description:f.args}]});
 const preview=await f.service.prepare(),files=unzipSync(f.service.archive(preview.id).bytes),text=strFromU8(files['diagnostics.json']),report=JSON.parse(text);
 assert.equal(report.modelUsage[0].requestCache.inputMessages,1);assert.equal(report.modelUsage[0].requestCache.firstDifference,'first-request');assert.deepEqual(report.modelUsage[0].transportErrorCodes,['UND_ERR_SOCKET']);
 assert.doesNotMatch(text,/PRIVATE CHAT|PRIVATE TOOL/);
});

test('preview and export use the same report, concurrent preparation coalesces, and stale tickets expire',async t=>{
 const f=fixture(t),first=f.service.prepare(),second=f.service.prepare();assert.equal(first,second);const preview=await first,original=Buffer.from(f.service.archive(preview.id).bytes);f.state.runs[0].error='different error';assert.deepEqual(Buffer.from(f.service.archive(preview.id).bytes),original);
 const next=await f.service.prepare();assert.notEqual(next.id,preview.id);assert.match(next.summary,/different error/);f.advance(31*60*1000);assert.throws(()=>f.service.archive(preview.id),/过期/);assert.throws(()=>f.service.issueUrl(next.id,'owner/repo'),/过期/);assert.throws(()=>f.service.archive('../../state.json'),/过期/);
});

test('diagnostic event recording rotates bounded files and never exposes keys',async t=>{
 const f=fixture(t);for(let i=0;i<100;i++)f.service.record('test.error',`${f.secret} ${i} `+'x'.repeat(3990));
 const path=join(f.data,'diagnostic-events.jsonl');assert.ok(existsSync(path+'.1'));assert.ok(readFileSync(path).length<262144+5000);assert.ok(!readFileSync(path,'utf8').includes(f.secret));assert.ok(!readFileSync(path+'.1','utf8').includes(f.secret));
 f.service.dispose();const before=readFileSync(path,'utf8');f.service.record('after.dispose','should not be written');assert.equal(readFileSync(path,'utf8'),before);await assert.rejects(()=>f.service.prepare(),/退出/);
});
