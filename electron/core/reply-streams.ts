import type {StreamingReply} from '../../src/shared';
import type {BotIdentity} from '../../src/peer-types';
import {botMentions} from '../../src/mentions';
import {streamingReplyText} from '../../src/streaming';

export type StreamTarget=Omit<StreamingReply,'content'|'mentions'>;
export class ReplyStreams {
  private entries=new Map<string,{reply:StreamingReply;token:symbol}>();
  private timer?:ReturnType<typeof setTimeout>;
  private lastEmit=0;
  constructor(private changed:()=>void,private interval=100){}
  snapshot(){return [...this.entries.values()].map(entry=>structuredClone(entry.reply)).filter(reply=>reply.content).sort((a,b)=>a.time.localeCompare(b.time)||a.id.localeCompare(b.id));}
  begin(target:StreamTarget,members?:()=>BotIdentity[]){
    // Group messages appear only after publication. Promoted tasks may still stream in their Bot's main chat.
    if(target.groupId&&!target.main)return {update:(_delta:string)=>{},close:(_notify=true)=>{}};
    const token=Symbol(target.id);let raw='',closed=false;this.entries.set(target.id,{token,reply:{...target,content:''}});
    const update=(delta:string)=>{
      const previous=this.entries.get(target.id);if(closed||previous?.token!==token)return;raw+=delta;
      let content=streamingReplyText(raw);if(target.purpose==='progress')content=Array.from(content.replace(/\s+/g,' ')).slice(0,240).join('');
      const allowed=members?.();if(allowed)content=content.replace(/@\{([^{}\s]+)\}/g,(match,id)=>allowed.some(member=>member.id===id&&id!==target.botId)?match:'');
      const formatted=allowed?botMentions(content,allowed,target.botId,false):{content,mentions:[]};
      if(previous?.reply.content===formatted.content)return;
      this.entries.set(target.id,{token,reply:{...target,...formatted}});this.schedule();
    };
    return {update,close:(notify=true)=>{if(closed)return;closed=true;const current=this.entries.get(target.id);if(current?.token===token){this.entries.delete(target.id);if(!this.entries.size){clearTimeout(this.timer);this.timer=undefined;}if(notify)this.emit();}}};
  }
  dropRun(runId:string){this.drop(reply=>reply.runId===runId);}
  dropBot(botId:string){this.drop(reply=>reply.botId===botId);}
  private drop(match:(reply:StreamingReply)=>boolean){let changed=false;for(const [id,entry] of this.entries)if(match(entry.reply)){this.entries.delete(id);changed=true;}if(!this.entries.size){clearTimeout(this.timer);this.timer=undefined;}if(changed)this.emit();}
  private emit(){clearTimeout(this.timer);this.timer=undefined;this.lastEmit=Date.now();this.changed();}
  private schedule(){const remaining=this.interval-(Date.now()-this.lastEmit);if(remaining<=0){this.emit();return;}if(!this.timer){this.timer=setTimeout(()=>this.emit(),remaining);this.timer.unref?.();}}
  dispose(){clearTimeout(this.timer);this.timer=undefined;this.entries.clear();}
}
