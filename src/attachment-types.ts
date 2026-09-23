import type {ScreenReference} from './shared';
export interface Attachment {id:string;name:string;size:number;mime:string;image?:ScreenReference;}
export type AttachmentScope={kind:'bot'|'group';id:string};
export interface StoredAttachment extends Attachment {createdAt:string;sha256:string;sourcePath?:string;draftScope?:AttachmentScope;ownerBotId?:string;}
export interface AttachmentUpload {name:string;bytes:Uint8Array;}
export interface DroppedAttachment {id:string;name:string;kind:'file'|'directory';}
export interface PreparedAttachmentDrop {entries:DroppedAttachment[];virtualIndexes:number[];}
export interface BotAttachmentInput {attachmentId?:string;path?:string;location?:'vm'|'host';}
export const ATTACHMENT_LIMITS={count:10,fileBytes:25*1024*1024,totalBytes:100*1024*1024} as const;
export const attachmentSummary=(attachments?:Attachment[])=>attachments?.length?attachments.map(file=>`[附件] ${file.name}`).join('、'):'';
export function firstDeliveryAttachments<T extends {id:string;role?:string;attachments?:Attachment[]}>(message:T,history:T[]){
  const files=message.attachments;if(!files?.length)return files;
  const index=history.findIndex(item=>item.id===message.id);
  const seen=new Set((index>=0?history.slice(0,index):history).filter(item=>item.role==='assistant').flatMap(item=>item.attachments||[]).map(file=>file.id));
  return files.filter(file=>!seen.has(file.id));
}
