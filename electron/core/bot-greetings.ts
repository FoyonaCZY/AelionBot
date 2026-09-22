import {conversationIdentityPrompt} from '../../src/user-profile';
import {assistantMessage,type ModelClient} from './model';
import type {Store} from './store';
import {randomUUID} from 'node:crypto';
import {ReplyStreams} from './reply-streams';

const instruction='Write the first greeting from the AI teammate to the human. Use 1–2 sentences: introduce yourself by the teammate name given below, say how that role can help, and invite the first task. Address the human only by their displayName when one is set. Output only the greeting, without a heading, quotation marks, or a list. Do not claim to have completed work, configured a model, or started a computer. Do not call tools.';

export class BotGreetings {
  readonly streams=new ReplyStreams(()=>this.changed());
  private active=new Map<string,{controller:AbortController;done:Promise<void>}>();
  private disposed=false;
  constructor(private store:Store,private model:Pick<ModelClient,'complete'>,private changed:()=>void,private isRunning:(botId:string)=>boolean=()=>false){}
  get botIds(){return [...this.active.keys()];}
  private eligible(botId:string){
    return this.store.data.bots.some(bot=>bot.id===botId)&&!this.isRunning(botId)&&
      !(this.store.data.conversations[botId]||[]).length&&
      !this.store.data.messages.some(message=>message.botId===botId&&message.role!=='event');
  }
  greet(botId:string):Promise<void>{
    const pending=this.active.get(botId);if(pending)return pending.done;
    if(this.disposed||!this.eligible(botId)||!this.store.modelFor(botId).model.trim())return Promise.resolve();
    const attempt={controller:new AbortController(),done:Promise.resolve()};
    this.active.set(botId,attempt);this.changed();
    attempt.done=this.generate(botId,attempt.controller).finally(()=>{
      if(this.active.get(botId)===attempt){this.active.delete(botId);this.changed();}
    });
    return attempt.done;
  }
  async greetEmpty(){await Promise.all(this.store.data.bots.map(bot=>this.greet(bot.id)));}
  cancel(botId:string){
    const attempt=this.active.get(botId);if(!attempt)return;
    attempt.controller.abort();this.active.delete(botId);this.streams.dropBot(botId);this.changed();
  }
  cancelAll(){for(const botId of this.botIds)this.cancel(botId);}
  dispose(){this.disposed=true;this.cancelAll();this.streams.dispose();}
  private async generate(botId:string,controller:AbortController){
    const id=randomUUID(),preview=this.streams.begin({id,botId,main:true,time:new Date().toISOString(),purpose:'greeting'});let accepting=true;
    try{
      if(controller.signal.aborted)return;
      const bot=this.store.bot(botId),identity=conversationIdentityPrompt(bot,this.store.data.userProfile);
      const result=await this.model.complete([
        {role:'system',content:instruction+'\n'+identity},
        {role:'user',content:'Write the greeting now.'}
      ],[],controller.signal,delta=>{if(accepting&&!controller.signal.aborted&&this.eligible(botId))preview.update(delta);},{botId,purpose:'greeting',maxOutputTokens:1024,timeoutMs:45000});
      accepting=false;preview.close(false);
      if(controller.signal.aborted||!this.eligible(botId))return;
      const current=this.store.bot(botId);
      if(conversationIdentityPrompt(current,this.store.data.userProfile)!==identity)return;
      const content=result.content.trim();
      if(!content||result.calls.length)throw new Error('模型未返回有效开场白');
      this.store.data.conversations[botId].push(assistantMessage({...result,content}));
      this.store.message(botId,'assistant',content,{id,status:'done'});
    }catch(error){
      if(controller.signal.aborted||!this.eligible(botId))return;
      this.store.message(botId,'event',`开场白生成失败：${(error as Error).message}`);
    }finally{accepting=false;preview.close(false);}
  }
}
