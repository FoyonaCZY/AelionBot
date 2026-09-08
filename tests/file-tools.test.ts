import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync,chmodSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {HostComputer,redactHost} from '../electron/core/host';
import {Interactions} from '../electron/core/interactions';
import {decodeText,editText,textPage} from '../electron/core/file-text';
import {Store} from '../electron/core/store';
import {FileCheckpoints} from '../electron/core/file-checkpoints';
import {DEFAULT_RUNTIME} from '../src/runtime-types';
import type {VmController} from '../electron/core/vm';
import {readToolResult} from '../electron/core/tool-results';
import {executionTarget} from '../electron/core/execution-ledger';

const hash=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex');
function fixture(t:test.TestContext){const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-file-tools-')),data=join(root,'data'),project=join(root,'project');mkdirSync(data);mkdirSync(project);const interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:data,homeDir:root,projectDir:project},interactions);t.after(()=>{host.dispose();interactions.dispose();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});return {root,data,project,host,interactions};}
function approve<T>(f:ReturnType<typeof fixture>,pending:Promise<T>){assert.equal(f.interactions.snapshot().length,1);f.interactions.approve(f.interactions.snapshot()[0].id,true);return pending;}
const signal=()=>new AbortController().signal;

test('character and line pagination preserve Unicode and make progress to EOF',()=>{
 const text='😀中文\r\nsecond\r\n尾行';let offset=0,joined='';do{const page=textPage(text,{offset,maxChars:3});joined+=page.content;assert.ok(page.nextOffset>offset||page.eof);offset=page.nextOffset;if(page.eof)break;}while(true);assert.equal(joined,text);
 const page=textPage(text,{startLine:2,lineCount:1});assert.equal(page.content,'second\r\n');assert.equal(page.startLine,2);assert.equal(page.endLine,2);assert.equal(page.nextLine,3);assert.equal(page.rangeTruncated,false);
 assert.deepEqual(textPage(text,{offset:0,startLine:2,lineCount:1}),page);
 assert.deepEqual(textPage(text,{offset:0,startLine:1,lineCount:2,withLineNumbers:true}),textPage(text,{startLine:1,lineCount:2,withLineNumbers:true}));
 const numbered=textPage(text,{startLine:1,lineCount:2,withLineNumbers:true});assert.equal(numbered.content,'1 | 😀中文\r\n2 | second\r\n');assert.equal(numbered.nextOffset,text.indexOf('尾'));
 assert.equal(textPage(text,{startLine:50}).eof,true);assert.equal(textPage('',{}).totalLines,0);assert.equal(textPage('a\n',{}).totalLines,1);assert.throws(()=>textPage(text,{offset:1,startLine:2}),/不能同时/);
 const long=textPage('x'.repeat(1000)+'\nnext',{startLine:1,lineCount:2,maxChars:80,withLineNumbers:true});assert.equal(long.content.length,80);assert.equal(long.partialLine,true);assert.equal(textPage('x'.repeat(1000)+'\nnext',{offset:long.nextOffset,maxChars:32000}).content.length,1005-long.nextOffset);
});

test('host line reads retain physical line numbers after credential redaction',async t=>{
 const f=fixture(t),path=join(f.project,'source.txt'),header='-----BEGIN '+'PRIVATE KEY-----',footer='-----END '+'PRIVATE KEY-----';writeFileSync(path,`first\n${header}\nsecret-data\n${footer}\nlast\n`);
 const page=await approve(f,f.host.readFile('bot','run',{path,reason:'read lines',startLine:5,lineCount:1,withLineNumbers:true},signal()));assert.equal(page.content,'5 | last\n');assert.equal(page.redacted,true);assert.equal(page.sha256,hash(readFileSync(path)));
 writeFileSync(path,Buffer.from([0xc3,0x28]));await assert.rejects(approve(f,f.host.readFile('bot','run',{path,reason:'read'},signal())),error=>(error as any).code==='UNSUPPORTED_ENCODING');
});

test('exact editing preserves BOM, CRLF, untouched secrets and executable mode',async t=>{
 const f=fixture(t),path=join(f.project,'script.txt'),before='\ufeffapi_key: fixture-private-token-998877\r\nsetting=old\r\n';writeFileSync(path,before);if(process.platform!=='win32')chmodSync(path,0o755);
 const read=await approve(f,f.host.readFile('bot','run',{path,reason:'inspect'},signal()));assert.equal(read.bom,true);assert.ok(!read.content.includes('fixture-private-token-998877'));
 const result=await approve(f,f.host.patchFile('bot','run',{path,reason:'change setting',oldText:'setting=old\n',newText:'setting=new\n',expectedSha256:read.sha256},signal()));const after=readFileSync(path,'utf8');assert.equal(after,before.replace('setting=old','setting=new'));assert.equal(result.sha256,hash(after));assert.equal(result.replacements,1);if(process.platform!=='win32')assert.equal(statSync(path).mode&0o777,0o755);
});

test('stale hashes, ambiguous matches, missing text and denied edits cannot overwrite a file',async t=>{
 const f=fixture(t),path=join(f.project,'data.txt');writeFileSync(path,'old\nold\n');
 const input={path,reason:'edit',oldText:'old',newText:'new',expectedSha256:hash('old\nold\n')};
 await assert.rejects(approve(f,f.host.patchFile('bot','run',input,signal())),error=>(error as any).code==='EDIT_AMBIGUOUS');assert.equal(readFileSync(path,'utf8'),'old\nold\n');
 await assert.rejects(approve(f,f.host.patchFile('bot','run',{...input,oldText:'missing'},signal())),error=>(error as any).code==='EDIT_NOT_FOUND');
 const denied=f.host.patchFile('bot','run',{...input,replaceAll:true},signal()),deniedCheck=assert.rejects(denied,/拒绝/);f.interactions.approve(f.interactions.snapshot()[0].id,false);await deniedCheck;
 writeFileSync(path,'user edit');await assert.rejects(approve(f,f.host.patchFile('bot','run',{...input,replaceAll:true},signal())),error=>(error as any).code==='FILE_CHANGED');assert.equal(readFileSync(path,'utf8'),'user edit');
 const pending=f.host.patchFile('bot','run',{...input,oldText:'user edit',expectedSha256:hash('user edit')},signal()),check=assert.rejects(pending,/确认期间/);writeFileSync(path,'newer user edit');f.interactions.approve(f.interactions.snapshot()[0].id,true);await check;assert.equal(readFileSync(path,'utf8'),'newer user edit');
});

test('replaceAll is explicit, replacement text is literal, and growth is bounded',()=>{
 const bytes=Buffer.from('old old');assert.equal(editText(bytes,{oldText:'old',newText:'$& $1',replaceAll:true,expectedSha256:hash(bytes)}).content,'$& $1 $& $1');
 assert.throws(()=>editText(bytes,{oldText:'old',newText:'old',expectedSha256:hash(bytes),replaceAll:true}),error=>(error as any).code==='EDIT_NO_CHANGE');
 assert.throws(()=>editText(Buffer.from('a'.repeat(100)),{oldText:'a',newText:'b'.repeat(50000),replaceAll:true,expectedSha256:hash('a'.repeat(100))}),error=>(error as any).code==='FILE_TOO_LARGE');
 assert.throws(()=>decodeText(Buffer.from([0])),error=>(error as any).code==='UNSUPPORTED_ENCODING');
});

test('edits seal normal file checkpoints and writes can verify the previously read hash',async t=>{
 const f=fixture(t),store=new Store(f.data);store.data.runtime={...DEFAULT_RUNTIME,fileCheckpoints:true};const checkpoints=new FileCheckpoints(store,{} as VmController,f.interactions),bot=store.data.bots[0],path=join(f.project,'file.txt');writeFileSync(path,'before');
 f.host.options.beforeWrite=(botId,runId,path)=>checkpoints.hostBefore(botId,runId,path);f.host.options.afterWrite=(record,path,expected)=>checkpoints.hostAfter(record,path,expected);
 await approve(f,f.host.patchFile(bot.id,'run',{path,reason:'edit',oldText:'before',newText:'after',expectedSha256:hash('before')},signal()));const checkpoint=checkpoints.list(bot.id)[0];assert.equal(checkpoint.beforeHash,hash('before'));assert.equal(checkpoint.afterHash,hash('after'));
 await assert.rejects(approve(f,f.host.writeFile(bot.id,'run',{path,reason:'overwrite',content:'stale',overwrite:true,expectedSha256:hash('before')},signal())),error=>(error as any).code==='FILE_CHANGED');assert.equal(readFileSync(path,'utf8'),'after');store.close();
});

test('directory pagination returns all entries without losing the tail',async t=>{
 const f=fixture(t);for(let index=0;index<270;index++)writeFileSync(join(f.project,String(index).padStart(3,'0')+'.txt'),'');
 const first=await approve(f,f.host.listDirectory('bot','run',{path:f.project,reason:'list'},signal())),second=await approve(f,f.host.listDirectory('bot','run',{path:f.project,reason:'continue',offset:first.nextOffset},signal()));assert.equal(first.total,270);assert.equal(first.items.length,250);assert.equal(second.items.length,20);assert.equal(second.eof,true);
});

test('batch result records are readable by their owner, remain private, and paginate safely',t=>{
 const f=fixture(t),store=new Store(f.data),bot=store.data.bots[0],other=store.createBot('other','scope'),id=randomUUID(),source=JSON.stringify({text:'😀中文'.repeat(6000)});mkdirSync(join(f.data,'results'));writeFileSync(join(f.data,'results',id+'.json'),source);
 store.data.runs.push({id:'run',botId:bot.id,status:'completed',startedAt:new Date().toISOString(),modelCalls:1,toolCalls:1,executions:[{id:'child',callId:'call',botId:bot.id,runId:'run',tool:'host_file_read',target:'file',targetKey:'key',status:'succeeded',startedAt:new Date().toISOString(),resultId:id}]});
 let offset=0,reconstructed='';do{const page=readToolResult(store,bot.id,{id,offset,maxChars:997});reconstructed+=page.text;offset=page.nextOffset;if(page.eof)break;}while(true);assert.equal(reconstructed,source);
 store.message(other.id,'user',JSON.stringify({resultId:id}));assert.throws(()=>readToolResult(store,other.id,{id}),/无权/);store.close();
});

test('execution targets match relative and absolute reads within the selected project',()=>{
 assert.equal(executionTarget('host_file_read',{path:'README.md'},'bot','C:\\Projects\\app').targetKey,executionTarget('host_file_read',{path:'C:\\Projects\\app\\README.md'},'bot').targetKey);
 assert.notEqual(executionTarget('host_file_read',{path:'README.md'},'bot','C:\\Projects\\one').targetKey,executionTarget('host_file_read',{path:'README.md'},'bot','C:\\Projects\\two').targetKey);
 assert.equal(redactHost('first\npassword: secret\nlast',[],true).split('\n').length,3);
});
