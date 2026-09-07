import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {build} from 'esbuild';
import {HostComputer} from '../electron/core/host';
import {Interactions,InteractionDenied} from '../electron/core/interactions';
import {FileSearch} from '../electron/core/file-search';
import type {FileSearchRequest} from '../electron/core/file-search-types';

const bundle=build({entryPoints:['electron/core/file-search-worker.ts'],write:false,bundle:true,platform:'node',format:'cjs',target:'node24'});
async function fixture(t:test.TestContext){
 const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-file-search-')),project=join(root,'project'),data=join(root,'data'),runtime=join(root,'runtime');for(const path of [project,data,runtime])mkdirSync(path);
 writeFileSync(join(runtime,'file-search-worker.cjs'),(await bundle).outputFiles[0].contents);
 const interactions=new Interactions(()=>{}),host=new HostComputer({dataDir:data,homeDir:root,projectDir:project,runtimeDir:runtime,secrets:()=>['fixture-private-value-991122']},interactions);
 t.after(()=>{host.dispose();interactions.dispose();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});
 const file=(name:string,content:string|Buffer)=>{const path=join(project,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);return path;};
 const run=async(args:Record<string,unknown>,kind:'find'|'search'='search')=>{const pending=host.searchFiles('bot','run',{path:project,reason:'inspect project',...args},new AbortController().signal,project,kind);assert.equal(interactions.snapshot().length,1);interactions.approve(interactions.snapshot()[0].id,true);return pending;};
 return {root,project,data,runtime,host,interactions,file,run};
}

test('native glob respects nested gitignore rules and paginates stable paths',async t=>{
 const f=await fixture(t);f.file('.gitignore','ignored/\n*.tmp\n');f.file('ignored/file.ts','needle');f.file('root.tmp','needle');f.file('src/.gitignore','!keep.tmp\n');const kept=f.file('src/keep.tmp','needle');f.file('src/a.ts','needle');f.file('src/b.ts','needle');
 const tmp=await f.run({pattern:'**/*.tmp'},'find');assert.deepEqual(tmp.files,[kept]);
 const first=await f.run({pattern:'**/*.ts',limit:1},'find'),second=await f.run({pattern:'**/*.ts',limit:1,offset:first.nextOffset},'find');assert.equal(first.total,2);assert.equal(second.eof,true);assert.notEqual(first.files![0],second.files![0]);
 const all=await f.run({pattern:'**/*.tmp',respectIgnore:false},'find');assert.equal(all.files!.length,2);
});

test('text search preserves line locations, context, modes and long-line match snippets',async t=>{
 const f=await fixture(t),path=f.file('src/main.ts','first\r\nneedle function\r\nlast\r\nneedle again\r\n');
 const result=await f.run({query:'NEEDLE',caseSensitive:false,glob:'**/*.ts',contextLines:1});assert.equal(result.matches!.length,2);assert.equal(result.matches![0].line,2);assert.equal(result.matches![0].offset,'first\r\n'.length);assert.deepEqual(result.matches![0].before,['first']);assert.deepEqual(result.matches![0].after,['last']);
 assert.deepEqual((await f.run({query:'needle',outputMode:'files'})).files,[path]);assert.equal((await f.run({query:'needle',outputMode:'count'})).counts![0].count,2);
 const long=f.file('long.txt','x'.repeat(10000)+'needle end');const single=await f.run({path:long,query:'needle'});assert.equal(single.path,long);assert.equal(single.matches![0].column,10001);assert.ok(single.matches![0].text.includes('needle'));assert.equal(single.matches![0].truncated,true);
 const empty=f.file('empty.txt','');assert.equal((await f.run({path:empty,query:'^$',regex:true})).total,0);
});

test('search cannot use a directory approval to read credentials, app data or linked targets',async t=>{
 const f=await fixture(t);f.file('.env','needle private');f.file('credentials.json','needle private');f.file('.ssh/config','needle private');f.file('src/tokens.ts','needle source');f.file('note.txt','needle fixture-private-value-991122');f.file('binary.bin',Buffer.from([0,110,101,101,100,108,101]));
 const outside=join(f.root,'outside');mkdirSync(outside);writeFileSync(join(outside,'outside.txt'),'needle private');symlinkSync(outside,join(f.project,'linked'),process.platform==='win32'?'junction':'dir');
 const result=await f.run({query:'needle',glob:'**/*',respectIgnore:false});assert.equal(result.matches!.length,2);assert.ok(!JSON.stringify(result).includes('fixture-private-value-991122'));assert.ok(result.skipped.sensitive>=3);assert.ok(result.skipped.links>0);assert.ok(result.skipped.binary>0);
 assert.equal((await f.run({query:'fixture-private-value-991122'})).total,0);writeFileSync(join(f.data,'state.json'),'needle private');assert.equal((await f.run({path:f.data,query:'needle'})).total,0);
});

test('denial and caller mutation cannot redirect an approved search',async t=>{
 const f=await fixture(t);f.file('file.txt','needle');const args={path:f.project,query:'needle',reason:'inspect'},controller=new AbortController();
 const denied=f.host.searchFiles('bot','run',args,controller.signal,f.project),check=assert.rejects(denied,InteractionDenied);f.interactions.approve(f.interactions.snapshot()[0].id,false);await check;
 const pending=f.host.searchFiles('bot','run',args,new AbortController().signal,f.project);args.path=f.data;args.query='different';f.interactions.approve(f.interactions.snapshot()[0].id,true);const result=await pending;assert.equal(result.path,f.project);assert.equal(result.total,1);
});

test('invalid regex is actionable and regex searches preserve Unicode',async t=>{
 const f=await fixture(t);f.file('code.ts','export function 中文() {}\n');await assert.rejects(f.run({query:'(',regex:true}),error=>(error as any).code==='INVALID_REGEX');assert.equal((await f.run({query:'^export\\s+function',regex:true})).total,1);
});

test('runaway workers time out without blocking the caller and queued cancellation is immediate',async t=>{
 const f=await fixture(t);writeFileSync(join(f.runtime,'file-search-worker.cjs'),'while(true) {}');const service=new FileSearch(f.runtime,250,1);t.after(()=>service.dispose());
 const request:FileSearchRequest={kind:'search',root:f.project,dataDir:f.data,homeDir:f.root,glob:'**/*',query:'needle',regex:false,caseSensitive:true,respectIgnore:true,outputMode:'content',contextLines:0,offset:0,limit:10,secrets:[]};
 const first=assert.rejects(service.run(request,new AbortController().signal),error=>(error as any).code==='SEARCH_TIMEOUT'),controller=new AbortController();const queued=service.run(request,controller.signal);controller.abort(Error('cancel queued'));await assert.rejects(queued,/cancel queued/);let responsive=false;setTimeout(()=>{responsive=true;},20);await first;assert.equal(responsive,true);
});
