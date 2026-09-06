import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../electron/core/store';
import {ExecutionLedger,executionTarget} from '../electron/core/execution-ledger';
import {Harness} from '../electron/core/harness';
import type {ModelClient} from '../electron/core/model';
import type {VmController} from '../electron/core/vm';
const call=(id:string,path:string)=>({id,type:'function' as const,function:{name:'file_write',arguments:JSON.stringify({path,content:'proof'})}});
function fixture(t:test.TestContext){const dir=mkdtempSync(join(tmpdir(),'aelion-ledger-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return new Store(dir);}
test('another target succeeding cannot erase a failure or complete the run',async t=>{
 const store=fixture(t);let turns=0,writes=0;
 const model={complete:async()=>({content:'完成',finishReason:'stop',calls:turns++===0?[call('a','a.txt'),call('b','b.txt')]:[]})} as unknown as ModelClient;
 const vm={execute:async()=>({exitCode:writes++===0?1:0,stdout:'',stderr:''})} as unknown as VmController;
 await new Harness(store,vm,model,()=>{}).run(store.data.bots[0].id,'写入两个文件');
 assert.equal(store.data.runs[0].status,'failed');assert.match(store.data.runs[0].error!,/不能确认完成/);
 assert.equal(store.data.runs[0].executions?.filter(e=>e.status==='failed'&&!e.resolution).length,1);
});
test('a successful retry of the same file resolves its failure',async t=>{
 const store=fixture(t);let turns=0,writes=0;
 const model={complete:async()=>({content:'完成',finishReason:'stop',calls:turns++===0?[call('a','a.txt'),call('b','./a.txt')]:[]})} as unknown as ModelClient;
 await new Harness(store,{execute:async()=>({exitCode:writes++===0?1:0,stdout:''})} as unknown as VmController,model,()=>{}).run(store.data.bots[0].id,'写入文件');
 assert.equal(store.data.runs[0].status,'completed');assert.ok(store.data.runs[0].executions?.[0].resolution);
 assert.equal(store.runMessages(store.data.runs[0].id).find(m=>m.role==='tool')?.executionResolved,true);
});
test('evidence is scoped to current bot/run and in-flight executions recover as unknown',t=>{
 const store=fixture(t),bot=store.data.bots[0],ledger=new ExecutionLedger(store);
 store.data.runs.push({id:'r',botId:bot.id,status:'running',startedAt:new Date().toISOString(),modelCalls:0,toolCalls:0});
 const failed=ledger.begin(bot.id,'r',call('a','a'),{path:'a'});ledger.finish(failed,'failed',{error:'missing'},'out-a');
 const running=ledger.begin(bot.id,'r',call('b','b'),{path:'b'});
 assert.throws(()=>ledger.resolve(bot.id,'r',{executionId:failed.id,kind:'resolved',reason:'已检查替代文件的实际结果',evidenceIds:[running.id]}),/成功执行/);
 const restored=new Store(store.dir);assert.equal(restored.data.runs[0].executions?.[1].status,'unknown');
 assert.notEqual(executionTarget('host_execute',{command:'echo "a b"'},bot.id).targetKey,executionTarget('host_execute',{command:'echo "ab"'},bot.id).targetKey);
 assert.equal(executionTarget('file_write',{path:'/work/'+bot.id+'/a'},bot.id).targetKey,executionTarget('file_write',{path:'a'},bot.id).targetKey);
});
