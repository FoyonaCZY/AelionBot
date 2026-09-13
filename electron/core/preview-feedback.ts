import type {Attachment,AttachmentScope} from '../../src/attachment-types';
import {previewFeedbackMessage,type PreviewFeedbackInput} from '../../src/preview-feedback';
interface Receipt {sent:true;attachmentId:string;}
interface Entry {key:string;attachment?:Attachment;promise?:Promise<Receipt>;receipt?:Receipt;}
export class PreviewFeedbackService {
 private entries=new Map<string,Entry>();
 constructor(private ops:{validate:(scope:AttachmentScope)=>void;capture:(input:PreviewFeedbackInput)=>Promise<Buffer>;attach:(scope:AttachmentScope,name:string,bytes:Buffer)=>Attachment;discard:(scope:AttachmentScope,id:string)=>void;send:(scope:AttachmentScope,text:string,attachmentId:string)=>void;delivered:(scope:AttachmentScope,attachmentId:string)=>boolean;}){}
 send(input:PreviewFeedbackInput):Promise<Receipt>{
  if(!input||typeof input.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(input.requestId))return Promise.reject(Error('反馈请求无效'));
  const text=previewFeedbackMessage(input);this.ops.validate(input.scope);
  const key=JSON.stringify(input),previous=this.entries.get(input.requestId);
  if(previous&&previous.key!==key)return Promise.reject(Error('反馈请求已变化，请重新发送'));
  if(previous?.receipt)return Promise.resolve(previous.receipt);if(previous?.promise)return previous.promise;
  if(!previous&&this.entries.size>=64){const removable=[...this.entries].find(([,entry])=>!entry.promise);if(!removable)return Promise.reject(Error('请等待当前反馈发送完成'));this.entries.delete(removable[0]);}
  const entry=previous||{key};this.entries.set(input.requestId,entry);
  const promise=(async()=>{try{
   if(!entry.attachment){const bytes=await this.ops.capture(input);if(!bytes.length||bytes.length>15*1024*1024)throw Error('截图为空或超过 15 MB，请调整窗口后重试');this.ops.validate(input.scope);entry.attachment=this.ops.attach(input.scope,'preview-'+input.requestId.slice(0,8)+'.png',bytes);}
   if(!this.ops.delivered(input.scope,entry.attachment.id))this.ops.send(input.scope,text,entry.attachment.id);
   return entry.receipt={sent:true,attachmentId:entry.attachment.id};
   }catch(error){if(entry.attachment&&this.ops.delivered(input.scope,entry.attachment.id))return entry.receipt={sent:true,attachmentId:entry.attachment.id};if(entry.attachment){try{this.ops.discard(input.scope,entry.attachment.id);}catch{}entry.attachment=undefined;}throw error;}
  })();entry.promise=promise;
  void promise.finally(()=>{entry.promise=undefined;}).catch(()=>{});return promise;
 }
}