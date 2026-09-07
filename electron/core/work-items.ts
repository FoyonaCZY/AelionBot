import {randomUUID} from 'node:crypto';
import type {RunRecord} from '../../src/shared';
import type {WorkItem,WorkMode,WorkAction} from '../../src/work-types';
import {workCommand} from '../../src/work-types';
import {RunPolicy} from './runtime-policy';
import type {Store} from './store';
import type {HarnessRunOptions} from './peer-runtime-types';

export const PLANNING_TOOLS=new Set(['task_read','task_update','plan_update','goal_read','execution_list','execution_resolve','host_file_read','host_list_directory','file_read','attachment_read','history_search','history_read','skills_list','skill_read','skill_file_read','read_result']);
const terminal=new Set(['completed','cancelled']);
const clean=(value:unknown,label:string,max=1200)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw Error(`${label}为空或过长`);return value.trim();};

export class WorkItems {
  constructor(private store:Store){store.data.workItems||=[];}
  get(id:string){const item=this.store.data.workItems!.find(item=>item.id===id);if(!item)throw Error('计划或目标不存在');return item;}
  forRun(run:RunRecord){return run.workItemId?this.store.data.workItems!.find(item=>item.id===run.workItemId&&item.botId===run.botId):undefined;}
  private save(item:WorkItem){item.updatedAt=new Date().toISOString();this.store.save();return item;}
  create(run:RunRecord,kind:WorkMode,objective:string,createdBy:'user'|'bot',sourceMessageId?:string){
    if(this.forRun(run))throw Error('本次任务已有计划或目标，请更新已有内容');
    const item:WorkItem={id:randomUUID(),botId:run.botId,scope:run.groupOrigin?{kind:'group',id:run.groupOrigin.groupId}:{kind:'bot',id:run.botId},kind,objective:clean(objective,'目标',8000),createdBy,status:kind==='plan'&&createdBy==='user'?'planning':'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),runIds:[run.id],activeRunId:run.id,workspaceDir:run.workspaceDir,sourceMessageId};
    run.workItemId=item.id;this.store.data.workItems!.push(item);return this.save(item);
  }
  begin(run:RunRecord,options:HarnessRunOptions,source?:{id:string;content:string}){
    const command=source?workCommand(source.content):undefined;
    if(command&&!this.store.data.workItems!.some(item=>item.botId===run.botId&&item.sourceMessageId===source?.id)){if(!command.objective)throw Error(`请在 /${command.kind} 后填写任务内容`);return this.create(run,command.kind,command.objective,'user',source?.id);}
    const carry=this.store.data.runs.find(r=>r.botId===run.botId&&r.id===(options.resumeRunId||options.supersedesRunId||options.groupTaskFrom));
    if(!options.workItemId&&source&&carry&&carry.workspaceDir!==run.workspaceDir)return;
    const pending=source&&!command?[...this.store.data.workItems!].reverse().find(item=>item.botId===run.botId&&item.scope.kind===(run.groupOrigin?'group':'bot')&&item.scope.id===(run.groupOrigin?.groupId||run.botId)&&item.workspaceDir===run.workspaceDir):undefined;
    const id=options.workItemId||carry?.workItemId||(pending?.kind==='plan'&&pending.createdBy==='user'&&!pending.approvedAt&&['ready','paused'].includes(pending.status)?pending.id:undefined);if(!id)return;
    const item=this.get(id);if(item.botId!==run.botId||terminal.has(item.status)){if(options.workItemId)throw Error('不能继续这个计划或目标');return;}
    if(item.activeRunId&&this.store.data.runs.some(r=>r.id===item.activeRunId&&r.status==='running'))throw Error('这个计划或目标仍在执行');
    run.workItemId=id;run.plan=item.plan?structuredClone(item.plan):undefined;run.workspaceDir=item.workspaceDir;
    item.status=item.kind==='plan'&&item.createdBy==='user'&&!item.approvedAt?'planning':'running';
    item.activeRunId=run.id;item.runIds.push(run.id);delete item.reason;this.save(item);return item;
  }
  sync(run:RunRecord){const item=this.forRun(run);if(item){item.plan=run.plan?structuredClone(run.plan):undefined;this.save(item);}return item;}
  frame(run:RunRecord){const item=this.forRun(run);return item?`当前${item.kind==='plan'?'计划':'目标'}（应用保存）：${JSON.stringify({id:item.id,objective:item.objective,status:item.status,reason:item.reason,summary:item.summary})}\n${item.status==='planning'?'用户要求先规划。仅可使用提供的只读工具调查，调用 plan_update 保存包含步骤和验收条件的计划。所有步骤保持 pending。然后向用户介绍计划并结束本轮，等待用户点击开始执行。禁止执行命令、写文件、发消息或安排后续自动执行。':item.kind==='goal'?'在原用户任务范围内持续实际执行，先用 plan_update 拆分步骤，随实际进展更新。验证后调用 goal_update(status=completed)，引用执行证据并写明完成依据；阻碍无法自行解决时用 goal_update(status=blocked) 说明需要什么。不要只说稍后继续就结束，也不要无限重复同一失败操作。':'按照已确认的计划执行，用 plan_update 更新步骤和真实证据。遇到阻碍用 goal_update(status=blocked) 说明原因。'}\n本任务之前执行的结果应先核对，禁止自动重复结果未知的操作。`:'';}
  updatePlan(run:RunRecord,args:Record<string,unknown>){
    const item=this.forRun(run);
    if(item&&terminal.has(item.status))throw Error('这个目标已结束');
    if(item?.status==='planning'&&(!Array.isArray(args.steps)||args.steps.some(step=>step?.status!=='pending')))throw Error('待确认计划中的步骤必须为 pending，确认前不能执行');
    const plan=new RunPolicy(this.store).update(run.botId,run.id,args);
    if(!item)this.create(run,'plan',plan.goal,'bot',this.store.humanRunMessage(run.id)?.id);
    this.sync(run);return plan;
  }
  invoke(run:RunRecord,name:string,args:Record<string,unknown>){
    if(name==='goal_read')return this.forRun(run)||{status:'none'};
    if(name==='plan_update')return this.updatePlan(run,args);
    if(name==='goal_set'){
      const current=this.forRun(run);if(current){if(current.status==='planning')throw Error('用户尚未确认计划');if(current.kind==='goal')throw Error('目标已存在，请继续执行或更新状态');current.kind='goal';current.objective=clean(args.objective,'目标',8000);return this.save(current);}
      return this.create(run,'goal',clean(args.objective,'目标',8000),'bot',this.store.humanRunMessage(run.id)?.id);
    }
    const item=this.forRun(run);if(!item)throw Error('请先设置计划或目标');
    if(terminal.has(item.status))throw Error('这个目标已结束');
    if(item.status==='planning')throw Error('用户尚未确认计划');
    if(args.status==='blocked'){item.status='blocked';item.reason=clean(args.reason,'阻碍说明');return this.save(item);}
    if(args.status!=='completed')throw Error('状态只能是 completed 或 blocked');
    if(!run.plan?.steps.length||new RunPolicy(this.store).incomplete(run.botId,run.id))throw Error('请先完成计划中的步骤并保存执行证据');
    if(this.store.data.processes?.some(p=>p.botId===run.botId&&item.runIds.includes(p.runId)&&p.purpose==='task'&&['starting','running','unknown'].includes(p.status)))throw Error('后台任务尚未核对完成，请先检查进程状态和结果');
    const evidence=args.evidenceIds;if(!Array.isArray(evidence)||!evidence.length||evidence.length>10||evidence.some(id=>typeof id!=='string'||!this.evidence(item).some(e=>e.id===id)))throw Error('完成目标需要引用本目标内实际成功执行的证据');
    if(this.store.data.runs.filter(r=>item.runIds.includes(r.id)).some(r=>r.executions?.some(e=>['failed','unknown'].includes(e.status)&&!e.resolution)))throw Error('还有未解决或结果未知的执行，请先核对');
    item.status='completed';item.summary=clean(args.summary,'完成依据',3000);item.evidenceIds=evidence;return this.save(item);
  }
  evidence(item:WorkItem){return this.store.data.runs.filter(r=>r.botId===item.botId&&item.runIds.includes(r.id)).flatMap(r=>r.executions||[]).filter(e=>e.status==='succeeded'&&!/^(task_|plan_|goal_|execution_)/.test(e.tool));}
  finish(run:RunRecord){
    const item=this.sync(run);if(!item||item.activeRunId!==run.id)return;
    delete item.activeRunId;
    if(run.status!=='completed'&&item.status!=='cancelled'){item.status=run.status==='failed'?'blocked':'paused';item.reason=run.error||'执行已暂停';}
    else if(item.status==='planning'){item.status=run.plan?.steps.length?'ready':'blocked';if(item.status==='blocked')item.reason='没有生成有效计划，请补充要求后重试';}
    else if(item.status==='running'){if(item.kind==='plan'&&run.plan?.steps.length&&!new RunPolicy(this.store).incomplete(run.botId,run.id))item.status='completed';else{item.status='paused';item.reason='本轮执行已结束，可继续处理剩余目标';}}
    this.save(item);
  }
  action(input:WorkAction){
    if(!input||!['start','pause','cancel'].includes(input.action))throw Error('无效计划操作');
    const item=this.get(input.id);this.store.bot(item.botId);
    if(item.scope.kind==='group'&&!this.store.data.groups.some(g=>g.id===item.scope.id&&g.members.some(m=>m.id===item.botId&&!m.leftAt)))throw Error('Bot 已离开这个群聊');
    if(terminal.has(item.status))throw Error('这个任务已经结束');
    if(input.action==='start'){if(item.activeRunId)throw Error('任务仍在结束，请稍候');if(item.status==='planning')throw Error('计划仍在生成');if(item.kind==='plan'&&item.plan?.steps.length)item.approvedAt=new Date().toISOString();return this.save(item);}
    item.status=input.action==='pause'?'paused':'cancelled';item.reason=input.action==='pause'?'你暂停了任务':'你取消了任务';return this.save(item);
  }
}
