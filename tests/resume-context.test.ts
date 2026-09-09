import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {Store} from '../electron/core/store';
import {Cognition} from '../electron/core/cognition';
import {SkillLibrary} from '../electron/core/skill-library';
import {Harness} from '../electron/core/harness';
import {ContextOverflowError,type CompletionOptions,type ModelClient} from '../electron/core/model';
import type {ContextInput} from '../electron/core/context-engine';
import type {VmController} from '../electron/core/vm';
import type {WireMessage} from '../src/shared';

function fixture(t:test.TestContext,model:ModelClient){
 const parent=realpathSync.native(tmpdir()),root=mkdtempSync(join(parent,'aelion-resume-context-')),paths={dataDir:join(root,'data'),homeDir:join(root,'home'),projectDir:join(root,'project'),configDir:join(root,'config'),env:{}};
 for(const path of [paths.dataDir,paths.homeDir,paths.projectDir,paths.configDir])mkdirSync(path);
 const store=new Store(paths.dataDir);store.data.model.model='fixture';store.data.model.contextTokens=128000;
 const skills=new SkillLibrary(store,paths),cognition=new Cognition(store,model,skills,()=>{},()=>true);
 const bot=store.data.bots[0];for(let i=0;i<6;i++)store.data.conversations[bot.id].push({role:'user',content:`Historical question ${i}: `+'archive '.repeat(150)},{role:'assistant',content:`Historical answer ${i}: `+'checked '.repeat(150)});
 const forced:boolean[]=[];const prepare=cognition.context.prepare.bind(cognition.context);cognition.context.prepare=(input:ContextInput)=>{forced.push(Boolean(input.force));return prepare(input);};
 let executions=0;const vm={execute:async()=>{executions++;return {exitCode:0,stdout:'verified',stderr:''};}} as unknown as VmController;
 const harness=new Harness(store,vm,model,()=>{},undefined,undefined,undefined,undefined,undefined,cognition);
 t.after(async()=>{harness.cancel(bot.id);await cognition.close();store.close();assert.equal(dirname(resolve(root)),parent);rmSync(root,{recursive:true,force:true});});
 return {store,cognition,harness,bot,forced,executions:()=>executions};
}

test('continuing after a network failure retains history without forced compaction or replaying tools',async t=>{
 let calls=0,compactions=0;
 const model={complete:async(_messages:WireMessage[],_tools:unknown,_signal:unknown,_onText:unknown,options:CompletionOptions)=>{
  if(options?.purpose==='compaction'){compactions++;throw Error('Unexpected compaction');}
  calls++;if(calls===1)return {content:'先检查项目。',finishReason:'tool_calls',calls:[{id:'verify',type:'function',function:{name:'computer_execute',arguments:'{"command":"verify"}'}}]};
  if(calls===2)throw new TypeError('fetch failed');return {content:'检查完成。',calls:[],finishReason:'stop'};
 }} as unknown as ModelClient;
 const f=fixture(t,model);await f.harness.run(f.bot.id,'检查项目');const failed=f.store.data.runs[0];assert.equal(failed.status,'failed');assert.match(failed.error!,/fetch failed/);
 const history=structuredClone(f.store.data.conversations[f.bot.id]),head=f.cognition.storage.head(f.bot.id);
 await f.harness.resume(f.bot.id,failed.id);
 assert.equal(f.store.data.runs.at(-1)?.status,'completed');assert.equal(compactions,0);assert.equal(calls,3);assert.equal(f.executions(),1);assert.ok(f.forced.every(force=>!force));
 assert.deepEqual(f.store.data.conversations[f.bot.id].slice(0,history.length),history);assert.deepEqual(f.cognition.storage.head(f.bot.id),head);
 assert.ok(f.store.data.messages.some(message=>message.content==='先检查项目。'&&message.presentation==='progress'));
});

test('an actual provider context overflow still triggers compression and retries the model',async t=>{
 let calls=0,compactions=0;
 const model={complete:async(_messages:WireMessage[],_tools:unknown,_signal:unknown,_onText:unknown,options:CompletionOptions)=>{
  if(options?.purpose==='compaction'){compactions++;return {content:JSON.stringify({goal:'检查项目',constraints:[],done:['保留历史检查结果'],pending:['回答当前问题'],decisions:[],failures:[],next:['完成回复']}),calls:[],finishReason:'stop'};}
  if(calls++===0)throw new ContextOverflowError();return {content:'已根据保留记录完成回答。',calls:[],finishReason:'stop'};
 }} as unknown as ModelClient;
 const f=fixture(t,model);await f.harness.run(f.bot.id,'继续回答');assert.equal(f.store.data.runs[0].status,'completed');assert.equal(calls,2);assert.equal(compactions,1);assert.ok(f.forced.includes(true));assert.ok(f.cognition.storage.head(f.bot.id).through>0);
});
