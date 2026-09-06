import type {WireMessage} from '../../src/shared';
import type {Store} from './store';
import type {ModelClient,ToolDefinition} from './model';
import type {SkillLibrary} from './skill-library';
import {CognitiveStore} from './cognitive-store';
import {MemoryService,knowledgeTextSafe} from './memory-service';
import {ContextEngine} from './context-engine';
import {LearningWorker,shouldReview,type ReviewPayload} from './learning-worker';
import {memoryRoute,routingOnlyRun} from './memory-routing';

export class Cognition {
  readonly storage:CognitiveStore;
  readonly memory:MemoryService;
  readonly context:ContextEngine;
  readonly learning:LearningWorker;
  private closing=false;
  constructor(readonly store:Store,model:ModelClient,readonly skills:SkillLibrary,private changed:()=>void,foregroundBusy:()=>boolean,private secrets:()=>string[]=()=>[],settleMs=2500){
    this.storage=new CognitiveStore(store);this.memory=new MemoryService(this.storage,secrets);this.context=new ContextEngine(this.storage,model,changed);this.learning=new LearningWorker(this.storage,this.memory,skills,model,this.context,changed,foregroundBusy,secrets,settleMs);
    for(const bot of store.data.bots)this.memory.mirror(bot.id);
  }
  start(){this.learning.start();}
  beforeRun(){this.learning.preempt();}
  afterRun(botId:string,runId:string,messages:WireMessage[]|undefined,tools:ToolDefinition[]){
    if(this.closing)return;this.storage.syncHistory(botId);
    const run=this.store.data.runs.find(run=>run.id===runId),request=[...this.store.data.messages].reverse().find(message=>message.runId===runId&&(message.role==='user'||run?.peerOrigin?.kind==='peer_task'&&message.taskSource));
    if(request?.reaction){this.learning.schedule();return;}
    if(routingOnlyRun(this.store,runId)){this.learning.schedule();return;}
    const route=request?memoryRoute(this.store,request):undefined;
    if(route&&!route.targetBotIds.includes(botId)){this.learning.schedule();return;}
    if(run?.status==='completed'&&request&&messages&&shouldReview(request.content,run.toolCalls)){
      const candidates=this.store.data.messages.filter(message=>message.botId===botId&&(message.role==='user'||message.role==='tool')&&(!run.peerOrigin||message.runId===runId&&message.role==='tool'&&message.status==='done'&&message.tool!=='memory')).slice(-32);if(request.role==='user'&&!candidates.some(message=>message.id===request.id))candidates.unshift(request);
      if(!candidates.length){this.learning.schedule();return;}
      const payload:ReviewPayload={messages:structuredClone(messages),tools:structuredClone(tools),sourceRefs:candidates.map(message=>message.id),revision:this.storage.revision(botId),model:this.store.modelFor(botId).model};
      this.learning.enqueue(botId,runId,payload);
    }else this.learning.schedule();
  }
  saveSkill(botId:string,runId:string,name:string,description:string,body:string,sourceRefs?:string[]){
    knowledgeTextSafe(body,this.secrets());const refs=sourceRefs?.map(id=>{const message=this.storage.sourceMessage(botId,id);if(!message)throw new Error('技能来源不存在或无权访问');return message.id;})||this.store.data.messages.filter(message=>message.botId===botId&&(message.runId===runId&&message.role==='user'||message.role==='tool'&&message.status==='done')).slice(-5).map(message=>message.id);const existing=this.skills.list(botId).find(skill=>skill.botId===botId&&skill.name===name),before=existing?this.skills.read(botId,existing.id).body:undefined;
    const result=this.skills.save(botId,name,description,body,{origin:'foreground',sourceRunId:runId,sourceRefs:refs});if(!result.unchanged){this.storage.audit(botId,runId,'skill',existing?'replace':'create',before,body,refs);this.storage.bump(botId);}return result;
  }
  view(){if(this.closing)return undefined;return {learning:this.learning.status(),bots:this.store.data.bots.map(bot=>{const events=this.storage.db.prepare('SELECT kind,action,created_at FROM knowledge_events WHERE bot_id=? ORDER BY created_at DESC LIMIT 1').get(bot.id) as any;return {botId:bot.id,memoryRevision:this.storage.revision(bot.id),context:this.context.stats(bot.id),lastLearning:events?{kind:events.kind,action:events.action,time:events.created_at}:undefined};})};}
  deleteBot(botId:string){this.learning.preempt();this.storage.clearBot(botId);}
  async close(){this.closing=true;await this.learning.close();this.storage.close();}
}
