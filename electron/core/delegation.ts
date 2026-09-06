import type {Store} from './store';
import type {PeerExchange} from '../../src/peer-types';
export interface DelegationContract {goal:string;acceptance:string[];expectedOutput:string;}
export interface DelegationReceipt {status:'completed'|'blocked';summary:string;evidenceIds:string[];runId:string;time:string;}
export function delegationContract(value:unknown):DelegationContract{
 const v=value as DelegationContract;if(!v||typeof v.goal!=='string'||!v.goal.trim()||v.goal.length>4000||!Array.isArray(v.acceptance)||!v.acceptance.length||v.acceptance.length>10||v.acceptance.some(c=>typeof c!=='string'||!c.trim()||c.length>400)||typeof v.expectedOutput!=='string'||!v.expectedOutput.trim()||v.expectedOutput.length>1000)throw Error('委托任务需要具体目标、验收条件和预期成果');return {goal:v.goal.trim(),acceptance:v.acceptance.map(c=>c.trim()),expectedOutput:v.expectedOutput.trim()};
}
export function delegationStatus(store:Store,botId:string,id:string){
 const exchange=store.data.peerExchanges.find(e=>e.id===id&&[e.fromBotId,e.toBotId].includes(botId));if(!exchange)throw Error('委托任务不存在或无权访问');
 const runs=store.data.runs.filter(run=>run.botId===exchange.toBotId&&(run.peerOrigin?.sessionId||run.peerOrigin?.exchangeId)===exchange.id),runIds=new Set(runs.map(r=>r.id));
 const usage=(store.data.modelUsage||[]).filter(u=>u.runId&&runIds.has(u.runId)).reduce((sum,u)=>({inputTokens:sum.inputTokens+(u.usage?.inputTokens||0),outputTokens:sum.outputTokens+(u.usage?.outputTokens||0)}),{inputTokens:0,outputTokens:0});
 const reply=store.data.peerThreads.find(t=>t.id===exchange.threadId)?.messages.find(m=>m.id===exchange.replyMessageId);
 return {id:exchange.id,fromBotId:exchange.fromBotId,toBotId:exchange.toBotId,transportStatus:exchange.status,task:exchange.task,receipt:exchange.receipt,reply:reply?.content,attachments:reply?.attachments,usage};
}
export function recordDelegationReceipt(store:Store,botId:string,runId:string,args:Record<string,unknown>){
 const run=store.data.runs.find(r=>r.id===runId&&r.botId===botId),origin=run?.peerOrigin,exchange=origin&&store.data.peerExchanges.find(e=>e.id===(origin.sessionId||origin.exchangeId)&&e.toBotId===botId);
 if(!run||origin?.kind!=='peer_task'||!exchange?.task)throw Error('只有已接下结构化委托的接收方可以提交回执');
 const status=args.status,summary=args.summary,evidenceIds=args.evidenceIds;if(!['completed','blocked'].includes(String(status))||typeof summary!=='string'||!summary.trim()||summary.length>3000||!Array.isArray(evidenceIds)||evidenceIds.length>10)throw Error('回执需要状态、总结和证据列表');
 const evidence=run.executions||[];
 if(status==='completed'&&(!evidenceIds.length||evidenceIds.some(id=>!evidence.some(e=>e.id===id&&e.status==='succeeded'&&!/^(task_|goal_|plan_|execution_|delegation_)/.test(e.tool)))||evidence.some(e=>['failed','unknown'].includes(e.status)&&!e.resolution)||run.plan?.steps.some(s=>['pending','working'].includes(s.status))))throw Error('完成回执需要真实执行证据，并先处理未完成步骤及失败');
 exchange.receipt={status:status as DelegationReceipt['status'],summary,evidenceIds,runId,time:new Date().toISOString()};store.save();return exchange.receipt;
}
