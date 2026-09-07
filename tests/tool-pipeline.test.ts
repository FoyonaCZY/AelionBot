import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {readPipeline} from '../electron/core/tool-pipeline';
import {Harness} from '../electron/core/harness';
import {HostComputer} from '../electron/core/host';
import {HostApprovals} from '../electron/core/host-approvals';
import {Interactions,InteractionDenied} from '../electron/core/interactions';
import {CommandPermissions} from '../electron/core/command-permissions';
import {Store} from '../electron/core/store';
import type {ModelClient} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';

const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};};
const step=(id:string,dependsOn?:string[])=>({id,tool:'host_file_read',args:{path:id,reason:'read fixture'},...(dependsOn?{dependsOn}:{})});

test('batch scheduling fills freed slots without waiting for an unrelated slow read',async()=>{
 const slow=deferred<unknown>(),started:string[]=[];
 const pending=readPipeline([step('slow'),step('fast'),step('dependent',['fast']),step('independent')],2,new AbortController().signal,async(_name,args)=>{started.push(String(args.path));return args.path==='slow'?slow.promise:{value:args.path};});
 try{await flush();assert.deepEqual(started,['slow','fast','dependent','independent']);}finally{slow.resolve({value:'slow'});}
 const result=await pending;assert.equal(result.isError,false);assert.deepEqual(Object.keys(result.results),['slow','fast','dependent','independent']);
});

test('failed dependencies skip dependents even without result references; independent reads continue',async()=>{
 const invoked:string[]=[];const result=await readPipeline([step('bad'),step('child',['bad']),step('grandchild',['child']),step('good')],3,new AbortController().signal,async(_name,args)=>{invoked.push(String(args.path));if(args.path==='bad')throw Error('file missing');return {read:true};});
 assert.deepEqual(invoked,['bad','good']);assert.equal(result.results.child?.status,'skipped');assert.deepEqual(result.results.child?.failedDependencies,['bad']);assert.equal(result.results.grandchild?.status,'skipped');assert.equal(result.results.good?.ok,true);
});

test('batch validation identifies the actual bad step before dispatch',async()=>{
 const cases:Array<[unknown,RegExp]>=[[[step('a'),step('a')],/ID 重复：a/],[[step('a',['missing'])],/a.*missing/],[[{...step('a'),tool:'host_execute'}],/a.*host_execute.*读取工具/],[[{...step('a'),args:[]}],/a.*args/],[[{...step('a'),dependsOn:'bad'}],/a.*dependsOn/],[[step('a'),{...step('b'),args:{path:{$from:'a',path:'value'}}}],/b.*dependsOn/],[[step('a'),{...step('b',['a']),args:{path:{$from:'a',path:'__proto__.value'}}}],/b.*引用路径/]];
 for(const [steps,pattern] of cases){let invoked=false;await assert.rejects(readPipeline(steps,4,new AbortController().signal,async()=>{invoked=true;}),pattern);assert.equal(invoked,false);}
 await assert.rejects(readPipeline([{id:'mcp',tool:'mcp_list_tools',args:{server:'test'}}],1,new AbortController().signal,async()=>{}, {allowedTools:new Set(['host_file_read'])}),/当前任务模式/);
});

test('batch input is immutable and declared result references are resolved',async()=>{
 const held=deferred<unknown>(),steps:any[]=[step('a'),{...step('b',['a']),args:{path:{$from:'a',path:'result.path'},reason:'read next'}}],calls:string[]=[];
 const pending=readPipeline(steps,1,new AbortController().signal,async(name,args)=>{calls.push(name+':'+args.path);return args.path==='a'?held.promise:{read:true};});
 await flush();steps[1].tool='host_execute';steps[1].args.path='unapproved';held.resolve({result:{path:'resolved'}});await pending;assert.deepEqual(calls,['host_file_read:a','host_file_read:resolved']);
});

