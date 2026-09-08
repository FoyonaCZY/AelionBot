import {resolveChatReply} from './message-replies';
import {workCommand} from '../../src/work-types';
import {conversationWorkspace} from './workspaces';
import {Attachments} from './attachments';
import type {Store} from './store';
import type {HarnessRunOptions} from './peer-runtime-types';
import type {BotMention,ChatMessage} from '../../src/shared';
import type {ScheduledTrigger} from '../../src/scheduled-types';
import {chatInputText,validateChatInput} from './chat-input';
import {pinDescription,updatePins,validPin,type PinActor,type PinInput} from '../../src/reactions';

export function pinChat(store:Store,botId:string,actor:PinActor,input:PinInput,runId?:string){
  validPin(input);store.bot(botId);
  const target=store.data.messages.find(message=>message.id===input.messageId&&message.botId===botId&&!message.reaction&&['user','assistant'].includes(message.role)&&(message.content||message.attachments?.length)&&(!message.status||message.status==='done')&&(!message.runId||!store.data.runs.find(run=>run.id===message.runId)?.groupOrigin));
  if(!target)throw new Error('只能回应当前聊天里已发送的文字消息');
  const reactingUser=actor.kind==='bot'&&runId&&store.data.runs.some(run=>run.id===runId&&run.botId===botId&&run.status==='running')&&store.data.messages.find(message=>message.botId===botId&&message.runId===runId&&message.role==='user'&&message.reaction?.messageId===target.id&&!message.reaction.removed&&target.pins?.some(pin=>pin.actor.id==='user'&&pin.emoji===message.reaction!.emoji));
  if(actor.kind==='bot'&&target.role!=='user'&&!reactingUser)throw new Error('请选择用户的消息，或当前用户表态所指向的原消息');
  if(!updatePins(target,actor,input))return {pinned:!input.remove,alreadyApplied:true,messageId:target.id};
  const event=store.message(botId,actor.kind==='user'?'user':'event',pinDescription(actor,input,target.content),{reaction:{messageId:target.id,emoji:input.emoji,removed:Boolean(input.remove)},...(runId?{runId}:{})});
  return {pinned:!input.remove,messageId:target.id,eventId:event.id};
}

export class ChatPinQueue {
  private timer?:ReturnType<typeof setTimeout>;private closed=false;
  private workers=new Set<string>();private superseded=new Map<string,string>();
  constructor(private store:Store,private runner:{isRunning:(id:string)=>boolean;run:(id:string,input:string,options:HarnessRunOptions)=>Promise<void>;refresh?:(id:string)=>string|undefined},private changed:()=>void,private attachments=new Attachments(store)){}
  private queued(message:ChatMessage){return message.role==='user'&&!message.runId&&(message.inputState==='queued'||Boolean(message.reaction&&!message.inputState));}
  hasPending(id:string){return this.workers.has(id)||this.store.data.messages.some(message=>message.botId===id&&this.queued(message));}
  private received(botId:string){
    const previous=this.runner.refresh?.(botId);if(previous)this.superseded.set(botId,previous);
    clearTimeout(this.timer);this.timer=undefined;this.changed();this.wake();
  }
  send(input:{botId:string;message:string;replyToMessageId?:string;mentions?:BotMention[];attachmentIds?:string[]}){
    if(this.closed)throw new Error('客户端正在退出');
    const attachments=this.attachments.forDraft({kind:'bot',id:input?.botId},input?.attachmentIds),mentions=validateChatInput(this.store,input?.botId,input?.message,input?.mentions,Boolean(attachments.length));
    if(!this.store.modelFor(input.botId).model)throw new Error('请先为这个 Bot 选择模型');
    const command=workCommand(input.message);if(command&&!command.objective)throw Error(`请在 /${command.kind} 后填写任务内容`);
    const reply=resolveChatReply(this.store,input.botId,input.replyToMessageId);
    this.store.message(input.botId,'user',input.message,{mentions,attachments,...(reply?{reply}:{}),workspaceDir:conversationWorkspace(this.store,{kind:'bot',id:input.botId})||null,inputState:'queued'});this.received(input.botId);
  }
  schedule(botId:string,message:string,scheduled:ScheduledTrigger){
    if(this.closed)throw new Error('客户端正在退出');validateChatInput(this.store,botId,message);
    if(this.store.data.messages.some(message=>message.scheduled?.occurrenceId===scheduled.occurrenceId))return;
    this.store.message(botId,'user',message,{scheduled,inputState:'queued'});this.changed();this.wake();
  }
  pin(input:PinInput&{botId:string}){
    if(this.closed)throw new Error('客户端正在退出');
    const result=pinChat(this.store,input.botId,{kind:'user',id:'user',name:'你'},input);
    if(result.eventId){const event=this.store.data.messages.find(message=>message.id===result.eventId)!;event.inputState='queued';this.store.save();this.received(input.botId);}else this.changed();
  }
  wake(){
    if(this.closed||this.timer||!this.store.data.messages.some(message=>this.queued(message)&&this.store.modelFor(message.botId).model))return;
    this.timer=setTimeout(()=>{this.timer=undefined;for(const botId of new Set(this.store.data.messages.filter(message=>this.queued(message)).map(message=>message.botId))){
      if(!this.store.modelFor(botId).model||this.runner.isRunning(botId)||this.workers.has(botId))continue;
      const queued=this.store.data.messages.filter(message=>message.botId===botId&&this.queued(message)),human=queued.filter(message=>!message.scheduled),batch=human.length?human:queued.slice(0,1),latest=batch.at(-1)!;
      this.workers.add(botId);const supersedesRunId=this.superseded.get(botId);this.superseded.delete(botId);
      void this.runner.run(botId,chatInputText(latest,false),{inputMessageIds:batch.map(message=>message.id),reactionMessageId:latest.reaction?latest.id:undefined,mentions:latest.reaction?undefined:latest.mentions,supersedesRunId}).catch(error=>{
        for(const message of batch)if(!message.runId)message.inputState='cancelled';
        if(this.store.data.bots.some(bot=>bot.id===botId))this.store.message(botId,'event',`这次输入未能处理：${String((error as Error).message).slice(0,300)}`);
      }).finally(()=>{this.workers.delete(botId);this.store.save();this.changed();this.wake();});
    }},80);
  }
  cancel(botId:string){for(const message of this.store.data.messages)if(message.botId===botId&&this.queued(message))message.inputState='cancelled';this.superseded.delete(botId);this.store.save();this.changed();}
  dispose(){this.closed=true;clearTimeout(this.timer);let dirty=false;for(const message of this.store.data.messages)if(this.queued(message)){message.inputState='interrupted';dirty=true;}if(dirty)this.store.save();}
}
