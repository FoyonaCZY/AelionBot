import {randomUUID} from 'node:crypto';
import {basename,extname} from 'node:path';
import type {AgentPreviewRequest} from '../../src/agent-preview';
import {sourceTextFile} from '../../src/source-language';
import type {Store} from './store';
import {artifactPath,type ArtifactService} from './artifacts';
import type {Attachments} from './attachments';
import type {HostComputer} from './host';
import {officeExtensions} from './office-preview';
const LIMIT=25*1024*1024;
const supported=(name:string)=>sourceTextFile(name)||officeExtensions.has(extname(name).toLowerCase())||['.pdf','.png','.jpg','.jpeg','.webp','.gif','.svg','.bmp','.avif'].includes(extname(name).toLowerCase());
export class AgentPreviews {
  private pending=new Map<string,AgentPreviewRequest>();
  constructor(private store:Store,private artifacts:ArtifactService,private attachments:Attachments,private changed:()=>void,private host?:HostComputer){}
  snapshot(){return [...this.pending.values()].filter(request=>this.store.data.bots.some(bot=>bot.id===request.botId)&&(request.scope.kind==='bot'||this.store.data.groups.some(group=>group.id===request.scope.id&&group.members.some(member=>member.id===request.botId&&!member.leftAt))));}
  acknowledge(id:string){for(const [key,request] of this.pending)if(request.id===id){this.pending.delete(key);this.changed();return;}}
  async open(botId:string,runId:string,args:Record<string,unknown>,signal:AbortSignal){
    this.store.bot(botId);signal.throwIfAborted();
    const run=this.store.data.runs.find(run=>run.id===runId&&run.botId===botId&&run.status==='running');
    if(!run)throw Error('当前任务已结束，不能发起预览');
    if(Boolean(args.path)===Boolean(args.attachmentId))throw Error('请只填写 path 或 attachmentId');
    if(args.placement!==undefined&&!['side','full'].includes(String(args.placement)))throw Error('placement 必须是 side 或 full');
    const scope:AgentPreviewRequest['scope']=run.groupOrigin&&!run.groupTask?{kind:'group',id:run.groupOrigin.groupId}:{kind:'bot',id:botId};
    if(scope.kind==='group'&&!this.store.data.groups.some(group=>group.id===scope.id&&group.members.some(member=>member.id===botId&&!member.leftAt)))throw Error('Bot 已不在此群聊中');
    let target:AgentPreviewRequest['target'],name:string,size:number;
    if(args.attachmentId){
      if(args.location!==undefined)throw Error('已有附件不需要 location');
      const [file]=this.attachments.forBot(botId,[args.attachmentId]);
      if(!supported(file.name))throw Error('此格式暂不支持预览，请用 message_attach 发送原文件');
      this.attachments.bytes(file.id);target={kind:'attachment',file};name=file.name;size=file.size;
    }else{
      if(typeof args.path!=='string'||!args.path.trim()||args.path.length>1500)throw Error('文件路径无效');
      if(!supported(args.path))throw Error('此格式暂不支持预览，请用 message_attach 发送原文件');
      if(args.location==='host'){
        if(!this.host)throw Error('本机文件服务尚未就绪');
        const source=await this.host.readPreviewFile(botId,runId,args,signal,run.workspaceDir);
        signal.throwIfAborted();const file=this.attachments.importForBot(botId,basename(source.path),source.bytes);
        target={kind:'attachment',file};name=file.name;size=file.size;
      }else if(args.location==='vm'){
        const prefix='/work/'+botId+'/',path=artifactPath(args.path.startsWith(prefix)?args.path.slice(prefix.length):args.path);
        const bytes=await this.artifacts.read(botId,path,officeExtensions.has(extname(path).toLowerCase())?LIMIT:sourceTextFile(path)&&extname(path).toLowerCase()!=='.svg'?2*1024*1024:15*1024*1024);signal.throwIfAborted();
        target={kind:'workspace',path};name=path.split('/').at(-1)!;size=bytes.length;
      }else throw Error('文件预览需要 location: host 或 vm');
    }
    signal.throwIfAborted();if(run.status!=='running')throw Error('任务已结束，预览未排队');
    const key=scope.kind+':'+scope.id,request:AgentPreviewRequest={id:randomUUID(),botId,runId,scope,target,name,size,placement:args.placement==='full'?'full':'side',createdAt:new Date().toISOString()};
    // Keep only the newest pending request in each conversation.
    this.pending.delete(key);this.pending.set(key,request);
    while(this.pending.size>100)this.pending.delete(this.pending.keys().next().value!);
    this.changed();
    return {queued:true,requestId:request.id,scope,name,placement:request.placement,message:'预览已排队，将在用户查看此会话且界面可用时展示；这不代表用户已经查看或文件已经验收。仍需发送最终说明，交付附件请用 message_attach。'};
  }
}