test('a fatal denial cancels sibling requests and never dispatches queued reads',async()=>{
 const started:string[]=[],controller=new AbortController(),deny=new InteractionDenied(),first=deferred<unknown>();
 const pending=readPipeline([step('denied'),step('waiting'),step('queued')],2,controller.signal,async(_name,args,signal)=>{started.push(String(args.path));if(args.path==='denied'){await first.promise;throw deny;}return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},{stopOnError:error=>error instanceof InteractionDenied});
 await flush();first.resolve(undefined);await assert.rejects(pending,error=>error===deny);assert.deepEqual(started,['denied','waiting']);assert.equal(controller.signal.aborted,false);
});

test('cancellation stops queued reads and is forwarded to running reads',async()=>{
 const controller=new AbortController(),started:string[]=[];
 const pending=readPipeline([step('a'),step('b')],1,controller.signal,async(_name,args,signal)=>{started.push(String(args.path));return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 await flush();controller.abort(Error('new user input'));await assert.rejects(pending,/new user input/);assert.deepEqual(started,['a']);
});

function fixture(t:test.TestContext,mode:'ask'|'auto'|'full'){
 const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-batch-')),project=join(root,'project'),store=new Store(join(root,'data'));mkdirSync(project);
 for(const file of ['README.md','go.mod','main.go'])writeFileSync(join(project,file),'fixture '+file);
 const interactions=new Interactions(()=>{}),commands=new CommandPermissions(join(store.dir,'rules.json'));let reviews=0;
 const policy=new HostApprovals(store,commands,async()=>{reviews++;return {decision:'allow',reason:'fixture'};},{homeDir:root,defaultModel:()=>({baseUrl:'http://localhost',model:'fixture',hasKey:false,contextTokens:32000})});interactions.setHostPolicy(policy);policy.set({kind:'bot',id:store.data.bots[0].id},mode);
 const host=new HostComputer({dataDir:store.dir,homeDir:root,projectDir:project},interactions);t.after(()=>{host.dispose();interactions.dispose();store.close();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});
 let modelCalls=0;const model={complete:async()=>++modelCalls===1?{content:'',calls:[{id:'batch',type:'function',function:{name:'tools_batch',arguments:JSON.stringify({steps:['README.md','go.mod','main.go'].map((path,index)=>({id:'read_'+index,tool:'host_file_read',args:{path,reason:'读取项目资料'}}))})}}],finishReason:'tool_calls'}:{content:'已读取项目资料',calls:[],finishReason:'stop'}} as unknown as ModelClient;
 const harness=new Harness(store,{} as VmController,model,()=>{},undefined,undefined,undefined,host,interactions);
 return {store,project,host,interactions,harness,reviews:()=>reviews,modelCalls:()=>modelCalls};
}
for(const mode of ['auto','full'] as const)test(`real host batch reads inherit ${mode} permissions and keep execution evidence`,async t=>{
 const f=fixture(t,mode);await f.harness.run(f.store.data.bots[0].id,'阅读本机项目文件',{workspaceDir:f.project});
 const run=f.store.data.runs[0];assert.equal(run.status,'completed');assert.equal(f.interactions.snapshot().length,0);assert.equal(f.reviews(),0);assert.equal(run.executions?.filter(entry=>entry.tool==='host_file_read'&&entry.status==='succeeded').length,3);
 for(const entry of run.executions||[])assert.ok(JSON.parse(readFileSync(join(f.store.dir,'results',entry.resultId+'.json'),'utf8')));
});
test('denying one host batch approval cancels the run and withdraws other pending approvals',async t=>{
 const f=fixture(t,'ask'),pending=f.harness.run(f.store.data.bots[0].id,'阅读本机项目文件',{workspaceDir:f.project});for(let i=0;i<30&&f.interactions.snapshot().length<3;i++)await flush();assert.equal(f.interactions.snapshot().length,3);
 f.interactions.approve(f.interactions.snapshot()[0].id,false);await pending;const run=f.store.data.runs[0];assert.equal(run.status,'cancelled');assert.equal(f.interactions.snapshot().length,0);assert.equal(f.modelCalls(),1);
 assert.ok(run.executions?.filter(entry=>entry.tool==='host_file_read').every(entry=>entry.status==='cancelled'));
 for(const entry of run.executions||[])if(entry.resultId)assert.ok(JSON.parse(readFileSync(join(f.store.dir,'results',entry.resultId+'.json'),'utf8')));
});
