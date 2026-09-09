import {DEFAULT_RUNTIME,reportedTotal,type RuntimeSettings,type TaskPlan} from '../../src/runtime-types';
import type {Store} from './store';
import {ExecutionLedger} from './execution-ledger';
import {FileToolError} from './file-text';
import {isDeepStrictEqual} from 'node:util';
export function runtimeSettings(value:unknown):RuntimeSettings{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('运行设置无效');
 // Older profiles contain this retired setting. It no longer triggers model requests.
 const {progressSeconds:legacyProgressSeconds,...input}=value as Partial<RuntimeSettings>&{progressSeconds?:unknown};
 const result={...DEFAULT_RUNTIME,...input};
 const ranges={maxTurns:[0,10000],maxMinutes:[0,1440],maxTokens:[0,10000000],modelRetries:[0,5],requestTimeoutMs:[1000,600000],maxOutputTokens:[256,65536],parallelReads:[1,8]} as const;
 for(const [key,[min,max]] of Object.entries(ranges))if(!Number.isInteger(result[key as keyof typeof ranges])||Number(result[key as keyof typeof ranges])<min||Number(result[key as keyof typeof ranges])>max)throw Error(`运行设置 ${key} 超出范围`);
 if(typeof result.fileCheckpoints!=='boolean'||Object.keys(input).some(key=>!(key in DEFAULT_RUNTIME)))throw Error('运行设置无效');return result;
}
export class RunPolicy {
 constructor(private store:Store){}
 settings(){return runtimeSettings(this.store.data.runtime||{});}
 check(botId:string,runId:string,iteration:number){
  const run=this.run(botId,runId),cfg=this.settings();
  if(cfg.maxTurns&&iteration>=cfg.maxTurns)throw Error(`达到 ${cfg.maxTurns} 轮执行预算，任务与执行记录已保留，可检查后继续`);
  if(cfg.maxMinutes>0&&Date.now()-Date.parse(run.startedAt)>=cfg.maxMinutes*60000)throw Error('达到本次执行时间预算，任务与执行记录已保留');
  if(cfg.maxTokens>0){
   const used=this.store.data.modelUsage?.filter(x=>x.runId===runId).reduce((n,x)=>n+(reportedTotal(x.usage)??x.estimatedTokens??((x.usage?.inputTokens??0)+(x.usage?.outputTokens??0))),0)||0;
   if(used>=cfg.maxTokens)throw Error('达到本次模型用量预算，任务与执行记录已保留');
  }
 }
 private run(botId:string,id:string){const run=this.store.data.runs.find(r=>r.id===id&&r.botId===botId);if(!run)throw Error('任务不存在');return run;}
 read(botId:string,runId:string){return this.run(botId,runId).plan||{revision:0,goal:'',steps:[]};}
 update(botId:string,runId:string,args:Record<string,unknown>){
  const run=this.run(botId,runId),prior=this.read(botId,runId);
  const goal=String(args.goal||'').trim(),steps=args.steps as TaskPlan['steps'];
  if(args.revision!==prior.revision){
   if(args.revision===prior.revision-1&&goal===prior.goal&&isDeepStrictEqual(steps,prior.steps))return prior;
   throw new FileToolError('PLAN_REVISION_CONFLICT','任务清单已变化；请使用 details.currentPlan 的 revision 合并本次修改。task_update 与 plan_update 更新同一个清单，不要对同一版本重复调用。',{currentPlan:structuredClone(prior)});
  }
  if(!goal||goal.length>1200||!Array.isArray(steps)||!steps.length||steps.length>30)throw Error('任务清单需要目标及 1–30 个步骤');
  const ledger=new ExecutionLedger(this.store),ids=new Set<string>();
  const work=this.store.data.workItems?.find(item=>item.id===run.workItemId&&item.botId===botId);
  const evidence=work?this.store.data.runs.filter(r=>r.botId===botId&&work.runIds.includes(r.id)).flatMap(r=>r.executions||[]):ledger.list(botId,runId);
  for(const step of steps){
   if(!step||typeof step.id!=='string'||!/^[\w-]{1,80}$/.test(step.id)||ids.has(step.id)||typeof step.title!=='string'||!step.title.trim()||step.title.length>300||typeof step.acceptance!=='string'||!step.acceptance.trim()||step.acceptance.length>800||!['pending','working','done','skipped'].includes(step.status)||!Array.isArray(step.evidenceIds)||step.evidenceIds.length>10||step.note!==undefined&&(typeof step.note!=='string'||step.note.length>1200))throw Error('任务步骤需要唯一 ID、标题、验收条件、状态及证据列表');
   ids.add(step.id);
   if(step.status==='done'&&(!step.evidenceIds.length||step.evidenceIds.some(id=>!evidence.some(e=>e.id===id&&e.status==='succeeded'&&!/^(task_|plan_|goal_|execution_)/.test(e.tool)))))throw Error('已完成步骤必须引用本任务的实际成功执行证据');
   if(step.status==='skipped'&&(!step.note||step.note.length<8))throw Error('跳过步骤需要说明原因');
  }
  if(prior.steps.some(s=>!ids.has(s.id)))throw Error('保留已有步骤，取消时标记 skipped 并说明原因');
  run.plan={revision:prior.revision+1,goal,steps:structuredClone(steps)};this.store.save();return run.plan;
 }
 frame(botId:string,runId:string){const run=this.run(botId,runId);return run.plan?`任务清单（程序保存，摘要不能替代验收）：${JSON.stringify(run.plan)}`:'';}
 incomplete(botId:string,runId:string){return this.read(botId,runId).steps.some(step=>['pending','working'].includes(step.status));}
}
